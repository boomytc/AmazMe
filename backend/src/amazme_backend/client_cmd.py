"""Non-interactive commands. The host, session, and workspace are always explicit."""

import argparse
import asyncio
import json
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
    return parser


async def _run(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
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
