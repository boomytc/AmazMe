"""Accept one existing frozen bundle through its public HTTP API; never build or install."""

import argparse
import json
import os
import secrets
import shutil
import tempfile
from pathlib import Path

import httpx
from pydantic import JsonValue, TypeAdapter
from resource_budget import ResourceBudget
from resource_census import apply_cleanup, live_processes, owned_hits, release_named_slot
from verify_electron import http_mcp_fixture
from verify_runtime import ROOT, Runtime, until

from amazme_backend.ai.classification.types import ClassifierCatalog, ClassifierModel
from amazme_backend.contracts.accounts import AccountsView, CredentialUpdate
from amazme_backend.contracts.code import CodeRun, CodeView
from amazme_backend.contracts.events import Snapshot, Stream
from amazme_backend.contracts.execution import TerminalOpen, TerminalType, TerminalView
from amazme_backend.contracts.identity import Identity
from amazme_backend.contracts.mcp import McpCall, McpCallRequest, McpDecision, McpOpen, McpState, McpView
from amazme_backend.contracts.models import ModelCatalog
from amazme_backend.contracts.plugins import PluginCallRequest, PluginCallView, PluginDraft, PluginView
from amazme_backend.contracts.resources import ResourceCatalog
from amazme_backend.platform.identity import FrozenManifest, frozen_identity
from amazme_backend.platform.private_files import private_write
from amazme_backend.platform.resource_manifest import CLIENT_DIRECTORY, REQUIRED_IDENTITY, RESOURCE_PATHS

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])


def api(runtime: Runtime, method: str, path: str, body=None, *, session: str = ""):
    response = runtime.client.request(
        method, path, json=body, headers=runtime.attach(session) if session else None,
    )
    response.raise_for_status()
    return JSON_OBJECT.validate_json(response.content)


def bundle_resources(executable: Path, report: dict) -> dict[str, Path]:
    bundle = executable.parent
    manifest = FrozenManifest.model_validate_json((bundle / "build.json").read_bytes())
    build = frozen_identity(bundle)
    assert build == manifest.build_id, "Frozen identity differs from build.json"
    assert executable.name in manifest.files, "Executable is outside the build identity"
    resources: dict[str, Path] = {}
    for name in REQUIRED_IDENTITY:
        matches = [path for path in manifest.files if path == name or path.endswith("/" + name)]
        assert len(matches) == 1, f"Required bundle resource missing or ambiguous: {name}"
        resources[name] = bundle / matches[0]
    report.update(build_id=build, bundle_files=len(manifest.files), required_identity={
        name: path.relative_to(bundle).as_posix() for name, path in resources.items()
    })
    report["checks"].append("frozen_identity verified all manifest bytes and every REQUIRED_IDENTITY resource")
    return resources


def catalogs(runtime: Runtime, resources: dict[str, Path], report: dict) -> None:
    models = ModelCatalog.model_validate(api(runtime, "GET", "/api/v1/models"))
    assert (models.current.provider, models.current.model) == ("faux", "faux")
    published = {(item.provider, item.model) for item in models.models}
    assert ("faux", "faux") in published
    snapshot = json.loads(resources[RESOURCE_PATHS["models"]].read_bytes())
    assert snapshot and {(item["provider"], item["id"]) for item in snapshot} <= published
    classifiers = ClassifierCatalog.model_validate(api(runtime, "GET", "/api/v1/classifiers"))
    expected = TypeAdapter(list[ClassifierModel]).validate_json(
        resources[RESOURCE_PATHS["classifiers"]].read_bytes(),
    )
    assert classifiers.models == expected and expected, "Classifier snapshot differs from the frozen bundle"
    assert any(item.api == "typesafe-system-one" for item in expected)
    report["catalogs"] = {"models": len(models.models), "classifiers": len(expected)}
    report["checks"].append("model and TypeSafe classifier snapshots loaded from the same frozen bundle; faux selected")


def web(runtime: Runtime, resources: dict[str, Path], report: dict) -> None:
    response = runtime.client.get("/")
    response.raise_for_status()
    assert "text/html" in response.headers.get("content-type", "")
    assert "globalThis.__AMAZME_BOOT__=" in response.text and '"mode":"installed"' in response.text
    assert "page.js" in response.text and "Content-Security-Policy" in response.headers
    paths = {
        "/page.js": CLIENT_DIRECTORY + "/page.js",
        "/client-assets/events.schema.json": RESOURCE_PATHS["web"] + "/events.schema.json",
        "/client-assets/xterm-terminal.js": RESOURCE_PATHS["web"] + "/xterm-terminal.js",
        "/client-assets/xterm.css": RESOURCE_PATHS["web"] + "/xterm.css",
    }
    for url, name in paths.items():
        served = runtime.client.get(url)
        served.raise_for_status()
        assert served.content and served.content == resources[name].read_bytes(), f"Served resource differs: {url}"
        if url.endswith("events.schema.json"):
            assert served.json() == Stream.model_json_schema(), "Served stream contract drift"
    report["checks"].append("installed boot page, bundled page.js, xterm assets and current event schema served over HTTP")


