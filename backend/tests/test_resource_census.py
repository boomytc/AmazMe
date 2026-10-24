import importlib.util
import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

SOURCE = Path(__file__).parents[1] / "tools/resource_census.py"
spec = importlib.util.spec_from_file_location("amazme_resource_census", SOURCE)
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)

GIB = 1024**3


def proc(pid: int, ppid: int, argv: list[str], cwd: str = "") -> dict:
    return {"pid": pid, "ppid": ppid, "argv": argv, "cwd": cwd}


def assembled(tmp_path: Path, processes: list[dict], free: int):
    arts = tmp_path / "arts"
    temp = tmp_path / "tmp"
    vm = tmp_path / "vm"
    arts.mkdir()
    temp.mkdir()
    report = census.assemble(
        processes, free_bytes=free, artifact_roots=[arts], vm_root=vm, temp_root=temp,
    )
    return report, arts, vm, temp


def test_disk_lines_match_the_host_floor():
    assert census.WARN_FREE_BYTES == 50 * GIB
    assert census.stop_free_bytes() == 20 * GIB
    assert census.disk_level(census.WARN_FREE_BYTES) == "ok"
    assert census.disk_level(census.WARN_FREE_BYTES - 1) == "warn"
    assert census.disk_level(census.stop_free_bytes()) == "warn"
    assert census.disk_level(census.stop_free_bytes() - 1) == "stop"


def test_supervisor_is_invisible_to_a_serve_only_pattern():
    argv = ["/usr/bin/python", "-m", "amazme_backend", "supervisor", "--profile", "/tmp/am2-x/p"]
    frozen = ["/opt/AmazMe Python 0.1.0/amazme-backend", "supervisor", "--profile", "/tmp/am2-x/p"]
    assert "amazme_backend serve" not in " ".join(argv)
    assert census.classify_argv(argv) == "supervisor"
    assert census.classify_argv(frozen) == "supervisor"
    assert census.classify_argv(["/bin/amazme-backend", "serve", "--profile", "/Users/keep"]) == "serve"


def test_ephemeral_supervisor_and_its_child_block_a_new_build(tmp_path):
    processes = [
        proc(1, 0, ["python", "-m", "amazme_backend", "supervisor", "--profile", "/tmp/am2-x/p"]),
        proc(2, 1, ["sleep", "100"]),
    ]
    report, _arts, _vm, _temp = assembled(tmp_path, processes, 60 * GIB)
    assert {row["pid"] for row in report["leaks"]} == {1, 2}
    assert report["build_allowed"] is False
    assert report["deletion"] == "not_performed"


def test_durable_serve_supervisor_and_worker_stay_observed(tmp_path):
    profile = "/Users/keep/profile"
    processes = [
        proc(3, 0, ["/bin/amazme-backend", "serve", "--profile", profile]),
        proc(4, 3, ["/bin/amazme-backend", "supervisor", "--profile", profile]),
        proc(5, 4, ["/bin/amazme-backend", "worker", "--profile", profile, "--session", "s"]),
        proc(6, 5, ["/bin/amazme-backend", "pty-gate"], cwd="/Users/keep/proj"),
    ]
    report, _arts, _vm, _temp = assembled(tmp_path, processes, 60 * GIB)
    assert report["leaks"] == []
    assert {row["role"] for row in report["observed"]} == {"serve", "supervisor", "worker", "pty-gate"}
    assert report["build_allowed"] is True
    assert census.classify_argv(["amazme-backend", "pty-gate"], cwd="/Users/keep/proj") is None
    assert census.classify_argv(["amazme-backend", "pty-gate"], cwd="/tmp/am2-x/w") is None


def test_lima_hostagent_and_headless_chrome_need_an_owned_path():
    assert census.classify_argv(["limactl", "start", "default"]) is None
    assert census.classify_argv(["/opt/limactl", "start", "/Users/x/.amazme-vm/abc"]) == "lima"
    assert census.classify_argv(["qemu-system-aarch64", "-name", "vm"]) is None
    assert census.classify_argv(["qemu-system-aarch64", "/Users/x/.amazme-vm/abc/disk"]) == "lima"
    hostagent = ["/bundle/.artifacts/pkg/lima-hostagent", "--vm", "/Users/x/.amazme-vm/abc"]
    assert census.classify_argv(hostagent) == "hostagent"
    assert census.classify_argv(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) is None
    headless = ["Google Chrome", "--headless=new", "--user-data-dir=/tmp/am2-x/chrome"]
    assert census.classify_argv(headless) == "browser"


