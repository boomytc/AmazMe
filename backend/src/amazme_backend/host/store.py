import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from amazme_backend.accounts.configuration import ProviderTransport
from amazme_backend.contracts.accounts import OAuthView, ProviderCheck, ProviderCheckRequest
from amazme_backend.contracts.execution import EditFile, ProcessLease, ServiceInfo, WorkerInfo, WriteFile
from amazme_backend.contracts.feedback import AnswerFeedback, AnswerFeedbackWrite
from amazme_backend.contracts.host import PrepareUpdate, UpdateRecord
from amazme_backend.contracts.ipc.host import PreparedFileWrite
from amazme_backend.contracts.ipc.worker import WorkerActivity
from amazme_backend.contracts.mcp import (
    McpConfigPatch,
    McpConfiguration,
    McpConfigWrite,
    McpHttpSettings,
    McpLoginRequest,
    McpOpen,
    McpReconnect,
)
from amazme_backend.contracts.plugins import PluginPackage, PluginPackageAdd, PluginPackages
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.projects import ProjectUpdate, ProjectView
from amazme_backend.contracts.schedules import ScheduleControl, ScheduleInput, ScheduleOutcome, ScheduleView
from amazme_backend.contracts.sessions import CreateSession, Receipt, Session, SessionList, SessionModel
from amazme_backend.contracts.settings import InterfacePreferences, ProductSettings
from amazme_backend.host.persistence import (
    checkpoints,
    content,
    deliveries,
    mcp,
    memories,
    plugins,
    registry,
    rows,
    schedules,
    schema,
    sessions,
    updates,
    workspaces,
)
from amazme_backend.host.persistence.database import HostDatabase as Database
from amazme_backend.host.records import Delivery, DeliveryKind, ServiceRecord
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class HostStore:
    def __init__(self, path: Path, *, require_existing: bool = False):
        self.db = Database(path, require_existing=require_existing, preflight=self.preflight)
        self.failed = False

    @staticmethod
    def preflight(db: sqlite3.Connection) -> None:
        return schema.preflight(db)

    async def call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:
        if self.failed:
            raise BackendError("storage_blocked", status=503)
        try:
            return await self.db.call(operation)
        except BackendError as error:
            if error.code.startswith("storage_") or error.code in {
                "database_closed",
                "unsupported_storage_format",
            }:
                self.failed = True
            raise
        except (sqlite3.Error, OSError, ValidationError) as error:
            self.failed = True
            raise BackendError("storage_failure", status=503) from error

    async def transaction[T](self, operation: Callable[[sqlite3.Connection], T]) -> T:

        def invoke(db: sqlite3.Connection) -> T:
            db.execute("BEGIN IMMEDIATE")
            try:
                result = operation(db)
                db.execute("COMMIT")
                return result
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise

        return await self.call(invoke)

    async def initialize(self, instance: str, build: str, lease: ProcessLease) -> int:
        return await schema.initialize(self, instance, build, lease)

    async def port(self, value: int | None = None) -> int:
        return await registry.port(self, value)

    @staticmethod
    def session_sql(tail: str) -> str:
        return rows.session_sql(tail)

    @staticmethod
    def session_row(row: sqlite3.Row) -> Session:
        return rows.session_row(row)

    async def sessions(self) -> SessionList:
        return await sessions.sessions(self)

    async def session(self, session_id: str) -> Session | None:
        return await sessions.session(self, session_id)

    async def workspace_grants(self) -> list[tuple[str, str]]:
        return await workspaces.workspace_grants(self)

    async def add_workspace_grant(self, name: str, host_path: str) -> None:
        return await workspaces.add_workspace_grant(self, name, host_path)

    async def remove_workspace_grant(self, name: str) -> None:
        return await workspaces.remove_workspace_grant(self, name)

    async def save_memory(
        self, memory_id: str, workspace: str, text: str, digest: str
    ) -> tuple[str, str, str]:
        return await memories.save_memory(self, memory_id, workspace, text, digest)

    async def memory_rows(self) -> list[tuple[str, str, str]]:
        return await memories.memory_rows(self)

    @staticmethod
    def save_checkpoint_row(
        db: sqlite3.Connection, cid: str, workspace: str, path: str, digest: str, content: str
    ) -> None:
        return checkpoints.save_checkpoint_row(db, cid, workspace, path, digest, content)

    async def save_checkpoint(
        self, checkpoint_id: str, workspace: str, path: str, digest: str, content: str
    ) -> tuple[str, str, str, str]:
        return await checkpoints.save_checkpoint(self, checkpoint_id, workspace, path, digest, content)

    async def file_write_preparation(
        self, session: str, call: str, write: WriteFile | EditFile
    ) -> PreparedFileWrite | None:
        return await checkpoints.file_write_preparation(self, session, call, write)

    async def prepare_file_write(
        self,
        session: str,
        call: str,
        write: WriteFile | EditFile,
        workspace: str,
        path: str,
        previous: tuple[str, str] | None,
        root: str,
    ) -> PreparedFileWrite:
        return await checkpoints.prepare_file_write(self, session, call, write, workspace, path, previous, root)

    async def checkpoints_for(self, workspace: str, path: str) -> list[tuple[str, str, str, str]]:
        return await checkpoints.checkpoints_for(self, workspace, path)

    async def checkpoint(self, checkpoint_id: str) -> tuple[str, str, str, str, str] | None:
        return await checkpoints.checkpoint(self, checkpoint_id)

    async def session_model(self, session_id: str) -> SessionModel | None:
        return await sessions.session_model(self, session_id)

    async def save_session_model(self, value: SessionModel) -> SessionModel:
        return await sessions.save_session_model(self, value)

    async def create_session(self, session_id: str, value: CreateSession) -> Session:
        return await sessions.create_session(self, session_id, value)

    async def lookup_reused(self, session_id: str, value: CreateSession) -> Session | None:
        return await sessions.lookup_reused(self, session_id, value)

    async def record_reuse(self, session_id: str, value: CreateSession, target: str) -> Session | None:
        return await sessions.record_reuse(self, session_id, value, target)

    async def empty_drafts(self) -> list[str]:
        return await sessions.empty_drafts(self)

    async def retain_session(self, session_id: str) -> None:
        await sessions.retain_session(self, session_id)

    async def create_branch(
        self, session_id: str, parent_id: str, fork_request_id: str, title: str, request_key: str = ""
    ) -> Session:
        return await sessions.create_branch(self, session_id, parent_id, fork_request_id, title, request_key)

    async def prepared_branch(self, session: str) -> Session:
        return await sessions.prepared_branch(self, session)

    async def discard_unopened_branch(self, session_id: str) -> None:
        return await sessions.discard_unopened_branch(self, session_id)

    async def exists(self, session: str) -> bool:
        return await sessions.exists(self, session)

    @staticmethod
    def delivery_row(row: sqlite3.Row) -> Delivery:
        return deliveries.delivery_row(row)

    async def enqueue(
        self,
        session: str,
        kind: DeliveryKind,
        key: str,
        value: Model,
        *,
        provider: ProviderConfig | None = None,
        transports: dict[str, ProviderTransport] | None = None,
    ) -> Delivery:
        return await deliveries.enqueue(
            self, session, kind, key, value, provider=provider, transports=transports
        )

    async def begin_quit(self) -> None:
        return await deliveries.begin_quit(self)

    async def pin_delivery_provider(
        self, identity: str, provider: ProviderConfig, transports: dict[str, ProviderTransport] | None = None
    ) -> Delivery:
        return await deliveries.pin_delivery_provider(self, identity, provider, transports)

    async def delivered(self, identity: str, receipt: Receipt) -> Delivery:
        return await deliveries.delivered(self, identity, receipt)

    async def rejected(self, identity: str, error: BackendError) -> Delivery:
        return await deliveries.rejected(self, identity, error)

    async def pending(self, session: str | None = None) -> list[Delivery]:
        return await deliveries.pending(self, session)

    async def set_archived(self, session_id: str, archived: bool) -> Session:
        return await sessions.set_archived(self, session_id, archived)

    async def rename_session(self, session_id: str, title: str, expected: str) -> Session:
        return await sessions.rename_session(self, session_id, title, expected)

    async def begin_session_removal(self, session: str) -> bool:
        return await sessions.begin_session_removal(self, session)

    async def finish_session_removal(self, session: str) -> None:
        return await sessions.finish_session_removal(self, session)

    async def activity(self, session: str, activity: WorkerActivity) -> None:
        return await sessions.activity(self, session, activity)

    async def demand(self, session: str = "") -> None:
        return await sessions.demand(self, session)

    async def due(self) -> list[str]:
        return await sessions.due(self)

    async def service(self) -> ServiceRecord | None:
        return await registry.service(self)

    async def services(self) -> list[ServiceInfo]:
        return await registry.services(self)

    async def blocked(self) -> str:
        return await registry.blocked(self)

    async def last_build(self, current: str) -> str:
        return await registry.last_build(self, current)

    async def save_service(self, value: ServiceRecord) -> None:
        return await registry.save_service(self, value)

    async def execution_initialized(self) -> bool:
        return await registry.execution_initialized(self)

    async def allow_restart(self, *, explicit: bool = False) -> None:
        return await registry.allow_restart(self, explicit=explicit)

    async def active_update(self) -> UpdateRecord | None:
        return await updates.active_update(self)

    async def update(self, identity: str) -> UpdateRecord:
        return await updates.update(self, identity)

    async def begin_update(self, value: PrepareUpdate, source: str) -> UpdateRecord:
        return await updates.begin_update(self, value, source)

    async def save_update(self, value: UpdateRecord) -> UpdateRecord:
        return await updates.save_update(self, value)

    async def source_hosts(self, current: str) -> list[ProcessLease]:
        return await registry.source_hosts(self, current)

    @staticmethod
    def verify_roster(previous: list[WorkerInfo], current: list[WorkerInfo]) -> None:
        return updates.verify_roster(previous, current)

    async def source_roster(self, identity: str, roster: list[WorkerInfo]) -> UpdateRecord:
        return await updates.source_roster(self, identity, roster)

    @staticmethod
    def project_row(row: sqlite3.Row) -> ProjectView:
        return content.project_row(row)

    async def save_project(self, project_id: str, name: str, workspaces: list[str]) -> ProjectView:
        return await content.save_project(self, project_id, name, workspaces)

    async def projects(self) -> list[ProjectView]:
        return await content.projects(self)

    async def update_project(self, project_id: str, value: ProjectUpdate) -> ProjectView:
        return await content.update_project(self, project_id, value)

    @staticmethod
    def settings_row(row: sqlite3.Row | None) -> ProductSettings:
        return content.settings_row(row)

    async def product_settings(self) -> ProductSettings:
        return await content.product_settings(self)

    async def save_product_settings(self, name: str, expected: int) -> ProductSettings:
        return await content.save_product_settings(self, name, expected)

    async def save_preferences(self, preferences: InterfacePreferences, expected: int) -> ProductSettings:
        return await content.save_preferences(self, preferences, expected)

    async def save_feedback(
        self, feedback_id: str, session_id: str, text: str, key: str
    ) -> tuple[str, str, str]:
        return await content.save_feedback(self, feedback_id, session_id, text, key)

    async def feedback_rows(self) -> list[tuple[str, str, str]]:
        return await content.feedback_rows(self)

    async def save_answer_feedback(self, session: str, value: AnswerFeedbackWrite) -> AnswerFeedback:
        return await content.save_answer_feedback(self, session, value)

    async def answer_feedback(self, session: str = "") -> list[AnswerFeedback]:
        return await content.answer_feedback(self, session)

    @staticmethod
    def check_answer_feedback_row(db: sqlite3.Connection, value: AnswerFeedback) -> bool:
        return content.check_answer_feedback_row(db, value)

    async def check_answer_feedback_import(self, values: list[AnswerFeedback]) -> None:
        return await content.check_answer_feedback_import(self, values)

    async def import_answer_feedback(self, values: list[AnswerFeedback]) -> None:
        return await content.import_answer_feedback(self, values)

    async def begin_provider_check(
        self, value: ProviderCheckRequest, configuration_revision: int, credential_revision: int
    ) -> tuple[ProviderCheck, bool]:
        return await content.begin_provider_check(self, value, configuration_revision, credential_revision)

    async def finish_provider_check(self, result: ProviderCheck) -> ProviderCheck:
        return await content.finish_provider_check(self, result)

    async def save_share(self, share_id: str, session_id: str, key: str, payload: str) -> str:
        return await content.save_share(self, share_id, session_id, key, payload)

    async def share_record(self, share_id: str) -> tuple[str, str] | None:
        return await content.share_record(self, share_id)

    async def read_share(self, share_id: str, session_id: str) -> str:
        return await content.read_share(self, share_id, session_id)

    async def ensure_import_session(
        self, session_id: str, title: str, workspace: str, project_id: str
    ) -> None:
        return await content.ensure_import_session(self, session_id, title, workspace, project_id)

    async def list_schedules(self) -> list[ScheduleView]:
        return await self.call(schedules.listing)

    async def schedule(self, identity: str) -> ScheduleView:
        return await self.call(lambda db: schedules.load(db, identity))

    async def save_schedule(self, value: ScheduleInput, now: int, secrets: tuple[str, ...]) -> ScheduleView:
        return await self.transaction(lambda db: schedules.save(db, value, now, secrets))

    async def claim_schedule(
        self,
        identity: str,
        now: int,
        provider: ProviderConfig,
        secrets: tuple[str, ...],
        *,
        operation_id: str = "",
        generation: int = 0,
        busy: bool = False,
        transports: dict[str, ProviderTransport] | None = None,
    ) -> ScheduleView:
        return await self.transaction(
            lambda db: schedules.claim(
                db,
                identity,
                now,
                provider,
                secrets,
                operation_id=operation_id,
                generation=generation,
                busy=busy,
                transports=transports,
            )
        )

    async def persist_schedule(self, value: ScheduleView) -> ScheduleView:
        return await self.transaction(lambda db: schedules.persist(db, value))

    async def finish_schedule(self, value: ScheduleView, outcome: ScheduleOutcome, now: int) -> ScheduleView:
        return await self.transaction(lambda db: schedules.finish(db, value, outcome, now))

    async def control_schedule(
        self, identity: str, value: ScheduleControl, action: Literal["enabled", "cancel", "remove"]
    ) -> ScheduleView:
        return await self.transaction(lambda db: schedules.control(db, identity, value, action))

    async def delete_schedule(self, identity: str) -> None:
        await self.transaction(lambda db: schedules.remove(db, identity))

    async def plugin_packages(self) -> PluginPackages:
        return await self.call(plugins.listing)

    async def existing_plugin_package(self, value: PluginPackageAdd) -> PluginPackages | None:
        return await self.call(lambda db: plugins.existing(db, value))

    async def add_plugin_package(self, value: PluginPackageAdd, entry: str) -> PluginPackages:
        return await self.transaction(lambda db: plugins.add(db, value, entry))

    async def begin_plugin_removal(self, identity: str, revision: int) -> PluginPackage:
        return await self.transaction(lambda db: plugins.begin_remove(db, identity, revision))

    async def finish_plugin_removal(self, identity: str) -> PluginPackages:
        return await self.transaction(lambda db: plugins.finish_remove(db, identity))

    async def mcp_configuration(self, workspace: str) -> McpConfiguration:
        return await self.call(lambda db: mcp.listing(db, workspace, self.db.path))

    async def change_mcp_configuration(
        self, value: McpConfigWrite | McpConfigPatch, workspace: str
    ) -> McpConfiguration:
        return await self.transaction(lambda db: mcp.change(db, value, workspace, self.db.path))

    async def effective_mcp_configuration(self, workspace: str) -> list[mcp.Configured]:
        return await self.call(lambda db: mcp.effective(db, workspace))

    async def current_mcp_server(self, item: mcp.Configured, session: str) -> str:
        return await self.call(lambda db: mcp.current_server(db, item, session))

    async def reserve_mcp_reconnect(self, session: str, workspace: str, value: McpReconnect) -> McpOpen:
        return await self.transaction(lambda db: mcp.reserve_reconnect(db, session, workspace, value))

    async def latest_mcp_reconnect(self, session: str, name: str, launch: str) -> str:
        return await self.call(lambda db: mcp.latest_reconnect(db, session, name, launch))

    async def mcp_login(self, identity: str) -> OAuthView:
        return await self.call(lambda db: mcp.login_view(db, identity))

    async def reserve_mcp_login(
        self, value: McpLoginRequest, active_count: int, provider_pending: bool
    ) -> tuple[McpHttpSettings | None, str, OAuthView]:
        return await self.transaction(lambda db: mcp.reserve_login(db, value, active_count, provider_pending))

    async def mcp_login_current(self, name: str, launch: str) -> bool:
        return await self.call(
            lambda db: any((item.name == name and item.launch_id == launch for item in mcp.effective(db, "")))
        )

    async def save_mcp_login(self, view: OAuthView) -> None:
        await self.transaction(lambda db: mcp.save_login(db, view))
