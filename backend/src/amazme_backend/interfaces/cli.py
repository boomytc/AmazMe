"""Non-interactive commands. The host, session, and workspace are always explicit."""

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path
from typing import cast

from pydantic import SecretStr

from amazme_backend.contracts.accounts import CredentialUpdate, OAuthInput, OAuthStart
from amazme_backend.contracts.management import ExportBundle
from amazme_backend.contracts.models import UpdateModelSettings
from amazme_backend.contracts.sessions import Approval, Receipt
from amazme_backend.contracts.workspaces import WorkspaceGrantRequest
from amazme_backend.sdk.client import Client
from amazme_backend.shared.errors import BackendError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amazme-backend client")
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    resource = sub.add_parser("resources")
    resource.add_argument("--session", required=True)
    create = sub.add_parser("create")
    create.add_argument("--workspace", required=True)
    create.add_argument("--title", default="新会话")
    create.add_argument("--session-id", default="")
    workspaces = sub.add_parser("workspaces")
    workspace_commands = workspaces.add_subparsers(dest="workspace_command")
    workspace_commands.add_parser("list")
    selected = workspace_commands.add_parser("select")
    selected.add_argument("path")
    selected.add_argument("--name", default="")
    granted = workspace_commands.add_parser("add")
    granted.add_argument("name")
    granted.add_argument("path")
    removed = workspace_commands.add_parser("remove")
    removed.add_argument("name")
    submit = sub.add_parser("submit")
    submit.add_argument("--session", required=True)
    submit.add_argument("--workspace", required=True)
    submit.add_argument("--request-id", required=True)
    submit.add_argument("--text", required=True)
    lookup = sub.add_parser("request")
    lookup.add_argument("--session", required=True)
    lookup.add_argument("--request-id", required=True)
    release = sub.add_parser("release")
    release.add_argument("--session", required=True)
    release.add_argument("--attachment", required=True)
    cancel = sub.add_parser("cancel")
    cancel.add_argument("--session", required=True)
    cancel.add_argument("--workspace", required=True)
    cancel.add_argument("--attachment", required=True)
    cancel.add_argument("--request-id", required=True)
    remote = sub.add_parser("rpc")
    remote.add_argument("--method", required=True)
    remote.add_argument("--params", required=True)
    decide = sub.add_parser("decide")
    decide.add_argument("--session", required=True)
    decide.add_argument("--workspace", required=True)
    decide.add_argument("--request", default="")
    decide.add_argument("--approval-id", default="")
    decide.add_argument("--call", default="")
    decide.add_argument("--server", default="")
    decide.add_argument("--decision", default="")
    models = sub.add_parser("models")
    models.add_argument("--search", default="")
    model = sub.add_parser("model")
    model.add_argument("--provider", default="")
    model.add_argument("--model", required=True)
    model.add_argument("--base-url", default="")
    model.add_argument("--api", choices=["openai-completions", "openai-responses", "openai-codex-responses",
                                         "anthropic-messages", "google-generative-ai"])
    exported = sub.add_parser("export")
    exported.add_argument("--output", default="-")
    imported = sub.add_parser("import")
    imported.add_argument("path", type=Path)
    sub.add_parser("accounts")
    sub.add_parser("doctor")
    auth = sub.add_parser("auth")
    actions = auth.add_subparsers(dest="auth_action", required=True)
    login = actions.add_parser("login")
    login.add_argument("--provider", required=True)
    login.add_argument("--method", choices=["api-key", "browser", "device_code", "copy_code"], default="browser")
    login.add_argument("--login-id", default="")
    login.add_argument("--no-wait", action="store_true")
    logout = actions.add_parser("logout")
    logout.add_argument("--provider", required=True)
    for name in ("status", "input", "cancel"):
        lookup = actions.add_parser(name)
        lookup.add_argument("--login-id", required=True)
    return parser


def _read_secret(prompt: str) -> SecretStr:
    value = getpass.getpass(prompt) if sys.stdin.isatty() else sys.stdin.readline(8193).rstrip("\r\n")
    if not value or len(value) > 8192:
        raise BackendError("invalid_credential")
    return SecretStr(value)


