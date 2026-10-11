"""Generic Evidra experiment worker for Modal.

The local Evidra controller supplies an argv command and a workspace-relative
working directory. Modal owns the compute container; no agent credentials or
SQLite state are mounted into the worker.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import base64
import selectors
import codecs
import signal
import time
import stat
from contextlib import ExitStack
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
MAX_CONFIG_BYTES = 1024 * 1024
MAX_CAPTURE_BYTES = 16 * 1024 * 1024
STREAM_CHUNK_BYTES = 64 * 1024
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024
# The controller retains an approximately 8 MiB output tail after truncation.
MAX_ENVELOPE_BYTES = 7 * 1024 * 1024


def read_worker_artifact(root: Path, name: str, remaining_bytes: int | None = None) -> bytes | None:
    """Read a bounded, stable regular file through workspace-relative handles."""
    path = Path(name)
    limit = MAX_ARTIFACT_BYTES if remaining_bytes is None else min(MAX_ARTIFACT_BYTES, remaining_bytes)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Invalid declared artifact path: {name}")
    with ExitStack() as handles:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.callback(os.close, directory)
        try:
            for part in path.parts[:-1]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                handles.callback(os.close, directory)
            descriptor = os.open(path.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        handles.callback(os.close, descriptor)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"Declared artifact must be a regular file: {name}")
        if before.st_size > limit:
            return None
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(descriptor, min(STREAM_CHUNK_BYTES, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        if len(data) > limit:
            return None
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != after.st_size:
            raise ValueError(f"Declared artifact changed during capture: {name}")
        return bytes(data)


def completion_envelope(result: dict[str, object]) -> str:
    """Keep terminal evidence inside the controller's retained output tail."""
    pieces: list[str] = []
    size = 0
    for piece in json.JSONEncoder(ensure_ascii=True).iterencode(result):
        size += len(piece)
        if size > MAX_ENVELOPE_BYTES:
            return json.dumps({
                "exitCode": 65,
                "stdout": "",
                "stderr": "Modal worker completed, but its inline result exceeded the transport budget; metrics and artifacts were discarded. Large-artifact transport is required.",
                "artifacts": {},
            })
        pieces.append(piece)
    return "".join(pieces)


def worker_environment() -> dict[str, str]:
    """Return runtime-only environment; never forward Modal/controller secrets."""
    safe: dict[str, str] = {}
    for key, value in os.environ.items():
        if SECRET_ENV.search(key):
            continue
        if (key in WORKER_ENV_KEYS or key.startswith(("LC_", "PYTHON", "CONDA_", "CUDA_", "NVIDIA_", "OMP_", "MKL_"))):
            safe[key] = value
    return safe


