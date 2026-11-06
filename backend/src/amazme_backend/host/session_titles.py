"""Generate a title from the first user message after the first exchange settles, without delaying delivery."""
import asyncio
import logging

from amazme_backend.accounts.configuration import request_identity
from amazme_backend.agent.model import conversation_title
from amazme_backend.ai.types import Auth
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import Receipt
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_access import WorkerSessions

log = logging.getLogger(__name__)


class SessionTitles:
    def __init__(self, lifecycle: HostLifecycle, access: WorkerSessions, accounts: AccountOperations):
        self.lifecycle = lifecycle
        self.access = access
        self.accounts = accounts
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.capacity = asyncio.Semaphore(4)

    async def consider(self, session: str) -> None:
        if session in self.tasks:
            return
        source = await self.lifecycle.store.title_source(session)
        if source is None:
            return
        request, provider = source
        receipt = await self.access.read(session, lambda store: store.get(request))
        if receipt.status == "succeeded" and receipt.answer.strip():
            self.tasks[session] = asyncio.create_task(self.generate(session, provider, receipt))

    async def generate(self, session: str, provider: ProviderConfig, receipt: Receipt) -> None:
        try:
            title = ""
            question = receipt.text.strip()
            if question and not contains_secret(question, self.accounts.secrets()):
                async with self.capacity, asyncio.timeout(60):
                    # Prefer the profile title model; thinking stays off even if chat default enables it.
                    config = await self.accounts.title_provider(provider)
                    title = await conversation_title(config, question,
                        auth=Auth(api_key=config.api_key, auth_type=config.auth_type, headers=request_identity(config.provider)))
                if contains_secret(title, self.accounts.secrets()):
                    title = ""
        except Exception as exc:
            log.warning("Session title generation failed: %s", type(exc).__name__)
            title = ""
        await self.lifecycle.store.finish_title(session, title or "新会话")

    def reap(self) -> None:
        for session, task in list(self.tasks.items()):
            if task.done():
                del self.tasks[session]
                task.result()

    async def close(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
