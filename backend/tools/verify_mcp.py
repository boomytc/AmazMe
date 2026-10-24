"""Chrome + official MCP SDK server on the native execution path, bounded and isolated."""
import importlib.metadata
import shlex
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from resource_budget import ResourceBudget
from resource_census import release_named_slot
from verify_runtime import ROOT, Runtime, until
from verify_web import finish, login


def main():
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "mcp-", 2)
    root = Path(tempfile.mkdtemp(prefix="mcp-", dir=parent))
    provider = root / "provider.json"
    provider.write_text('{"provider":"faux"}')
    runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
    report = {"status": "running", "execution": "native", "vm_created": False,
              "sdk": "mcp " + importlib.metadata.version("mcp"), "checks": []}
    budget = ResourceBudget([ROOT / ".artifacts"], limit_bytes=512 * 1024**2, deadline_seconds=120)
    try:
        with budget:
            runtime.start()
            report["identity"] = runtime.ready
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    page = browser.new_page(viewport={"width": 1440, "height": 1000})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    login(page, runtime)
                    page.locator("#create").click()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    session = page.url.split("session=")[1].split("&")[0]
                    endpoint = f"/api/v1/sessions/{session}/mcp"
                    page.locator("#mcp summary").click()
                    command = shlex.join([sys.executable, str(ROOT / "backend/tools/mcp_probe_server.py"),
                                          "--workspace", str(runtime.workspace)])
                    page.locator("#mcp-command").fill(command)
                    page.locator("#mcp-form button").click()
                    expect(page.locator("#mcp-state")).to_contain_text("已连接", timeout=20000)
                    server = runtime.client.get(endpoint).json()["servers"][0]
                    assert server["protocol_version"] in {"2025-11-25", "2025-06-18"}
                    page.get_by_role("button", name="native_echo", exact=True).click()
                    expect(page.locator("#mcp-schema")).to_contain_text('"numbers"')
                    page.locator("#mcp-arguments").fill('{"text":"denied","numbers":[1]}')
                    page.locator("#mcp-request").click()
                    page.get_by_role("button", name="拒绝调用", exact=True).click()
                    expect(page.locator("#mcp-result")).to_contain_text("denied")
                    assert not (runtime.workspace / "mcp-effect.txt").exists()
                    report["checks"].append("official SDK initialized on local Python; schema preserved; denied call had no effect")

                    page.locator("#mcp-arguments").fill('{"text":"x","numbers":[2,3]}')
                    page.locator("#mcp-request").click()
                    expect(page.get_by_role("button", name="批准调用", exact=True)).to_be_visible()
                    page.reload()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    page.locator("#mcp summary").click()
                    expect(page.get_by_role("button", name="批准调用", exact=True)).to_be_visible()
                    decisions = []

                    def lost_reply(route):
                        decisions.append(route.request.post_data_json)
                        if len(decisions) == 1:
                            route.fetch()
                            route.abort()
                        else:
                            route.continue_()

                    page.route("**/mcp/*/calls/*/decision", lost_reply)
                    page.get_by_role("button", name="批准调用", exact=True).click()
                    expect(page.locator("#error")).not_to_be_empty()
                    page.reload()
                    expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                    page.locator("#mcp summary").click()
                    expect(page.locator("#mcp-result")).to_contain_text('"total": 5', timeout=10000)
                    assert (runtime.workspace / "mcp-effect.txt").read_text() == "x"
                    state = runtime.client.get(endpoint).json()
                    done = next(call for call in state["calls"] if call["phase"] == "done")
                    response = runtime.client.post(endpoint + "/" + server["server_id"] + "/calls/" + done["call_id"] + "/decision",
                        json=decisions[0], headers=runtime.attach(session))
                    assert response.status_code == 200 and response.json()["phase"] == "done", response.text
                    assert (runtime.workspace / "mcp-effect.txt").read_text() == "x"
                    assert (runtime.workspace / "mcp-starts.txt").read_text() == "x"
                    report["checks"].append("approval survived refresh; lost decision reply queried after reconnect; same decision caused one effect; structured result preserved")

                    page.get_by_role("button", name="native_wait", exact=True).click()
                    page.locator("#mcp-arguments").fill('{"seconds":60}')
                    page.locator("#mcp-request").click()
                    page.get_by_role("button", name="批准调用", exact=True).click()
                    expect(page.locator("#mcp-result")).to_contain_text("running")
                    page.locator("#mcp-cancel").click()
                    expect(page.locator("#mcp-state")).to_contain_text("已退出", timeout=15000)
                    expect(page.locator("#mcp-result")).to_contain_text("unknown")
                    until(lambda: runtime.client.get(endpoint).json()["servers"][0]["clean"], bool)
                    response = runtime.client.post(endpoint, json={"server_id": server["server_id"], "command": command, "workspace": "primary"}, headers=runtime.attach(session))
                    assert response.status_code == 200 and response.json()["phase"] == "exited", response.text
                    assert (runtime.workspace / "mcp-starts.txt").read_text() == "x"
                    report["checks"].append("in-flight stop confirmed owned process cleanup while call outcome stayed unknown; same service ID never restarted")
                    page.screenshot(path=str(root / "mcp.png"), full_page=True)
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
        finish(runtime, root, report)


if __name__ == "__main__":
    main()
