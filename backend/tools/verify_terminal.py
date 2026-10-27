"""Real Chrome/native PTY lifecycle and lost-input-receipt verification, without a VM."""
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from resource_budget import ResourceBudget
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime, until
from verify_web import login


def main():
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "terminal-", 2)
    root = Path(tempfile.mkdtemp(prefix="terminal-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    report = {"status": "running", "execution": "native", "vm_created": False, "checks": []}
    runtime = None
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=120)
    try:
        with budget:
            runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
            runtime.start()
            report["identity"] = runtime.ready
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    page = browser.new_page(viewport={"width": 1440, "height": 1000})
                    errors, inputs = [], []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    login(page, runtime)
                    page.locator("#create").click()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    page.locator("#terminal summary").click()
                    expect(page.locator("#terminal-state")).to_have_text("尚无终端，点击新建")
                    page.locator("#terminal-new").click()
                    expect(page.locator("#terminal-state")).to_have_text("运行中")
                    session = page.url.split("session=")[1].split("&")[0]
                    base = f"/api/v1/sessions/{session}/terminals"
                    rows = runtime.client.get(base).json()["terminals"]
                    assert len(rows) == 1
                    terminal_id = rows[0]["terminal_id"]
                    report["checks"].append("explicit create starts one native terminal; opening the panel itself starts none")

                    def lost_once(route):
                        inputs.append(route.request.post_data_json["input_id"])
                        if len(inputs) == 1:
                            route.fetch()
                            route.abort()
                        else:
                            route.continue_()

                    page.route("**/terminals/*/input", lost_once)
                    command = "printf x >> terminal-once.txt; pwd; command -v git; printf 'NATIVE_TERM_OK\\n'"
                    page.locator("#terminal-input").fill(command)
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#error")).not_to_be_empty()
                    until(lambda: (runtime.workspace / "terminal-once.txt").exists(), bool)
                    page.reload()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    page.locator("#terminal summary").click()
                    expect(page.locator("#terminal-input")).to_have_value(command)
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-input")).to_have_value("")
                    expect(page.locator("#terminal-output")).to_contain_text("NATIVE_TERM_OK")
                    expect(page.locator("#terminal-output .xterm")).to_be_visible()
                    expect(page.locator("#terminal-output")).to_contain_text(str(runtime.workspace))
                    assert len(inputs) == 2 and inputs[0] == inputs[1]
                    assert (runtime.workspace / "terminal-once.txt").read_text() == "x"
                    rows = runtime.client.get(base).json()["terminals"]
                    assert len(rows) == 1 and rows[0]["terminal_id"] == terminal_id
                    report["checks"].append("lost input response + page reload retained input ID and terminal; one actual file effect")

                    page.locator("#terminal-input").fill("printf '\\033[31mRED\\033[0m'")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-output .xterm-fg-1")).to_be_visible(timeout=15000)
                    expect(page.locator("#terminal-output")).to_contain_text("RED")
                    report["checks"].append("xterm DOM painted the shell output and a red cell")

                    page.unroute("**/terminals/*/input", lost_once)
                    page.locator("#terminal-input").fill("printf '\\033[?1000h\\033[?1006h'")
                    page.locator("#terminal-form button").first.click()
                    until(lambda: runtime.client.post(
                        base + "/" + terminal_id + "/read", json={}, headers=runtime.attach(session)
                    ).json().get("output", ""), lambda value: "1006" in value)
                    page.wait_for_timeout(1200)
                    mouse_reports: list[str] = []

                    def capture_mouse(route) -> None:
                        body = route.request.post_data_json or {}
                        data = body.get("data") if isinstance(body, dict) else ""
                        if isinstance(data, str):
                            mouse_reports.append(data)
                        route.continue_()

                    page.route("**/terminals/*/input", capture_mouse)
                    page.locator("#terminal-output .xterm-rows").click()
                    until(lambda: list(mouse_reports), lambda rows: any(item.startswith("\x1b[<") for item in rows))
                    page.unroute("**/terminals/*/input", capture_mouse)
                    report["checks"].append("xterm mouse report reached the terminal input ledger")
                    newline = runtime.client.post(
                        base + "/" + terminal_id + "/input",
                        json={"input_id": "e" * 32, "data": "\n"},
                        headers=runtime.attach(session),
                    )
                    assert newline.status_code == 200, newline.text
                    expect(page.locator("#terminal-output")).to_contain_text("command not found", timeout=15000)

                    page.locator("#terminal-resize").click()
                    until(lambda: runtime.client.get(base).json()["terminals"][0]["cols"], lambda v: v == 100)
                    page.locator("#terminal-input").fill("stty size")
                    page.locator("#terminal-form button").first.click()
                    expect(page.locator("#terminal-output")).to_contain_text("40 100")
                    page.screenshot(path=str(root / "terminal.png"), full_page=True)
                    page.close()
                    response = runtime.client.post(base + "/" + terminal_id + "/read", json={}, headers=runtime.attach(session))
                    assert response.status_code == 200 and response.json()["phase"] == "running", response.text
                    response = runtime.client.post(base + "/" + terminal_id + "/close", json={}, headers=runtime.attach(session))
                    assert response.status_code == 200 and response.json()["clean"], response.text
                    assert response.json()["phase"] == "exited"
                    report["checks"].append("native resize observed through stty; browser close preserved terminal; explicit close confirmed known cleanup")
                    assert not errors, errors
                    report.update(browser=browser.version, page_errors=errors)
                finally:
                    browser.close()
            report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        report["budget"] = budget.snapshot()
        pending = apply_cleanup(runtime, report)
        (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(root / "report.json")
        raise_pending(pending)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
