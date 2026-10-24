"""Connect to an existing Python Host; inspect or send one explicitly identified request.

Run with backend/.venv/bin/python and explicit arguments. Persist session/request IDs before retrying.
"""
import argparse
import asyncio
from pathlib import Path

from amazme_backend.sdk import Client


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--request', required=True)
    parser.add_argument('--prompt')
    args = parser.parse_args()
    async with Client(args.url, args.token_file.read_text().strip()) as client:
        session = await client.session(args.session)
        if session.workspace != args.workspace:
            raise ValueError('workspace_mismatch')
        if args.prompt is not None:
            attachment = await client.attach(session.session_id)
            try:
                receipt = await client.submit(session_id=session.session_id, workspace=session.workspace,
                    attachment_id=attachment.attachment_id, request_id=args.request, text=args.prompt,
                    append_system_prompt='Answer briefly.', allowed_tools=['read_file'])
                print(receipt.model_dump_json())
            finally:
                await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
        else:
            print((await client.request(session_id=session.session_id, request_id=args.request)).model_dump_json())
        print((await client.session_usage(session.session_id)).model_dump_json())


if __name__ == '__main__':
    asyncio.run(main())
