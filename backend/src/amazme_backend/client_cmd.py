"""Non-interactive commands. The host, session, and workspace are always explicit."""

import argparse
import asyncio
import json
import secrets
import sys
from typing import cast

from .contracts import BackendError
from .sdk import Client


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amazme-backend client")
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--workspace", required=True)
    create.add_argument("--title", default="新会话")
    submit = sub.add_parser("submit")
    submit.add_argument("--session", required=True)
    submit.add_argument("--workspace", required=True)
    submit.add_argument("--request-id", required=True)
    submit.add_argument("--text", required=True)
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
    decide.add_argument("--call", default="")
    decide.add_argument("--server", default="")
    decide.add_argument("--decision", default="")
    return parser


def _decision_target(args: argparse.Namespace) -> tuple[str, str, str, bool] | None:
    """Reject a missing or ambiguous decision before any host connection."""
    request, call, server = str(args.request or ""), str(args.call or ""), str(args.server or "")
    if str(args.decision or "") not in {"批准", "拒绝"}:
        print("invalid_decision", file=sys.stderr)
        return None
    if bool(request) == bool(call) or bool(server) != bool(call):
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


async def _apply_decision(client: Client, *, session_id: str, workspace: str, request: str, call: str,
                          server: str, approve: bool) -> int:
    current = await client.session(session_id)
    if current.workspace != workspace:
        raise BackendError("workspace_mismatch")
    attachment = await client.attach(session_id)
    try:
        if request:
            receipt, approval = await client.await_user_decision(
                session_id=session_id, request_id=request, attempts=400)
            if approval is None:
                if receipt.status not in {"succeeded", "cancelled", "interrupted", "failed", "unknown"}:
                    raise BackendError("approval_not_found", status=404)
            else:
                await client.decide(
                    session_id=session_id, attachment_id=attachment.attachment_id,
                    decision_id=secrets.token_hex(16), approval_id=approval.approval_id,
                    expected_revision=approval.revision, proposal_digest=approval.proposal_digest, approve=approve)
                receipt = await client.wait(session_id=session_id, request_id=request, attempts=400)
            print(receipt.model_dump_json())
            return _request_exit(approve, receipt.status, receipt.error)
        state = await client.mcp_state(session_id)
        found = next((item for item in state.calls if item.call_id == call and item.server_id == server), None)
        if found is None:
            raise BackendError("approval_not_found", status=404)
        if found.phase == "waiting_approval":
            await client.decide_mcp(
                session_id=session_id, attachment_id=attachment.attachment_id, server_id=server, call_id=call,
                decision_id=secrets.token_hex(16), digest=found.digest, approve=approve)
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
            if args.command == "create":
                session = await client.create_session(title=args.title, workspace=args.workspace)
                print(session.model_dump_json())
                return 0
            if args.command == "submit":
                attachment = await client.attach(args.session)
                receipt = await client.submit(session_id=args.session, workspace=args.workspace,
                                              attachment_id=attachment.attachment_id, request_id=args.request_id,
                                              text=args.text)
                receipt = await client.wait(session_id=args.session, request_id=receipt.request_id)
                print(receipt.model_dump_json())
                return 0 if receipt.status == "succeeded" else 1
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
                    call=call, server=server, approve=approve)
            loaded = json.loads(args.params)
            if not isinstance(loaded, dict):
                raise BackendError("invalid_rpc")
            params = cast(dict[object, object], loaded)
            result = await client.rpc(args.method, **{str(key): value for key, value in params.items()})
            print(json.dumps(result, ensure_ascii=False))
            return 0
    except BackendError as exc:
        print(exc.code, file=sys.stderr)
        return 1


def run_client(argv: list[str]) -> int:
    return asyncio.run(_run(argv))
