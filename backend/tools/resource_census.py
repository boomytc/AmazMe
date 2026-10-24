"""Disk, process, VM, and package census for one build or verification round.

A passing test report is not this census. ``reclaimed`` is true only after the
categories in ``CHECKED`` have been read for the scope below. ``main`` never
deletes a directory. Package builds and named-slot runners may remove unused
directories they have already classified, and only inside the roots they pass.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path, PurePosixPath
from typing import TypedDict

WARN_FREE_BYTES = 50 * 1024**3
PACKAGE_SLOTS = 2
CHECKED = ["processes", "vm_dirs", "temp_dirs", "packages", "free_bytes"]
SCOPE = (
    "processes classified by mode token and parentage (serve, supervisor, worker, execute, "
    "service-runner, pty-gate, mcp-gate, plugin-gate, computer-driver, lima, hostagent, owned headless browsers, descendants); "
    "VM directories; am2-/amcu- temp directories; package-* retention; free space on the artifact volume"
)
NOTE = (
    "reclaimed covers only this scope. A test pass is not reclaimed. "
    "A serve-only process match misses supervisor, worker, execute, service-runner, and session gates. "
    "The census command does not delete directories. Durable profiles stay observed and are not stopped. "
    "Package builds and runners may remove unused over-cap directories only inside the roots they pass. "
    "Confirm an unowned VM directory before removing it. Do not install or start a VM to clean one."
)
VM_STEPS = [
    "do not install, start, or recreate Lima, Docker, Colima, or a Linux VM",
    "stop only processes whose argv references the confirmed owner profile_path",
    "after that owner is confirmed and those processes are gone, the VM directory itself must be absent",
]
REPO = Path(__file__).resolve().parents[2]


class ProcessRow(TypedDict):
    pid: int
    ppid: int
    argv: list[str]
    cwd: str


class Report(TypedDict):
    scope: str
    checked: list[str]
    free_bytes: int
    free_gib: float
    disk_level: str
    artifact_bytes: int
    vm_bytes: int
    leaks: list[dict[str, object]]
    observed: list[dict[str, object]]
    vm_dirs: list[dict[str, object]]
    temp_dirs: list[dict[str, object]]
    packages: list[dict[str, object]]
    reclaimed: bool
    build_allowed: bool
    deletion: str
    note: str
    vm_steps: list[str]


def stop_free_bytes() -> int:
    return int(_budget().DEFAULT_MIN_FREE_BYTES)


def disk_level(free: int) -> str:
    if free < stop_free_bytes():
        return "stop"
    if free < WARN_FREE_BYTES:
        return "warn"
    return "ok"


def _budget():
    name = "_amazme_resource_budget"
    if name in sys.modules:
        return sys.modules[name]
    import importlib.util

    path = Path(__file__).with_name("resource_budget.py")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("resource_budget could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _gib(value: int) -> float:
    return round(value / 1024**3, 2)


def profile_arg(argv: list[str]) -> str | None:
    for index, token in enumerate(argv):
        if token == "--profile" and index + 1 < len(argv):
            return argv[index + 1]
        if token.startswith("--profile="):
            return token.split("=", 1)[1]
    return None


def _posix(path: str) -> str:
    return os.path.normpath(path).replace("\\", "/")


def _canonical_profile(profile: str) -> str:
    """Resolve symlinks through the longest existing ancestor. A missing temp profile still canonicalizes."""
    path = os.path.normpath(profile)
    if os.path.lexists(path):
        return os.path.realpath(path)
    missing: list[str] = []
    current = path
    while current and current != os.path.dirname(current) and not os.path.lexists(current):
        missing.append(os.path.basename(current))
        current = os.path.dirname(current)
    if not current or not os.path.lexists(current):
        return path
    resolved = os.path.realpath(current)
    for part in reversed(missing):
        resolved = os.path.join(resolved, part)
    return os.path.normpath(resolved)


def _ephemeral_text(path: str) -> bool:
    if path in {"/tmp", "/private/tmp"}:
        return True
    if any(marker in path for marker in ("/tmp/", "/private/tmp/", "/.artifacts/", ".amazme-vm", "/am2-")):
        return True
    parts = PurePosixPath(path).parts
    if len(parts) >= 6 and parts[0] == "/" and parts[1:3] == ("var", "folders") and parts[5] == "T":
        return True
    return len(parts) >= 7 and parts[0] == "/" and parts[1:4] == ("private", "var", "folders") and parts[6] == "T"


def _profile_aliases(path: str) -> set[str]:
    aliases = {path}
    if path.startswith("/private/var/"):
        aliases.add("/var/" + path.removeprefix("/private/var/"))
    elif path.startswith("/var/"):
        aliases.add("/private" + path)
    return aliases


def _profile_ephemeral(profile: str) -> bool:
    candidates = {_posix(profile), _posix(_canonical_profile(profile))}
    expanded: set[str] = set()
    for item in candidates:
        expanded.update(_profile_aliases(item))
    return any(_ephemeral_text(item) for item in expanded)


def _mentions_owned_runtime(blob: str) -> bool:
    return any(marker in blob for marker in (".amazme-vm", "/.artifacts/", "/am2-"))


def _backend(argv: list[str]) -> bool:
    return any(name in {"amazme_backend", "amazme-backend"} for name in _names(argv))


def gate_role(argv: list[str]) -> str | None:
    if not _backend(argv):
        return None
    for token in argv:
        if token in {"pty-gate", "mcp-gate", "plugin-gate"}:
            return token
    return None


def _names(argv: list[str]) -> list[str]:
    return [Path(token).name for token in argv]


def _browser_name(names: list[str]) -> bool:
    return any(
        name in {"Google Chrome", "Google Chrome Helper", "Chromium", "chrome", "Electron", "electron"}
        or name.startswith("AmazMe")
        for name in names
    )


def _headless(argv: list[str]) -> bool:
    return any(token == "--headless" or token.startswith("--headless=") for token in argv)


def classify_argv(argv: list[str], cwd: str = "") -> str | None:
    """Return the owned role. The mode is its own argv token, so a serve-only pattern misses supervisor."""
    if not argv:
        return None
    names = _names(argv)
    blob = "\n".join([*argv, cwd])
    if (any(token.endswith("/AmazMe Computer Use.app/Contents/MacOS/" + name)
            for token in argv for name in ("cua-driver", "amazme-computer-use"))
            and any(token.startswith(("/tmp/amcu-", "/private/tmp/amcu-"))
                    and token.endswith("/driver.sock") for token in argv)):
        return "computer-driver"
    if gate_role(argv) is None and _backend(argv):
        for token in argv:
            if token in {"service-runner", "serve", "supervisor", "worker", "execute"}:
                return token
    if any(name in {"limactl", "lima"} or name.startswith("qemu-system-") for name in names):
        if _mentions_owned_runtime(blob):
            return "lima"
    if any(name == "hostagent" or name.endswith("-hostagent") for name in names) and _mentions_owned_runtime(blob):
        return "hostagent"
    if _browser_name(names) and _headless(argv) and _mentions_owned_runtime(blob):
        return "browser"
    return None


def _disposition(role: str, argv: list[str], _cwd: str) -> str:
    if role in {"lima", "hostagent", "browser"}:
        return "leak"
    profile = profile_arg(argv)
    if profile is None or _profile_ephemeral(profile):
        return "leak"
    return "observed"


def _public(proc: ProcessRow, role: str, disposition: str, via: str) -> dict[str, object]:
    return {
        "pid": proc["pid"],
        "ppid": proc["ppid"],
        "role": role,
        "disposition": disposition,
        "via": via,
        "profile": profile_arg(proc["argv"]),
        "cwd": proc["cwd"],
        "argv": [token[:180] for token in proc["argv"][:16]],
    }


def _nearest(pid: int, parent: dict[int, int], roles: dict[int, str]) -> int | None:
    seen: set[int] = set()
    cursor = parent.get(pid, 0)
    while cursor and cursor not in seen:
        seen.add(cursor)
        if cursor in roles:
            return cursor
        cursor = parent.get(cursor, 0)
    return None


def annotate(processes: list[ProcessRow]) -> list[dict[str, object]]:
    direct_role: dict[int, str] = {}
    direct_disposition: dict[int, str] = {}
    for proc in processes:
        if gate_role(proc["argv"]) is not None:
            continue
        role = classify_argv(proc["argv"], proc["cwd"])
        if role is None:
            continue
        direct_role[proc["pid"]] = role
        direct_disposition[proc["pid"]] = _disposition(role, proc["argv"], proc["cwd"])
    parent = {proc["pid"]: proc["ppid"] for proc in processes}
    gate_info: dict[int, tuple[str, str, str]] = {}
    for proc in processes:
        role = gate_role(proc["argv"])
        if role is None:
            continue
        found = _nearest(proc["pid"], parent, direct_disposition)
        if found is None:
            gate_info[proc["pid"]] = (role, "leak", "orphan")
            direct_disposition[proc["pid"]] = "leak"
        else:
            gate_info[proc["pid"]] = (role, direct_disposition[found], str(found))
            direct_disposition[proc["pid"]] = direct_disposition[found]
    rows: list[dict[str, object]] = []
    for proc in processes:
        if proc["pid"] in direct_role:
            rows.append(_public(proc, direct_role[proc["pid"]], direct_disposition[proc["pid"]], "argv"))
            continue
        if proc["pid"] in gate_info:
            role, disposition, via = gate_info[proc["pid"]]
            rows.append(_public(proc, role, disposition, via))
            continue
        found = _nearest(proc["pid"], parent, direct_disposition)
        if found is None:
            continue
        rows.append(_public(proc, "descendant", direct_disposition[found], str(found)))
    return rows


def _topmost(paths: list[Path]) -> list[Path]:
    chosen: list[Path] = []
    for path in sorted((path.resolve() for path in paths), key=lambda item: len(item.parts)):
        if any(path == earlier or path.is_relative_to(earlier) for earlier in chosen):
            continue
        chosen.append(path)
    return chosen


def package_rows(roots: list[Path]) -> list[dict[str, object]]:
    found: list[Path] = []
    seen: set[Path] = set()
    budget = _budget()
    for root in _topmost(roots):
        if not root.exists() or root.is_symlink():
            continue
        for directory, dirnames, _files in os.walk(root, followlinks=False):
            current = Path(directory)
            kept: list[str] = []
            for name in dirnames:
                path = current / name
                if path.is_symlink():
                    continue
                if name.startswith("package-"):
                    resolved = path.resolve()
                    if resolved not in seen:
                        seen.add(resolved)
                        found.append(path)
                    continue
                kept.append(name)
            dirnames[:] = kept
    found.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    rows: list[dict[str, object]] = []
    for index, path in enumerate(found):
        current = index < PACKAGE_SLOTS
        rows.append({
            "path": str(path),
            "allocated_bytes": budget.allocated_bytes([path]),
            "retention": "current_slot" if current else "over_cap",
            "reason": "newest two package directories" if current else "exceeds the two-slot package cap",
        })
    return rows


def vm_rows(root: Path) -> tuple[list[dict[str, object]], int]:
    if not root.exists():
        return [], 0
    if root.is_symlink():
        raise RuntimeError(f"VM root is a symlink: {root}")
    rows: list[dict[str, object]] = []
    for child in sorted(root.iterdir()):
        if child.is_symlink() or not child.is_dir():
            continue
        owner: dict[str, object] | None = None
        owner_path = child / "owner.json"
        if owner_path.is_file() and not owner_path.is_symlink():
            try:
                parsed = json.loads(owner_path.read_text())
            except (OSError, json.JSONDecodeError):
                owner = {"unreadable": True}
            else:
                if isinstance(parsed, dict):
                    owner = {key: parsed.get(key) for key in ("vm_id", "profile_id", "profile_path")}
                else:
                    owner = {"unreadable": True}
        rows.append({"path": str(child), "owner": owner})
    return rows, int(_budget().allocated_bytes([root]))


def temp_rows(root: Path) -> list[dict[str, object]]:
    if not root.exists():
        return []
    directory = root.resolve() if root.is_symlink() else root
    rows: list[dict[str, object]] = []
    for child in directory.iterdir():
        if child.is_symlink() or not child.is_dir() or not child.name.startswith(("am2-", "amcu-")):
            continue
        rows.append({"path": str(child), "name": child.name})
    return rows


def assemble(
    processes: list[ProcessRow], *, free_bytes: int, artifact_roots: list[Path], vm_root: Path, temp_root: Path,
) -> Report:
    annotated = annotate(processes)
    leaks = [row for row in annotated if row["disposition"] == "leak"]
    observed = [row for row in annotated if row["disposition"] == "observed"]
    directories, vm_bytes = vm_rows(vm_root)
    temps = temp_rows(temp_root)
    packages = package_rows(artifact_roots)
    over_cap = any(row["retention"] == "over_cap" for row in packages)
    level = disk_level(free_bytes)
    reclaimed = not leaks and not directories and not temps and not over_cap
    return {
        "scope": SCOPE,
        "checked": list(CHECKED),
        "free_bytes": free_bytes,
        "free_gib": _gib(free_bytes),
        "disk_level": level,
        "artifact_bytes": int(_budget().allocated_bytes(_topmost(artifact_roots))),
        "vm_bytes": vm_bytes,
        "leaks": leaks,
        "observed": observed,
        "vm_dirs": directories,
        "temp_dirs": temps,
        "packages": packages,
        "reclaimed": reclaimed,
        "build_allowed": reclaimed and level != "stop",
        "deletion": "not_performed",
        "note": NOTE,
        "vm_steps": list(VM_STEPS),
    }


def live_processes() -> list[ProcessRow]:
    import psutil

    rows: list[ProcessRow] = []
    for proc in psutil.process_iter(["pid", "ppid", "cmdline"]):
        try:
            info = proc.info
            raw = info.get("cmdline") or []
            if not isinstance(raw, list):
                continue
            pid = info.get("pid")
            ppid = info.get("ppid")
            if not isinstance(pid, int) or not isinstance(ppid, int):
                continue
            try:
                cwd = proc.cwd()
            except (psutil.Error, OSError):
                cwd = ""
            rows.append({"pid": pid, "ppid": ppid, "argv": [str(token) for token in raw], "cwd": cwd})
        except (psutil.Error, OSError):
            continue
    return rows


def collect(
    *,
    processes: list[ProcessRow] | None = None,
    free_bytes: int | None = None,
    artifact_roots: list[Path] | None = None,
    extra_artifact_roots: list[Path] | None = None,
    vm_root: Path | None = None,
    temp_root: Path | None = None,
) -> Report:
    rows = live_processes() if processes is None else processes
    roots = list(artifact_roots) if artifact_roots is not None else [REPO / ".artifacts", *(extra_artifact_roots or [])]
    if artifact_roots is not None and extra_artifact_roots:
        roots.extend(extra_artifact_roots)
    available = _budget().free_bytes([REPO, Path.home()]) if free_bytes is None else free_bytes
    return assemble(
        rows,
        free_bytes=available,
        artifact_roots=roots,
        vm_root=vm_root if vm_root is not None else Path.home() / ".amazme-vm",
        temp_root=temp_root if temp_root is not None else Path("/tmp"),
    )


def scan() -> tuple[Report, list[ProcessRow]]:
    rows = live_processes()
    return collect(processes=rows), rows


def ledger_path(root: Path | None = None) -> Path:
    base = root if root is not None else REPO / ".artifacts"
    return base / "resource-ledger.jsonl"


def record(
    report: dict[str, object], *, purpose: str, event: str, ledger: Path | None = None,
    before: dict[str, object] | None = None, retired: list[str] | None = None,
) -> None:
    path = ledger if ledger is not None else ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    row: dict[str, object] = {
        "unix": time.time(),
        "purpose": purpose,
        "event": event,
        "free_bytes": report.get("free_bytes"),
        "disk_level": report.get("disk_level"),
        "artifact_bytes": report.get("artifact_bytes"),
        "vm_bytes": report.get("vm_bytes"),
        "reclaimed": report.get("reclaimed"),
        "build_allowed": report.get("build_allowed"),
        "leaks": report.get("leaks", []),
        "observed": report.get("observed", []),
        "vm_dirs": report.get("vm_dirs", []),
        "temp_dirs": report.get("temp_dirs", []),
        "packages": report.get("packages", []),
        "scope": report.get("scope"),
        "note": report.get("note"),
        "vm_steps": report.get("vm_steps"),
        "deletion": "not_performed",
    }
    if before is not None:
        row["free_before"] = before.get("free_bytes")
        row["artifact_before"] = before.get("artifact_bytes")
        row["vm_before"] = before.get("vm_bytes")
    if retired:
        row["retired"] = retired
        row["deletion"] = "unused_directories"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def refuse_message(report: dict[str, object]) -> str:
    payload = {
        "event": "resource_census",
        "build_allowed": report.get("build_allowed", False),
        "reclaimed": report.get("reclaimed", False),
        "disk_level": report.get("disk_level"),
        "free_bytes": report.get("free_bytes"),
        "scope": report.get("scope", SCOPE),
        "leaks": report.get("leaks", report.get("processes", [])),
        "vm_dirs": report.get("vm_dirs", report.get("new_vm_dirs", [])),
        "temp_dirs": report.get("temp_dirs", report.get("new_temp_dirs", [])),
        "packages": report.get("packages", []),
        "deletion": "not_performed",
        "note": report.get("note", NOTE),
        "vm_steps": report.get("vm_steps", VM_STEPS),
    }
    return json.dumps(payload, ensure_ascii=False)


def warn_message(report: dict[str, object]) -> str:
    return json.dumps({
        "event": "disk_warn",
        "free_bytes": report.get("free_bytes"),
        "warn_free_bytes": WARN_FREE_BYTES,
        "stop_free_bytes": stop_free_bytes(),
        "scope": report.get("scope", SCOPE),
    }, ensure_ascii=False)


def admit(report: dict[str, object], *, purpose: str, ledger: Path | None = None) -> None:
    if not report["build_allowed"]:
        record(report, purpose=purpose, event="refused", ledger=ledger)
        raise SystemExit(refuse_message(report))
    record(report, purpose=purpose, event="before", ledger=ledger)
    if report["disk_level"] == "warn":
        print(warn_message(report), file=sys.stderr)


def _path_forms(root: Path) -> set[str]:
    text = str(root)
    forms = {text}
    try:
        forms.add(str(root.resolve()))
    except OSError:
        pass
    mirrored: set[str] = set()
    for form in forms:
        if form.startswith("/tmp/"):
            mirrored.add("/private" + form)
        elif form.startswith("/private/tmp/"):
            mirrored.add(form.removeprefix("/private"))
    forms.update(mirrored)
    return {form for form in forms if form and form != "/"}


def mentions_path(argv: list[str], cwd: str, root: Path) -> bool:
    forms = _path_forms(root)
    if not forms:
        return False
    for token in [*argv, cwd]:
        value = token.split("=", 1)[-1].strip("\"'")
        for form in forms:
            if value == form or value.startswith(form + "/"):
                return True
    return False


def owned_hits(roots: list[Path], processes: list[ProcessRow], self_pid: int) -> list[dict[str, object]]:
    annotated = {int(row["pid"]): row for row in annotate(processes)}
    children: dict[int, list[int]] = {}
    for proc in processes:
        children.setdefault(proc["ppid"], []).append(proc["pid"])
    owned: set[int] = set()
    stack = list(children.get(self_pid, []))
    while stack:
        pid = stack.pop()
        if pid in owned or pid == self_pid:
            continue
        owned.add(pid)
        stack.extend(children.get(pid, []))
    hits: list[dict[str, object]] = []
    seen: set[int] = set()
    for proc in processes:
        if proc["pid"] in seen:
            continue
        row = annotated.get(proc["pid"])
        in_root = any(mentions_path(proc["argv"], proc["cwd"], root) for root in roots)
        browser = _browser_name(_names(proc["argv"]))
        leak = row is not None and row["disposition"] == "leak"
        owned_browser = proc["pid"] in owned and browser
        rooted_headless = in_root and browser and _headless(proc["argv"])
        take = (row is not None and in_root) or (leak and proc["pid"] in owned) or owned_browser or rooted_headless
        if not take:
            continue
        seen.add(proc["pid"])
        hits.append(row or _public(proc, "browser", "leak", "owned"))
    return hits


def owned_after(
    roots: list[Path], report: Report, processes: list[ProcessRow], *,
    before: dict[str, object] | None, self_pid: int | None = None,
) -> dict[str, object]:
    pid = os.getpid() if self_pid is None else self_pid
    hits = owned_hits(roots, processes, pid)
    if before is None:
        new_vms: list[dict[str, object]] = []
        new_temps: list[dict[str, object]] = []
    else:
        old_vms = {str(item["path"]) for item in before.get("vm_dirs", []) if isinstance(item, dict)}
        old_temps = {str(item["path"]) for item in before.get("temp_dirs", []) if isinstance(item, dict)}
        new_vms = [item for item in report["vm_dirs"] if str(item["path"]) not in old_vms]
        new_temps = [item for item in report["temp_dirs"] if str(item["path"]) not in old_temps]
    owned_reclaimed = not hits and not new_vms and not new_temps
    global_reclaimed = bool(report["reclaimed"])
    return {
        "scope": SCOPE,
        "roots": [str(root) for root in roots],
        "owned_reclaimed": owned_reclaimed,
        "global_reclaimed": global_reclaimed,
        "reclaimed": owned_reclaimed and global_reclaimed,
        "processes": hits,
        "new_vm_dirs": new_vms,
        "new_temp_dirs": new_temps,
        "leaks": report["leaks"],
        "vm_dirs": report["vm_dirs"],
        "temp_dirs": report["temp_dirs"],
        "packages": report["packages"],
        "disk_level": report["disk_level"],
        "free_bytes": report["free_bytes"],
        "deletion": "not_performed",
        "note": NOTE,
        "vm_steps": list(VM_STEPS),
    }


def apply_cleanup(runtime: object, report: dict[str, object]) -> BaseException | None:
    pending: BaseException | None = None
    try:
        if runtime is not None:
            close = getattr(runtime, "close")
            close()
    except BaseException as error:
        pending = error
    found = getattr(runtime, "resource_report", None) if runtime is not None else None
    if not isinstance(found, dict):
        found = None
    if found is None:
        report["cleanup"] = {
            "reclaimed": False,
            "owned_reclaimed": False,
            "global_reclaimed": None,
            "scope": "census did not run" if runtime is None else SCOPE,
            "deletion": "not_performed",
            "note": NOTE,
        }
        if pending is None:
            pending = RuntimeError(refuse_message(report["cleanup"]))
    else:
        report["cleanup"] = found
        if not found.get("reclaimed", False) and pending is None:
            pending = RuntimeError(refuse_message(found))
    if pending is not None:
        report["status"] = "failed"
        report["cleanup_error"] = f"{type(pending).__name__}: {pending}"
    return pending


def raise_pending(pending: BaseException | None) -> None:
    if pending is not None and sys.exc_info()[0] is None:
        raise pending


def exit_code(report: Report) -> int:
    if not report["build_allowed"]:
        return 1
    if report["disk_level"] == "warn":
        return 2
    return 0


def classified_cwd_unreadable(processes: list[ProcessRow]) -> bool:
    known = {proc["pid"]: proc for proc in processes}
    for row in annotate(processes):
        proc = known.get(int(row["pid"]))
        if proc is not None and proc["cwd"] == "":
            return True
    return False


def _resolved_roots(roots: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_symlink():
            raise RuntimeError(f"deletion root is a symlink: {root}")
        resolved.append(root.resolve())
    return resolved


def _deletable(path: Path, roots: list[Path], *, prefix: str, direct: bool) -> bool:
    if not path.name.startswith(prefix) or path.is_symlink() or not path.is_dir():
        return False
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for root in roots:
        if not resolved.is_relative_to(root) or resolved == root:
            continue
        if direct and resolved.parent != root:
            continue
        cursor = path
        safe = True
        while cursor.resolve() != root:
            if cursor.is_symlink() or cursor == cursor.parent:
                safe = False
                break
            cursor = cursor.parent
        if safe:
            return True
    return False


def _in_use(path: Path, processes: list[ProcessRow]) -> bool:
    candidates = [path]
    try:
        resolved = path.resolve()
    except OSError:
        resolved = None
    if resolved is not None and resolved != path:
        candidates.append(resolved)
    return any(mentions_path(proc["argv"], proc["cwd"], candidate) for proc in processes for candidate in candidates)


def _refusal(event: str, payload: dict[str, object]) -> SystemExit:
    removed = payload.get("removed") or []
    body = {
        "event": event,
        "deletion": "partial" if removed else "not_performed",
        "note": NOTE,
        **payload,
    }
    return SystemExit(json.dumps(body, ensure_ascii=False))


def _trim_unused(
    paths: list[Path], processes: list[ProcessRow], *, keep: int, roots: list[Path], prefix: str,
    direct: bool, removed: list[str], event: str, extra: dict[str, object],
) -> list[str]:
    if len(paths) <= keep:
        return removed
    if classified_cwd_unreadable(processes):
        raise _refusal(event + "_cwd_unreadable", {**extra, "removed": list(removed), "keep": keep})
    while len(paths) > keep:
        chosen: int | None = None
        for index in range(len(paths) - 1, keep - 1, -1):
            candidate = paths[index]
            if _deletable(candidate, roots, prefix=prefix, direct=direct) and not _in_use(candidate, processes):
                chosen = index
                break
        if chosen is None:
            break
        shutil.rmtree(paths[chosen])
        removed.append(str(paths[chosen]))
        del paths[chosen]
    if removed:
        print(json.dumps({
            "event": event, "paths": removed, "deletion": "unused_directories", "keep": keep,
        }, ensure_ascii=False), file=sys.stderr)
    if len(paths) > keep:
        raise _refusal(event + "_blocked", {
            **extra, "removed": list(removed), "keep": keep, "remaining": [str(path) for path in paths],
        })
    return removed


def retire_unused_packages(
    report: dict[str, object], processes: list[ProcessRow], *, keep: int, roots: list[Path],
    removed: list[str] | None = None,
) -> list[str]:
    """Drop unused package directories older than the newest ``keep`` entries."""
    if keep < 1:
        raise ValueError("keep at least the newest package slot")
    sink = removed if removed is not None else []
    packages = report.get("packages", [])
    paths = [Path(str(row["path"])) for row in packages if isinstance(row, dict) and row.get("path")]
    return _trim_unused(
        paths, processes, keep=keep, roots=_resolved_roots(roots), prefix="package-", direct=False,
        removed=sink, event="packages_retired", extra={"roots": [str(root) for root in roots]},
    )


def release_named_slot(
    parent: Path, prefix: str, slots: int, processes: list[ProcessRow] | None = None,
) -> list[str]:
    """Make room for one new direct child. Keep the newest ``slots - 1`` directories."""
    if slots < 1:
        raise ValueError("slot count must be positive")
    if not prefix or "/" in prefix or prefix in {".", ".."} or not prefix.endswith("-"):
        raise ValueError("slot prefix must be one path segment ending with '-'")
    if not parent.exists():
        return []
    if parent.is_symlink() or not parent.is_dir():
        raise RuntimeError(f"slot parent is not a real directory: {parent}")
    rows = live_processes() if processes is None else processes
    children = [
        child for child in parent.iterdir()
        if child.is_dir() and not child.is_symlink() and child.name.startswith(prefix)
    ]
    children.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return _trim_unused(
        children, rows, keep=slots - 1, roots=[parent.resolve()], prefix=prefix, direct=True,
        removed=[], event="slot_released", extra={"parent": str(parent), "prefix": prefix, "slots": slots},
    )


def main() -> int:
    report = collect()
    record(report, purpose="census", event="manual")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return exit_code(report)


if __name__ == "__main__":
    raise SystemExit(main())
