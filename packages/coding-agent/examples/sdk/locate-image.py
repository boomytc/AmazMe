"""Run the existing Python crop pipeline with an explicitly selected classifier account.

Usage: backend/.venv/bin/python .../locate-image.py PROFILE IMAGE TARGET
This makes real classifier requests; it does not perform desktop actions.
"""
import argparse
import asyncio
from pathlib import Path

from amazme_backend.accounts import AccountStore
from amazme_backend.classifiers import ClassifierContext, ClassifierResult, classify
from amazme_backend.computer_grounding import locate
from amazme_backend.contracts import ComputerPolicy


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('profile', type=Path)
    parser.add_argument('image', type=Path)
    parser.add_argument('target')
    args = parser.parse_args()
    policy = ComputerPolicy()
    async def ask(context: ClassifierContext) -> ClassifierResult:
        return await classify(AccountStore(args.profile), policy.jev_provider, policy.jev_model, context)
    result = await locate(args.image.read_bytes(), args.target, 'look_closer', ask, policy)
    print(result.model_dump_json(exclude={'crop'}))


if __name__ == '__main__':
    asyncio.run(main())
