"""Chrome page path for one Codemode run. The Node binary is the shipped layout, not PATH."""

import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from resource_census import apply_cleanup, raise_pending, release_named_slot
from verify_runtime import ROOT, Runtime, until

OFFICIAL_NODE = Path.home() / "Library/Caches/amazme-release/node-v22.23.3-darwin-arm64/bin/node"
SOURCE = """const n = (load("n") || 0) + 1;
store("n", n);
return n;
"""


def stage_node() -> Path:
    if not OFFICIAL_NODE.is_file():
        raise RuntimeError("official Node binary is missing")
    root = ROOT / "backend/resources"
    dest = root / "node" / "bin" / "node"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OFFICIAL_NODE, dest)
    dest.chmod(0o755)
    return dest


def remove_node() -> None:
    node_root = ROOT / "backend/resources/node"
    if node_root.exists():
        shutil.rmtree(node_root)
    resources = ROOT / "backend/resources"
    if resources.is_dir() and not any(resources.iterdir()):
        resources.rmdir()


def code_state(profile: Path) -> str:
    database = profile / "execution.sqlite"
    if not database.is_file():
        return ""
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT document FROM code_state").fetchone()
        count = connection.execute("SELECT count(*) FROM code_runs").fetchone()
    if row is None or count is None or int(count[0]) != 1:
        return ""
    return str(row[0])


def finish(runtime: Runtime, root: Path, report: dict[str, object]) -> None:
    pending = apply_cleanup(runtime, report)
    (root / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(root / "report.json", flush=True)
    raise_pending(pending)


def main() -> None:
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "code-page-", 2)
    root = Path(tempfile.mkdtemp(prefix="code-page-", dir=parent))
    provider = root / "faux.json"
    provider.write_text('{"provider":"faux"}')
    runtime = Runtime([sys.executable, "-m", "amazme_backend"], root, provider)
    report: dict[str, object] = {
        "status": "running", "execution": "chrome-code-page", "vm_created": False, "checks": [],
    }
    try:
        stage_node()
        runtime.start()
        report["identity"] = {"build_id": runtime.ready["build_id"], "url": runtime.ready["url"]}
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
                calls: list[str] = []
                attempts = {"count": 0}

                def lose_first(route) -> None:
                    body = route.request.post_data_json
                    if isinstance(body, dict) and isinstance(body.get("run_id"), str):
                        calls.append(body["run_id"])
                    attempts["count"] += 1
                    if attempts["count"] == 1:
                        route.fetch()
                        route.abort()
                        return
                    route.continue_()

                page.route("**/sessions/**/code", lose_first)
                page.locator("#codemode summary").click()
                page.locator("#code-source").fill(SOURCE)
                page.locator("#code-run").click()
                expect(page.locator("#error")).not_to_have_text("", timeout=20000)
                until(lambda: code_state(runtime.profile), lambda value: '"n":1' in value.replace(" ", ""), timeout=20)
                page.locator("#code-run").click()
                expect(page.locator("#code-result")).to_have_text("1", timeout=20000)
                stored = code_state(runtime.profile).replace(" ", "")
                assert '"n":1' in stored and '"n":2' not in stored
                assert len(calls) >= 2 and calls[0] == calls[1]
                page.unroute("**/sessions/**/code", lose_first)
                assert not errors, errors
                report["checks"].append(
                    "chrome page reused one codemode run after the receipt was lost; state stayed n=1"
                )
                report["page_errors"] = errors
            finally:
                context.close()
                browser.close()
        report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        remove_node()
        finish(runtime, root, report)


if __name__ == "__main__":
    main()
