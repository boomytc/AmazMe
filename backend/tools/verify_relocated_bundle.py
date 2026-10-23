"""Move a frozen onedir onto a path that contains spaces and start it twice.

The process gets a PATH that only contains the system directories. With the
default seatbelt, a direct connect to a public IP is refused while localhost
still connects. That is process offline startup, not a physical cable pull.
"""

import argparse
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import cast

CLEAN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
SANDBOX_BODY = """(version 1)
(deny default)
(allow process*)
(allow signal)
(allow sysctl-read)
(allow file-read*)
(allow file-ioctl)
(allow file-read* file-write* file-ioctl (literal "/dev/null"))
(allow file-read* file-ioctl (literal "/dev/urandom"))
(allow file-read* file-ioctl (literal "/dev/random"))
(allow file-read* file-ioctl (literal "/dev/zero"))
(allow file-ioctl (literal "/dev/dtracehelper"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
"""


def write_sandbox(path: Path, write_roots: list[Path]) -> None:
    lines = [SANDBOX_BODY]
    seen: set[str] = set()
    for root in write_roots:
        resolved = str(root.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        lines.append(f'(allow file-write* (subpath "{resolved}"))\n')
    path.write_text("".join(lines))


def prove_seatbelt(profile: Path) -> dict[str, str]:
    denied = subprocess.run(
        ["/usr/bin/sandbox-exec", "-f", str(profile), "/usr/bin/python3", "-c",
         "import socket;s=socket.socket();s.settimeout(3);s.connect(('1.1.1.1',443))"],
        check=False, capture_output=True, text=True)
    local = subprocess.run(
        ["/usr/bin/sandbox-exec", "-f", str(profile), "/usr/bin/python3", "-c",
         "import socket;s=socket.socket();s.settimeout(3);s.connect(('127.0.0.1',9))"],
        check=False, capture_output=True, text=True)
    denied_text = denied.stderr + denied.stdout
    local_text = local.stderr + local.stdout
    if "Operation not permitted" not in denied_text:
        raise SystemExit("seatbelt did not refuse a public IP: " + denied_text[-500:])
    if "Connection refused" not in local_text and "Errno 61" not in local_text:
        raise SystemExit("seatbelt did not allow localhost: " + local_text[-500:])
    return {"public_ip_443": "operation not permitted", "localhost_9": "connection refused"}


def launched(executable: Path, args: list[str], sandbox: Path | None) -> list[str]:
    command = [str(executable), *args]
    if sandbox is None:
        return command
    return ["/usr/bin/sandbox-exec", "-f", str(sandbox), *command]


def clean_env() -> dict[str, str]:
    kept = ("HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL")
    env = {key: os.environ[key] for key in kept if os.environ.get(key)}
    env["PATH"] = CLEAN_PATH
    env.setdefault("LANG", "C")
    return env


def copy_bundle(source: Path, destination: Path) -> None:
    if destination.exists():
        raise SystemExit(f"destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    cloned = subprocess.run(["/bin/cp", "-cR", str(source), str(destination)], check=False, capture_output=True, text=True)
    if cloned.returncode != 0:
        shutil.copytree(source, destination, symlinks=True)


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


def process_rows() -> list[tuple[int, int, str]]:
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,command="], check=True, capture_output=True, text=True)
    rows: list[tuple[int, int, str]] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def process_tree(root: int) -> list[tuple[int, str]]:
    rows = process_rows()
    ids = {root}
    changed = True
    while changed:
        changed = False
        for pid, ppid, _command in rows:
            if ppid in ids and pid not in ids:
                ids.add(pid)
                changed = True
    return [(pid, command) for pid, _ppid, command in rows if pid in ids]


def loopback_sockets(pids: list[int]) -> list[str]:
    if not pids:
        return []
    result = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(str(pid) for pid in pids), "-i"],
        check=False, capture_output=True, text=True)
    if result.returncode not in {0, 1}:
        raise SystemExit(result.stderr[-1000:])
    sockets: list[str] = []
    for line in result.stdout.splitlines()[1:]:
        endpoints = [part for part in line.split() if ":" in part and (part[0].isdigit() or part.startswith("["))]
        if not endpoints:
            raise SystemExit(f"could not read a socket address: {line}")
        for endpoint in endpoints:
            for side in endpoint.split("->"):
                host = side.rsplit(":", 1)[0]
                if host not in {"127.0.0.1", "[::1]", "localhost"}:
                    raise SystemExit(f"startup opened a non-loopback socket: {line}")
        sockets.extend(endpoints)
    return sockets


