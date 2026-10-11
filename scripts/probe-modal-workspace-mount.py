"""Enumerate a disposable workspace with the installed Modal SDK, without RPCs.

Run with a Python environment containing Modal. This intentionally exercises
the SDK's private local enumerator; API changes should fail the probe explicitly.
"""

import ast
import hashlib
import json
import os
import platform
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import modal
from modal.mount import _MountDir


source = Path(__file__).resolve().parents[1] / "modal_app.py"
source_bytes = source.read_bytes()
policy = ast.Module(
    body=[node for node in ast.parse(source_bytes).body
          if isinstance(node, ast.FunctionDef)
          and node.name in {"include_workspace_path", "ignore_workspace_path"}],
    type_ignores=[],
)

with tempfile.TemporaryDirectory(prefix="evidra-modal-mount-probe-") as temporary:
    root = Path(temporary) / ".sota" / "worktrees" / "experiment"
    root.mkdir(parents=True)
    allowed = {"train.py", "src/.hidden/module.py", ".sota/experiment-config.json"}
    rejected = {
        ".git/config", ".sota/controller.sqlite", ".sota/worker-home/.credentials",
        ".venv/bin/python", "node_modules/package/index.js", "__pycache__/cache.pyc",
        ".mypy_cache/cache.json", "src/.sota/experiment-config.json",
        ".git/.sota/experiment-config.json",
    }
    for name in allowed | rejected:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("disposable fixture\n")
    outside = Path(temporary) / "controller-secret"
    outside.write_text("disposable external fixture\n")
    for name, target in {
        "allowed-link.py": root / "train.py",
        "controller-link": root / ".sota/controller.sqlite",
        "git-link": root / ".git/config",
        "config-link": root / ".sota/experiment-config.json",
        "external-link": outside,
        "dangling-link": root / "missing",
    }.items():
        (root / name).symlink_to(target)
    os.mkfifo(root / "fifo")
    namespace = {"Path": Path, "WORKSPACE": root}
    exec(compile(policy, str(source), "exec"), namespace)
    entry = _MountDir(root, PurePosixPath("/workspace"), namespace["ignore_workspace_path"], recursive=True)
    selected = sorted(str(remote.relative_to("/workspace")) for _, remote in entry.get_files_to_upload())
    expected = sorted(allowed | {"allowed-link.py"})
    if selected != expected:
        raise RuntimeError(f"Unexpected Modal SDK upload manifest: {selected!r}; expected {expected!r}")
    config = root / ".sota/experiment-config.json"
    config.unlink()
    config.symlink_to(root / "train.py")
    after_alias = sorted(str(remote.relative_to("/workspace")) for _, remote in entry.get_files_to_upload())
    if after_alias != sorted((set(expected) - {".sota/experiment-config.json"}) | {"config-link"}):
        raise RuntimeError("Symlinked config was included by the Modal SDK enumerator")

print(json.dumps({
    "schemaVersion": 1,
    "at": datetime.now(timezone.utc).isoformat(),
    "modalVersion": modal.__version__,
    "pythonVersion": platform.python_version(),
    "workerSourceSha256": hashlib.sha256(source_bytes).hexdigest(),
    "sdkMountSourceSha256": hashlib.sha256(Path(__import__("modal.mount", fromlist=["__file__"]).__file__).read_bytes()).hexdigest(),
    "includedPaths": selected,
    "symlinkedConfigRejected": True,
    "fixtureRootInsideControllerState": True,
    "remoteCalls": 0,
    "scope": "Local upload enumeration; remote mounting, authentication, cancellation, and live worker execution are unverified.",
}, indent=2))
