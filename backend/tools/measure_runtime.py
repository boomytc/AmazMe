"""Historical VM contract, retired at the main entry point. Native replacement: stage B/D.

Measure submit, history load, and cancel-to-exit on one frozen amazme-backend.

Submit latency is the POST that returns the durable receipt. History load is a
later GET of the snapshot and of search. Cancel latency follows `/shell sleep`
until the receipt is terminal and no host-side sleep for that profile remains.
A parked request is not reported as process exit.
"""

import argparse
import json
import os
import select
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import cast


def clean_env() -> dict[str, str]:
    kept = ("HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL")
    env = {key: os.environ[key] for key in kept if os.environ.get(key)}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    env.setdefault("LANG", "C")
    return env


def read_ready(proc: subprocess.Popen[bytes], err_path: Path) -> dict[str, object]:
    if proc.stdout is None:
        raise SystemExit("serve stdout is unavailable")
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    pending = ""
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if proc.poll() is not None and not pending:
            break
        readable, _, _ = select.select([fd], [], [], 0.05)
        if not readable:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            if proc.poll() is not None:
                break
            continue
        pending += chunk.decode()
        while "\n" in pending:
            line, pending = pending.split("\n", 1)
            if not line.startswith("{"):
                continue
            loaded = json.loads(line)
            if isinstance(loaded, dict) and "url" in loaded:
                return {str(key): value for key, value in cast(dict[object, object], loaded).items()}
    proc.kill()
    raise SystemExit(err_path.read_text(errors="replace")[-2000:])


def request(url: str, token: str, method: str, path: str, headers: dict[str, str], body: object | None = None) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url + path, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", **headers, **({} if data is None else {"content-type": "application/json"})},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise SystemExit(f"{method} {path} {exc.code} {detail}") from exc


