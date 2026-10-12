"""Check actual SDK registration and subprocess environment filtering, without RPCs."""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import modal
from modal._utils.async_utils import synchronizer

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / 'modal_app.py'
with tempfile.TemporaryDirectory(prefix='evidra-modal-isolation-') as workspace:
    with patch.dict(os.environ, {'EVIDRA_MODAL_WORKSPACE': workspace,
                                 'EVIDRA_MODAL_SUBMISSION_ID': 'offline-isolation-probe'}, clear=True):
        spec = importlib.util.spec_from_file_location('evidra_isolation_probe', source)
        worker = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = worker
        spec.loader.exec_module(worker)
    # SDK internals intentionally fail visibly if registration metadata changes.
    info = synchronizer._translate_in(worker.execute)._function_info
    assert info.restrict_modal_access is True
    assert info.single_use_containers is True
    assert info.block_network is False
    assert info.secrets == []
    assert info.gpus == []
    fixtures = {
        'PATH': '/usr/bin', 'LANG': 'C.UTF-8', 'CUDA_VISIBLE_DEVICES': '0',
        'MODAL_TOKEN_ID': 'sentinel', 'MODAL_TOKEN_SECRET': 'sentinel',
        'MODAL_TASK_ID': 'sentinel', 'MODAL_SERVER_URL': 'sentinel',
        'AWS_ACCESS_KEY_ID': 'sentinel', 'PYTHON_API_KEY': 'sentinel',
        'CUDA_AUTH_TOKEN': 'sentinel', 'CONDA_PASSWORD': 'sentinel',
        'UNDECLARED_CONTROLLER_VALUE': 'sentinel',
    }
    with patch.dict(os.environ, fixtures, clear=True):
        environment = worker.worker_environment()
    assert environment == {key: fixtures[key] for key in ('PATH', 'LANG', 'CUDA_VISIBLE_DEVICES')}
    print(json.dumps({
        'at': datetime.now(timezone.utc).isoformat(), 'modalVersion': modal.__version__,
        'workerSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'rpcPerformed': False, 'restrictModalAccess': info.restrict_modal_access,
        'singleUseContainers': info.single_use_containers, 'blockNetwork': info.block_network,
        'attachedSecrets': len(info.secrets), 'gpuRequested': bool(info.gpus),
        'environmentFilterPassed': True,
        'scope': 'Actual SDK registration and local environment filtering only. Does not prove server enforcement, subprocess credential recovery resistance, or network isolation.',
    }, indent=2))
