"""Run real processes, crash boundaries, HTTP/WS and a relocated frozen executable.

All writes and subprocesses are restricted to a newly created artifact directory.
The negative macOS test is a passing reproduction, not a passing cleanup guarantee.
"""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import platform
import secrets
import select
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from websockets.asyncio.client import connect

from proof_app import Store, Submission

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def line(process: subprocess.Popen, timeout=20):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError(f"process {process.pid} did not become ready")
    value = process.stdout.readline()
    if not value:
        raise RuntimeError(f"process {process.pid} exited before ready")
    return json.loads(value)


def stop(process: subprocess.Popen):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class Running:
    def __init__(self, command, root: Path, database: Path):
        self.token = secrets.token_hex(24)
        self.log = (root / f"server-{secrets.token_hex(4)}.log").open("w")
        # No developer Python, Node, PYTHONPATH or virtualenv in the child environment.
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(root),
            "TMPDIR": str(root),
            "AMAZME_PROOF_TOKEN": self.token,
        }
        self.process = subprocess.Popen(
            [*command, "serve", "--database", str(database)],
            cwd=root,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
        )
        try:
            self.ready = line(self.process)
            self.url = f"http://127.0.0.1:{self.ready['port']}"
            self.headers = {"Authorization": f"Bearer {self.token}"}
            self.client = httpx.Client(base_url=self.url, headers=self.headers, timeout=5, trust_env=False)
            for _ in range(100):
                try:
                    response = self.client.get("/bootstrap")
                    response.raise_for_status()
                    break
                except httpx.TransportError:
                    time.sleep(0.02)
            else:
                raise TimeoutError("HTTP not ready")
        except BaseException:
            stop(self.process)
            self.log.close()
            raise

    def close(self):
        self.client.close()
        stop(self.process)
        self.log.close()


async def websocket_check(server: Running):
    snapshot = server.client.get("/snapshot").json()
    # Commit deliberately between snapshot and subscription.
    response = server.client.post("/submissions", json={"request_id": "gap", "text": "between"})
    assert response.status_code == 202
    uri = server.url.replace("http:", "ws:") + "/events"
    async with connect(uri, additional_headers=server.headers, open_timeout=5) as ws:
        await ws.send(json.dumps({"after": snapshot["seq"]}))
        event = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert event["request_id"] == "gap"
        assert int(event["seq"]) == int(snapshot["seq"]) + 1
    async with connect(uri, additional_headers=server.headers, open_timeout=5) as ws:
        await ws.send(json.dumps({"after": snapshot["seq"]}))
        replay = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert replay == event
    return {
        "snapshot_seq": snapshot["seq"],
        "replayed_event": event,
        "transport": "real loopback HTTP + WebSocket",
    }


