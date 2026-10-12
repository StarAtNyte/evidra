"""Read-only recovery of a recorded Evidra Modal call; never launch new work."""

import argparse
import json
import re
import asyncio
import time


def check_runtime() -> dict[str, object]:
    import modal
    from modal.client import _Client
    from modal._object import _get_environment_name
    from modal._utils.async_utils import synchronizer
    from modal_proto import api_pb2
    if not callable(_Client.from_env) or not callable(_get_environment_name) or not callable(synchronizer.create_blocking) or not callable(modal.FunctionCall.from_id) or not callable(modal.FunctionCall.get):
        raise RuntimeError("Unsupported Modal allocation inspection runtime")
    api_pb2.FunctionCallFromIdRequest(function_call_id="fc-runtimecheck")
    api_pb2.AppListRequest(environment_name="")
    if not isinstance(api_pb2.APP_STATE_STOPPED, int):
        raise RuntimeError("Unsupported Modal allocation state schema")
    return {"ready": True, "modalVersion": modal.__version__}


async def inspect_allocation(call_id: str, wait_stopped_seconds: int = 0) -> dict[str, object]:
    # These are the same SDK RPCs used by `modal app list`. Missing/changed
    # SDK APIs fail closed; a completed call alone never proves quiescence.
    from modal.client import _Client
    from modal._object import _get_environment_name
    from modal_proto import api_pb2
    client = await _Client.from_env()
    metadata = await client._stub.FunctionCallFromId(api_pb2.FunctionCallFromIdRequest(function_call_id=call_id))
    if metadata.function_call_id != call_id:
        raise ValueError("Modal call metadata identity mismatch")
    app_id = metadata.metadata.app_id
    if not re.fullmatch(r"ap-[A-Za-z0-9]{1,128}", app_id):
        raise ValueError("Modal call has no valid application identity")
    deadline = time.monotonic() + wait_stopped_seconds
    while True:
        response = await client._stub.AppList(api_pb2.AppListRequest(environment_name=_get_environment_name(None)))
        matches = [app for app in response.apps if app.app_id == app_id]
        if len(matches) != 1:
            raise ValueError("Modal application is missing or ambiguous")
        app = matches[0]
        stopped = app.state == api_pb2.APP_STATE_STOPPED
        if (stopped and app.n_running_tasks == 0) or time.monotonic() >= deadline:
            return {"appId": app_id, "appState": "STOPPED" if stopped else "ACTIVE", "runningTasks": app.n_running_tasks}
        await asyncio.sleep(min(0.5, max(0, deadline - time.monotonic())))


def inspect_call(call_id: str, wait_stopped_seconds: int = 0) -> dict[str, object]:
    if type(wait_stopped_seconds) is not int or not 0 <= wait_stopped_seconds <= 10:
        raise ValueError("Invalid Modal allocation verification wait")
    if not re.fullmatch(r"fc-[A-Za-z0-9]{1,128}", call_id):
        raise ValueError("Invalid Modal call ID")
    import modal
    from modal._utils.async_utils import synchronizer

    call = modal.FunctionCall.from_id(call_id)
    try:
        result = call.get(timeout=0)
    except TimeoutError:
        return {"callId": call_id, "state": "PENDING"}
    if (not isinstance(result, dict)
            or type(result.get("exitCode")) is not int
            or not 0 <= result["exitCode"] <= 255
            or not isinstance(result.get("stdout"), str)
            or not isinstance(result.get("stderr"), str)
            or not isinstance(result.get("artifacts"), dict)
            or not all(isinstance(key, str) and isinstance(value, str) for key, value in result["artifacts"].items())):
        raise ValueError("Modal call returned malformed worker completion evidence")
    return {"callId": call_id, "state": "COMPLETED", "exitCode": result["exitCode"], **synchronizer.create_blocking(inspect_allocation)(call_id, wait_stopped_seconds)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("call_id", nargs="?")
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--wait-stopped-seconds", type=int, choices=range(11), default=0)
    args = parser.parse_args()
    if args.check_runtime:
        print(json.dumps(check_runtime()))
    elif args.call_id is None:
        parser.error("call_id is required")
    else:
        print(json.dumps(inspect_call(args.call_id, args.wait_stopped_seconds)))
