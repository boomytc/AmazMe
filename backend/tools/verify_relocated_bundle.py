"""Historical VM contract, retired at the main entry point. Native replacement: stage B/D.

Move a frozen onedir onto a path that contains spaces and start it twice.

The process gets a PATH that only contains the system directories. With the
default seatbelt, a direct connect to a public IP is refused while localhost
still connects. That is process offline startup, not a physical cable pull.
"""

import argparse
import json
import os
import re
import select
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
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
VM_ALLOWS = """(allow mach-lookup)
(allow ipc-posix*)
(allow system-socket)
(allow network-bind (local unix-socket))
(allow network-inbound (local unix-socket))
(allow network-outbound (remote unix-socket))
"""
# Last matching seatbelt rule wins. Deny these names, then allow the same names inside the bundle.
RUNTIME_EXEC_DENY = """(deny process-exec*
  (regex #"/((python3(\\.[0-9]+)*)|python|node|colima|docker)$"))
"""
FORBIDDEN_RUNTIME = re.compile(r"^(python3(\.\d+)*|python|node|colima|docker)$")


def seatbelt_path(path: Path) -> str:
    text = str(path.resolve())
    if "\"" in text or "\n" in text or "\\" in text:
        raise SystemExit("sandbox path cannot be quoted")
    return text


def write_sandbox(path: Path, write_roots: list[Path], bundle: Path | None = None) -> None:
    lines = [SANDBOX_BODY]
    seen: set[str] = set()
    for root in write_roots:
        resolved = seatbelt_path(root)
        if resolved in seen:
            continue
        seen.add(resolved)
        lines.append(f'(allow file-write* (subpath "{resolved}"))\n')
    if bundle is not None:
        # Virtualization.framework cannot issue sandbox extensions under deny-default.
        # System interpreter and CLI paths are still refused. The process tree rejects
        # any other python, node, colima, or docker outside the bundle.
        lines = ["(version 1)\n(allow default)\n"]
        for literal in ("/usr/bin/python3", "/usr/bin/python"):
            lines.append(f'(deny process-exec* (literal "{literal}"))\n')
        for pattern in (
            "^/opt/.*/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
            "^/usr/local/.*/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
            "^/(bin|sbin)/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
            "^/Library/.*/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
            "^/System/.*/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
            "^/Applications/.*/(python3(\\.[0-9]+)*|python|node|colima|docker)$",
        ):
            lines.append(f'(deny process-exec* (regex #"{pattern}"))\n')
    path.write_text("".join(lines))


def is_forbidden_runtime(executable: str, bundle: Path) -> bool:
    name = Path(executable).name
    if name == "sandbox-exec" or FORBIDDEN_RUNTIME.fullmatch(name) is None:
        return False
    resolved = str(Path(executable).resolve())
    root = str(bundle.resolve())
    return resolved != root and not resolved.startswith(root + os.sep)


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


def text_executables(pids: list[int]) -> list[str]:
    if not pids:
        raise SystemExit("process tree was empty")
    result = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(str(pid) for pid in pids), "-d", "txt", "-Fn"],
        check=False, capture_output=True, text=True)
    if result.returncode not in {0, 1}:
        raise SystemExit(result.stderr[-1000:])
    paths = [line[1:] for line in result.stdout.splitlines() if line.startswith("n/")]
    if not paths:
        raise SystemExit("could not read process executables")
    return paths


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
        pids = [pid for pid, _command in tree]
        executables = text_executables(pids)
        forbidden = [item for item in executables if is_forbidden_runtime(item, executable.parent)]
        if forbidden:
            raise SystemExit("packaged backend invoked a system runtime: " + " | ".join(forbidden))
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
            "executables": executables,
            "forbidden_runtime": forbidden,
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


def http_json(url: str, token: str, method: str, path: str, headers: dict[str, str], body: object | None = None,
              timeout: float = 240) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url + path, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", **headers, **({} if data is None else {"content-type": "application/json"})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise SystemExit(f"{method} {path} {exc.code} {detail}") from exc