def experiment_environment(root: Path, expected_digest: str) -> dict[str, str]:
    """Validate a bounded snapshot before making any metadata visible to code."""
    if not isinstance(expected_digest, str) or expected_digest and not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise ValueError("Invalid config digest")
    config_path = root / ".sota" / "experiment-config.json"
    data = read_worker_artifact(root, ".sota/experiment-config.json", MAX_CONFIG_BYTES)
    if data is None:
        if expected_digest or os.path.lexists(config_path):
            raise ValueError("Missing or oversized config")
        return {}
    digest = hashlib.sha256(data).hexdigest()
    if expected_digest and digest != expected_digest:
        raise ValueError("Config snapshot differs from prepared contract")
    config = json.loads(data)
    if not isinstance(config, dict) or type(config.get("schemaVersion")) is not int or config["schemaVersion"] != 1:
        raise ValueError("Unsupported config schema")
    for field in ("experimentId", "datasetVersion", "splitVersion"):
        if not isinstance(config.get(field), str) or not config[field] or "\0" in config[field]:
            raise ValueError("Invalid experiment metadata")
    evaluation = config.get("evaluation")
    if not isinstance(evaluation, dict) or type(evaluation.get("matrixRequired")) is not bool:
        raise ValueError("Invalid evaluation contract")
    for field in ("folds", "seeds"):
        values = evaluation.get(field)
        if not isinstance(values, list) or not values or any(type(value) is not int or field == "folds" and value < 0 for value in values):
            raise ValueError("Invalid evaluation matrix")
    resources = config.get("resources")
    if not isinstance(resources, dict):
        raise ValueError("Invalid resource contract")
    declared = resources.get("environment", {})
    if not isinstance(declared, dict):
        raise ValueError("Invalid declared environment")
    environment: dict[str, str] = {}
    for key, value in declared.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\0" in value:
            raise ValueError("Invalid declared environment")
        if not SECRET_ENV.search(key):
            environment[key] = value
    environment.update({
        "EVIDRA_EXPERIMENT_CONFIG": str(config_path),
        "EVIDRA_EXPERIMENT_CONFIG_SHA256": digest,
        "EVIDRA_EXPERIMENT_ID": config["experimentId"],
        "EVIDRA_DATASET_VERSION": config["datasetVersion"],
        "EVIDRA_SPLIT_VERSION": config["splitVersion"],
        "EVIDRA_MATRIX_REQUIRED": "1" if evaluation["matrixRequired"] else "0",
    })
    return environment


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
def execute(command_json: str, cwd: str, artifacts_json: str = "[]", timeout_seconds: int = 3600, config_sha256: str = "") -> dict[str, object]:
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or timeout_seconds <= 0:
        raise ValueError("Evidra Modal timeout must be a positive integer")
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
    try:
        environment.update(experiment_environment(REMOTE_WORKSPACE, config_sha256))
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        return {"exitCode": 65, "stdout": "", "stderr": "Modal experiment configuration is missing, invalid, or differs from the prepared contract; no experiment command was started.", "artifacts": {}}
    # Declared environment cannot override the private worker home.
    environment["HOME"] = "/tmp/evidra-worker-home"
    # Stream worker output for long GPU jobs while retaining a bounded copy for
    # the controller's structured RunResult. Buffering the whole subprocess
    # made Modal experiments appear hung and could grow memory without bound.
    process = subprocess.Popen(command, cwd=working_directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, start_new_session=True)
    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    capture_truncated = False
    decoders = {stream: codecs.getincrementaldecoder("utf-8")(errors="replace") for stream in captured}
    deadline = time.monotonic() + timeout_seconds
    try:
        while selector.get_map() or process.poll() is None:
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise TimeoutError("Evidra Modal worker exceeded its subprocess deadline; remote completion remains unconfirmed")
            for key, _ in selector.select(timeout=min(0.1, remaining_seconds)):
                # Read available bytes, never wait for a newline while the other
                # pipe fills. Each allocation is bounded even for enormous lines.
                chunk = os.read(key.fileobj.fileno(), STREAM_CHUNK_BYTES)
                stream = key.data
                text = decoders[stream].decode(chunk, final=not chunk)
                if text:
                    # Frame progress separately so unterminated worker output
                    # cannot swallow the final JSON completion envelope.
                    print(f"[evidra-worker:{stream}] {text}", flush=True)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                remaining = MAX_CAPTURE_BYTES - len(captured[stream])
                if len(chunk) > remaining:
                    capture_truncated = True
                if remaining > 0:
                    captured[stream].extend(chunk[:remaining])
    finally:
        # Also terminate children after the leader exits; cleanup is scoped to
        # this invocation's new session, never the Modal runtime's process group.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        selector.close()
        process.stdout.close()
        process.stderr.close()
        process.wait(timeout=5)
    if capture_truncated:
        return {"exitCode": 65, "stdout": "", "stderr": f"Modal worker completed with exit {process.returncode}, but output exceeded the capture budget; incomplete metrics and artifacts were discarded.", "artifacts": {}}
    completed_stdout = captured["stdout"].decode("utf-8", errors="replace")
    completed_stderr = captured["stderr"].decode("utf-8", errors="replace")
    artifact_payload: dict[str, str] = {}
    captured_artifact_bytes = 0
    for artifact in json.loads(artifacts_json):
        data = read_worker_artifact(working_directory, artifact, MAX_ARTIFACT_TOTAL_BYTES - captured_artifact_bytes)
        if data is not None:
            captured_artifact_bytes += len(data)
            artifact_payload[str(Path(artifact))] = base64.b64encode(data).decode("ascii")
        elif (working_directory / artifact).exists():
            return {"exitCode": 65, "stdout": "", "stderr": "Modal worker completed, but declared artifacts exceeded the capture budget; metrics and artifacts were discarded.", "artifacts": {}}
    return json.loads(completion_envelope({
        # Match the controller's portable 0..255 process-exit contract.
        "exitCode": process.returncode if process.returncode >= 0 else 128 - process.returncode,
        "stdout": completed_stdout,
        "stderr": completed_stderr,
        "artifacts": artifact_payload,
    }))


@app.local_entrypoint()
def run(command_json: str, cwd: str = ".", artifacts_json: str = "[]", timeout_seconds: int = 3600, submission_id: str = "", config_sha256: str = "") -> None:
    call = execute.spawn(command_json, cwd, artifacts_json, timeout_seconds, config_sha256)
    print("[evidra-call] " + json.dumps({"submissionId": submission_id, "callId": call.object_id}), flush=True)
    result = call.get()
    print(completion_envelope(result))
    # Returning an envelope completes the runtime-client contract. Worker
    # failure is represented inside it; RPC/client errors must still propagate.
