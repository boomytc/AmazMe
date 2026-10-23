"""Fixed desktop driver protocol. It never receives a shell command."""

import json
import sys
import time
from pathlib import Path
from typing import cast

DISPLAYS = {
    "unconfigured": (False, False, 0, 0, 1, 1),
    "denied": (True, False, 0, 0, 1, 1),
    "granted": (True, True, 20, 10, 6, 2),
    "plain": (True, True, 8, 6, 1, 2),
    "hold": (True, True, 20, 10, 6, 2),
    "drop": (True, True, 20, 10, 6, 2),
}


def reply(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def as_record(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    return {str(key): item for key, item in cast(dict[object, object], value).items()}


def main() -> None:
    permit = as_record(json.loads(sys.stdin.readline() or "{}"))
    scenario = permit.get("scenario") if permit is not None else None
    if not isinstance(scenario, str) or scenario not in DISPLAYS:
        sys.exit(2)
    accessibility, screen, raw_width, raw_height, orientation, scale = DISPLAYS[scenario]
    reply({
        "op": "ready", "accessibility": accessibility, "screen": screen, "identity": "fixed-computer-driver",
        "raw_width": raw_width, "raw_height": raw_height, "orientation": orientation, "scale": scale,
    })
    current = ""
    record = Path("computer-actions.jsonl")
    for line in sys.stdin:
        message = as_record(json.loads(line))
        if message is None:
            sys.exit(2)
        op = message.get("op")
        if op == "stop":
            sys.exit(0)
        if op == "observe":
            capture = message.get("capture_id")
            if not isinstance(capture, str) or not capture:
                sys.exit(2)
            current = capture
            reply({"op": "capture", "capture_id": current})
            continue
        if op != "act":
            sys.exit(2)
        if scenario == "drop":
            sys.stdout.close()
            sys.exit(7)
        capture = message.get("capture_id")
        if capture != current:
            reply({"op": "rejected", "reason": "stale"})
            continue
        if scenario == "hold":
            time.sleep(0.25)
        point: dict[str, object] = {"op": "act", "capture_id": current, "x": message.get("x"), "y": message.get("y")}
        with record.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(point, separators=(",", ":")) + "\n")
        reply({"op": "acted", "x": point["x"], "y": point["y"]})


if __name__ == "__main__":
    main()
