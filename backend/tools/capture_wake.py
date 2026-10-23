"""Prepare or record a real host sleep/wake. This script never sleeps or powers off the machine.

--prepare writes the scenario and stays not_accepted.
--record reads `pmset -g log` and accepts only a Sleep followed by a Wake after the prepare timestamp.
SIGSTOP, VM force-stop, and a missing log stay not_accepted.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path


def write(path: Path, body: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--record", action="store_true")
    parser.add_argument("--marker", type=Path)
    args = parser.parse_args()
    if args.prepare == args.record:
        parser.error("choose one of --prepare or --record")
    marker = args.marker or args.output.with_suffix(".marker.json")
    if args.prepare:
        body = {
            "status": "not_accepted",
            "prepared_at": time.time(),
            "proves": None,
            "does_not_prove": ["SIGSTOP/SIGCONT", "VM force-stop", "power loss", "filesystem ENOSPC"],
            "scenario": [
                "用已打开的 AmazMe profile 跑一个 faux 会话，确认快照 seq。",
                "用户自行让 Mac 睡眠并唤醒。本脚本不会调用 sleep、shutdown 或 pmset sleep。",
                "唤醒后执行 capture_wake.py --record --marker <本文件> --output <报告>。",
                "通过条件：pmset 日志在 prepared_at 之后有 Sleep 和 Wake，且原 profile 的已接纳请求仍在、没有被静默清空。",
            ],
        }
        write(marker, body)
        write(args.output, body)
        return
    if not marker.is_file():
        write(args.output, {"status": "not_accepted", "error": "missing prepare marker"})
        return
    prepared = json.loads(marker.read_text())
    started = float(prepared["prepared_at"])
    log = subprocess.run(["pmset", "-g", "log"], text=True, capture_output=True)
    if log.returncode != 0:
        write(args.output, {"status": "not_accepted", "error": log.stderr.strip() or "pmset failed"})
        return
    # pmset prints timestamps like "2026-10-23 21:04:11 +0800". Keep lines after the marker.
    sleep_at = wake_at = ""
    for line in log.stdout.splitlines():
        if " Sleep " not in line and " Wake " not in line:
            continue
        stamp = line[:19]
        try:
            parsed = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
        if parsed < started:
            continue
        if " Sleep " in line and not sleep_at:
            sleep_at = stamp
        elif " Wake " in line and sleep_at and not wake_at:
            wake_at = stamp
    accepted = bool(sleep_at and wake_at)
    write(args.output, {
        "status": "needs_profile_reopen" if accepted else "not_accepted",
        "proves": "pmset recorded Sleep then Wake after the marker" if accepted else None,
        "does_not_prove": ["power loss", "filesystem ENOSPC", "SIGSTOP/SIGCONT", "profile durability until reopened"],
        "sleep_at": sleep_at,
        "wake_at": wake_at,
        "note": "日志里的睡眠不等于 profile 已复核。还要用原 profile 打开并核对接纳请求未被清空。",
    })


if __name__ == "__main__":
    main()
