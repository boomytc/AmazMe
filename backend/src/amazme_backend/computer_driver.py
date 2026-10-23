"""Fixed desktop driver protocol. It never receives a shell command."""

import json
import sys
import time
from pathlib import Path

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


def main() -> None:
    permit = json.loads(sys.stdin.readline() or "{}")
    scenario = permit.get("scenario") if isinstance(permit, dict) else None
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
        message = json.loads(line)
        if not isinstance(message, dict):
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
        point = {"op": "act", "capture_id": current, "x": message.get("x"), "y": message.get("y")}
        with record.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(point, separators=(",", ":")) + "\n")
        reply({"op": "acted", "x": point["x"], "y": point["y"]})


if __name__ == "__main__":
    main()
