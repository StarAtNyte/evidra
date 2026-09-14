"""Generic Evidra experiment worker for Modal.

The local Evidra controller supplies an argv command and a workspace-relative
working directory. Modal owns the compute container; no agent credentials or
SQLite state are mounted into the worker.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import base64
from pathlib import Path

import modal

WORKSPACE = Path(os.environ.get("EVIDRA_MODAL_WORKSPACE", ".")).resolve()
REMOTE_WORKSPACE = Path("/workspace")
GPU = os.environ.get("EVIDRA_MODAL_GPU") or None
SECRET_ENV = re.compile(r"(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PASS|API[_-]?KEY)", re.IGNORECASE)
WORKER_ENV_KEYS = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "PWD",
    "LANG", "LANGUAGE", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
    "CUDA_HOME", "CUDA_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES",
    "NVIDIA_DRIVER_CAPABILITIES", "LD_LIBRARY_PATH", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
}


def worker_environment() -> dict[str, str]:
    """Return runtime-only environment; never forward Modal/controller secrets."""
    safe: dict[str, str] = {}
    for key, value in os.environ.items():
        if SECRET_ENV.search(key):
            continue
        if (key in WORKER_ENV_KEYS or key.startswith(("LC_", "PYTHON", "CONDA_", "CUDA_", "NVIDIA_", "OMP_", "MKL_"))):
            safe[key] = value
    return safe


def contained_path(root: Path, candidate: Path) -> Path:
    """Resolve a worker path and require it to remain under the mounted root."""
    resolved_root = root.resolve()
    resolved_candidate = candidate.resolve()
    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"Path escapes the mounted workspace: {candidate}") from error
    return resolved_candidate


def include_workspace_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lstrip("./")
    # Controller state is excluded, but the isolated worker config is part of
    # the experiment contract and is safe to copy into the remote workspace.
    if normalized.endswith("/.sota/experiment-config.json") or normalized == ".sota/experiment-config.json":
        return True
    excluded = {".git", ".sota", "node_modules", ".venv", "__pycache__", ".mypy_cache"}
    return not any(part in excluded for part in Path(normalized).parts)


def ignore_workspace_path(path: Path) -> bool:
    return not include_workspace_path(str(path))


image = modal.Image.debian_slim(python_version="3.11").pip_install("uv").add_local_dir(WORKSPACE, remote_path=str(REMOTE_WORKSPACE), ignore=ignore_workspace_path)
app = modal.App("evidra-experiment")


@app.function(
    image=image,
    gpu=GPU,
    timeout=int(os.environ.get("EVIDRA_MODAL_TIMEOUT_SECONDS", "3600")),
)
def execute(command_json: str, cwd: str, artifacts_json: str = "[]") -> dict[str, object]:
    command = json.loads(command_json)
    if not isinstance(command, list) or not command or not all(isinstance(value, str) for value in command):
        raise ValueError("Evidra Modal command must be a non-empty argv array")
    relative_cwd = Path(cwd)
    if relative_cwd.is_absolute() or ".." in relative_cwd.parts:
        raise ValueError("Evidra Modal working directory must stay inside the mounted workspace")
    working_directory = contained_path(REMOTE_WORKSPACE, REMOTE_WORKSPACE / relative_cwd)
    if not working_directory.is_dir():
        raise FileNotFoundError(f"Modal working directory does not exist: {working_directory}")
    environment = worker_environment()
    # Never expose the image's default home (or a controller-provided home) to
    # model-supplied experiment code; /tmp is an ephemeral Modal filesystem.
    environment["HOME"] = "/tmp/evidra-worker-home"
    Path(environment["HOME"]).mkdir(parents=True, exist_ok=True)
    config_path = REMOTE_WORKSPACE / ".sota" / "experiment-config.json"
    if config_path.is_file():
        environment["EVIDRA_EXPERIMENT_CONFIG"] = str(config_path)
        try:
            config = json.loads(config_path.read_text())
            environment["EVIDRA_EXPERIMENT_ID"] = str(config["experimentId"])
            environment["EVIDRA_DATASET_VERSION"] = str(config["datasetVersion"])
            environment["EVIDRA_SPLIT_VERSION"] = str(config["splitVersion"])
            environment["EVIDRA_MATRIX_REQUIRED"] = "1" if config.get("evaluation", {}).get("matrixRequired") else "0"
        except (OSError, ValueError, KeyError, TypeError):
            pass
    completed = subprocess.run(command, cwd=working_directory, capture_output=True, text=True, check=False, env=environment)
    artifact_payload: dict[str, str] = {}
    for artifact in json.loads(artifacts_json):
        relative_artifact = Path(artifact)
        if relative_artifact.is_absolute() or ".." in relative_artifact.parts:
            raise ValueError(f"Invalid declared artifact path: {artifact}")
        raw_artifact_path = working_directory / relative_artifact
        if raw_artifact_path.is_symlink():
            raise ValueError(f"Declared artifact may not be a symlink: {artifact}")
        artifact_path = contained_path(working_directory, raw_artifact_path)
        if artifact_path.is_file() and artifact_path.stat().st_size <= 64 * 1024 * 1024:
            artifact_payload[str(relative_artifact)] = base64.b64encode(artifact_path.read_bytes()).decode("ascii")
    return {
        "exitCode": completed.returncode,
        "stdout": completed.stdout[-16 * 1024 * 1024 :],
        "stderr": completed.stderr[-16 * 1024 * 1024 :],
        "artifacts": artifact_payload,
    }


@app.local_entrypoint()
def run(command_json: str, cwd: str = ".", artifacts_json: str = "[]", timeout_seconds: int = 3600) -> None:
    # timeout_seconds is included in the CLI contract for observability; the
    # function timeout is set when the app module is loaded.
    del timeout_seconds
    result = execute.remote(command_json, cwd, artifacts_json)
    print(json.dumps(result))
    raise SystemExit(int(result["exitCode"]))
