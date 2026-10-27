"""Chrome path for a user Python extension and a lost call receipt."""

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime, until


def finish(runtime: Runtime, root: Path, report: dict[str, object]) -> None:
    pending = apply_cleanup(runtime, report)
    (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(root / "report.json", flush=True)
    raise_pending(pending)


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "plugin-page-", 2)
    root = Path(tempfile.mkdtemp(prefix="plugin-page-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    entry = root / "extension.py"
    entry.write_text((ROOT / "backend/tests/helpers/plugin_fixture.py").read_text())
    runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
    report: dict[str, object] = {
        "status": "running", "execution": "chrome-plugin-page", "vm_created": False, "checks": [],
    }
    try:
        runtime.start()
        report["identity"] = {
            "build_id": runtime.ready["build_id"], "url": runtime.ready["url"],
        }
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            try:
                page = context.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(runtime.ready["url"])
                page.locator("#create").click()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                page.locator("#plugins summary").click()
                page.locator("#plugin-name").fill("greeting")
                page.locator("#plugin-entry").fill(str(entry))
                page.locator("#plugin-label").fill('{"label":"page"}')
                page.locator("#plugin-form button").click()
                expect(page.locator("#plugin-state")).to_contain_text("ready", timeout=15000)
                registered = page.locator("#plugin-list").inner_text()
                assert "greeting" in registered
                calls: list[str] = []
                attempts = {"count": 0}

                def lose_first(route) -> None:
                    body = route.request.post_data_json
                    if isinstance(body, dict) and isinstance(body.get("call_id"), str):
                        calls.append(body["call_id"])
                    attempts["count"] += 1
                    if attempts["count"] == 1:
                        route.fetch()
                        route.abort()
                        return
                    route.continue_()

                page.route("**/plugins/**/calls", lose_first)
                page.locator("#plugin-tool").select_option("tool:hello")
                page.locator("#plugin-text").fill('{"name":"Bob"}')
                page.locator("#plugin-call button").click()
                expect(page.locator("#error")).not_to_have_text("", timeout=15000)
                stamp = until(
                    lambda: list(runtime.workspace.glob("effects.txt")),
                    lambda found: len(found) == 1 and found[0].read_text().endswith(":Bob\n"),
                    timeout=20,
                )[0]
                page.locator("#plugin-call button").click()
                expect(page.locator("#plugin-result")).to_contain_text("Hello, Bob!", timeout=15000)
                assert stamp.read_text().splitlines() == [calls[0] + ":Bob"]
                assert len(calls) >= 2 and calls[0] == calls[1]
                page.unroute("**/plugins/**/calls", lose_first)
                assert not errors, errors
                report["checks"].append(
                    "chrome page reused one plugin call after the receipt was lost; the extension effect stayed one line"
                )
                report["page_errors"] = errors
                report["stamp"] = str(stamp.relative_to(root))
            finally:
                context.close()
                browser.close()
        report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        finish(runtime, root, report)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