async def _auth(client: Client, args: argparse.Namespace) -> int:
    if args.auth_action == "logout":
        current = await client.accounts()
        print((await client.update_account(args.provider, CredentialUpdate(expected_revision=current.revision, clear=True))).model_dump_json())
        return 0
    if args.auth_action == "status":
        print((await client.oauth(args.login_id)).model_dump_json())
        return 0
    if args.auth_action == "cancel":
        print((await client.cancel_oauth(args.login_id)).model_dump_json())
        return 0
    if args.auth_action == "input":
        value = _read_secret("授权回调 URL 或验证码：")
        print((await client.oauth_input(args.login_id, OAuthInput(value=value))).model_dump_json())
        return 0
    current = await client.accounts()
    if args.method == "api-key":
        value = _read_secret("API key：")
        print((await client.update_account(args.provider, CredentialUpdate(expected_revision=current.revision, api_key=value))).model_dump_json())
        return 0
    request = OAuthStart(login_id=args.login_id or secrets.token_hex(16), provider=args.provider,
                         expected_revision=current.revision, method=args.method)
    # Publish the original identity before sending. A transport failure never creates a replacement login.
    print(json.dumps({"login_id": request.login_id, "provider": request.provider}), flush=True)
    view = None
    if args.login_id:
        try:
            view = await client.oauth(args.login_id)
            if view.provider != request.provider:
                raise BackendError("oauth_login_conflict")
        except BackendError as exc:
            if exc.status != 404:
                raise
    if view is None:
        view = await client.start_oauth(request)
    printed = ""
    while True:
        body = view.model_dump_json()
        if body != printed and (view.url or view.phase != "pending"):
            print(body, flush=True)
            printed = body
        if view.phase != "pending" or args.no_wait and view.url:
            return 0 if view.phase in {"complete", "pending"} else 1
        await asyncio.sleep(0.25)
        view = await client.oauth(request.login_id)


def _decision_target(args: argparse.Namespace) -> tuple[str, str, str, bool] | None:
    """Reject a missing or ambiguous decision before any host connection."""
    request, call, server = str(args.request or ""), str(args.call or ""), str(args.server or "")
    if str(args.decision or "") not in {"批准", "拒绝"}:
        print("invalid_decision", file=sys.stderr)
        return None
    if bool(request) == bool(call) or bool(server) != bool(call):
        print("decision_target_conflict", file=sys.stderr)
        return None
    if request and not args.approval_id:
        print("approval_id_required", file=sys.stderr)
        return None
    if call and args.approval_id:
        print("decision_target_conflict", file=sys.stderr)
        return None
    return request, call, server, str(args.decision) == "批准"


def _request_exit(approve: bool, status: str, error: str) -> int:
    if approve:
        return 0 if status == "succeeded" else 1
    return 0 if status == "failed" and error == "approval_denied" else 1


def _mcp_exit(approve: bool, phase: str, is_error: bool) -> int:
    if approve:
        return 0 if phase == "done" and not is_error else 1
    return 0 if phase == "denied" else 1


def _print_receipt(receipt: Receipt, approval: Approval | None = None) -> None:
    body = receipt.model_dump(mode="json")
    if approval is not None:
        body.update({"approval_id":approval.approval_id,"revision":approval.revision,
            "proposal_digest":approval.proposal_digest,"tool":approval.call.model_dump(mode="json")})
    print(json.dumps(body, ensure_ascii=False))


async def _apply_decision(client: Client, *, session_id: str, workspace: str, request: str, call: str,
                          server: str, approve: bool, approval_id: str) -> int:
    current = await client.session(session_id)
    if current.workspace != workspace:
        raise BackendError("workspace_mismatch")
    attachment = await client.attach(session_id)
    try:
        if request:
            receipt = await client.request(session_id=session_id, request_id=request)
            if receipt.status not in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}:
                approval = next((item for item in (await client.snapshot(session_id)).approvals
                    if item.approval_id == approval_id and item.request_id == request), None)
                if approval is None:
                    raise BackendError("approval_not_found", status=404)
                if approval.state not in {"approved", "consumed", "denied"}:
                    decision_id = hashlib.sha256(json.dumps([session_id,approval_id,approve],separators=(",",":")).encode()).hexdigest()[:32]
                    await client.decide(
                        session_id=session_id, attachment_id=attachment.attachment_id,
                        decision_id=decision_id, approval_id=approval.approval_id,
                        expected_revision=approval.revision, proposal_digest=approval.proposal_digest, approve=approve)
                receipt, pending = await client.await_user_decision(session_id=session_id, request_id=request, attempts=400)
                _print_receipt(receipt,pending)
                if pending is not None:
                    return 2
            else:
                _print_receipt(receipt)
            return _request_exit(approve, receipt.status, receipt.error)
        state = await client.mcp_state(session_id)
        found = next((item for item in state.calls if item.call_id == call and item.server_id == server), None)
        if found is None:
            raise BackendError("approval_not_found", status=404)
        if found.phase == "waiting_approval":
            await client.decide_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server, call_id=call,
                decision_id=hashlib.sha256(json.dumps([session_id,server,call,approve],separators=(",",":")).encode()).hexdigest()[:32], digest=found.digest, approve=approve)
            found = await client.await_mcp(session_id, call, attempts=400)
        elif found.phase == "running":
            found = await client.await_mcp(session_id, call, attempts=400)
        print(found.model_dump_json())
        return _mcp_exit(approve, found.phase, found.is_error)
    finally:
        await client.release(session_id=session_id, attachment_id=attachment.attachment_id)