def fixtures(runtime: Runtime) -> None:
    # The profile and all input files belong only to this invocation.
    agent = runtime.root / "agent"
    agent.mkdir()
    config = runtime.profile / "config.json"
    value = json.loads(config.read_text())
    value["user_resources"] = str(agent)
    private_write(config, json.dumps(value))
    (runtime.workspace / "AGENTS.md").write_text("Frozen resource acceptance workspace.\n")
    skill = runtime.workspace / ".amazme/skills/frozen-resource/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: frozen-resource\ndescription: Frozen acceptance fixture\n---\nInspect this owned workspace.\n")
    prompt = runtime.workspace / ".amazme/prompts/frozen-resource.md"
    prompt.parent.mkdir(parents=True)
    prompt.write_text("---\ndescription: Frozen prompt fixture\n---\nFrozen acceptance $ARGUMENTS\n")
    shutil.copyfile(ROOT / "backend/tests/helpers/plugin_fixture.py", runtime.workspace / "plugin_fixture.py")


def resource_catalog(runtime: Runtime, session: str, report: dict) -> None:
    found = ResourceCatalog.model_validate(api(runtime, "GET", f"/api/v1/sessions/{session}/resources"))
    assert str(runtime.workspace / "AGENTS.md") in found.context_files
    assert any(item.name == "frozen-resource" and item.scope == "project" for item in found.skills)
    assert any(item.name == "frozen-resource" for item in found.prompts)
    report["checks"].append("resource loader discovered owned context, YAML skill and prompt through the frozen Host")


def gate_pids(runtime: Runtime, role: str) -> list[int]:
    rows = owned_hits([runtime.root], live_processes(), os.getpid())
    gates = [row for row in rows if row["role"] == role]
    assert all(Path(row["argv"][0]).resolve() == Path(runtime.command[0]) for row in gates), "Gate escaped the frozen executable"
    return [int(row["pid"]) for row in gates]


def terminal(runtime: Runtime, session: str, report: dict) -> None:
    endpoint = f"/api/v1/sessions/{session}/terminals"
    identity = secrets.token_hex(16)
    opened = TerminalView.model_validate(api(runtime, "POST", endpoint, TerminalOpen(
        terminal_id=identity, command="/bin/sh", cols=80, rows=24, workspace="primary",
    ).model_dump(), session=session))
    try:
        assert opened.phase == "running" and not opened.clean
        pids = gate_pids(runtime, "pty-gate")
        assert len(pids) == 1, "Real frozen PTY gate was not observed"
        marker = runtime.workspace / "terminal-marker.txt"
        typed = TerminalType(input_id=secrets.token_hex(16), data=
            "printf 'FROZEN_%s\\n' 'PTY_OK' > terminal-marker.txt; cat terminal-marker.txt\n")
        accepted = TerminalView.model_validate(api(runtime, "POST", endpoint + f"/{identity}/input",
            typed.model_dump(), session=session))
        assert accepted.input_status == "accepted"
        until(lambda: TerminalView.model_validate(api(runtime, "POST", endpoint + f"/{identity}/read", session=session)),
              lambda view: "FROZEN_PTY_OK" in view.output and marker.exists()
              and marker.read_text() == "FROZEN_PTY_OK\n", timeout=20)
    finally:
        closed = TerminalView.model_validate(api(runtime, "POST", endpoint + f"/{identity}/close", session=session))
        assert closed.phase == "exited" and closed.clean
        until(lambda: gate_pids(runtime, "pty-gate"), lambda pids: not pids, timeout=10)
    report["terminal"] = {"gate_pids": pids, "clean": closed.clean, "marker": "FROZEN_PTY_OK"}
    report["checks"].append("actual frozen PTY gate opened, accepted input, read shell output and closed cleanly")