def as_record(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SystemExit("response was not an object")
    return cast(dict[str, object], value)


def processes() -> list[str]:
    result = subprocess.run(["/bin/ps", "-axo", "pid=,command="], check=True, capture_output=True, text=True)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def profile_processes(profile: Path) -> list[str]:
    marker = str(profile)
    return [line for line in processes() if marker in line]


def sleep_processes(profile: Path) -> list[str]:
    return [line for line in profile_processes(profile) if " sleep " in f" {line} " or line.endswith(" sleep 30")]


def docker_ps(executable: Path, profile: Path) -> tuple[list[str], str]:
    locator = profile / "vm.json"
    if not locator.is_file():
        return [], "vm.json missing"
    home = Path(str(as_record(json.loads(locator.read_text())).get("home", "")))
    socket = home / "execution" / "sock" / "docker.sock"
    docker = executable.parent / "resources" / "docker"
    if not socket.exists() or not docker.is_file():
        return [], "docker socket missing"
    result = subprocess.run(
        [str(docker), "--host", f"unix://{socket}", "ps", "--format", "{{.ID}} {{.Command}}"],
        check=False, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        return [], result.stderr.strip()[:200]
    return [line.strip() for line in result.stdout.splitlines() if line.strip()], ""


def submit(url: str, token: str, fence: dict[str, str], session: str, attachment: str, text: str, not_before_ms: int = 0) -> tuple[float, dict[str, object]]:
    request_id = os.urandom(8).hex()
    started = time.perf_counter()
    status, payload = request(url, token, "POST", f"/api/v1/sessions/{session}/submissions", {
        **fence, "x-amazme-attachment": attachment,
    }, {"request_id": request_id, "text": text, "not_before_ms": not_before_ms})
    elapsed = time.perf_counter() - started
    if status != 202:
        raise SystemExit(f"submit status {status}")
    receipt = as_record(payload)
    if receipt.get("request_id") != request_id:
        raise SystemExit("submit receipt identity changed")
    return elapsed, receipt


def wait_succeeded(url: str, token: str, session: str, request_id: str, answer: str) -> tuple[float, dict[str, object]]:
    started = time.perf_counter()
    deadline = time.monotonic() + 30
    latest = fetch_receipt(url, token, session, request_id)
    while not (latest.get("status") == "succeeded" and latest.get("answer") == answer) and time.monotonic() < deadline:
        time.sleep(0.01)
        latest = fetch_receipt(url, token, session, request_id)
    if latest.get("status") != "succeeded" or latest.get("answer") != answer:
        raise SystemExit(f"submit did not commit: {latest.get('status')}")
    return time.perf_counter() - started, latest


def fetch_receipt(url: str, token: str, session: str, request_id: str) -> dict[str, object]:
    _status, payload = request(url, token, "GET", f"/api/v1/sessions/{session}/requests/{request_id}", {})
    return as_record(payload)


def main() -> None:
    raise SystemExit("Retired VM measurement contract; native performance verification belongs to stage D")
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    executable = args.executable.resolve()
    manifest = json.loads((executable.parent / "build.json").read_text())
    build_id = str(manifest["build_id"])
    root = Path(tempfile.mkdtemp(prefix="amazme-perf-", dir=executable.parent.parent.parent))
    profile = root / "profile"
    workspace = root / "workspace"
    workspace.mkdir(mode=0o700)
    provider = root / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    env = clean_env()
    init = subprocess.run(
        [str(executable), "init", "--profile", str(profile), "--workspace", str(workspace),
         "--provider-config", str(provider), "--approval-policy", "auto"],
        check=False, capture_output=True, text=True, env=env)
    if init.returncode != 0:
        raise SystemExit(init.stderr[-2000:])
    err_path = root / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        [str(executable), "serve", "--profile", str(profile), "--port", "0"],
        stdout=subprocess.PIPE, stderr=err_file, env=env)
    err_file.close()
    try:
        ready = read_ready(proc, err_path)
        url = str(ready["url"])
        if ready.get("build_id") != build_id:
            raise SystemExit("ready build_id does not match the package")
        token = (profile / "web.token").read_text().strip()
        _status, boot_payload = request(url, token, "GET", "/api/v1/bootstrap", {})
        boot = as_record(boot_payload)
        fence = {"x-amazme-build": str(boot["build_id"]), "x-amazme-epoch": str(boot["host_epoch"])}
        _status, created_payload = request(url, token, "POST", "/api/v1/sessions", fence, {"title": "计时", "workspace": "primary"})
        created = as_record(created_payload)
        session = str(created["session_id"])
        _status, attachment_payload = request(url, token, "POST", f"/api/v1/sessions/{session}/attachments", fence, {})
        attachment = str(as_record(attachment_payload)["attachment_id"])

        cold_post_s, cold = submit(url, token, fence, session, attachment, "冷启动")
        cold_wait_s, _confirmed = wait_succeeded(url, token, session, str(cold["request_id"]), "已收到：冷启动")

        warm_post: list[float] = []
        warm_wait: list[float] = []
        for index in range(8):
            text = f"历史条目{index}"
            post_s, receipt = submit(url, token, fence, session, attachment, text)
            wait_s, _settled = wait_succeeded(url, token, session, str(receipt["request_id"]), f"已收到：{text}")
            warm_post.append(post_s)
            warm_wait.append(wait_s)

        started = time.perf_counter()
        snap_status, snap_payload = request(url, token, "GET", f"/api/v1/sessions/{session}/snapshot", {})
        snapshot_s = time.perf_counter() - started
        raw_snapshot = json.dumps(snap_payload).encode()
        snapshot = as_record(snap_payload)
        requests_list = snapshot.get("requests")
        events = snapshot.get("events")
        if snap_status != 200 or not isinstance(requests_list, list) or len(requests_list) < 9:
            raise SystemExit("snapshot did not contain the committed history")
        started = time.perf_counter()
        search_status, search_payload = request(url, token, "GET", f"/api/v1/sessions/{session}/search?q={urllib.request.quote('历史条目')}", {})
        search_s = time.perf_counter() - started
        search = as_record(search_payload)
        hits = search.get("hits")
        if search_status != 200 or not isinstance(hits, list) or len(hits) < 8:
            raise SystemExit("search did not load the committed history")

        shell_s, shell = submit(url, token, fence, session, attachment, "/shell sleep 120")
        shell_id = str(shell["request_id"])
        terminal = {"succeeded", "cancelled", "failed", "unknown", "interrupted"}
        ready_deadline = time.monotonic() + 90
        observed = shell
        before_sleep: list[str] = []
        before_containers: list[str] = []
        docker_error = ""
        running_since: float | None = None
        while time.monotonic() < ready_deadline:
            observed = fetch_receipt(url, token, session, shell_id)
            before_sleep = sleep_processes(profile)
            before_containers, docker_error = docker_ps(executable, profile)
            if before_sleep or before_containers:
                break
            if observed.get("status") in terminal:
                break
            if observed.get("status") == "running":
                running_since = running_since or time.monotonic()
                if time.monotonic() - running_since >= 3:
                    break
            time.sleep(0.2)
        running = observed.get("status") == "running"
        if observed.get("status") in terminal:
            latest = observed
            receipt_s = 0.0
        else:
            cancel_started = time.perf_counter()
            cancel_status, cancel_payload = request(
                url, token, "POST", f"/api/v1/sessions/{session}/requests/{shell_id}/cancel",
                {**fence, "x-amazme-attachment": attachment}, {})
            if cancel_status != 202:
                raise SystemExit(f"cancel status {cancel_status}")
            latest = as_record(cancel_payload)
            cancel_deadline = time.monotonic() + 60
            while time.monotonic() < cancel_deadline and latest.get("status") not in terminal:
                time.sleep(0.05)
                latest = fetch_receipt(url, token, session, shell_id)
            receipt_s = time.perf_counter() - cancel_started
        saw_process = bool(before_sleep or before_containers)
        remaining = before_sleep
        containers = before_containers
        process_s: float | None = None
        if saw_process:
            process_started = time.perf_counter()
            sleep_deadline = time.monotonic() + 30
            while (remaining or containers) and time.monotonic() < sleep_deadline:
                time.sleep(0.1)
                remaining = sleep_processes(profile)
                containers, docker_error = docker_ps(executable, profile)
            if not remaining and not containers:
                process_s = time.perf_counter() - process_started
        report = {
            "executable": str(executable),
            "build_id": build_id,
            "approval_policy": "auto",
            "cold_post_s": round(cold_post_s, 6),
            "cold_until_succeeded_s": round(cold_post_s + cold_wait_s, 6),
            "cold_settled_s": round(cold_wait_s, 6),
            "cold_post_status": cold.get("status"),
            "warm_post_s": [round(item, 6) for item in warm_post],
            "warm_settled_s": [round(item, 6) for item in warm_wait],
            "snapshot_s": round(snapshot_s, 6),
            "snapshot_requests": len(requests_list) if isinstance(requests_list, list) else 0,
            "snapshot_events": len(events) if isinstance(events, list) else 0,
            "snapshot_bytes": len(raw_snapshot),
            "search_s": round(search_s, 6),
            "search_hits": len(hits) if isinstance(hits, list) else 0,
            "search_bytes": len(json.dumps(search_payload).encode()),
            "shell_submit_s": round(shell_s, 6),
            "shell_status_before_cancel": observed.get("status"),
            "shell_reached_running": running,
            "shell_sleep_visible_before_cancel": len(before_sleep),
            "containers_before_cancel": before_containers,
            "docker_ps_error": docker_error,
            "cancel_receipt_s": round(receipt_s, 6),
            "cancel_status": latest.get("status"),
            "cancel_requested": latest.get("cancel_requested"),
            "cancel_process_gone_s": None if process_s is None else round(process_s, 6),
            "sleep_still_visible": len(remaining),
            "containers_after_cancel": containers,
            "host_pid": proc.pid,
        }
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        if latest.get("status") not in terminal:
            raise SystemExit(f"cancel did not reach a terminal receipt: {latest.get('status')}")
        print(json.dumps({"build_id": build_id, "cold_settled_s": report["cold_settled_s"], "cancel_status": report["cancel_status"]}))
    finally:
        subprocess.run([str(executable), "stop", "--profile", str(profile)], check=False, capture_output=True, text=True, env=env, timeout=40)
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        subprocess.run([str(executable), "destroy-vm", "--profile", str(profile)], check=False, capture_output=True, text=True, env=env, timeout=180)
        if proc.stdout is not None:
            proc.stdout.close()


if __name__ == "__main__":
    main()
