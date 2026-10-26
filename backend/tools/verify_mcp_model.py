"""DeepSeek selects a connected local MCP tool. The key stays in a private temp config."""

import json
import os
import shlex
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

import httpx
from verify_runtime import ROOT, Runtime, until

from amazme_backend.platform.private_files import private_write

MARKER = "marker-7f3a"
ARGUMENTS = {"text": MARKER, "numbers": [4, 5]}
PROMPT = (
    "使用本回合提供的 MCP 工具 native_echo，不要使用 shell、read_file、write_file 或其他工具。"
    '参数必须是 {"text":"marker-7f3a","numbers":[4,5]}。'
    "工具返回后，只回复工具结果里的 cwd 字段原文。"
)


def snapshot(runtime: Runtime, session: str) -> dict:
    response = runtime.client.get(f"/api/v1/sessions/{session}/snapshot", headers=runtime.attach(session))
    response.raise_for_status()
    return response.json()


def decide(runtime: Runtime, session: str, approval: dict, *, approve: bool, decision_id: str) -> None:
    response = runtime.client.post(
        f"/api/v1/sessions/{session}/approvals",
        headers=runtime.attach(session),
        json={
            "decision_id": decision_id,
            "approval_id": approval["approval_id"],
            "expected_revision": approval["revision"],
            "proposal_digest": approval["proposal_digest"],
            "approve": approve,
        },
    )
    response.raise_for_status()


def wait_proposal(runtime: Runtime, session: str, request: str) -> tuple[dict, dict]:
    def current():
        try:
            view = snapshot(runtime, session)
        except httpx.HTTPError:
            return {"status": "running", "error": ""}, None
        receipt = next(item for item in view["requests"] if item["request_id"] == request)
        pending = [item for item in view["approvals"] if item["request_id"] == request and item["state"] == "pending"]
        return receipt, pending[0] if pending else None

    receipt, approval = until(
        current,
        lambda pair: pair[0]["status"] in {"succeeded", "cancelled", "interrupted", "failed", "unknown"} or pair[1],
        timeout=150,
    )
    if approval is None:
        raise AssertionError(f"model finished without an MCP proposal: {receipt['status']} {receipt.get('error', '')}")
    body = json.loads(approval["call"]["arguments"])
    if approval["call"]["name"] != "mcp_tool" or body.get("tool") != "native_echo" or body.get("arguments") != ARGUMENTS:
        decide(runtime, session, approval, approve=False, decision_id=request + "-reject")
        raise AssertionError("model proposal was not the requested native_echo call")
    return receipt, approval


def tool_messages(profile: Path, session: str) -> list[str]:
    path = profile / "sessions" / session / "session.sqlite"
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        rows = connection.execute("SELECT payload FROM messages ORDER BY ordinal").fetchall()
    finally:
        connection.close()
    messages = [json.loads(row[0]) for row in rows]
    return [message["content"] for message in messages if message["role"] == "tool"]


def main() -> None:
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        print(json.dumps({"status": "skipped", "reason": "DEEPSEEK_API_KEY missing"}, ensure_ascii=False))
        raise SystemExit(2)
    root = Path(tempfile.mkdtemp(prefix="amazme-mcp-model-"))
    provider = root / "provider.json"
    private_write(provider, json.dumps({
        "provider": "deepseek",
        "model": "deepseek-flash",
        "base_url": "https://api.deepseek.com",
        "api_key": key,
    }))
    runtime: Runtime | None = None
    report: dict[str, object] = {"status": "running", "execution": "native", "vm_created": False}
    try:
        runtime = Runtime(
            [sys.executable, "-m", "amazme_backend"], root, provider, approval_policy="mutations")
        runtime.start()
        report["build_id"] = runtime.ready["build_id"]
        session = runtime.session()
        command = shlex.join([sys.executable, str(ROOT / "backend/tools/mcp_probe_server.py"),
                              "--workspace", str(runtime.workspace)])
        opened = runtime.client.post(
            f"/api/v1/sessions/{session}/mcp",
            headers=runtime.attach(session),
            json={"server_id": "a" * 32, "command": command},
        )
        opened.raise_for_status()
        until(lambda: runtime.client.get(f"/api/v1/sessions/{session}/mcp", headers=runtime.attach(session)).json(),
              lambda state: state["servers"] and state["servers"][0]["phase"] == "ready", timeout=20)
        effect = runtime.workspace / "mcp-effect.txt"

        runtime.client.post(
            f"/api/v1/sessions/{session}/submissions",
            headers=runtime.attach(session),
            json={"request_id": "deny-mcp", "text": PROMPT},
        ).raise_for_status()
        _receipt, denied = wait_proposal(runtime, session, "deny-mcp")
        decide(runtime, session, denied, approve=False, decision_id="deny-mcp-decision")
        denied_receipt = until(lambda: runtime.receipt(session, "deny-mcp"),
                               lambda item: item["status"] in {"failed", "unknown", "cancelled"}, timeout=30)
        if denied_receipt["status"] != "failed" or denied_receipt.get("error") != "approval_denied" or effect.exists():
            raise AssertionError("denied MCP approval still produced an effect or the wrong status")
        report["denied"] = "approval_denied_without_effect"

        runtime.client.post(
            f"/api/v1/sessions/{session}/submissions",
            headers=runtime.attach(session),
            json={"request_id": "use-mcp", "text": PROMPT},
        ).raise_for_status()
        _receipt, approved = wait_proposal(runtime, session, "use-mcp")
        decide(runtime, session, approved, approve=True, decision_id="use-mcp-decision")
        done = until(lambda: runtime.receipt(session, "use-mcp"),
                     lambda item: item["status"] in {"succeeded", "failed", "unknown", "cancelled"}, timeout=150)
        answer = done.get("answer") or ""
        calls = runtime.client.get(f"/api/v1/sessions/{session}/mcp", headers=runtime.attach(session)).json()["calls"]
        model_calls = [call for call in calls if call.get("origin") == "model"]
        written = effect.read_text() if effect.exists() else ""
        tools = tool_messages(runtime.profile, session)
        workspace = str(runtime.workspace.resolve())
        if (done["status"] != "succeeded" or workspace not in answer or written != MARKER
                or not model_calls or model_calls[-1]["phase"] != "done"
                or not any(workspace in content for content in tools)):
            safe_answer = answer.replace(key, "[redacted]")[:300]
            raise AssertionError(
                f"model result was not returned: status={done['status']} error={done.get('error', '')} "
                f"effect={written == MARKER} answer={safe_answer}")
        report.update({
            "status": "passed",
            "session_tool": "native_echo",
            "origin": "model",
            "phase": model_calls[-1]["phase"],
            "effect_once": True,
            "result_visible_to_model": True,
            "workspace_reported": True,
        })
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = str(exc).replace(key, "[redacted]")[:500]
        raise
    finally:
        if runtime is not None:
            try:
                runtime.close()
            finally:
                provider.unlink(missing_ok=True)
                config = runtime.profile / "config.json"
                if config.exists():
                    value = json.loads(config.read_text())
                    provider_config = value.get("provider")
                    if isinstance(provider_config, dict):
                        provider_config["api_key"] = ""
                        private_write(config, json.dumps(value))
                report["resource"] = getattr(runtime, "resource_report", {})
                if runtime.process is None or runtime.process.poll() is not None:
                    shutil.rmtree(root, ignore_errors=True)
        else:
            provider.unlink(missing_ok=True)
            shutil.rmtree(root, ignore_errors=True)
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