def mcp(runtime: Runtime, session: str, token: str, report: dict) -> None:
    accounts = AccountsView.model_validate(api(runtime, "GET", "/api/v1/accounts"))
    saved = AccountsView.model_validate(api(runtime, "POST", "/api/v1/accounts/faux", {
        "expected_revision": accounts.revision, "api_key": token,
    }))
    assert any(item.provider == "faux" for item in saved.accounts)
    marker = runtime.workspace / "mcp-marker.txt"
    endpoint = f"/api/v1/sessions/{session}/mcp"
    identity, call_id = secrets.token_hex(16), secrets.token_hex(16)
    with http_mcp_fixture(marker, bearer_token=token) as url:
        # Rejecting a direct unauthenticated request proves the fixture really gates auth.
        with httpx.Client(timeout=5, trust_env=False) as unauthenticated:
            assert unauthenticated.post(url, json={"jsonrpc": "2.0", "id": "unauthorized", "method": "initialize"}).status_code == 401
        launch = McpOpen.model_validate({"server_id": identity, "command": url, "workspace": "primary",
            "http": {"url": url, "auth": {"provider": "faux"}}})
        opened = McpView.model_validate(api(runtime, "POST", endpoint, launch.model_dump(), session=session))
        try:
            assert opened.phase == "ready" and opened.protocol_version == "2025-11-25"
            assert [tool.name for tool in opened.tools] == ["native_echo"] and not opened.clean
            assert opened.tools[0].input_schema == {"type": "object"}
            pids = gate_pids(runtime, "mcp-gate")
            assert len(pids) == 1, "Real frozen HTTP MCP gate was not observed"
            call_path = endpoint + f"/{identity}/calls"
            proposal = McpCallRequest(call_id=call_id, name="native_echo", arguments={})
            pending = McpCall.model_validate(api(runtime, "POST", call_path, proposal.model_dump(), session=session))
            assert pending.phase == "waiting_approval" and not marker.exists()
            decision_path = call_path + f"/{call_id}/decision"
            decision = McpDecision(decision_id=secrets.token_hex(16), approve=True, digest=pending.digest)
            api(runtime, "POST", decision_path, decision.model_dump(), session=session)

            def result():
                state = McpState.model_validate(api(runtime, "GET", endpoint))
                return next(item for item in state.calls if item.call_id == call_id)

            done = until(result, lambda item: item.phase in {"done", "denied", "unknown", "conflict"}, timeout=20)
            assert done.phase == "done" and done.result == "FROZEN_HTTP_MCP_OK" and not done.is_error
            assert done.result_data == {"content": [{"type": "text", "text": "FROZEN_HTTP_MCP_OK"}]}
            assert marker.read_text() == "x"
            assert McpCall.model_validate(api(runtime, "POST", call_path, proposal.model_dump(), session=session)) == done
            assert McpCall.model_validate(api(runtime, "POST", decision_path, decision.model_dump(), session=session)) == done
            assert marker.read_text() == "x", "Stable MCP call/decision ID repeated its side effect"
        finally:
            closed = McpView.model_validate(api(runtime, "POST", endpoint + f"/{identity}/cancel", session=session))
            assert closed.phase == "exited" and closed.clean
            until(lambda: gate_pids(runtime, "mcp-gate"), lambda pids: not pids, timeout=10)
    api(runtime, "POST", "/api/v1/accounts/faux", CredentialUpdate(
        expected_revision=saved.revision, clear=True,
    ).model_dump(mode="json"))
    report["mcp"] = {"gate_pids": pids, "account_auth": True, "marker_count": 1, "clean": closed.clean}
    report["checks"].append("frozen bootstrap account resolver authenticated local HTTP MCP initialize/list/call; approval, stable IDs and actual gate cancel passed")


def plugin(runtime: Runtime, session: str, report: dict) -> None:
    identity, call_id = secrets.token_hex(16), secrets.token_hex(16)
    opened = PluginView.model_validate(api(runtime, "POST", "/api/v1/plugins", PluginDraft(
        session_id=session, plugin_id=identity, name="frozen-resource",
        entry=str(runtime.workspace / "plugin_fixture.py"),
    ).model_dump()))
    endpoint = f"/api/v1/sessions/{session}/plugins/{identity}"
    try:
        assert opened.phase == "ready" and any(tool.name == "hello" and tool.kind == "tool" for tool in opened.tools)
        pids = gate_pids(runtime, "plugin-gate")
        assert len(pids) == 1, "Real frozen external-source plugin gate was not observed"
        value = PluginCallRequest(call_id=call_id, name="hello", arguments={"name": "Frozen"},
            expected_fingerprint=opened.fingerprint, expected_load_id=opened.load_id)
        done = PluginCallView.model_validate(api(runtime, "POST", endpoint + "/calls", value.model_dump(), session=session))
        assert done.phase == "done" and done.result is not None and not done.result.is_error
        assert done.result.content == [{"type": "text", "text": "Hello, Frozen!"}]
        assert done.result.details == {"count": 1, "session": session, "secret_inherited": False}
        assert PluginCallView.model_validate(api(runtime, "POST", endpoint + "/calls", value.model_dump(), session=session)) == done
        assert (runtime.workspace / "effects.txt").read_text() == f"{call_id}:Frozen\n"
    finally:
        closed = PluginView.model_validate(api(runtime, "POST", endpoint + "/close", session=session))
        assert closed.phase == "disconnected"
        until(lambda: gate_pids(runtime, "plugin-gate"), lambda pids: not pids, timeout=10)
    report["plugin"] = {"gate_pids": pids, "phase": closed.phase, "marker_count": 1}
    report["checks"].append("copied external plugin imported its public API in the frozen gate; register/call/result/dedup/close passed")


