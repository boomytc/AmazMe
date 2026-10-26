"""Prove filesystem ENOSPC on a fixed-size image. Does not fill the system disk.

This is not SQLite max_page_count, VM force-stop, sleep, or power loss.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

from amazme_backend.contracts import BackendError, HostFence, Submit
from amazme_backend.sessions.store import SessionStore

FENCE = HostFence(host_epoch=1, build_id="test-build")
SESSION = "a" * 32


def command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True)


def write_report(path: Path, body: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n")


async def fill(database: Path, copy_dir: Path) -> dict[str, object]:
    store = SessionStore(database, SESSION, approval_policy="auto", instance="enospc")
    await store.initialize()
    await store.fence(FENCE)
    await store.accept(Submit(request_id="kept", text="original"), FENCE)
    limits = await store.db.call(lambda db: {
        "page_size": int(db.execute("PRAGMA page_size").fetchone()[0]),
        "page_count": int(db.execute("PRAGMA page_count").fetchone()[0]),
        "max_page_count": int(db.execute("PRAGMA max_page_count").fetchone()[0]),
    })
    if limits["max_page_count"] <= limits["page_count"] * 2:
        raise RuntimeError("max_page_count is already tight; this would not prove the filesystem")
    failure: BackendError | None = None
    accepted = 0
    failed_id = ""
    for index in range(4000):
        failed_id = f"fill-{index}"
        try:
            await store.accept(Submit(request_id=failed_id, text="x" * 16000), FENCE)
        except BackendError as error:
            failure = error
            break
        accepted += 1
    else:
        raise RuntimeError("volume accepted 4000 large receipts without returning a storage error")
    assert failure is not None
    await store.db.close()
    # Read the committed image onto the system disk. Reopening on the full volume can fail for lack of WAL space.
    copy = copy_dir / "session-copy.sqlite"
    shutil.copyfile(database, copy)
    wal = database.with_name(database.name + "-wal")
    if wal.exists():
        shutil.copyfile(wal, copy.with_name(copy.name + "-wal"))
    reopened = SessionStore(copy, SESSION, require_existing=True, approval_policy="auto")
    await reopened.initialize()
    try:
        restored = await reopened.snapshot()
        try:
            await reopened.get(failed_id)
            missing = False
        except BackendError as error:
            missing = error.code == "request_not_found"
        kept_ok = any(item.request_id == "kept" and item.text == "original" and item.status == "queued"
                      for item in restored.requests)
    finally:
        await reopened.db.close()
    return {
        "code": failure.code,
        "message": failure.message,
        "accepted_before_failure": accepted,
        "limits_before_fill": limits,
        "kept_receipt_survived": kept_ok,
        "uncommitted_request_absent": missing,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    work = args.output.parent / (args.output.stem + "-volume")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    image = work / "enospc.dmg"
    mount = work / "mnt"
    mount.mkdir()
    report: dict[str, object] = {
        "status": "blocked",
        "proves": None,
        "does_not_prove": ["sqlite max_page_count FULL", "vm force-stop", "host sleep", "power loss"],
        "image": str(image),
    }
    attached = False
    try:
        created = command(["hdiutil", "create", "-size", "2m", "-fs", "HFS+", "-volname", "amazme-enospc",
                           "-type", "UDIF", str(image)])
        if created.returncode != 0:
            report["error"] = created.stderr.strip() or created.stdout.strip()
            write_report(args.output, report)
            sys.exit(2)
        attached_result = command(["hdiutil", "attach", str(image), "-nobrowse", "-owners", "off",
                                   "-mountpoint", str(mount)])
        if attached_result.returncode != 0:
            report["error"] = attached_result.stderr.strip() or attached_result.stdout.strip()
            write_report(args.output, report)
            sys.exit(2)
        attached = True
        database = mount / "session.sqlite"
        if not database.resolve().is_relative_to(mount.resolve()):
            raise RuntimeError("database path escaped the image mount")
        usage_before = os.statvfs(mount)
        outcome = asyncio.run(fill(database, args.output.parent))
        usage_after = os.statvfs(mount)
        # Re-open only to record the cap was still above the file. The fill already checked it.
        probe = sqlite3.connect(database)
        try:
            max_pages = int(probe.execute("PRAGMA max_page_count").fetchone()[0])
            pages = int(probe.execute("PRAGMA page_count").fetchone()[0])
        finally:
            probe.close()
        proves_filesystem = (
            outcome["code"] == "storage_failure"
            and "full" in str(outcome["message"]).lower()
            and usage_after.f_bavail == 0
            and max_pages > pages
            and outcome["kept_receipt_survived"] is True
            and outcome["uncommitted_request_absent"] is True
        )
        report.update({
            "status": "passed" if proves_filesystem else "failed",
            "proves": "filesystem ENOSPC on an isolated 2MiB HFS+ image" if proves_filesystem else None,
            "blocks_available_before": usage_before.f_bavail,
            "blocks_available_after": usage_after.f_bavail,
            "max_page_count_after": max_pages,
            "page_count_after": pages,
            **outcome,
        })
        write_report(args.output, report)
        sys.exit(0 if proves_filesystem else 1)
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        write_report(args.output, report)
        sys.exit(1)
    finally:
        if attached:
            command(["hdiutil", "detach", str(mount), "-force"])
        shutil.rmtree(work, ignore_errors=True)
        for name in ("session-copy.sqlite", "session-copy.sqlite-wal", "session-copy.sqlite-shm"):
            extra = args.output.parent / name
            if extra.exists():
                extra.unlink()


if __name__ == "__main__":
    main()