def as_record(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SystemExit("response was not an object")
    return cast(dict[str, object], value)


def bundled_executables(bundle: Path) -> list[str]:
    marker = str(bundle.resolve())
    pids = [pid for pid, _ppid, command in process_rows() if marker in command or marker in command.replace("\\ ", " ")]
    if not pids:
        return []
    return text_executables(pids)


def reject_forbidden(paths: list[str], bundle: Path) -> list[str]:
    forbidden = [item for item in paths if is_forbidden_runtime(item, bundle)]
    if forbidden:
        raise SystemExit("packaged backend invoked a system runtime: " + " | ".join(forbidden))
    return [item for item in paths if Path(item).name in {"node", "docker", "limactl"}]


def exercise_tools(executable: Path, root: Path, build_id: str, sandbox: Path | None) -> dict[str, object]:
    from amazme_backend.mcp_session import mcp_digest

    work = root / "tool work"
    profile = work / "profile"
    workspace = work / "workspace"
    workspace.mkdir(parents=True, mode=0o700)
    (workspace / "echo_mcp.py").write_text(
        "import json,sys\n"
        "def send(message):\n"
        "    sys.stdout.write(json.dumps(message)+'\\n'); sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    msg=json.loads(line); method=msg.get('method')\n"
        "    if method=='initialize':\n"
        "        send({'jsonrpc':'2.0','id':msg['id'],'result':{'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'demo','version':'0'}}})\n"
        "    elif method=='tools/list':\n"
        "        send({'jsonrpc':'2.0','id':msg['id'],'result':{'tools':[{'name':'echo','description':'回声'}]}})\n"
        "    elif method=='tools/call':\n"
        "        text=msg['params']['arguments'].get('text','')\n"
        "        send({'jsonrpc':'2.0','id':msg['id'],'result':{'content':[{'type':'text','text':text}]}})\n"
    )
    provider = work / "provider.json"
    provider.write_text(json.dumps({
        "provider": "faux", "model": "faux", "base_url": "", "api_key": "",
        "max_tokens": 2048, "proxy": "", "headers": {},
    }))
    env = clean_env()
    init = subprocess.run(
        launched(executable, ["init", "--profile", str(profile), "--workspace", str(workspace),
                              "--provider-config", str(provider), "--approval-policy", "auto"], sandbox),
        check=False, capture_output=True, text=True, env=env)
    if init.returncode != 0:
        raise SystemExit(init.stderr[-2000:] or init.stdout[-2000:])
    err_path = work / "serve.err"
    err_file = err_path.open("wb")
    proc = subprocess.Popen(
        launched(executable, ["serve", "--profile", str(profile), "--port", "0"], sandbox),
        stdout=subprocess.PIPE, stderr=err_file, env=env)
    err_file.close()
    observed: dict[str, list[str]] = {"codemode": [], "shell": [], "mcp": []}
    try:
        ready = read_ready(proc, err_path)
        url = str(ready["url"])
        token = (profile / "web.token").read_text().strip()
        _status, boot_payload = http_json(url, token, "GET", "/api/v1/bootstrap", {})
        boot = as_record(boot_payload)
        fence = {"x-amazme-build": str(boot["build_id"]), "x-amazme-epoch": str(boot["host_epoch"])}
        _status, created_payload = http_json(url, token, "POST", "/api/v1/sessions", fence, {"title": "工具", "workspace": "primary"})
        session = str(as_record(created_payload)["session_id"])
        _status, attachment_payload = http_json(url, token, "POST", f"/api/v1/sessions/{session}/attachments", fence, {})
        attachment = str(as_record(attachment_payload)["attachment_id"])
        bound = {**fence, "x-amazme-attachment": attachment}
        bundle = executable.parent

        code_holder: dict[str, object] = {}

        def post_code() -> None:
            try:
                status, payload = http_json(url, token, "POST", f"/api/v1/sessions/{session}/code", bound, {
                    "run_id": "c" * 32, "source": 'await bridge.call("block", {}); return 1;',
                })
                code_holder["status"] = status
                code_holder["payload"] = payload
            except SystemExit as exc:
                code_holder["error"] = str(exc)

        coder = threading.Thread(target=post_code)
        coder.start()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not observed["codemode"]:
            observed["codemode"] = reject_forbidden(bundled_executables(bundle), bundle)
            observed["codemode"] = [item for item in observed["codemode"] if Path(item).name == "node"]
            if not observed["codemode"]:
                time.sleep(0.05)
        http_json(url, token, "POST", f"/api/v1/sessions/{session}/code/{'c' * 32}/cancel", bound, {}, timeout=30)
        coder.join(timeout=30)
        if "error" in code_holder:
            raise SystemExit(str(code_holder["error"]))
        if not observed["codemode"]:
            raise SystemExit("codemode did not execute the bundled node")

        shell_holder: dict[str, object] = {}

        def post_shell() -> None:
            try:
                status, payload = http_json(url, token, "POST", f"/api/v1/sessions/{session}/submissions", bound, {
                    "request_id": "s" * 16, "text": "/shell echo amazme-shell-ok", "not_before_ms": 0,
                })
                shell_holder["status"] = status
                shell_holder["payload"] = payload
            except SystemExit as exc:
                shell_holder["error"] = str(exc)

        sheller = threading.Thread(target=post_shell)
        sheller.start()
        deadline = time.monotonic() + 240
        shell_answer = ""
        while time.monotonic() < deadline:
            observed["shell"] = [item for item in reject_forbidden(bundled_executables(bundle), bundle) if Path(item).name in {"docker", "limactl"}]
            try:
                _status, receipt_payload = http_json(url, token, "GET", f"/api/v1/sessions/{session}/requests/{'s' * 16}", {}, timeout=20)
                receipt = as_record(receipt_payload)
            except (SystemExit, TimeoutError, urllib.error.URLError):
                receipt = {}
            if receipt.get("status") == "succeeded" and "amazme-shell-ok" in str(receipt.get("answer", "")):
                shell_answer = str(receipt.get("answer", ""))
                break
            if receipt.get("status") in {"failed", "cancelled"}:
                raise SystemExit("shell did not run: " + str(receipt.get("answer", "")))
            time.sleep(0.2)
        sheller.join(timeout=5)
        if "error" in shell_holder:
            raise SystemExit(str(shell_holder["error"]))
        if not shell_answer:
            raise SystemExit("shell did not return amazme-shell-ok")
        if not observed["shell"]:
            observed["shell"] = [item for item in reject_forbidden(bundled_executables(bundle), bundle) if Path(item).name in {"docker", "limactl"}]
        if not observed["shell"]:
            raise SystemExit("shell finished without the bundled lima or docker process")

        server_id = "b" * 32
        mcp_holder: dict[str, object] = {}

        def post_mcp() -> None:
            try:
                status, payload = http_json(url, token, "POST", f"/api/v1/sessions/{session}/mcp", bound, {
                    "server_id": server_id, "command": "python -I /workspace/echo_mcp.py",
                }, timeout=180)
                mcp_holder["status"] = status
                mcp_holder["payload"] = payload
            except SystemExit as exc:
                mcp_holder["error"] = str(exc)

        mcper = threading.Thread(target=post_mcp)
        mcper.start()
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and not mcp_holder:
            observed["mcp"] = [item for item in reject_forbidden(bundled_executables(bundle), bundle) if Path(item).name in {"docker", "limactl"}]
            time.sleep(0.1)
        mcper.join(timeout=180)
        if "error" in mcp_holder:
            raise SystemExit(str(mcp_holder["error"]))
        mcp = as_record(mcp_holder.get("payload"))
        tools = mcp.get("tools")
        names = [str(as_record(item).get("name")) for item in tools] if isinstance(tools, list) else []
        if mcp.get("phase") != "ready" or "echo" not in names:
            raise SystemExit("mcp did not become ready: " + json.dumps(mcp)[:500])
        if not observed["mcp"]:
            observed["mcp"] = [item for item in reject_forbidden(bundled_executables(bundle), bundle) if Path(item).name in {"docker", "limactl"}]
        arguments = {"text": "amazme-mcp-ok"}
        digest = mcp_digest("echo", arguments)
        call_id = "d" * 32
        _status, call_payload = http_json(url, token, "POST", f"/api/v1/sessions/{session}/mcp/{server_id}/calls", bound, {
            "call_id": call_id, "name": "echo", "arguments": arguments,
        })
        waiting = as_record(call_payload)
        if waiting.get("phase") != "waiting_approval":
            raise SystemExit("mcp call was not waiting for approval")
        _status, decided_payload = http_json(
            url, token, "POST", f"/api/v1/sessions/{session}/mcp/{server_id}/calls/{call_id}/decision", bound, {
                "decision_id": "approve-echo", "approve": True, "digest": digest,
            })
        decided = as_record(decided_payload)
        if decided.get("phase") != "done" or decided.get("result") != "amazme-mcp-ok":
            raise SystemExit("mcp call did not return amazme-mcp-ok")
        reject_forbidden(bundled_executables(bundle), bundle)
        return {
            "codemode_node": observed["codemode"],
            "shell_answer": shell_answer,
            "shell_runtime": observed["shell"],
            "mcp_phase": mcp.get("phase"),
            "mcp_tools": names,
            "mcp_result": decided.get("result"),
            "mcp_runtime": observed["mcp"],
            "forbidden_runtime": [],
        }
    finally:
        subprocess.run(launched(executable, ["stop", "--profile", str(profile)], sandbox), check=False, capture_output=True, text=True, env=env, timeout=40)
        subprocess.run(launched(executable, ["destroy-vm", "--profile", str(profile)], sandbox), check=False, capture_output=True, text=True, env=env, timeout=60)
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()


def main() -> None:
    raise SystemExit("Retired VM relocation contract; native installation verification belongs to stage D")
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
        network = moved.parent / "offline.sb"
        write_roots = [moved.parent, Path("/private/var/folders"), Path("/var/folders"), Path("/private/tmp"), Path("/tmp")]
        write_roots.append(Path.home() / ".amazme-vm")
        write_sandbox(network, write_roots)
        seatbelt = prove_seatbelt(network)
        sandbox = moved.parent / "runtime.sb"
        write_sandbox(sandbox, write_roots, moved)
    runs = [serve_once(executable, moved.parent, index, build_id, sandbox) for index in (1, 2)]
    tools = exercise_tools(executable, moved.parent, build_id, sandbox)
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
        "runtime_exec_policy": "allow default, refuse system python node colima and docker, reject any other outside those names in the process tree" if sandbox is not None else "not requested",
        "runs": runs,
        "tools": tools,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"moved": str(moved), "build_id": build_id, "runs": len(runs)}))


if __name__ == "__main__":
    main()
