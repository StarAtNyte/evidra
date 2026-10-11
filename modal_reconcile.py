"""Read-only recovery of a recorded Evidra Modal call; never launch new work."""

import json
import re
import sys


def inspect_call(call_id: str) -> dict[str, object]:
    if not re.fullmatch(r"fc-[A-Za-z0-9]{1,128}", call_id):
        raise ValueError("Invalid Modal call ID")
    import modal

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
    return {"callId": call_id, "state": "COMPLETED", "exitCode": result["exitCode"]}


if __name__ == "__main__":
    print(json.dumps(inspect_call(sys.argv[1])))
