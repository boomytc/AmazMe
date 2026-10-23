"""Exercise ambiguous replies, reconnect and conversation ownership in real Chrome."""

import argparse
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from verify_runtime import ROOT, Runtime, daemon_command, until


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".artifacts/python-backend-p1"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="client-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
    runtime = Runtime(command, root, provider)
    report = {"status": "running", "root": str(root), "checks": []}
    try:
        runtime.start()
        report["identity"] = runtime.ready
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.add_init_script("""(() => {
                const Original = window.WebSocket;
                window.testSockets = [];
                window.WebSocket = class extends Original {
                    constructor(...args) { super(...args); window.testSockets.push(this); }
                };
            })()""")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(runtime.ready["url"])
            page.get_by_label("输入本机配对码").fill((runtime.profile / "web.token").read_text())
            page.get_by_role("button", name="连接", exact=True).click()
            expect(page.locator("#login")).to_be_hidden()
            page.locator("#create").click()
            expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)

            ids = []

            def lose_reply(route):
                ids.append(route.request.post_data_json["request_id"])
                response = route.fetch()
                assert response.status == 202
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
            expect(page.locator("#send")).to_be_enabled()
            expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=30000)
            assert (runtime.workspace / "browser-once.txt").read_text() == "x"
            report["checks"].append("accepted reply lost, reload and same-ID retry produced one effect")

            # Hold only the reply in the client; the real HTTP submission still commits.
            page.evaluate("""() => {
                const original = window.fetch;
                window.fetch = async (...args) => {
                    const result = await original(...args);
                    if (String(args[0]).endsWith('/submissions'))
                        await new Promise(resolve => { window.releaseSubmission = resolve; });
                    return result;
                };
            }""")
            page.locator("#prompt").fill("/shell printf bound > bound.txt")
            page.locator("#send").click()
            until(lambda: page.evaluate("() => typeof window.releaseSubmission === 'function'"), bool)
            page.locator("#create").click()
            expect(page.locator("#sessions button")).to_have_count(2)
            expect(page.locator("#connection")).to_have_text("已连接")
            expect(page.locator("#conversation article")).to_have_count(0)
            page.locator("#prompt").fill("第二个会话的草稿")
            page.evaluate("window.releaseSubmission()")
            expect(page.locator("#send")).to_be_enabled()
            expect(page.locator("#prompt")).to_have_value("第二个会话的草稿")
            page.locator("#sessions button").first.click()
            expect(page.locator("#conversation article")).to_have_count(2)
            expect(page.locator("#prompt")).to_have_value("")
            until(lambda: (runtime.workspace / "bound.txt").exists(), bool)
            report["checks"].append("late submission reply preserved the other conversation draft")

            context.set_offline(True)
            page.evaluate("() => window.testSockets.forEach(socket => socket.close())")
            expect(page.locator("#connection")).to_have_text("正在重连")
            page.wait_for_timeout(3200)
            context.set_offline(False)
            # Explicit reload is unnecessary: the client retries until both HTTP and WS recover.
            expect(page.locator("#connection")).to_have_text("已连接", timeout=15000)
            expect(page.locator("#conversation article")).to_have_count(2)
            expect(page.locator("#tools")).to_contain_text("bound.txt")
            report["checks"].append("offline reconnect restored receipts and tool snapshot")

            page.reload()
            expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
            page.route("**/submissions", lambda route: route.fulfill(status=422, content_type="application/json", body='{"message":"rejected"}'))
            page.locator("#prompt").fill("bad input")
            page.locator("#send").click()
            expect(page.locator("#error")).to_have_text("rejected")
            assert page.evaluate("sessionStorage.getItem('pending')") is None
            page.unroute("**/submissions")
            page.locator("#prompt").fill("/shell printf corrected > corrected.txt")
            page.locator("#send").click()
            expect(page.locator("#conversation article")).to_have_count(3)
            expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=30000)
            assert (runtime.workspace / "corrected.txt").read_text() == "corrected"
            assert not errors, errors
            report["checks"].append("definitive rejection allowed a corrected new submission")
            page.locator("#prompt").fill("/shell " + daemon_command("live-cleanup.log"))
            page.locator("#send").click()
            marker = runtime.workspace / "live-cleanup.log"
            until(lambda: marker.stat().st_size if marker.exists() else 0, lambda size: size > 4)
            session = runtime.client.get("/api/v1/sessions").json()["sessions"][0]["session_id"]
            control = Path(runtime.worker(session)[2]).parent / "vm/execution/sock/docker.sock"
            held = control.with_name("docker.held.sock")
            control.rename(held)
            try:
                page.wait_for_timeout(6000)
                page.locator("#cancel").click()
                expect(page.locator("#state")).to_have_text("等待清理", timeout=15000)
                expect(page.locator("#conversation .status").last).to_contain_text("正在清理")
                expect(page.locator("#conversation .status").last).to_contain_text("execution_cleanup_pending")
                report["checks"].append("cleanup failure reached the visible page without reload")
            finally:
                held.rename(control)
            assert not errors, errors
            report["page_errors"] = errors
            report["browser"] = browser.version
            context.close()
            browser.close()
        report["status"] = "passed"
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            runtime.close()
            report["cleanup"] = "browser, owned services and VM closed"
        except BaseException as error:
            report["status"] = "failed"
            report["cleanup_error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
            print(root / "report.json", flush=True)


if __name__ == "__main__":
    main()
