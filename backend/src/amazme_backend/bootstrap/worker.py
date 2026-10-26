"""Assemble the single session writer, model/account capabilities and worker HTTP process."""
import asyncio
import contextlib
from pathlib import Path

import httpx
import uvicorn

from amazme_backend.accounts.configuration import request_identity
from amazme_backend.accounts.store import AccountStore, ApiKeyCredential
from amazme_backend.agent.driver import Worker, WorkerContext
from amazme_backend.ai.catalog import SELECTION_INDEX
from amazme_backend.ai.types import Auth
from amazme_backend.contracts.identity import HostReady
from amazme_backend.contracts.mcp import catalog_payload, offers_from_views
from amazme_backend.contracts.models import Message
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.resources import ResourceOptions
from amazme_backend.contracts.web import WebCallRequest, WebCallView
from amazme_backend.diagnostics.faults import Faults
from amazme_backend.execution.client import SupervisorClient
from amazme_backend.execution.web.client import execute_web_call
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.features.memories.policy import inject_memories, relevant_memories
from amazme_backend.features.resources.service import session_resources
from amazme_backend.host.queries import HostQueries
from amazme_backend.interfaces.worker import application
from amazme_backend.platform.identity import build_id
from amazme_backend.platform.ipc import unix_listener
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.layout import SessionRuntimeFile, session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.service import SessionOps, SessionStore
from amazme_backend.shared.errors import BackendError


def create_worker(profile: Profile, session: str, instance: str, *, frozen: bool = False,
                  require_existing: bool = False, validation: bool = False) -> Worker:
    build = build_id()
    faults = Faults(profile.path, 'worker', instance, enabled=profile.config.testing)
    queries = HostQueries(profile.path)

    def current_provider() -> ProviderConfig:
        profile.reload_provider()
        return profile.config.provider

    def account_secrets() -> tuple[str, ...]:
        return AccountStore(profile.account_path).secrets()

    def resource_secrets() -> tuple[str, ...]:
        return (*account_secrets(), profile.token, profile.config.provider.api_key.get_secret_value())

    def scan(value: str) -> bool:
        profile.reload_provider()
        return contains_secret(value, account_secrets())

    def expand(text: str, options: ResourceOptions) -> tuple[str, str]:
        workspace = queries.session_workspace(session)
        location = profile.config.workspace if workspace == 'primary' else dict(queries.workspace_grants()).get(workspace)
        if location is None:
            raise BackendError('workspace_not_found')
        resources = session_resources(profile, session, options, workspace=Path(location))
        return resources.expand(text), resources.system_context()

    def prepare_messages(messages: list[Message]) -> list[Message]:
        query = next((item.content for item in reversed(messages) if item.role == 'user'), '')
        workspace = queries.session_workspace(session)
        profile.reload_provider()
        secrets = account_secrets()
        memories = [item for item in relevant_memories(queries.memory_rows(), workspace, query)
                    if not contains_secret(item.text, secrets)]
        return inject_memories(messages, memories)

    async def configured_model(config: ProviderConfig) -> tuple[ProviderConfig, Auth]:
        configured = await AccountStore(profile.account_path).configured(config)
        return configured, Auth(api_key=configured.api_key, auth_type=configured.auth_type,
                                headers=request_identity(configured.provider))

    async def execute_web(store: SessionOps, value: WebCallRequest, *, key: str, question: str,
                          client: httpx.AsyncClient | None, secrets: tuple[str, ...]) -> WebCallView:
        return await execute_web_call(store, value, key=key, question=question, client=client,
                                      contains_secret=contains_secret, secrets=secrets)

    def web_key(config: ProviderConfig) -> str:
        credential = AccountStore(profile.account_path).read().credentials.get('deepseek')
        return credential.key.get_secret_value() if config.provider == 'deepseek' and isinstance(credential, ApiKeyCredential) else ''

    store = SessionStore(session_database(profile.path, session), session, build=build,
                         config=profile.config.provider, approval_policy=profile.config.approval_policy,
                         faults=faults, require_existing=require_existing, instance=instance,
                         model_catalog=SELECTION_INDEX, expand_resources=expand, secret_source=resource_secrets)
    context = WorkerContext(build=build, profile_id=profile.config.profile_id, token=profile.token, faults=faults,
        identity=lambda state, epoch: profile.identity(instance, build, role='worker', state=state, host_epoch=epoch),
        current_provider=current_provider, configured_model=configured_model, secrets=account_secrets,
        contains_secret=scan, prepare_messages=prepare_messages,
        workspace=lambda: queries.session_workspace(session),
        host_ready=lambda: HostReady.model_validate_json((profile.path / 'ready.json').read_bytes()),
        web_key=web_key, execute_web=execute_web, mcp_catalog=lambda views: offers_from_views(views, surface='catalog'),
        catalog_payload=catalog_payload)
    return Worker(session, instance, store=store,
                  supervisor=SupervisorClient(profile.socket('supervisor'), profile.token),
                  context=context, frozen=frozen, validation=validation)


async def serve(profile: Profile, session: str, instance: str, *, frozen: bool = False,
                require_existing: bool = False, validation: bool = False) -> None:
    directory = profile.path / "sessions" / session
    with lock(directory / SessionRuntimeFile.WRITER_LOCK):
        owner = create_worker(profile, session, instance, frozen=frozen,
                              require_existing=require_existing, validation=validation)
        try:
            await owner.initialize()
            path = profile.worker_socket(session)
            listener = unix_listener(path)
            server = uvicorn.Server(uvicorn.Config(application(owner), log_level="error", access_log=False,
                                                  timeout_graceful_shutdown=5))
            async def watch() -> None:
                await owner.stop.wait()
                server.should_exit = True
            watcher = asyncio.create_task(watch())
            try:
                await server.serve(sockets=[listener])
            finally:
                watcher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher
                listener.close()
        finally:
            await owner.shutdown()