def test_vm_temp_and_extra_packages_block_without_deleting(tmp_path):
    processes: list[dict] = []
    report, arts, vm, temp = assembled(tmp_path, processes, 60 * GIB)
    vm.mkdir()
    instance = vm / "abc"
    instance.mkdir()
    (instance / "owner.json").write_text(json.dumps({
        "vm_id": "vm-1", "profile_id": "profile-1", "profile_path": "/tmp/am2-x/p",
    }))
    (temp / "am2-left").mkdir()
    (temp / "other").mkdir()
    for name, stamp in (("package-old", 1), ("package-mid", 2), ("package-new", 3)):
        path = arts / name
        path.mkdir()
        os.utime(path, (stamp, stamp))
    report = census.assemble([], free_bytes=60 * GIB, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    assert report["reclaimed"] is False
    assert report["build_allowed"] is False
    assert report["deletion"] == "not_performed"
    assert report["vm_dirs"][0]["owner"]["vm_id"] == "vm-1"
    assert [row["name"] for row in report["temp_dirs"]] == ["am2-left"]
    retained = {Path(row["path"]).name: row["retention"] for row in report["packages"]}
    assert retained == {"package-new": "current_slot", "package-mid": "current_slot", "package-old": "over_cap"}
    assert instance.exists()


def test_two_packages_and_warn_disk_can_still_build(tmp_path, capsys):
    _report, arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    for name, stamp in (("package-a", 1), ("package-b", 2)):
        path = arts / name
        path.mkdir()
        os.utime(path, (stamp, stamp))
    report = census.assemble(
        [], free_bytes=census.WARN_FREE_BYTES - 1, artifact_roots=[arts], vm_root=vm, temp_root=temp,
    )
    assert report["disk_level"] == "warn"
    assert report["build_allowed"] is True
    ledger = tmp_path / "ledger.jsonl"
    census.admit(report, purpose="package", ledger=ledger)
    assert "disk_warn" in capsys.readouterr().err
    row = json.loads(ledger.read_text())
    assert row["event"] == "before"
    assert row["deletion"] == "not_performed"


def test_stop_line_refuses_before_work(tmp_path):
    report, _arts, _vm, _temp = assembled(tmp_path, [], census.stop_free_bytes() - 1)
    ledger = tmp_path / "ledger.jsonl"
    with pytest.raises(SystemExit) as caught:
        census.admit(report, purpose="package", ledger=ledger)
    assert "resource_census" in str(caught.value)
    assert json.loads(ledger.read_text())["event"] == "refused"


def test_owned_cleanup_checks_its_roots_and_the_global_scope(tmp_path):
    profile = Path("/tmp/am2-owned/p")
    before, _arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    processes = [
        proc(3, 0, ["/bin/amazme-backend", "serve", "--profile", "/Users/keep/profile"]),
        proc(20, 2, ["python", "-m", "amazme_backend", "supervisor", "--profile", str(profile)]),
        proc(21, 99, ["Google Chrome", "--headless", "--user-data-dir=/tmp/am2-owned/chrome"]),
    ]
    after = census.assemble(processes, free_bytes=60 * GIB, artifact_roots=[_arts], vm_root=vm, temp_root=temp)
    owned = census.owned_after([Path("/tmp/am2-owned"), profile], after, processes, before=before, self_pid=99)
    assert {row["pid"] for row in owned["processes"]} == {20, 21}
    assert owned["global_reclaimed"] is False
    assert owned["reclaimed"] is False
    vm.mkdir()
    (vm / "new").mkdir()
    grown = census.assemble([], free_bytes=60 * GIB, artifact_roots=[_arts], vm_root=vm, temp_root=temp)
    grew = census.owned_after([profile], grown, [], before=before, self_pid=99)
    assert grew["owned_reclaimed"] is False
    assert grew["new_vm_dirs"][0]["path"].endswith("/new")


def test_apply_cleanup_cannot_report_a_bare_success_string():
    class Runtime:
        def __init__(self):
            self.resource_report = {"reclaimed": False, "scope": census.SCOPE, "leaks": [{"role": "supervisor"}]}

        def close(self):
            return None

    report = {"status": "passed"}
    pending = census.apply_cleanup(Runtime(), report)
    assert isinstance(pending, RuntimeError)
    assert report["status"] == "failed"
    assert report["cleanup"]["reclaimed"] is False
    assert "owned processes exited" not in json.dumps(report)
    assert census.CHECKED == ["processes", "vm_dirs", "temp_dirs", "packages", "free_bytes"]
    empty = {"status": "passed"}
    missing = census.apply_cleanup(None, empty)
    assert isinstance(missing, RuntimeError)
    assert empty["cleanup"]["reclaimed"] is False
    assert empty["cleanup"]["scope"] == "census did not run"


def test_vm_root_symlink_is_refused(tmp_path):
    target = tmp_path / "real"
    target.mkdir()
    link = tmp_path / "alias"
    link.symlink_to(target)
    with pytest.raises(RuntimeError, match="symlink"):
        census.vm_rows(link)


def test_exit_code_matches_the_build_gate(tmp_path):
    clean, arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    assert census.exit_code(clean) == 0
    warn = census.assemble([], free_bytes=census.WARN_FREE_BYTES - 1, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    assert warn["build_allowed"] is True
    assert census.exit_code(warn) == 2
    stopped = census.assemble([], free_bytes=census.stop_free_bytes() - 1, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    assert census.exit_code(stopped) == 1
    leaked = census.assemble(
        [proc(1, 0, ["amazme-backend", "supervisor", "--profile", "/tmp/am2-x/p"])],
        free_bytes=census.WARN_FREE_BYTES - 1, artifact_roots=[arts], vm_root=vm, temp_root=temp,
    )
    assert census.exit_code(leaked) == 1
    assert "destroy-vm" not in "\n".join(census.VM_STEPS)
    assert census.VM_STEPS[0].startswith("do not install")
    assert "rmtree" not in census.main.__code__.co_names
    assert "retire_unused_packages" not in census.main.__code__.co_names


def test_session_gates_follow_the_owner_profile(tmp_path):
    profile = "/Users/keep/profile"
    processes = [
        proc(4, 1, ["amazme-backend", "service-runner", "--kind", "pty", "--profile", profile, "--instance", "i"], cwd="/tmp"),
        proc(5, 4, ["amazme-backend", "pty-gate"], cwd="/tmp/am2-workspace"),
        proc(6, 5, ["/bin/sleep", "30"], cwd="/tmp/am2-workspace"),
        proc(7, 1, ["amazme-backend", "execute", "--profile", profile, "--instance", "e"], cwd="/tmp"),
        proc(8, 1, ["amazme-backend", "mcp-gate"], cwd="/Users/keep/proj"),
        proc(9, 1, ["amazme-backend", "service-runner", "--profile", "/tmp/am2-x/p", "--instance", "j"]),
    ]
    report, _arts, _vm, _temp = assembled(tmp_path, processes, 60 * GIB)
    rows = {row["pid"]: row for row in [*report["observed"], *report["leaks"]]}
    assert rows[4]["role"] == "service-runner" and rows[4]["disposition"] == "observed"
    assert rows[5]["role"] == "pty-gate" and rows[5]["disposition"] == "observed" and rows[5]["via"] == "4"
    assert rows[6]["role"] == "descendant" and rows[6]["disposition"] == "observed"
    assert rows[7]["role"] == "execute" and rows[7]["disposition"] == "observed"
    assert rows[8]["role"] == "mcp-gate" and rows[8]["disposition"] == "leak" and rows[8]["via"] == "orphan"
    assert rows[9]["role"] == "service-runner" and rows[9]["disposition"] == "leak"
    assert report["build_allowed"] is False


def test_owned_path_match_is_a_path_boundary(tmp_path):
    before, arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    processes = [proc(20, 2, ["python", "-m", "amazme_backend", "supervisor", "--profile", "/tmp/am2-owned-extra/p"])]
    after = census.assemble(processes, free_bytes=60 * GIB, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    owned = census.owned_after([Path("/tmp/am2-owned")], after, processes, before=before, self_pid=99)
    assert owned["processes"] == []
    assert [row["pid"] for row in owned["leaks"]] == [20]


def test_retire_keeps_the_newest_package_and_anything_in_use(tmp_path):
    report, arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    (temp / "am2-keep").mkdir()
    vm.mkdir()
    kept_vm = vm / "confirmed"
    kept_vm.mkdir()
    old, mid, new = (arts / "package-old", arts / "package-mid", arts / "package-new")
    for index, path in enumerate((old, mid, new), start=1):
        path.mkdir()
        os.utime(path, (index, index))
    outside = tmp_path / "outside"
    outside.mkdir()
    foreign = outside / "package-foreign"
    foreign.mkdir()
    link = arts / "package-link"
    link.symlink_to(outside, target_is_directory=True)
    report = census.assemble([], free_bytes=60 * GIB, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    removed = census.retire_unused_packages(report, [], keep=1, roots=[arts])
    assert removed == [str(old), str(mid)]
    assert new.exists() and not old.exists() and not mid.exists()
    assert foreign.exists() and kept_vm.exists() and (temp / "am2-keep").exists() and link.is_symlink()
    busy = arts / "package-busy"
    busy.mkdir()
    os.utime(busy, (1, 1))
    os.utime(new, (2, 2))
    report = census.assemble([], free_bytes=60 * GIB, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    with pytest.raises(SystemExit, match="blocked"):
        census.retire_unused_packages(report, [proc(3, 0, ["sleep", str(busy)])], keep=1, roots=[arts])
    assert busy.exists() and new.exists()


def test_unreadable_classified_cwd_does_not_delete_packages(tmp_path):
    _report, arts, vm, temp = assembled(tmp_path, [], 60 * GIB)
    old, new = arts / "package-old", arts / "package-new"
    old.mkdir()
    new.mkdir()
    os.utime(old, (1, 1))
    os.utime(new, (2, 2))
    report = census.assemble([], free_bytes=60 * GIB, artifact_roots=[arts], vm_root=vm, temp_root=temp)
    processes = [proc(1, 0, ["amazme-backend", "serve", "--profile", "/Users/keep/profile"], cwd="")]
    with pytest.raises(SystemExit, match="cwd_unreadable"):
        census.retire_unused_packages(report, processes, keep=1, roots=[arts])
    assert old.exists() and new.exists()


def test_release_named_slot_drops_only_unused_older_directories(tmp_path):
    parent = tmp_path / "native"
    parent.mkdir()
    other = parent / "notes"
    other.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = parent / "run-link"
    link.symlink_to(outside, target_is_directory=True)
    old, mid, new = parent / "run-old", parent / "run-mid", parent / "run-new"
    for index, path in enumerate((old, mid, new), start=1):
        path.mkdir()
        (path / "report.json").write_text("{}\n")
        os.utime(path, (index, index))
    removed = census.release_named_slot(parent, "run-", 2, [])
    assert removed == [str(old), str(mid)]
    assert new.exists() and not old.exists() and not mid.exists()
    assert other.exists() and outside.exists() and link.is_symlink()

    blocked = tmp_path / "blocked"
    blocked.mkdir()
    pinned, newer, newest = blocked / "run-pinned", blocked / "run-newer", blocked / "run-newest"
    for index, path in enumerate((pinned, newer, newest), start=1):
        path.mkdir()
        os.utime(path, (index, index))
    with pytest.raises(SystemExit, match="blocked") as caught:
        census.release_named_slot(blocked, "run-", 2, [proc(4, 0, ["sleep", str(pinned)])])
    assert not newer.exists()
    assert pinned.exists() and newest.exists()
    assert str(pinned) in str(caught.value)


def test_live_processes_keep_durable_profiles_and_report_orphans(tmp_path):
    script = tmp_path / "amazme-backend"
    script.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "service-runner" ]; then\n'
        '  "$0" pty-gate &\n'
        '  /bin/sleep 30 &\n'
        '  wait\n'
        'else\n'
        '  /bin/sleep 30\n'
        'fi\n'
    )
    script.chmod(0o755)
    ephemeral = str(tmp_path / "am2-census-live" / "p")
    procs: list[subprocess.Popen[bytes]] = []

    def spawn(args: list[str], cwd: str) -> subprocess.Popen[bytes]:
        proc = subprocess.Popen(
            [str(script), *args], cwd=cwd, start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        procs.append(proc)
        return proc

    try:
        service = spawn(["service-runner", "--kind", "pty", "--profile", "/Users/keep/profile", "--instance", "i"], "/tmp")
        leaked = spawn(["supervisor", "--profile", ephemeral], "/tmp")
        orphan = spawn(["mcp-gate"], str(tmp_path))
        seen = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            rows = census.live_processes()
            if not all(proc.poll() is None and any(row["pid"] == proc.pid for row in rows) for proc in (service, leaked, orphan)):
                time.sleep(0.05)
                continue
            report = census.assemble(
                rows, free_bytes=60 * GIB, artifact_roots=[tmp_path / "missing-arts"],
                vm_root=tmp_path / "missing-vm", temp_root=tmp_path / "missing-tmp",
            )
            found = {row["pid"]: row for row in [*report["observed"], *report["leaks"]]}
            gates = [row for row in found.values() if row["ppid"] == service.pid and row["role"] == "pty-gate"]
            if service.pid in found and leaked.pid in found and orphan.pid in found and gates:
                seen = found
                break
            time.sleep(0.05)
        assert seen is not None
        assert seen[service.pid]["role"] == "service-runner" and seen[service.pid]["disposition"] == "observed"
        assert seen[leaked.pid]["role"] == "supervisor" and seen[leaked.pid]["disposition"] == "leak"
        assert seen[orphan.pid]["role"] == "mcp-gate" and seen[orphan.pid]["via"] == "orphan"
        assert seen[orphan.pid]["disposition"] == "leak"
        gate = next(row for row in seen.values() if row["ppid"] == service.pid and row["role"] == "pty-gate")
        assert gate["disposition"] == "observed"
    finally:
        for proc in procs:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait(timeout=5)
    alive = {row["pid"] for row in census.live_processes()}
    assert all(proc.pid not in alive for proc in procs)
    assert not (tmp_path / "am2-census-live").exists()
