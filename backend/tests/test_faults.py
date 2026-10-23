import asyncio
import json
import os

import pytest

from amazme_backend.faults import Faults


@pytest.mark.asyncio
async def test_fault_requires_explicit_profile_opt_in_and_exact_match(tmp_path):
    disabled = Faults(tmp_path, "worker", "one")
    await disabled.hit("accepted", request_id="request")
    assert not (tmp_path / "faults").exists()
    faults = Faults(tmp_path, "worker", "one", enabled=True)
    nonce = "a" * 16
    control = faults.root / "worker.accepted.json"
    control.write_text(json.dumps({"nonce": nonce, "match": {"request_id": "request"}}))
    await faults.hit("accepted", request_id="different")
    assert control.exists()
    task = asyncio.create_task(faults.hit("accepted", request_id="request"))
    try:
        reached = faults.root / f"{nonce}.reached.json"
        async with asyncio.timeout(2):
            while not reached.exists():
                await asyncio.sleep(0.01)
        value = json.loads(reached.read_text())
        assert value["instance"] == "one" and value["pid"] == os.getpid()
        assert not task.done()
        assert not control.exists()
        # A restarted actor cannot hit the already consumed point again.
        await Faults(tmp_path, "worker", "two", enabled=True).hit("accepted", request_id="request")
    finally:
        (faults.root / f"{nonce}.release").touch()
        await task


async def test_real_worker_sql_transaction_kill_rolls_back_acceptance(tmp_path):
    import sqlite3
    import subprocess
    import sys
    import time

    import pytest

    from amazme_backend.contracts import BackendError, HostFence, Submit
    from amazme_backend.storage import SessionStore

    faults = tmp_path / "faults"
    faults.mkdir()
    (faults / "worker.before_commit.json").write_text(
        '{"nonce":"aaaaaaaaaaaaaaaa","match":{"request_id":"commit-crash"}}')
    script = '''import asyncio,sys
from pathlib import Path
from amazme_backend.storage import SessionStore
from amazme_backend.faults import Faults
from amazme_backend.contracts import HostFence,Submit
async def run():
 p=Path(sys.argv[1])
 store=SessionStore(p/'session.sqlite','s',build='build',faults=Faults(p,'worker','sql-test',enabled=True))
 await store.initialize()
 await store.accept(Submit(request_id='commit-crash',text='one'),HostFence(host_epoch=0,build_id='build'))
 await store.db.close()
asyncio.run(run())
'''
    child = subprocess.Popen([sys.executable, "-c", script, str(tmp_path)])
    try:
        deadline = time.monotonic() + 10
        while not (faults / "aaaaaaaaaaaaaaaa.reached.json").exists():
            assert child.poll() is None
            assert time.monotonic() < deadline
            await asyncio.sleep(0.02)
        with sqlite3.connect(tmp_path / "session.sqlite") as db:
            assert db.execute("SELECT count(*) FROM requests").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM batches").fetchone()[0] == 0
        child.kill()
        child.wait(timeout=5)
        store = SessionStore(tmp_path / "session.sqlite", "s", build="build", require_existing=True)
        try:
            await store.initialize()
            with pytest.raises(BackendError, match="request_not_found"):
                await store.get("commit-crash")
            receipt = await store.accept(Submit(request_id="commit-crash", text="one"), HostFence(host_epoch=0, build_id="build"))
            assert receipt.accepted_revision == "1"
            replay = await store.events(0)
            assert len(replay.batches) == 1
            assert [event.kind for event in replay.batches[0].events] == ["accepted"]
        finally:
            await store.db.close()
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