def code(runtime: Runtime, session: str, report: dict) -> None:
    value = CodeRun(run_id=secrets.token_hex(16), source="text(6 * 7); return 42;")
    result = CodeView.model_validate(api(runtime, "POST", f"/api/v1/sessions/{session}/code",
        value.model_dump(), session=session))
    assert result.phase == "success" and result.clean and not result.error
    assert json.loads(result.value) == 42
    assert any(item.type == "text" and item.text == "42" for item in result.output)
    report["codemode"] = {"run_id": result.run_id, "value": 42, "output": "42", "clean": result.clean}
    report["checks"].append("CodeRun executed text(6 * 7); return 42 through the bundled Node/QuickJS/helper and confirmed cleanup")


def snapshot(runtime: Runtime, session: str, report: dict) -> None:
    request_id = secrets.token_hex(16)
    text = "FROZEN_RESOURCE_SNAPSHOT"
    api(runtime, "POST", f"/api/v1/sessions/{session}/submissions", {
        "request_id": request_id, "text": text,
    }, session=session)
    receipt = runtime.complete(session, request_id)
    assert receipt["status"] == "succeeded" and text in receipt["answer"]
    first = Snapshot.model_validate(api(runtime, "GET", f"/api/v1/sessions/{session}/snapshot"))
    second = Snapshot.model_validate(api(runtime, "GET", f"/api/v1/sessions/{session}/snapshot"))
    assert first.session_id == session and first.stream_id == second.stream_id
    assert first.events and any(item.request_id == request_id and item.status == "succeeded" for item in second.requests)
    assert not second.pending and not second.approvals and not second.effects
    report["snapshot"] = {"request_id": request_id, "stream_id": second.stream_id, "seq": second.seq,
                          "events": len(second.events)}
    report["checks"].append("frozen faux worker completed a real submission and returned repeatable typed snapshots without pending effects")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    executable, report_path = args.executable.resolve(strict=True), args.report.resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        parser.error("--executable must be an existing frozen executable")
    if report_path.is_relative_to(executable.parent):
        parser.error("--report must be outside the immutable bundle")
    parent = ROOT / ".artifacts/native"
    parent.mkdir(parents=True, exist_ok=True)
    release_named_slot(parent, "frozen-resources-", 2)
    root = Path(tempfile.mkdtemp(prefix="frozen-resources-", dir=parent))
    report = {"status": "running", "execution": "frozen", "executable": str(executable), "root": str(root),
              "provider": "faux", "external_accounts_tested": False, "checks": []}
    runtime = None
    budget = ResourceBudget([root], limit_bytes=256 * 1024**2, deadline_seconds=240)
    private_tokens = ["faux-" + secrets.token_hex(24)]
    failure = None
    try:
        with budget:
            resources = bundle_resources(executable, report)
            provider = root / "provider.json"
            private_write(provider, '{"provider":"faux","model":"faux","api_key":""}')
            runtime = Runtime([str(executable)], root, provider, approval_policy="mutations")
            fixtures(runtime)
            runtime.start()
            private_tokens.extend((runtime.profile / name).read_text().strip() for name in ("web.token", "control.token"))
            identity = Identity.model_validate(api(runtime, "GET", "/api/v1/bootstrap"))
            assert identity.build_id == runtime.ready["build_id"] == report["build_id"]
            assert identity.profile_id == runtime.ready["profile_id"] and identity.host_epoch == runtime.ready["host_epoch"]
            report["identity"] = identity.model_dump()
            catalogs(runtime, resources, report)
            web(runtime, resources, report)
            session = runtime.session()
            resource_catalog(runtime, session, report)
            terminal(runtime, session, report)
            mcp(runtime, session, private_tokens[0], report)
            plugin(runtime, session, report)
            code(runtime, session, report)
            snapshot(runtime, session, report)
            assert frozen_identity(executable.parent) == report["build_id"], "Bundle changed during acceptance"
        report["status"] = "passed"
    except BaseException as error:
        failure = error
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
    finally:
        report["budget"] = budget.snapshot()
        pending = apply_cleanup(runtime, report)
        # Only summaries are retained. Even failures and census diagnostics must not expose a token.
        encoded = json.dumps(report, ensure_ascii=False, indent=2)
        for token in private_tokens:
            if token:
                encoded = encoded.replace(token, "[redacted]")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(encoded + "\n")
        print(json.dumps({"status": report["status"], "build_id": report.get("build_id"), "report": str(report_path)}))
    if failure is not None or pending is not None:
        raise SystemExit(1)


if __name__ == "__main__":
    from workspace_lock import run_locked

    run_locked(main)
