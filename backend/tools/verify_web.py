"""Drive a real isolated Chrome window through the shipped Web client and DeepSeek."""

import argparse
import json
import sqlite3
import sys
import tempfile
from collections import Counter
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from verify_runtime import ROOT, Runtime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider-config", type=Path, required=True)
    parser.add_argument("--executable", type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="browser-", dir=ROOT / ".artifacts/python-backend-p1"))
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "amazme_backend"]
    runtime = Runtime(command, root, args.provider_config.resolve())
    report = {"status": "running", "root": str(root)}
    try:
        runtime.start()
        report["identity"] = runtime.ready
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            errors = []
            counts = Counter()
            page.on("pageerror", lambda error: errors.append(str(error)))

            def frame(payload):
                if isinstance(payload, str):
                    data = json.loads(payload)
                    for event in data.get("events", []):
                        counts[event["kind"]] += 1
            page.on("websocket", lambda socket: socket.on("framereceived", frame))
            page.goto(runtime.ready["url"])
            page.get_by_label("输入本机配对码").fill((runtime.profile / "web.token").read_text())
            page.get_by_role("button", name="连接", exact=True).click()
            expect(page.locator("#login")).to_be_hidden()
            page.get_by_role("button", name="新建会话", exact=True).click()
            expect(page.locator("#connection")).to_have_text("已连接", timeout=30000)
            prompt = "请调用 shell 工具执行这一条命令：printf 'AMAZME_REAL_VM_OK\\n' > real-proof.txt; cat real-proof.txt。必须实际执行，完成后简短报告读到的内容。"
            page.get_by_label("任务", exact=True).fill(prompt)
            page.get_by_role("button", name="发送", exact=True).click()
            expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=120000)
            assert (runtime.workspace / "real-proof.txt").read_text() == "AMAZME_REAL_VM_OK\n"
            expect(page.locator("#conversation .answer").last).to_contain_text("AMAZME_REAL_VM_OK")
            assert counts["tool"] >= 2 and counts["preview"] > 0, counts
            page.reload()
            expect(page.locator("#conversation .answer").last).to_contain_text("AMAZME_REAL_VM_OK", timeout=30000)
            expect(page.locator("#connection")).to_have_text("已连接")
            page.get_by_label("任务", exact=True).fill("请使用 write_file 工具把中文“恢复后继续”写入 continued.txt，再使用 read_file 读取它并报告内容。")
            page.get_by_role("button", name="发送", exact=True).click()
            expect(page.locator("#conversation article")).to_have_count(2)
            expect(page.locator("#conversation .status").last).to_contain_text("已完成", timeout=120000)
            assert (runtime.workspace / "continued.txt").read_text().strip() == "恢复后继续"
            assert not errors, errors
            page.locator("details").evaluate("node => node.open = true")
            page.screenshot(path=str(root / "web.png"), full_page=True)
            report["browser"] = browser.version
            report["websocket_event_counts"] = dict(counts)
            report["page_errors"] = errors
            report["screenshot"] = str(root / "web.png")
            context.close()
            browser.close()
        sessions = runtime.client.get("/api/v1/sessions").json()["sessions"]
        session = sessions[0]["session_id"]
        snapshot = runtime.client.get(f"/api/v1/sessions/{session}/snapshot").json()
        with sqlite3.connect(runtime.profile / "sessions" / session / "session.sqlite") as db:
            messages = [json.loads(row[0]) for row in db.execute("SELECT payload FROM messages ORDER BY seq")]
            report["provider_response_ids"] = [m["provider_response_id"] for m in messages if m.get("provider_response_id")]
            report["tools"] = [json.loads(row[0]) for row in db.execute("SELECT result FROM tools WHERE status='done'")]
        assert report["provider_response_ids"] and all(i != "faux" for i in report["provider_response_ids"])
        assert all(r["status"] == "succeeded" for r in snapshot["requests"])
        report["requests"] = snapshot["requests"]
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