def serve_once(executable: Path, root: Path, index: int, build_id: str, sandbox: Path | None) -> dict[str, object]:
    work = root / f"work space {index}"
    profile = work / "profile"
    workspace = work / "workspace"
    workspace.mkdir(parents=True, mode=0o700)
    provider = work / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    env = clean_env()
    init = subprocess.run(
        launched(executable, ["init", "--profile", str(profile), "--workspace", str(workspace), "--provider-config", str(provider)], sandbox),
        check=False, capture_output=True, text=True, env=env)
    if init.returncode != 0:
        raise SystemExit(init.stderr[-2000:] or init.stdout[-2000:])
    err_path = work / "serve.err"
    err_file = err_path.open("wb")
    started = time.monotonic()
    proc = subprocess.Popen(
        launched(executable, ["serve", "--profile", str(profile), "--port", "0"], sandbox),
        stdout=subprocess.PIPE, stderr=err_file, env=env)
    err_file.close()
    try:
        ready = read_ready(proc, err_path)
        ready_s = round(time.monotonic() - started, 3)
        if proc.pid is None:
            raise SystemExit("serve did not start")
        tree = process_tree(proc.pid)
        executable_text = str(executable)
        outside = [command for _pid, command in tree if executable_text not in command]
        if outside:
            raise SystemExit("process left the moved bundle: " + " | ".join(outside))
        token = (profile / "web.token").read_text().strip()
        request = urllib.request.Request(
            str(ready["url"]) + "/api/v1/bootstrap",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode())
        if not isinstance(payload, dict):
            raise SystemExit("bootstrap was not an object")
        body = cast(dict[object, object], payload)
        if body.get("build_id") != build_id or body.get("protocol") != "amazme-http/1" or body.get("role") != "host":
            raise SystemExit("bootstrap did not match the moved bundle")
        pids = [pid for pid, _command in tree]
        sockets = loopback_sockets(pids)
        rss = subprocess.run(
            ["/bin/ps", "-o", "rss=", "-p", ",".join(str(pid) for pid in pids)],
            check=True, capture_output=True, text=True)
        rss_kb = sum(int(item) for item in rss.stdout.split())
        return {
            "pid": proc.pid,
            "ready_s": ready_s,
            "rss_kb": rss_kb,
            "protocol": body["protocol"],
            "build_id": body["build_id"],
            "role": body["role"],
            "sockets": sockets,
            "commands": [command for _pid, command in tree],
        }
    finally:
        subprocess.run(launched(executable, ["stop", "--profile", str(profile)], sandbox), check=False, capture_output=True, text=True, env=env, timeout=40)
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--offline", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    source = args.bundle.resolve()
    executable_name = source / "amazme-backend"
    manifest_path = source / "build.json"
    if not executable_name.is_file() or not manifest_path.is_file():
        raise SystemExit("bundle is missing amazme-backend or build.json")
    manifest = json.loads(manifest_path.read_text())
    build_id = str(manifest["build_id"])
    parent = source.parent.parent / "relocated with space"
    parent.mkdir(parents=True, exist_ok=True)
    moved = Path(tempfile.mkdtemp(prefix="bundle ", dir=parent)) / "AmazMe Python 0.1.0"
    copy_bundle(source, moved)
    executable = moved / "amazme-backend"
    if " " not in str(executable):
        raise SystemExit("moved executable path has no space")
    sandbox: Path | None = None
    seatbelt: dict[str, str] | None = None
    if args.offline:
        sandbox = moved.parent / "offline.sb"
        write_sandbox(sandbox, [moved.parent, Path("/private/var/folders"), Path("/var/folders"), Path("/private/tmp"), Path("/tmp")])
        seatbelt = prove_seatbelt(sandbox)
    runs = [serve_once(executable, moved.parent, index, build_id, sandbox) for index in (1, 2)]
    for run in runs:
        if not any(pid == run["pid"] for pid, _ppid, _command in process_rows()):
            continue
        raise SystemExit(f"serve pid {run['pid']} stayed after stop")
    report = {
        "source": str(source),
        "moved": str(moved),
        "build_id": build_id,
        "clean_path": CLEAN_PATH,
        "offline_enforcement": seatbelt if seatbelt is not None else "not requested",
        "runs": runs,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"moved": str(moved), "build_id": build_id, "runs": len(runs)}))


if __name__ == "__main__":
    main()
