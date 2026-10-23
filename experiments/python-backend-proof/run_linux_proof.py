"""Create an owned Colima VM; prove container cleanup; remove only that VM.

Colima is a disposable test harness, not a product dependency decision.
No host directory or Docker socket is exposed to the workload containers.
"""

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
(REPO / ".artifacts/python-backend-proof").mkdir(parents=True, exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="linux-", dir=REPO / ".artifacts/python-backend-proof"))
PROFILE = f"amazme-proof-{secrets.token_hex(4)}"
CONTEXT = f"colima-{PROFILE}"
VM_HOME = Path(tempfile.mkdtemp(prefix="amvp-", dir="/tmp"))
RUN_ENV = {**os.environ, "COLIMA_HOME": str(VM_HOME), "LIMA_HOME": str(VM_HOME / "_lima")}
IMAGE = "python@sha256:bf12ecc0bea3f171d55145dd02c78b5eeb09f30ee2ac9cc2b4c9e4e8f5e30741"
REPORT = {
    "status": "running",
    "artifact_root": str(ROOT.relative_to(REPO)),
    "profile": PROFILE,
    "colima_home": str(VM_HOME),
    "source_sha256": {
        name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
        for name in ("run_linux_proof.py", "linux_fixture.py")
    },
    "checks": {},
}
LOG = (ROOT / "commands.log").open("w")


def command(args, timeout=60, check=True, isolated=True):
    LOG.write(json.dumps(args) + "\n")
    LOG.flush()
    result = subprocess.run(
        args, text=True, capture_output=True, timeout=timeout, env=RUN_ENV if isolated else None
    )
    LOG.write(result.stdout + result.stderr)
    LOG.flush()
    if check and result.returncode:
        raise RuntimeError(f"command failed {args[:4]}: {(result.stderr or result.stdout)[-1500:]}")
    return result


def docker(*args, timeout=60, check=True):
    return command(["docker", "--context", CONTEXT, *args], timeout, check)


def guest(*args, check=True):
    return command(["colima", "ssh", "--profile", PROFILE, "--", *args], check=check)


def save():
    (ROOT / "report.json").write_text(json.dumps(REPORT, indent=2) + "\n")


def stage(name):
    print(name, flush=True)
    save()


def inspect(cid):
    return json.loads(docker("inspect", cid).stdout)[0]


def create(scope):
    volume = docker("volume", "create", "--label", f"amazme.proof={PROFILE}").stdout.strip()
    cid = docker(
        "create", "--name", f"{PROFILE}-{scope}", "--label", f"amazme.proof={PROFILE}",
        "--label", f"amazme.scope={scope}", "--restart=no", "--network=none",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m",
        "--read-only", "--mount", f"type=volume,src={volume},dst=/proof",
        IMAGE, "python", "-B", "-c", (HERE / "linux_fixture.py").read_text(),
    ).stdout.strip()
    assert inspect(cid)["State"]["Status"] == "created"
    return cid, volume


def snapshot(volume):
    script = (
        "import json,pathlib; p=pathlib.Path('/proof'); "
        "print(json.dumps({f.name:(f.stat().st_size if f.suffix=='.log' else f.read_text()) "
        "for f in p.iterdir()}))"
    )
    return json.loads(docker(
        "run", "--rm", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--read-only", "--mount", f"type=volume,src={volume},dst=/proof,readonly",
        IMAGE, "python", "-c", script,
    ).stdout)


def permit(cid):
    # Test-only gate. Production must use an authenticated private control channel.
    docker("exec", cid, "python", "-c", "from pathlib import Path; Path('/proof/permit').touch()")


def observe_live(volume):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        first = snapshot(volume)
        if "detached.log" in first and "direct.log" in first:
            time.sleep(0.15)
            second = snapshot(volume)
            assert second["direct.log"] > first["direct.log"]
            assert second["detached.log"] > first["detached.log"]
            assert second["shell.txt"] == "ALPHA\nBETA\n"
            direct = json.loads(second["direct.json"])
            detached = json.loads(second["detached.json"])
            assert direct["sid"] != detached["sid"] and detached["ppid"] == 1
            return {"before": first, "after": second}
    raise TimeoutError("fixture did not write both markers")


