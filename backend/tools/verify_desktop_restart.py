"""Verify a desktop upgrade against state created by the real preceding desktop.

Both builds and the profile are disposable. Historical revisions can be
selected without changing the checkout.
"""

import argparse
import json
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright
from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_electron import PYTHON, ElectronRun, free_port, product_pages
from verify_runtime import ROOT, until


def prepare_builds(root: Path, candidate_ref: str | None, previous_ref: str | None) -> tuple[Path, Path]:
    def copy_build(destination: Path, ref: str | None) -> None:
        destination.mkdir()
        if ref:
            archive = root / (destination.name + ".tar")
            subprocess.run(["git", "archive", "--format=tar", "--output", str(archive), ref, "--",
                            "backend/src/amazme_backend", "backend/uv.lock"], cwd=ROOT, check=True)
            subprocess.run(["tar", "-xf", str(archive), "-C", str(destination)], check=True)
            archive.unlink()
        else:
            (destination / "backend/src").mkdir(parents=True)
            shutil.copytree(ROOT / "backend/src/amazme_backend", destination / "backend/src/amazme_backend",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            shutil.copy2(ROOT / "backend/uv.lock", destination / "backend/uv.lock")
        (destination / "packages").symlink_to(ROOT / "packages", target_is_directory=True)

    candidate = root / "candidate"
    copy_build(candidate, candidate_ref)
    previous = root / "previous"
    if previous_ref:
        copy_build(previous, previous_ref)
    else:
        shutil.copytree(candidate, previous, symlinks=True)
    if not previous_ref:
        identity = previous / "backend/src/amazme_backend/platform/identity.py"
        with identity.open("a") as stream:
            stream.write("\n# Disposable previous build for restart verification.\n")
    wrappers = []
    for name, build in (("previous", previous), ("candidate", candidate)):
        wrapper = root / (name + "-backend")
        wrapper.write_text("#!/bin/sh\nexport PYTHONPATH=" + shlex.quote(str(build / "backend/src"))
                           + "\nexec " + shlex.quote(str(PYTHON)) + ' -m amazme_backend "$@"\n')
        wrapper.chmod(0o755)
        wrappers.append(wrapper)
    return wrappers[0], wrappers[1]


def create_chat(page) -> str:
    expect(page.locator("#new-chat")).to_be_enabled(timeout=30000)
    with page.expect_response(lambda response: response.request.method == "POST"
                              and response.url.endswith("/api/v1/sessions"), timeout=30000) as response:
        page.locator("#new-chat").click()
    result = response.value
    assert result.status == 201, result.text()
    session = result.json()["session_id"]
    try:
        until(lambda: page.evaluate("new URL(location.href).searchParams.get('session')"),
              lambda value: value == session, timeout=30)
    except AssertionError as error:
        raise AssertionError(f"new chat {session} was not selected; url={page.url}; "
                             f"location={page.evaluate('location.href')}; "
                             f"status={page.locator('#connection-status-text').inner_text()}; "
                             f"page={page.locator('body').inner_text()[-1200:]}") from error
    expect(page.locator("#prompt")).to_be_enabled(timeout=30000)
    expect(page.locator("#new-chat")).to_be_enabled(timeout=30000)
    return session


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-ref", help="Test a historical backend revision in a disposable copy")
    parser.add_argument("--previous-ref", help="Create initial state with a historical backend revision")
    args = parser.parse_args()
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "desktop-restart-", 2)
    root = Path(tempfile.mkdtemp(prefix="desktop-restart-", dir=parent))
    workspace = root / "workspace"
    workspace.mkdir()
    (root / "agent").mkdir()
    runtimes: list[ElectronRun] = []
    checks: list[str] = []
    report: dict[str, object] = {"status": "running", "candidate_ref": args.candidate_ref or "current",
                                 "previous_ref": args.previous_ref or "candidate", "checks": checks}
    budget = ResourceBudget([root], limit_bytes=512 * 1024**2, deadline_seconds=240)
    pending: BaseException | None = None
    try:
        with budget:
            runtime = ElectronRun(root, workspace, root / "previous-backend")
            runtimes.append(runtime)
            _, candidate = prepare_builds(root, args.candidate_ref, args.previous_ref)
            port = free_port()
            runtime.start(port)
            profile = root / "python-profile"
            headers = {"Authorization": "Bearer " + (profile / "web.token").read_text().strip()}
            with httpx.Client(base_url=runtime.origin, headers=headers, timeout=30, trust_env=False) as client:
                old_build = client.get("/api/v1/bootstrap").json()["build_id"]
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                    page = until(lambda: product_pages(browser), bool, timeout=30)[0]
                    expect(page.locator("#connection-status")).to_have_attribute("data-state", "connected", timeout=30000)
                    saved = create_chat(page)
                    page.locator("#prompt").fill("重启后保留的消息")
                    page.locator("#primary").click()
                    expect(page.locator("#transcript")).to_contain_text("已收到：重启后保留的消息", timeout=30000)
                    empty = create_chat(page)
                    assert empty != saved
                    assert create_chat(page) == empty
                    checks.append("desktop reuses the empty chat after retaining a sent conversation")
                runtime.quit()
            runtime = ElectronRun(root, workspace, candidate)
            runtimes.append(runtime)
            port = free_port()
            runtime.start(port)
            with httpx.Client(base_url=runtime.origin, headers=headers, timeout=30, trust_env=False) as client:
                boot = client.get("/api/v1/bootstrap").json()
                assert boot["build_id"] != old_build
                health = client.get("/api/v1/health").json()
                assert health["state"] == "ready" and health["update"] is None, health
                sessions = client.get("/api/v1/sessions").json()["sessions"]
                assert {item["session_id"] for item in sessions} == {saved}, sessions
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                    page = until(lambda: product_pages(browser), bool, timeout=30)[0]
                    expect(page.locator("#prompt")).to_be_enabled(timeout=30000)
                    expect(page.locator("#transcript")).to_contain_text("重启后保留的消息", timeout=30000)
                    assert page.evaluate("new URL(location.href).searchParams.get('session')") == saved
                checks.append("new build activates and restores the sent conversation without the empty chat")
            runtime.quit()
            report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        pending = error
    finally:
        report["budget"] = budget.snapshot()
        for runtime in reversed(runtimes):
            cleanup_error = apply_cleanup(runtime, report)
            pending = pending or cleanup_error
        (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(root / "report.json")
        raise_pending(pending)


if __name__ == "__main__":
    main()
