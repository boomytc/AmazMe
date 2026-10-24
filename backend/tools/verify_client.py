"""P2 real-browser identity/retry proof; UI-only fault injection is explicitly labeled."""

import argparse
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from resource_census import release_named_slot
from verify_runtime import ROOT, Runtime, until
from verify_web import approve_and_finish, assert_protocol, configure_approvals, finish, login, observe


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "client-", 2)
    root = Path(tempfile.mkdtemp(prefix="client-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
    runtime = Runtime(command, root, provider)
    report = {"status":"running", "root":str(root), "checks":[]}
    try:
        configure_approvals(runtime)
        runtime.start()
        report["identity"] = runtime.ready
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width":1440, "height":1000})
            try:
                page = context.new_page()
                page.add_init_script("""(() => {
                    const Original = window.WebSocket;
                    window.testSockets = [];
                    window.WebSocket = class extends Original {
                        constructor(...args) { super(...args); window.testSockets.push(this); }
                    };
                })()""")
                errors, sent, received, _, writes = observe(page)
                login(page, runtime)
                page.locator("#create").click()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                ids = []

                def lose_reply(route):
                    ids.append(route.request.post_data_json["request_id"])
                    response = route.fetch()
                    assert response.status == 202, response.text()
                    route.abort("failed")

                page.route("**/submissions", lose_reply)
                page.locator("#prompt").fill("/shell printf x >> browser-once.txt")
                page.locator("#send").click()
                expect(page.locator("#error")).to_contain_text("沿用原请求 ID")
                page.unroute("**/submissions", lose_reply)
                page.reload()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                expect(page.locator("#prompt")).to_have_value("/shell printf x >> browser-once.txt")
                with page.expect_request("**/submissions") as retry:
                    page.locator("#send").click()
                assert retry.value.post_data_json["request_id"] == ids[0]
                approve_and_finish(page)
                assert (runtime.workspace / "browser-once.txt").read_text() == "x"
                report["checks"].append("accepted reply lost; reload and same-ID retry caused one approved effect")

                page.evaluate("""() => {
                    const original = window.fetch;
                    let once = true;
                    window.fetch = async (...args) => {
                        const result = await original(...args);
                        if (once && String(args[0]).endsWith('/submissions')) {
                            once = false;
                            await new Promise(resolve => { window.releaseSubmission = resolve; });
                        }
                        return result;
                    };
                }""")
                page.locator("#prompt").fill("/shell printf bound > bound.txt")
                with page.expect_request("**/submissions") as held:
                    page.locator("#send").click()
                until(lambda: page.evaluate("() => typeof window.releaseSubmission === 'function'"), bool)
                page.locator("#create").click()
                expect(page.locator("#sessions button")).to_have_count(2)
                expect(page.locator("#connection")).to_have_text("已连接")
                expect(page.locator("#conversation article")).to_have_count(0)
                page.locator("#prompt").fill("第二个会话的草稿")
                page.locator("#sessions button").first.click()
                expect(page.locator("#connection")).to_have_text("已连接")
                page.evaluate("window.releaseSubmission()")
                expect(page.locator("#send")).to_be_enabled()
                expect(page.locator("#prompt")).to_have_value("/shell printf bound > bound.txt")
                assert page.evaluate("JSON.parse(sessionStorage.getItem('pending')).request_id") == held.value.post_data_json["request_id"]
                with page.expect_request("**/submissions") as retry:
                    page.locator("#send").click()
                assert retry.value.post_data_json["request_id"] == held.value.post_data_json["request_id"]
                approve_and_finish(page)
                assert (runtime.workspace / "bound.txt").read_text() == "bound"
                page.locator("#sessions button").nth(1).click()
                expect(page.locator("#connection")).to_have_text("已连接")
                expect(page.locator("#prompt")).to_have_value("第二个会话的草稿")
                page.locator("#sessions button").first.click()
                expect(page.locator("#connection")).to_have_text("已连接")
                report["checks"].append("A-B-A late reply preserved both draft ownership and original retry ID")

                context.set_offline(True)
                page.evaluate("() => window.testSockets.forEach(socket => socket.close())")
                expect(page.locator("#connection")).to_have_text("正在重连")
                expect(page.locator("#send")).to_be_disabled()
                page.wait_for_timeout(1500)
                context.set_offline(False)
                expect(page.locator("#connection")).to_have_text("已连接", timeout=45000)
                expect(page.locator("#conversation article")).to_have_count(2)
                expect(page.locator("#tools")).to_contain_text("bound.txt")
                report["checks"].append("offline reconnect obtained a fresh attachment and restored the full session")

                page.locator("#prompt").fill("/shell printf a >> approval-once.txt")
                page.locator("#send").click()
                expect(page.locator("#approvals article")).to_have_count(1)
                decisions = []

                def lose_approval(route):
                    decisions.append(route.request.post_data_json["decision_id"])
                    response = route.fetch()
                    assert response.status == 202, response.text()
                    route.abort("failed")

                page.route("**/approvals", lose_approval)
                page.locator("#approvals").get_by_role("button", name="批准", exact=True).click()
                expect(page.locator("#action-retries")).to_contain_text("审批")
                expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=120000)
                page.unroute("**/approvals", lose_approval)
                page.reload()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                with page.expect_request("**/approvals") as retried:
                    page.locator("#action-retries button").click()
                assert retried.value.post_data_json["decision_id"] == decisions[0]
                expect(page.locator("#action-retries button")).to_have_count(0)
                assert (runtime.workspace / "approval-once.txt").read_text() == "a"
                report["checks"].append("lost approval response retained the same decision ID across reload")

                page.route("**/submissions", lambda route: route.fulfill(status=422, content_type="application/json", body='{"message":"rejected"}'))
                page.locator("#prompt").fill("bad input")
                page.locator("#send").click()
                expect(page.locator("#error")).to_have_text("rejected")
                assert page.evaluate("sessionStorage.getItem('pending')") is None
                page.unroute("**/submissions")
                report["checks"].append("definitive rejection released the pending request for editing")

                note = runtime.workspace / "browser-note.txt"
                note.write_text("before\n")
                page.locator("#prompt").fill('/write {"path":"browser-note.txt","content":"after\\n"}')
                page.locator("#send").click()
                approve_and_finish(page)
                assert note.read_text() == "after\n"
                page.locator("#files").evaluate("node => node.open = true")
                page.locator("#file-list").get_by_role("button", name="browser-note.txt", exact=True).click()
                expect(page.locator("#file-content")).to_have_value("after\n")
                expect(page.locator("#checkpoint-state")).to_contain_text("browser-note.txt")
                page.locator("#checkpoint-preview").click()
                expect(page.locator("#file-diff")).to_contain_text("before")
                expect(page.locator("#file-content")).to_have_value("after\n")
                page.locator("#checkpoint-restore").click()
                expect(page.locator("#file-content")).to_have_value("before\n")
                assert note.read_text() == "before\n"
                report["checks"].append("live native file write auto-checkpoint discovered; preview preserved editor; restore changed only selected file")

                def frozen_health(route):
                    response = route.fetch()
                    value = response.json()
                    value["state"] = "frozen"
                    route.fulfill(response=response, json=value)

                page.route("**/api/v1/health", frozen_health)
                expect(page.locator("#recovery")).to_contain_text("普通网页无法解除冻结", timeout=10000)
                expect(page.locator("#send")).to_be_disabled()
                expect(page.get_by_role("button", name="完成更新")).to_have_count(0)
                # This is a real auth rejection, without the private control credential.
                response = context.request.post(runtime.ready["url"] + "/control/updates/complete",
                                                data={"update_id":"forbidden", "expected_revision":"0"},
                                                headers={"Origin":runtime.ready["url"]})
                assert response.status == 401
                page.unroute("**/api/v1/health", frozen_health)
                report["checks"].append("injected frozen health disabled writes; real browser credential could not complete update")
                assert_protocol(sent, received, writes, runtime.ready["build_id"])
                assert not errors, errors
                report.update(page_errors=errors, browser=browser.version)
                page.screenshot(path=str(root / "client.png"), full_page=True)
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
    main()
