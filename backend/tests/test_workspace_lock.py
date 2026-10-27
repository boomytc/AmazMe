"""Real processes must not overlap desktop builds and resource-owning verifiers."""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
from workspace_lock import workspace_lock  # noqa: E402

ROOT = Path(__file__).parents[2]


def test_lock_refuses_competing_verification_and_releases_after_exit(tmp_path):
    helper = ROOT / "backend/tools/workspace_lock.py"
    marker = tmp_path / "ran"
    command = [sys.executable, str(helper), str(tmp_path), sys.executable, "-c",
               "from pathlib import Path; import sys; Path(sys.argv[1]).touch()", str(marker)]
    with workspace_lock(tmp_path):
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0
        assert "已有构建或验证正在运行" in result.stderr
        assert not marker.exists()
    subprocess.run(command, check=True)
    assert marker.exists()


def test_real_verifier_entrypoints_refuse_a_live_build_lock():
    with workspace_lock(ROOT):
        for name in ("verify_electron.py", "verify_desktop_restart.py", "verify_web.py", "package_backend.py"):
            result = subprocess.run([sys.executable, str(ROOT / "backend/tools" / name), "--help"],
                                    capture_output=True, text=True, timeout=15)
            assert result.returncode != 0
            assert "已有构建或验证正在运行" in result.stderr
        for package in ("web", "gui", "codemode"):
            for task in ("build", "clean"):
                result = subprocess.run(["npm", "run", task, "--workspace", "@amazme/" + package],
                                        cwd=ROOT, capture_output=True, text=True, timeout=15)
                assert result.returncode != 0
                assert "已有构建或验证正在运行" in result.stderr
                env = dict(os.environ)
                env.pop("AMAZME_WORKSPACE_LOCK_OWNER", None)
                result = subprocess.run(["npm", "run", task + ":unlocked", "--workspace", "@amazme/" + package],
                                        cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
                assert result.returncode != 0
                assert "内部构建任务必须由持锁入口调用" in result.stderr


def test_lock_releases_when_owning_process_is_killed(tmp_path):
    helper = ROOT / "backend/tools/workspace_lock.py"
    marker = tmp_path / "ready"
    owner = subprocess.Popen([sys.executable, str(helper), str(tmp_path), sys.executable, "-c",
                              "from pathlib import Path; import sys,time; Path(sys.argv[1]).touch(); time.sleep(60)", str(marker)])
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and owner.poll() is None and time.monotonic() < deadline:
            time.sleep(.02)
        assert marker.exists()
        with pytest.raises(RuntimeError, match="已有构建或验证正在运行"):
            with workspace_lock(tmp_path):
                pass
        owner.kill()
        owner.wait(timeout=5)
        with workspace_lock(tmp_path):
            pass
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=5)


def test_parallel_desktop_build_is_refused_before_it_writes(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is unavailable")
    project = tmp_path / "project"
    for name in ("dev-desktop.mjs", "build-workspace-dependencies.mjs", "package-artifacts.mjs", "workspace-lock.mjs"):
        target = project / "scripts" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "scripts" / name, target)
    target = project / "backend/tools/workspace_lock.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "backend/tools/workspace_lock.py", target)
    for package, dependencies in (("web", "{}"), ("gui", '{"@amazme/web":"workspace:*"}')):
        directory = project / "packages" / package
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(
            '{"name":"@amazme/' + package + '","scripts":{"build":"build"},"dependencies":' + dependencies + '}')
    ready, release, calls = (tmp_path / name for name in ("ready", "release", "calls"))
    fake_cli = tmp_path / "npm.mjs"
    fake_cli.write_text('''import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [ready, release, calls] = process.env.LOCK_FIXTURE.split("|");
appendFileSync(calls, "build\\n");
writeFileSync(ready, "ready");
while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20));
for (const name of ["packages/gui/dist/main.js", "packages/gui/dist/start.js", "packages/gui/dist/preload.cjs", "packages/gui/dist/updates/update-preload.cjs", "packages/gui/dist/updates/update-window.html", "packages/gui/dist/updates/update-window.js", "packages/web/dist/page/index.html", "packages/web/dist/page/page.js", "packages/web/dist/page/page.css"]) {
  const path = join(process.cwd(), name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "built");
}
''')
    env = {**os.environ, "npm_execpath": str(fake_cli), "LOCK_FIXTURE": f"{ready}|{release}|{calls}"}
    env.pop("AMAZME_WORKSPACE_LOCK_FD", None)
    command = [node, str(project / "scripts/dev-desktop.mjs"), "--build-only"]
    first = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and first.poll() is None and time.monotonic() < deadline:
            time.sleep(.02)
        assert ready.exists(), first.stderr.read() if first.poll() is not None else "build did not start"
        second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        assert second.returncode != 0
        assert "已有构建或验证正在运行" in second.stderr
        assert calls.read_text().splitlines() == ["build"]
        # The build child keeps the lock even if its launcher dies mid-build.
        first.kill()
        first.wait(timeout=5)
        second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        assert second.returncode != 0
        assert "已有构建或验证正在运行" in second.stderr
        release.touch()
        deadline = time.monotonic() + 10
        while True:
            check = subprocess.run([node, str(project / "scripts/dev-desktop.mjs"), "--check-build"],
                                   env=env, capture_output=True, text=True, timeout=10)
            if check.returncode == 0 or time.monotonic() >= deadline:
                break
            time.sleep(.02)
        assert check.returncode == 0, check.stderr
        third = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        assert third.returncode == 0, third.stderr
        assert calls.read_text().splitlines() == ["build", "build"]
    finally:
        release.touch()
        if first.poll() is None:
            first.kill()
            first.wait(timeout=10)
