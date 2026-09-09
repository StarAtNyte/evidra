"""Headless Evidra controller for long-running Modal campaigns.

This is intentionally separate from modal_app.py: modal_app runs one
experiment, while this module runs the Node controller and persists `.sota`
state in a Modal Volume. The local TUI remains the attach/inspection client.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import modal

WORKSPACE = Path(os.environ.get("EVIDRA_MODAL_WORKSPACE", ".")).resolve()
REMOTE_WORKSPACE = Path("/workspace")
STATE_VOLUME = modal.Volume.from_name(os.environ.get("EVIDRA_MODAL_STATE_VOLUME", "evidra-controller-state"), create_if_missing=True)
CODEX_SECRET_NAME = os.environ.get("EVIDRA_MODAL_CODEX_SECRET")


def include_workspace_path(path: str) -> bool:
    excluded = {".git", ".sota", "node_modules", ".venv", "__pycache__", ".mypy_cache"}
    return not any(part in excluded for part in Path(path).parts)


def ignore_workspace_path(path: Path) -> bool:
    return not include_workspace_path(str(path))


image = (
    modal.Image.from_registry("node:22-bookworm")
    .apt_install("python3", "python3-pip")
    .pip_install("uv")
    .add_local_dir(WORKSPACE, remote_path=str(REMOTE_WORKSPACE), ignore=ignore_workspace_path)
)
app = modal.App("evidra-controller")
secrets = [modal.Secret.from_name(CODEX_SECRET_NAME)] if CODEX_SECRET_NAME else []


@app.function(image=image, secrets=secrets, volumes={"/state": STATE_VOLUME}, timeout=24 * 60 * 60)
def execute(goal: str, budget: str, provider: str = "codex", model: str = "default", lanes: int = 3) -> int:
    environment = {
        **os.environ,
        "EVIDRA_STATE_DIR": "/state",
        "EVIDRA_CONTROLLER_MODE": "modal",
    }
    install = subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=REMOTE_WORKSPACE, env=environment, text=True, check=False)
    if install.returncode != 0:
        return install.returncode
    build = subprocess.run(["npm", "run", "build"], cwd=REMOTE_WORKSPACE, env=environment, text=True, check=False)
    if build.returncode != 0:
        return build.returncode
    command = [
        "node", "dist/cli.js", "research",
        "--goal", goal,
        "--budget", budget,
        "--provider", provider,
        "--model", model,
        "--lanes", str(max(1, min(lanes, 6))),
        "--limit-policy", "wait",
    ]
    process = subprocess.Popen(command, cwd=REMOTE_WORKSPACE, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
    return process.wait()


@app.local_entrypoint()
def run(goal: str, budget: str = "4h", provider: str = "codex", model: str = "default", lanes: int = 3) -> None:
    raise SystemExit(execute.remote(goal, budget, provider, model, lanes))