async def _run(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    decision: tuple[str, str, str, bool] | None = None
    if args.command == "decide":
        decision = _decision_target(args)
        if decision is None:
            return 1
    try:
        async with Client(args.url, args.token) as client:
            if args.command == "resources":
                print((await client.resources(args.session)).model_dump_json())
                return 0
            if args.command == "workspaces":
                if args.workspace_command == "select":
                    result = await client.select_workspace(args.path, args.name)
                elif args.workspace_command == "add":
                    result = await client.add_workspace(WorkspaceGrantRequest(name=args.name, host_path=args.path))
                else:
                    if args.workspace_command == "remove":
                        await client.remove_workspace(args.name)
                    result = await client.workspaces()
                print(result.model_dump_json())
                return 0
            if args.command == "models":
                catalog = await client.models()
                catalog.models = [model for model in catalog.models if args.search.casefold() in (
                    model.provider + "/" + model.model + " " + model.label).casefold()]
                print(catalog.model_dump_json())
                return 0
            if args.command == "model":
                catalog = await client.models()
                provider, model = str(args.provider), str(args.model)
                if not provider:
                    matches = [item for item in catalog.models if item.model == model or item.provider + "/" + item.model == model]
                    if len(matches) != 1:
                        raise BackendError("model_selector_ambiguous")
                    provider, model = matches[0].provider, matches[0].model
                print((await client.update_model(UpdateModelSettings(provider=provider, model=model,
                    base_url=args.base_url, api=args.api))).model_dump_json())
                return 0
            if args.command == "accounts":
                print((await client.accounts()).model_dump_json())
                return 0
            if args.command == "doctor":
                view = await client.health()
                print(view.model_dump_json())
                return 0 if view.state == "ready" else 1
            if args.command == "auth":
                return await _auth(client, args)
            if args.command == "export":
                body = (await client.export_bundle()).model_dump_json() + "\n"
                if args.output == "-":
                    print(body, end="")
                else:
                    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as output:
                        output.write(body)
                        output.flush()
                        os.fsync(output.fileno())
                return 0
            if args.command == "import":
                if args.path.stat().st_size > 32 * 1024 * 1024:
                    raise BackendError("import_capacity")
                value = ExportBundle.model_validate_json(args.path.read_bytes())
                print((await client.import_bundle(value)).model_dump_json())
                return 0
            if args.command == "create":
                session = await client.create_session(title=args.title, workspace=args.workspace, session_id=args.session_id)
                print(session.model_dump_json())
                return 0
            if args.command == "submit":
                attachment = await client.attach(args.session)
                try:
                    receipt = await client.submit(session_id=args.session, workspace=args.workspace,
                                                  attachment_id=attachment.attachment_id, request_id=args.request_id,
                                                  text=args.text)
                    receipt, approval = await client.await_user_decision(session_id=args.session, request_id=receipt.request_id)
                    _print_receipt(receipt,approval)
                    if approval is not None:
                        return 2
                    return 0 if receipt.status == "succeeded" else 1
                finally:
                    await client.release(session_id=args.session, attachment_id=attachment.attachment_id)
            if args.command == "request":
                receipt = await client.request(session_id=args.session, request_id=args.request_id)
                approval = next((item for item in (await client.snapshot(args.session)).approvals
                    if item.request_id == args.request_id and item.state == "pending"), None) if receipt.status == "waiting_approval" else None
                _print_receipt(receipt,approval)
                return 2 if approval is not None else 0 if receipt.status == "succeeded" else 1
            if args.command == "release":
                await client.release(session_id=args.session, attachment_id=args.attachment)
                print(json.dumps({"detached": True, "cancelled": False}))
                return 0
            if args.command == "cancel":
                receipt = await client.cancel(session_id=args.session, workspace=args.workspace,
                                              attachment_id=args.attachment, request_id=args.request_id)
                print(receipt.model_dump_json())
                return 0
            if args.command == "decide":
                assert decision is not None
                request, call, server, approve = decision
                return await _apply_decision(
                    client, session_id=args.session, workspace=args.workspace, request=request,
                    call=call, server=server, approve=approve, approval_id=args.approval_id)
            loaded = json.loads(args.params)
            if not isinstance(loaded, dict):
                raise BackendError("invalid_rpc")
            params = cast(dict[object, object], loaded)
            result = await client.rpc(args.method, **{str(key): value for key, value in params.items()})
            print(json.dumps(result, ensure_ascii=False))
            return 0
    except (BackendError, OSError, ValueError) as exc:
        print(exc.code if isinstance(exc, BackendError) else type(exc).__name__, file=sys.stderr)
        return 1


def run_client(argv: list[str]) -> int:
    return asyncio.run(_run(argv))
