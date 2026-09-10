"""Headless Evidra controller for long-running Modal campaigns.

This is intentionally separate from modal_app.py: modal_app runs one
experiment, while this module runs the Node controller and persists `.sota`
state in a Modal Volume. The local TUI remains the attach/inspection client.
"""

from __future__ import annotations

import os
import json
import sqlite3
import subprocess
import time
from pathlib import Path

import modal

WORKSPACE = Path(os.environ.get("EVIDRA_MODAL_WORKSPACE", ".")).resolve()
REMOTE_WORKSPACE = Path("/workspace")
STATE_VOLUME = modal.Volume.from_name(os.environ.get("EVIDRA_MODAL_STATE_VOLUME", "evidra-controller-state"), create_if_missing=True)
CODEX_SECRET_NAME = os.environ.get("EVIDRA_MODAL_CODEX_SECRET")
MODAL_AUTH_SECRET_NAME = os.environ.get("EVIDRA_MODAL_AUTH_SECRET")


def include_workspace_path(path: str) -> bool:
    excluded = {".git", ".sota", "node_modules", ".venv", "__pycache__", ".mypy_cache"}
    return not any(part in excluded for part in Path(path).parts)


def ignore_workspace_path(path: Path) -> bool:
    return not include_workspace_path(str(path))


image = (
    modal.Image.from_registry("python:3.11-slim-bookworm")
    .apt_install("nodejs", "npm")
    .run_commands("python -m pip install uv modal")
    .add_local_dir(WORKSPACE, remote_path=str(REMOTE_WORKSPACE), ignore=ignore_workspace_path)
)
app = modal.App("evidra-controller")
secrets = [modal.Secret.from_name(name) for name in (CODEX_SECRET_NAME, MODAL_AUTH_SECRET_NAME) if name]


@app.function(volumes={"/state": STATE_VOLUME})
def inspect_state() -> dict[str, object]:
    database = Path("/state/database.sqlite")
    if not database.exists():
        return {"status": "not_initialized"}
    connection = sqlite3.connect(database)
    try:
        counts = {}
        for table in ("events", "hypotheses", "experiments", "runs", "artifacts", "decisions", "evidence_claims"):
            try:
                counts[table] = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.OperationalError:
                counts[table] = None
        try:
            campaign = connection.execute("SELECT payload_json FROM research_campaigns WHERE id = 1").fetchone()
        except sqlite3.OperationalError:
            campaign = None
        try:
            scheduler = connection.execute("SELECT status, mode, current_step, updated_at FROM scheduler_state WHERE id = 1").fetchone()
        except sqlite3.OperationalError:
            scheduler = None
        return {"status": "ready", "counts": counts, "campaign": json.loads(campaign[0]) if campaign else None, "scheduler": scheduler}
    finally:
        connection.close()


@app.function(volumes={"/state": STATE_VOLUME})
def set_control(action: str) -> str:
    if action not in {"pause", "resume", "stop"}:
        raise ValueError("Controller action must be pause, resume, or stop")
    Path("/state/controller-control.json").write_text(json.dumps({"action": action}), encoding="utf-8")
    STATE_VOLUME.commit()
    return action


@app.function(image=image, secrets=secrets, volumes={"/state": STATE_VOLUME}, timeout=24 * 60 * 60)
def execute(goal: str, budget: str, mode: str = "research", autonomy: str = "safe", provider: str = "codex", model: str = "default", lanes: int = 3, competition: str = "local-research", executor: str = "local") -> int:
    if mode not in {"research", "challenge"}:
        raise ValueError("Controller mode must be research or challenge")
    if autonomy not in {"safe", "fast", "yolo"}:
        raise ValueError("Controller autonomy must be safe, fast, or yolo")
    if executor not in {"local", "modal"}:
        raise ValueError("The Modal controller supports local or modal experiment workers; use container from a local controller.")
    environment = {
        **os.environ,
        "EVIDRA_STATE_DIR": "/state",
        "EVIDRA_CONTROLLER_MODE": "modal",
        "EVIDRA_CONTROLLER_CONTROL_FILE": "/state/controller-control.json",
    }
    install = subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=REMOTE_WORKSPACE, env=environment, text=True, check=False)
    if install.returncode != 0:
        return install.returncode
    build = subprocess.run(["npm", "run", "build"], cwd=REMOTE_WORKSPACE, env=environment, text=True, check=False)
    if build.returncode != 0:
        return build.returncode
    if not Path("/state/database.sqlite").exists():
        initialize = subprocess.run(["node", "dist/cli.js", "init", competition], cwd=REMOTE_WORKSPACE, env=environment, text=True, check=False)
        if initialize.returncode != 0:
            return initialize.returncode
    command = [
        "node", "dist/cli.js", "research",
        "--mode", mode,
        "--autonomy", autonomy,
        "--goal", goal,
        "--budget", budget,
        "--provider", provider,
        "--model", model,
        "--lanes", str(max(1, min(lanes, 6))),
        "--limit-policy", "wait",
        "--executor", executor,
    ]
    process = subprocess.Popen(command, cwd=REMOTE_WORKSPACE, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert process.stdout is not None
    last_volume_commit = time.monotonic()
    for line in process.stdout:
        print(line, end="", flush=True)
        if time.monotonic() - last_volume_commit >= 30:
            STATE_VOLUME.commit()
            last_volume_commit = time.monotonic()
    exit_code = process.wait()
    # Modal Volume writes are not durable across function/container teardown
    # until explicitly committed. Always publish the final SQLite/WAL state.
    STATE_VOLUME.commit()
    return exit_code


@app.local_entrypoint()
def run(action: str = "start", goal: str = "", budget: str = "4h", mode: str = "research", autonomy: str = "safe", provider: str = "codex", model: str = "default", lanes: int = 3, competition: str = "local-research", executor: str = "local") -> None:
    if action == "status":
        print(json.dumps(inspect_state.remote(), indent=2, default=str))
        return
    if action in {"pause", "resume", "stop"}:
        print(f"Controller {set_control.remote(action)} request recorded.")
        return
    if action != "start" or not goal:
        raise ValueError("Start requires --goal; actions are start, status, pause, resume, and stop")
    raise SystemExit(execute.remote(goal, budget, mode, autonomy, provider, model, lanes, competition, executor))