def api_check(command, root: Path):
    root.mkdir()
    database = root / "session.sqlite"
    server = Running(command, root, database)
    try:
        running_id = server.ready.copy()
        duplicate = subprocess.run(
            [*command, "serve", "--database", str(database)],
            env=server.env,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        assert duplicate.returncode != 0 and "BlockingIOError" in duplicate.stderr
        assert server.client.get("/bootstrap").json()["host_epoch"] == running_id["host_epoch"]
        assert server.client.get("/bootstrap", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert server.client.post("/submissions", json={"request_id": "bad", "text": 9}).status_code == 422
        request = {"request_id": "dedup", "text": "hello 中文"}
        with ThreadPoolExecutor(max_workers=16) as pool:
            responses = list(pool.map(lambda _: server.client.post("/submissions", json=request), range(16)))
        assert all(response.status_code == 202 for response in responses)
        assert all(response.json() == responses[0].json() for response in responses)
        assert server.client.post("/submissions", json={**request, "text": "different"}).status_code == 409
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT COUNT(*) FROM requests WHERE id='dedup'").fetchone()[0] == 1
            assert db.execute("SELECT COUNT(*) FROM outbox WHERE request_id='dedup'").fetchone()[0] == 1
        ws = asyncio.run(websocket_check(server))
        old_epoch = server.ready["host_epoch"]
        try:
            server.client.post(
                "/submissions",
                json={"request_id": "lost", "text": "durable"},
                headers={"X-Proof-Crash": "after-commit"},
            )
            raise AssertionError("crash did not interrupt HTTP response")
        except httpx.TransportError:
            pass
        assert server.process.wait(timeout=5) == 91
    finally:
        server.close()
    server = Running(command, root, database)
    try:
        receipt = server.client.get("/requests/lost").json()
        assert receipt["status"] == "accepted"
        assert (
            server.client.post("/submissions", json={"request_id": "lost", "text": "durable"}).json()
            == receipt
        )
        assert server.ready["host_epoch"] > old_epoch
        stale = server.client.post(
            "/control/stop", json={"host_epoch": old_epoch, "build_id": server.ready["build_id"]}
        )
        mismatch = server.client.post(
            "/control/stop",
            json={"host_epoch": server.ready["host_epoch"], "build_id": "different-build-same-0.1.0"},
        )
        assert stale.status_code == mismatch.status_code == 409
        assert server.client.get("/bootstrap").json()["pid"] == server.process.pid
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT COUNT(*) FROM outbox WHERE request_id='lost'").fetchone()[0] == 1
        result = {
            "identity": running_id,
            "concurrent_same_request": 16,
            "duplicate_host_rejected_by_os_lock": True,
            "receipts": 1,
            "ws": ws,
            "crash_after_commit_recovered": True,
            "stale_stop_rejected": True,
            "build_mismatch_rejected": True,
            "restart_epoch": server.ready["host_epoch"],
        }
        accepted = server.client.post(
            "/control/stop",
            json={"host_epoch": server.ready["host_epoch"], "build_id": server.ready["build_id"]},
        )
        assert accepted.status_code == 200
        assert server.process.wait(timeout=5) == 0
        return result
    finally:
        server.close()


def build_identity_check(command, root: Path):
    root.mkdir()
    changed = root / "different-source"
    changed.mkdir()
    source_b = changed / "proof_app.py"
    source_b.write_bytes((HERE / "proof_app.py").read_bytes() + b"\n# Different development build.\n")
    first = Running(command, root, root / "a.sqlite")
    try:
        second = Running([sys.executable, str(source_b)], root, root / "b.sqlite")
        try:
            assert first.ready["version"] == second.ready["version"] == "0.1.0"
            assert first.ready["build_id"] != second.ready["build_id"]
            rejected = first.client.post(
                "/control/stop",
                json={"host_epoch": first.ready["host_epoch"], "build_id": second.ready["build_id"]},
            )
            assert rejected.status_code == 409
            assert first.client.get("/bootstrap").json()["pid"] == first.process.pid
            # A changed source on disk must not change an already running instance's identity.
            source_b.write_bytes(source_b.read_bytes() + b"# Changed after startup.\n")
            assert second.client.get("/bootstrap").json()["build_id"] == second.ready["build_id"]
            return {
                "version": "0.1.0",
                "first_build": first.ready["build_id"],
                "second_build": second.ready["build_id"],
                "mismatch_rejected": True,
                "running_identity_survives_disk_change": True,
                "limit": "control-boundary test; not a complete supervisor takeover implementation",
            }
        finally:
            second.close()
    finally:
        first.close()


def crash_check(command, root: Path, repeats: int):
    root.mkdir()
    rows = []
    for repeat in range(repeats):
        for phase, count, status in [
            ("before-intent", 1, "done"),
            ("after-intent", 0, "unknown"),
            ("after-effect", 1, "unknown"),
            ("after-result", 1, "done"),
        ]:
            case = root / f"{repeat}-{phase}"
            case.mkdir()
            database, effect = case / "state.sqlite", case / "effect"
            env = {"PATH": "/usr/bin:/bin", "HOME": str(case), "TMPDIR": str(case)}
            store = Store(database)
            store.accept(Submission(request_id="one", text="effect"))
            store.db.close()
            base = [
                *command,
                "execute",
                "--database",
                str(database),
                "--request-id",
                "one",
                "--effect",
                str(effect),
            ]
            with (case / "worker.log").open("w") as log:
                process = subprocess.Popen(
                    [*base, "--pause", phase],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=log,
                    text=True,
                    env=env,
                    cwd=case,
                )
                try:
                    assert line(process)["phase"] == phase
                    process.kill()
                    assert process.wait(timeout=5) == -9
                finally:
                    stop(process)
            subprocess.run(
                [*command, "recover", "--database", str(database)],
                check=True,
                capture_output=True,
                timeout=15,
                env=env,
                cwd=case,
            )
            subprocess.run(base, check=True, capture_output=True, timeout=15, env=env, cwd=case)
            actual_count = len(effect.read_text().splitlines()) if effect.exists() else 0
            with sqlite3.connect(database) as db:
                actual_status = db.execute("SELECT status FROM requests").fetchone()[0]
                assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert (actual_count, actual_status) == (count, status), (phase, actual_count, actual_status)
            rows.append(
                {"phase": phase, "iteration": repeat, "effect_count": actual_count, "status": actual_status}
            )
    return rows


def native_check(root: Path):
    root.mkdir()
    executable = root / "macos-probe"
    subprocess.run(
        [
            "/usr/bin/xcrun",
            "clang",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fblocks",
            "-lEndpointSecurity",
            str(HERE / "macos_probe.c"),
            "-o",
            str(executable),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    results = []
    for i in range(3):
        directory = root / str(i)
        directory.mkdir()
        output = subprocess.run(
            [str(executable), "probe", str(directory)], check=True, capture_output=True, text=True, timeout=15
        )
        result = json.loads(output.stdout)
        assert result["es_result"] == result["es_not_entitled_code"]
        results.append(result)
    return {
        "observations": results,
        "full_descendant_cleanup": "blocked",
        "scope": "suspended spawn + direct unreaped child only; process groups fail the escape case",
        "endpoint_security": "blocked: restricted entitlement absent",
    }


def package_check(root: Path):
    root.mkdir()
    manifest = {
        "version": "0.1.0",
        "build_id": hashlib.sha256(
            (HERE / "proof_app.py").read_bytes() + (HERE / "uv.lock").read_bytes() + sys.version.encode()
        ).hexdigest(),
    }
    (root / "build.json").write_text(json.dumps(manifest))
    with (root / "build.log").open("w") as log:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "PyInstaller",
                "--noconfirm",
                "--clean",
                "--onedir",
                "--name",
                "amazme-proof",
                "--distpath",
                str(root / "dist"),
                "--workpath",
                str(root / "build"),
                "--specpath",
                str(root),
                "--add-data",
                f"{root / 'build.json'}:.",
                str(HERE / "proof_app.py"),
            ],
            check=True,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=180,
        )
    moved = root / "relocated product"
    shutil.move(str(root / "dist" / "amazme-proof"), str(moved))
    executable = moved / "amazme-proof"
    env = {"PATH": "/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root)}
    frozen = json.loads(subprocess.check_output([str(executable), "identity"], env=env, cwd=root, timeout=20))
    assert frozen["frozen"] is True and frozen["build_id"] == manifest["build_id"]
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--strict", str(executable)],
        check=True,
        capture_output=True,
        timeout=20,
    )
    api = api_check([str(executable)], root / "api")
    crashes = crash_check([str(executable)], root / "crashes", 1)
    return {
        "identity": frozen,
        "api": api,
        "crashes": crashes,
        "artifact": str(moved.relative_to(REPO)),
        "bytes": sum(p.stat().st_size for p in moved.rglob("*") if p.is_file()),
        "signature": "local ad-hoc verified; Developer ID/notarization NOT tested",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-package", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin" or sys.version_info[:2] != (3, 13):
        raise SystemExit("This proof requires macOS 27 SDK/runtime and CPython 3.13")
    parent = REPO / ".artifacts" / "python-backend-proof"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    report = {
        "status": "running",
        "artifact_root": str(root.relative_to(REPO)),
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "sqlite": sqlite3.sqlite_version,
            "packages": {
                name: importlib.metadata.version(name)
                for name in ["fastapi", "uvicorn", "pydantic", "websockets", "pyinstaller"]
            },
        },
        "source_sha256": {
            name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
            for name in ["proof_app.py", "macos_probe.c", "uv.lock", "run_proof.py"]
        },
        "checks": {},
    }
    command = [sys.executable, str(HERE / "proof_app.py")]
    checks = [
        ("macos", lambda: native_check(root / "native")),
        ("http_ws_sqlite", lambda: api_check(command, root / "api")),
        ("build_identity", lambda: build_identity_check(command, root / "identity")),
        ("crashes", lambda: crash_check(command, root / "crashes", 3)),
    ]
    if not args.skip_package:
        checks.append(("packaging", lambda: package_check(root / "package")))
    try:
        for name, operation in checks:
            print(json.dumps({"starting": name, "root": str(root.relative_to(REPO))}), flush=True)
            start = time.monotonic()
            value = operation()
            report["checks"][name] = {"result": value, "elapsed_seconds": round(time.monotonic() - start, 3)}
            (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"completed": name}), flush=True)
        report["status"] = "completed_with_macos_execution_blocker"
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(
            json.dumps({"report": str(root.relative_to(REPO) / "report.json"), "status": report["status"]}),
            flush=True,
        )


if __name__ == "__main__":
    main()