def cgroup(cid):
    pid = inspect(cid)["State"]["Pid"]
    text = guest("sudo", "cat", f"/proc/{pid}/cgroup").stdout.strip()
    assert text.startswith("0::/"), text
    path = "/sys/fs/cgroup" + text.split("::", 1)[1]
    assert cid in path, path
    before = guest("sudo", "cat", path + "/cgroup.events").stdout
    assert "populated 1" in before, before
    return {"path": path, "before": before}


def stopped(cid, volume, cg):
    docker("wait", cid)
    state = inspect(cid)["State"]
    assert not state["Running"] and state["Pid"] == 0
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        exists = guest("sudo", "test", "-e", cg["path"] + "/cgroup.events", check=False)
        if exists.returncode == 1:
            cg["after"] = "removed"
            break
        assert exists.returncode == 0
        value = guest("sudo", "cat", cg["path"] + "/cgroup.events").stdout
        if "populated 0" in value:
            cg["after"] = value
            break
        time.sleep(0.05)
    else:
        raise TimeoutError("cgroup is not empty")
    first = snapshot(volume)
    time.sleep(0.3)
    second = snapshot(volume)
    assert first == second, (first, second)
    return {"container_id": cid, "state": state, "cgroup": cg, "stable_markers": second}


def run():
    global IMAGE
    REPORT["initial_context"] = command(["docker", "context", "show"]).stdout.strip()
    REPORT["initial_profiles"] = command(["colima", "list", "--json"], isolated=False).stdout.strip()
    REPORT["colima"] = command(["colima", "version"]).stdout.strip()
    assert PROFILE not in REPORT["initial_profiles"]
    config = VM_HOME / "_lima/_config"
    config.mkdir(parents=True)
    override = """provision:
  - mode: dependency
    skipDefaultDependencyResolution: true
    script: |
      #!/bin/sh
      set -eu
      # No mount or rsync operation is used by this experiment.
      # Fail if the base image lacks the runtime this experiment actually needs.
      for binary in dockerd containerd runc iptables; do command -v "$binary"; done
"""
    (config / "override.yaml").write_text(override)
    (ROOT / "lima-override.yaml").write_text(override)
    REPORT["provisioning"] = "fixed image runtime; skip optional rsync dependency installation"
    stage("starting isolated VM (no host mounts, context unchanged)")
    command([
        "colima", "start", "--profile", PROFILE, "--activate=false", "--ssh-config=false",
        "--template=false", "--mount=none", "--port-forwarder=none", "--binfmt=false",
        "--vm-type=vz", "--arch=aarch64", "--runtime=docker", "--cpus=2", "--memory=2", "--disk=10",
    ], timeout=600)
    REPORT["environment"] = json.loads(docker("info", "--format", "{{json .}}").stdout)
    # Retain only runtime facts, never registry/auth configuration or full host diagnostics.
    REPORT["environment"] = {
        key: REPORT["environment"].get(key)
        for key in ("ServerVersion", "KernelVersion", "OperatingSystem", "Architecture",
                    "CgroupDriver", "CgroupVersion", "SecurityOptions")
    }
    assert REPORT["environment"]["CgroupVersion"] == "2"
    stage("pulling disposable Python fixture image")
    docker("pull", IMAGE, timeout=600)
    image = json.loads(docker("image", "inspect", IMAGE).stdout)[0]
    IMAGE = image["RepoDigests"][0]
    REPORT["image"] = {"digest": IMAGE, "id": image["Id"], "architecture": image["Architecture"]}

    stage("create/register/start gaps and gated cleanup")
    cid, volume = create("never-started")
    found = docker("ps", "-aq", "--no-trunc", "--filter", f"label=amazme.proof={PROFILE}").stdout
    assert cid in found and snapshot(volume) == {}
    docker("rm", cid)
    REPORT["checks"]["created_before_registration"] = {
        "rediscovered_by_label": True, "state": "created", "effects": 0,
        "limit": "simulated lost create receipt; not a production supervisor crash test",
    }
    cid, volume = create("gated")
    docker("start", cid)
    cg = cgroup(cid)
    assert snapshot(volume) == {}
    docker("kill", "--signal=KILL", cid)
    REPORT["checks"]["killed_before_permit"] = stopped(cid, volume, cg)

    stage("controller SIGKILL; recover and terminate detached descendants")
    cid, volume = create("epoch-one")
    controller = subprocess.Popen(
        [sys.executable, "-c", "import subprocess,sys,time; subprocess.run(sys.argv[1:],check=True); "
         "print('ready',flush=True); time.sleep(120)", "docker", "--context", CONTEXT, "start", cid],
        stdout=subprocess.PIPE, stderr=LOG, text=True,
    )
    try:
        # docker start prints the ID before the controller's readiness marker.
        assert controller.stdout.readline().strip() == cid
        assert controller.stdout.readline().strip() == "ready"
        permit(cid)
        live = observe_live(volume)
        cg = cgroup(cid)
        controller.kill()
        controller.wait(timeout=5)
        after_controller_death = observe_live(volume)
        sibling, sibling_volume = create("independent-session")
        docker("start", sibling)
        permit(sibling)
        observe_live(sibling_volume)
        sibling_cg = cgroup(sibling)
        docker("kill", "--signal=KILL", cid)
        cleaned = stopped(cid, volume, cg)
        sibling_still_live = observe_live(sibling_volume)
        REPORT["checks"]["controller_death_cleanup"] = {
            "before": live, "continues_after_controller_sigkill": after_controller_death,
            "cleanup": cleaned, "other_session_unaffected": sibling_still_live,
        }
        next_id, next_volume = create("epoch-two")
        docker("start", next_id)
        permit(next_id)
        new_live = observe_live(next_volume)
        assert snapshot(volume) == cleaned["stable_markers"]
        REPORT["checks"]["new_epoch_after_receipt"] = {
            "new_container": next_id, "new_effects": new_live, "old_markers_unchanged": True,
        }
        next_cg = cgroup(next_id)
        docker("kill", "--signal=KILL", next_id)
        stopped(next_id, next_volume, next_cg)
        docker("kill", "--signal=KILL", sibling)
        stopped(sibling, sibling_volume, sibling_cg)
    finally:
        if controller.poll() is None:
            controller.kill()
            controller.wait(timeout=5)

    stage("VM stop/restart: no automatic execution, boot identity changes")
    reboot_id, reboot_volume = create("vm-restart")
    docker("start", reboot_id)
    permit(reboot_id)
    observe_live(reboot_volume)
    old_boot = guest("cat", "/proc/sys/kernel/random/boot_id").stdout.strip()
    command(["colima", "stop", "--profile", PROFILE], timeout=120)
    command(["colima", "start", "--profile", PROFILE, "--activate=false", "--ssh-config=false"], timeout=180)
    new_boot = guest("cat", "/proc/sys/kernel/random/boot_id").stdout.strip()
    assert old_boot != new_boot
    state = inspect(reboot_id)["State"]
    assert not state["Running"] and state["Pid"] == 0
    first = snapshot(reboot_volume)
    time.sleep(0.3)
    assert first == snapshot(reboot_volume)
    REPORT["checks"]["vm_restart"] = {
        "old_boot": old_boot, "new_boot": new_boot, "restart_policy": "no",
        "state": state, "markers_stable": True,
        "limit": "orderly VM stop/restart; not host power loss or disk corruption",
    }
    REPORT["status"] = "passed_runtime_mechanism_checks"


try:
    run()
except BaseException as error:
    REPORT["status"] = "failed"
    REPORT["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    stage("cleaning owned VM and runtime data")
    cleanup = command(["colima", "delete", "--profile", PROFILE, "--force", "--data"],
                      timeout=180, check=False)
    REPORT["cleanup"] = {"returncode": cleanup.returncode}
    REPORT["owned_profiles_after_delete"] = command(["colima", "list", "--json"]).stdout.strip()
    REPORT["final_profiles"] = command(["colima", "list", "--json"], isolated=False).stdout.strip()
    REPORT["final_context"] = command(["docker", "context", "show"]).stdout.strip()
    if cleanup.returncode or PROFILE in REPORT["owned_profiles_after_delete"]:
        REPORT["status"] = "cleanup_failed"
    if REPORT["final_context"] != REPORT.get("initial_context"):
        REPORT["status"] = "context_changed"
    save()
    LOG.close()
    if REPORT["status"] == "passed_runtime_mechanism_checks":
        shutil.rmtree(VM_HOME)
    print(ROOT / "report.json", flush=True)

if REPORT["status"] != "passed_runtime_mechanism_checks":
    raise SystemExit(1)
