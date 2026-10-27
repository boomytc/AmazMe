"""Verify session drafts and deletion in the built page against a real local Host."""

import json
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "session-page-", 2)
    root = Path(tempfile.mkdtemp(prefix="session-page-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
    checks: list[str] = []
    report: dict[str, object] = {"status": "running", "checks": checks, "root": str(root)}
    try:
        runtime.start()
        sessions: list[str] = []
        for title in ("A", "B"):
            response = runtime.client.post("/api/v1/sessions", json={"title": title})
            response.raise_for_status()
            sessions.append(response.json()["session_id"])
        a, b = sessions
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            try:
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN")
                try:
                    page = context.new_page()
                    errors: list[str] = []
                    requests: list[tuple[str, str]] = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: requests.append((request.method, urlsplit(request.url).path)))
                    page.goto(runtime.ready["url"] + "?session=" + a)
                    connected = page.locator("#connection-status")
                    expect(connected).to_have_attribute("data-state", "connected", timeout=30000)
                    prompt = page.locator("#prompt")
                    prompt.fill("A draft")
                    page.locator(f'[data-session-id="{b}"] .session-select').click()
                    expect(connected).to_have_attribute("data-state", "connected")
                    expect(prompt).to_have_value("")
                    prompt.fill("B draft")
                    page.locator(f'[data-session-id="{a}"] .session-select').click()
                    expect(connected).to_have_attribute("data-state", "connected")
                    expect(prompt).to_have_value("A draft")
                    checks.append("real Chrome switches sessions without mixing drafts")

                    pending = []

                    def hold_refresh(route):
                        if route.request.method == "GET":
                            pending.append((route, route.fetch()))
                        else:
                            route.continue_()

                    page.route("**/api/v1/sessions", hold_refresh)
                    page.locator(f'[data-session-id="{a}"] .session-more').click()
                    page.locator('[data-action="session:remove"]').click()
                    expect(page.locator("#modal-root")).to_be_visible()
                    mark = len(requests)
                    with page.expect_response(lambda response: response.request.method == "DELETE"
                                              and urlsplit(response.url).path == f"/api/v1/sessions/{a}", timeout=35000) as deleting:
                        page.locator("#modal-root").get_by_role("button", name="删除", exact=True).click()
                    removed = deleting.value
                    report["deletion"] = {"status": removed.status, "body": removed.text()}
                    assert removed.ok, report["deletion"]
                    expect(page.locator(f'[data-session-id="{a}"]')).to_have_count(0)
                    expect(prompt).to_have_value("")
                    expect(page.locator("#primary")).to_be_disabled()
                    assert "session" not in parse_qs(urlsplit(page.url).query)
                    page.wait_for_timeout(3500)  # Cross the former 3-second session poll interval.
                    assert pending, "refresh was not held"
                    late = [(method, path) for method, path in requests[mark:] if a in path and method != "DELETE"]
                    assert not late, late
                    checks.append("confirmed deletion retires the session before list refresh; no late polling or reconnect")

                    for route, response in pending:
                        route.fulfill(response=response)
                    page.unroute("**/api/v1/sessions", hold_refresh)
                    expect(page.locator(f'[data-session-id="{b}"] .session-select')).to_have_attribute("aria-current", "true")
                    expect(connected).to_have_attribute("data-state", "connected")
                    expect(prompt).to_have_value("B draft")
                    remaining = runtime.client.get("/api/v1/sessions").json()["sessions"]
                    assert [row["session_id"] for row in remaining] == [b]
                    assert not (runtime.profile / "sessions" / a).exists()
                    assert not errors, errors
                    checks.append("refresh selects the remaining session with its draft; backend removed only the selected history")
                    page.screenshot(path=str(root / "page.png"))
                    report.update(status="passed", page_errors=errors, late_session_requests=late)
                finally:
                    context.close()
            finally:
                browser.close()
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        pending_cleanup = apply_cleanup(runtime, report)
        (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(root / "report.json", flush=True)
        raise_pending(pending_cleanup)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
