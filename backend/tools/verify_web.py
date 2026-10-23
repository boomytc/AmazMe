"""Drive the shipped P2 Web client in Chrome. Faux is the credential-free default."""

import argparse
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from verify_runtime import ROOT, Runtime

from amazme_backend.common import private_write


def configure_approvals(runtime):
    """Only the new, unstarted verifier profile is configured here."""
    path = runtime.profile / "config.json"
    config = json.loads(path.read_text())
    config["approval_policy"] = "mutations"
    private_write(path, json.dumps(config))


def login(page, runtime):
    page.goto(runtime.ready["url"])
    page.get_by_label("输入本机配对码").fill((runtime.profile / "web.token").read_text())
    page.get_by_role("button", name="连接", exact=True).click()
    expect(page.locator("#login")).to_be_hidden()


def approve_and_finish(page, *, count=1, timeout=120000):
    for _ in range(count):
        approval = page.locator("#approvals article").first
        expect(approval).to_be_visible(timeout=timeout)
        identity = approval.get_attribute("data-approval-id")
        approval.get_by_role("button", name="批准", exact=True).click()
        expect(page.locator(f'#approvals article[data-approval-id="{identity}"]')).to_have_count(0, timeout=timeout)
    expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=timeout)


def observe(page):
    errors, sent, received, writes = [], [], [], []
    counts = Counter()
    page.on("pageerror", lambda error: errors.append(str(error)))

    def frames(payload, target):
        if not isinstance(payload, str):
            return
        value = json.loads(payload)
        target.append(value)
        for batch in value.get("batches", []):
            for event in batch["events"]:
                counts[event["kind"]] += 1

    def socket(ws):
        ws.on("framesent", lambda payload: frames(payload, sent))
        ws.on("framereceived", lambda payload: frames(payload, received))

    def request(value):
        if value.method == "POST" and "/api/v1/sessions/" in value.url and not value.url.endswith("/attachments"):
            writes.append({"url": value.url, "headers": value.all_headers(), "body": value.post_data_json})

    page.on("websocket", socket)
    page.on("request", request)
    return errors, sent, received, counts, writes


def assert_protocol(sent, received, writes, build):
    hellos = [frame for frame in sent if frame.get("kind") == "hello"]
    acks = [frame for frame in sent if frame.get("kind") == "ack"]
    assert hellos and acks
    assert all(hello["build_id"] == build and hello["binding_id"] for hello in hellos)
    delivered = {(frame["binding_id"], frame["stream_id"], frame["snapshot"]["seq"] if frame.get("snapshot") else frame["batches"][-1]["seq"])
                 for frame in received if frame.get("snapshot") or frame.get("batches")}
    assert all((ack["binding_id"], ack["stream_id"], ack["seq"]) in delivered for ack in acks)
    assert writes and all(value["headers"].get("x-amazme-build") == build and value["headers"].get("x-amazme-epoch")
                          and value["headers"].get("x-amazme-attachment") for value in writes)
    assert not any("/control/" in value["url"] for value in writes)


def finish(runtime, root, report):
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider-config", type=Path, help="Explicit opt-in to a configured real provider")
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    parent = ROOT / ".artifacts/python-backend-p2"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="browser-", dir=parent))
    provider = args.provider_config.resolve() if args.provider_config else root / "faux.json"
    if not args.provider_config:
        provider.write_text('{"provider":"faux"}')
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
    runtime = Runtime(command, root, provider)
    report = {"status":"running", "root":str(root), "provider":"configured" if args.provider_config else "faux", "checks":[]}
    try:
        configure_approvals(runtime)
        runtime.start()
        report["identity"] = runtime.ready
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width":1440, "height":1000})
            try:
                page = context.new_page()
                errors, sent, received, counts, writes = observe(page)
                login(page, runtime)
                page.locator("#create").click()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                prompt = "/shell printf 'AMAZME_P2_VM_OK\\n' > real-proof.txt; cat real-proof.txt"
                if args.provider_config:
                    prompt = "只调用一次 shell 执行：printf 'AMAZME_P2_VM_OK\\n' > real-proof.txt; cat real-proof.txt。报告实际内容。"
                page.locator("#prompt").fill(prompt)
                page.locator("#send").click()
                expect(page.locator("#approvals article")).to_have_count(1, timeout=120000)
                assert not (runtime.workspace / "real-proof.txt").exists()
                page.reload()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                expect(page.locator("#approvals article")).to_have_count(1)
                expect(page.locator("#conversation .status").last).to_contain_text("等待审批")
                approve_and_finish(page)
                assert (runtime.workspace / "real-proof.txt").read_text() == "AMAZME_P2_VM_OK\n"
                expect(page.locator("#conversation .answer").last).to_contain_text("AMAZME_P2_VM_OK")
                report["checks"].append("approval survived reload; shell effect occurred only after approval")
                if not args.provider_config:
                    page.locator("#prompt").fill('/delegate ["/shell printf one > child-one.txt", "/shell printf two > child-two.txt"]')
                    page.locator("#send").click()
                    # Child approval order follows the real durable driver; approve only visible proposals.
                    for _ in range(2):
                        approval = page.locator("#approvals article").first
                        expect(approval).to_be_visible(timeout=120000)
                        approval_id = approval.get_attribute("data-approval-id")
                        approval.get_by_role("button", name="批准", exact=True).click()
                        expect(page.locator(f'#approvals article[data-approval-id="{approval_id}"]')).to_have_count(0, timeout=120000)
                    expect(page.locator("#conversation .status").filter(has_text="已完成")).to_have_count(4, timeout=120000)
                    assert (runtime.workspace / "child-one.txt").read_text() == "one"
                    assert (runtime.workspace / "child-two.txt").read_text() == "two"
                    expect(page.locator(".children")).to_contain_text("已完成")
                    report["checks"].append("independent children and required join reached the page")
                page.reload()
                expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
                expect(page.locator("#tools")).to_contain_text("real-proof.txt")
                assert_protocol(sent, received, writes, runtime.ready["build_id"])
                assert not errors, errors
                page.locator("#tool-records").evaluate("node => node.open = true")
                page.screenshot(path=str(root / "web.png"), full_page=True)
                report.update(browser=browser.version, websocket_event_counts=dict(counts), page_errors=errors,
                              ack_count=sum(frame.get("kind") == "ack" for frame in sent), screenshot=str(root / "web.png"))
                report["checks"].append("full snapshot reload, attachment headers and delivered-watermark ACKs")
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
