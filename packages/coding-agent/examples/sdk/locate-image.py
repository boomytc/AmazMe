"""Run the existing Python crop pipeline with an explicitly selected classifier account.

Usage: backend/.venv/bin/python .../locate-image.py PROFILE IMAGE TARGET
This makes real classifier requests; it does not perform desktop actions.
"""
import argparse
import asyncio
from pathlib import Path

from amazme_backend.accounts.store import AccountStore, ApiKeyCredential
from amazme_backend.ai.classification.client import classify
from amazme_backend.ai.classification.types import ClassifierContext, ClassifierResult
from amazme_backend.ai.types import Auth, RequestTransport
from amazme_backend.contracts import ComputerPolicy
from amazme_backend.execution.computer.grounding import locate


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('profile', type=Path)
    parser.add_argument('image', type=Path)
    parser.add_argument('target')
    args = parser.parse_args()
    policy = ComputerPolicy(jev_model='jev-latest')
    accounts = AccountStore(args.profile)

    async def ask(context: ClassifierContext) -> ClassifierResult:
        configured = accounts.read().transports.get(policy.jev_provider)
        transport = RequestTransport(proxy=configured.proxy if configured else '',
                                     headers=configured.headers if configured else {})

        async def auth() -> Auth:
            credential = await accounts.resolve(policy.jev_provider, proxy=transport.proxy)
            if credential is None:
                return Auth()
            key = credential.key if isinstance(credential, ApiKeyCredential) else credential.access
            return Auth(api_key=key, auth_type=credential.type)

        return await classify(policy.jev_provider, policy.jev_model, context, auth=auth, transport=transport)

    result = await locate(args.image.read_bytes(), args.target, 'look_closer', ask, policy)
    print(result.model_dump_json(exclude={'crop'}))


if __name__ == '__main__':
    asyncio.run(main())
