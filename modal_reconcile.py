"""Inspect a recorded Modal call and optionally stop its uniquely owned app."""

import argparse
import inspect
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
    if not {"restrict_modal_access", "single_use_containers"}.issubset(inspect.signature(modal.App.function).parameters):
        raise RuntimeError("Modal SDK lacks required worker isolation options")
    api_pb2.FunctionCallFromIdRequest(function_call_id="fc-runtimecheck")
    api_pb2.AppListRequest(environment_name="")
    if not isinstance(api_pb2.APP_STATE_STOPPED, int):
        raise RuntimeError("Unsupported Modal allocation state schema")
    return {"ready": True, "modalVersion": modal.__version__}


def credentials_configured() -> bool:
    # Match SDK configuration rules without contacting the service or exposing
    # credential values. Configuration is not proof of valid authentication.
    from modal.config import config
    token = [config.get("token_id"), config.get("token_secret")]
    oauth = [config.get("oauth_refresh_token"), config.get("oauth_client_id"), config.get("oauth_client_secret")]
    return bool(all(token) and not any(oauth) or all(oauth) and not any(token))


async def inspect_allocation(call_id: str, wait_stopped_seconds: int = 0, stop_app_id: str | None = None, expected_app_name: str | None = None) -> dict[str, object]:
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
    stop_sent = False
    deadline = time.monotonic() + wait_stopped_seconds
    while True:
        response = await client._stub.AppList(api_pb2.AppListRequest(environment_name=_get_environment_name(None)))
        matches = [app for app in response.apps if app.app_id == app_id]
        if len(matches) != 1:
            raise ValueError("Modal application is missing or ambiguous")
        app = matches[0]
        if stop_app_id is not None:
            if app_id != stop_app_id or app.description != expected_app_name or metadata.num_inputs != 1:
                raise ValueError("Modal app ownership does not match the recorded execution")
            if app.state not in (api_pb2.APP_STATE_EPHEMERAL, api_pb2.APP_STATE_STOPPING, api_pb2.APP_STATE_STOPPED):
                raise ValueError("Only an owned ephemeral Modal app may be stopped")
            if not stop_sent and app.state == api_pb2.APP_STATE_EPHEMERAL:
                await client._stub.AppStop(api_pb2.AppStopRequest(app_id=app_id, source=api_pb2.APP_STOP_SOURCE_CLI))
                stop_sent = True
                continue
        stopped = app.state == api_pb2.APP_STATE_STOPPED
        if (stopped and app.n_running_tasks == 0) or time.monotonic() >= deadline:
            return {"appId": app_id, "appState": "STOPPED" if stopped else "ACTIVE", "runningTasks": app.n_running_tasks}
        await asyncio.sleep(min(0.5, max(0, deadline - time.monotonic())))


def inspect_call(call_id: str, wait_stopped_seconds: int = 0, stop_app_id: str | None = None, expected_app_name: str | None = None) -> dict[str, object]:
    if type(wait_stopped_seconds) is not int or not 0 <= wait_stopped_seconds <= 10:
        raise ValueError("Invalid Modal allocation verification wait")
    if not re.fullmatch(r"fc-[A-Za-z0-9]{1,128}", call_id):
        raise ValueError("Invalid Modal call ID")
    import modal
    from modal._utils.async_utils import synchronizer

    if stop_app_id is not None and (not re.fullmatch(r"ap-[A-Za-z0-9]{1,128}", stop_app_id) or not isinstance(expected_app_name, str) or not re.fullmatch(r"evidra-[a-f0-9-]{36}", expected_app_name)):
        raise ValueError("Invalid Modal cancellation identity")
    allocation = synchronizer.create_blocking(inspect_allocation)(call_id, wait_stopped_seconds, stop_app_id, expected_app_name)
    stopped = allocation["appState"] == "STOPPED" and type(allocation["runningTasks"]) is int and allocation["runningTasks"] == 0
    allocation_only = {"callId": call_id, "state": "ALLOCATION_STOPPED", "exitCode": 125, **allocation}
    try:
        call = modal.FunctionCall.from_id(call_id)
        result = call.get(timeout=0)
    except BaseException as error:
        # Keyboard/process interruption is never remote termination evidence.
        if isinstance(error, (KeyboardInterrupt, SystemExit, GeneratorExit, asyncio.CancelledError)):
            raise
        if stopped:
            return allocation_only
        if isinstance(error, TimeoutError):
            return {"callId": call_id, "state": "PENDING", **allocation}
        raise
    if (not isinstance(result, dict)
            or type(result.get("exitCode")) is not int
            or not 0 <= result["exitCode"] <= 255
            or not isinstance(result.get("stdout"), str)
            or not isinstance(result.get("stderr"), str)
            or not isinstance(result.get("artifacts"), dict)
            or not all(isinstance(key, str) and isinstance(value, str) for key, value in result["artifacts"].items())):
        if stopped:
            return allocation_only
        raise ValueError("Modal call returned malformed worker completion evidence")
    return {"callId": call_id, "state": "COMPLETED", "exitCode": result["exitCode"], **allocation}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("call_id", nargs="?")
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--check-credentials", action="store_true")
    parser.add_argument("--wait-stopped-seconds", type=int, choices=range(11), default=0)
    parser.add_argument("--stop-owned-app")
    parser.add_argument("--expected-app-name")
    args = parser.parse_args()
    if args.check_runtime:
        capability = check_runtime()
        if args.check_credentials:
            capability["credentialsConfigured"] = credentials_configured()
        print(json.dumps(capability))
    elif args.call_id is None:
        parser.error("call_id is required")
    else:
        print(json.dumps(inspect_call(args.call_id, args.wait_stopped_seconds, args.stop_owned_app, args.expected_app_name)))
