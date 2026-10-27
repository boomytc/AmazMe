from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import secrets
import time
from urllib.parse import quote

import httpx

from amazme_backend.accounts.configuration import request_identity, select_model
from amazme_backend.agent.model import summarize
from amazme_backend.ai.catalog import SELECTION_INDEX
from amazme_backend.ai.types import Auth
from amazme_backend.contracts.events import HistoryPage, Snapshot
from amazme_backend.contracts.execution import Cleanup, EffectResolution, SupervisorHealth
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.ipc.host import CodeToolBinding, CodeToolDispatch, CodeToolReceipt
from amazme_backend.contracts.ipc.supervisor import TerminalSession
from amazme_backend.contracts.ipc.worker import (
    ApprovalEnvelope,
    Cancel,
    CodeChild,
    JobNotice,
    JobNoticeEnvelope,
    ResolutionEnvelope,
    Submission,
)
from amazme_backend.contracts.models import ImagePart, Message
from amazme_backend.contracts.sessions import (
    ApprovalDecision,
    Attachment,
    BranchSession,
    Compaction,
    CompactSession,
    CreateSession,
    Receipt,
    RenameSession,
    SearchResults,
    Session,
    SessionDiagnostic,
    SessionList,
    Submit,
    UsageReport,
    WorkflowOpen,
    WorkflowVerdict,
    WorkflowView,
)
from amazme_backend.contracts.web import WebCallRequest, WebCallView, WebPolicy, validate_base_url
from amazme_backend.execution.processes import exited
from amazme_backend.execution.web.client import execute_web_call, original_question
from amazme_backend.features.management.rules import contains_secret
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.computer import ComputerOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.records import DeliveryKind
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.store import Delivery
from amazme_backend.platform.private_files import lock
from amazme_backend.profiles.layout import SessionRuntimeFile, session_database
from amazme_backend.sessions.maintenance import (
    read_session_policies,
    read_settled_root,
    remove_session_directory,
)
from amazme_backend.sessions.service import TERMINAL, SessionOps, compaction_basis
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model
from amazme_backend.workspaces.paths import PRIMARY


class SessionOperations:
    def __init__(
        self,
        access: WorkerSessions,
        accounts: AccountOperations,
        computer: ComputerOperations,
        lifecycle: HostLifecycle,
    ):
        self.access = access
        self.accounts = accounts
        self.computer = computer
        self.lifecycle = lifecycle
        self.delivery_locks: dict[str, asyncio.Lock] = {}
        self.session_management_locks: dict[str, asyncio.Lock] = {}
        self.compacting: set[str] = set()
        self.attachments: dict[str, Attachment] = {}
        self.attachment_seen: dict[str, float] = {}
        self.web_client: httpx.AsyncClient | None = None

    async def sessions(self) -> SessionList:
        return await self.lifecycle.store.sessions()

    async def dispatch_code_tool(self, value: CodeToolDispatch, *, cancel: bool = False) -> CodeToolReceipt:
        if value.build_id != self.lifecycle.build or value.host_epoch != self.lifecycle.fence.host_epoch:
            raise BackendError("stale_host_epoch")
        await self.lifecycle.require_session(value.session_id)
        binding = await self.lifecycle.supervisor.call(
            "POST", "/code/tools/bind", CodeToolBinding, value.model_copy(update={"cancel": cancel})
        )
        if cancel:
            receipt = await self.deliver(
                value.session_id,
                "cancel",
                binding.request_id,
                Cancel(**self.lifecycle.fence.model_dump(), request_id=binding.request_id),
            )
        elif binding.parent_request_id:
            receipt = await self.access.operate(
                value.session_id,
                lambda store: store.accept_code_tool(
                    CodeChild(
                        parent_request_id=binding.parent_request_id,
                        parent_step_id=binding.parent_step_id,
                        request_id=binding.request_id,
                        call=binding.call,
                    )
                ),
            )
        else:
            receipt = await self.deliver(
                value.session_id,
                "submit",
                binding.request_id,
                Submit(
                    request_id=binding.request_id,
                    text=f"Script {value.run_id} tool {value.name}",
                    tool_call=binding.call,
                ),
            )
        messages = (
            await self.access.read(value.session_id, lambda store: store.messages(binding.request_id))
            if receipt.status == "succeeded"
            else []
        )
        return CodeToolReceipt(
            receipt=receipt,
            images=[image for message in messages if message.role == "tool" for image in message.images],
        )

    async def create_session(self, value: CreateSession) -> Session:
        self.lifecycle.admit()
        await self.lifecycle.require_workspace(value.workspace)
        chosen = value.session_id
        if chosen and (len(chosen) != 32 or any((item not in "0123456789abcdef" for item in chosen))):
            raise BackendError("invalid_session_id", status=400)
        return await self.lifecycle.store.create_session(chosen or secrets.token_hex(16), value)

    async def rename_session(self, session_id: str, value: RenameSession) -> Session:
        self.lifecycle.admit()
        title = value.title.strip()
        if not title:
            raise BackendError("session_name_required")
        return await self.lifecycle.store.rename_session(session_id, title, value.expected_title)

    async def _grant_allows_new_work(self, session_id: str) -> bool:
        if not await self.lifecycle.store.exists(session_id):
            raise BackendError("session_not_found", status=404)
        session = next((item for item in (await self.sessions()).sessions if item.session_id == session_id))
        if session.workspace == PRIMARY:
            return True
        return session.workspace in {name for name, _host in await self.lifecycle.store.workspace_grants()}

    async def open_workflow(self, session: str, value: WorkflowOpen) -> WorkflowView:
        path = session_database(self.lifecycle.profile.path, session)
        existing = False
        if path.is_file():
            try:
                await self.workflow(session, value.workflow_id)
            except BackendError as exc:
                if exc.code != "workflow_not_found":
                    raise
            else:
                existing = True
        if not existing and contains_secret(value.check, self.accounts.secrets()):
            raise BackendError("workflow_secret")
        if not existing and (not await self._grant_allows_new_work(session)):
            raise BackendError("workspace_not_found", status=404)
        choice = await self.lifecycle.store.session_model(session)
        captured = (
            select_model(
                self.lifecycle.profile.config.provider,
                choice,
                self.accounts.accounts.read().transports,
                catalog=SELECTION_INDEX,
            )
            if not existing
            else None
        )
        return await self.access.operate(
            session,
            lambda store: store.open_workflow(
                value.workflow_id, value.check, value.correction_limit, accepted_config=captured
            ),
        )

    async def workflow(self, session: str, workflow_id: str) -> WorkflowView:
        return await self.access.operate(
            session, lambda store: store.workflow(workflow_id), require_active=False, write=False
        )

    async def resume_workflow(self, session: str, workflow_id: str) -> WorkflowView:
        return await self.access.operate(
            session, lambda store: store.resume_workflow(workflow_id), require_active=False
        )

    async def record_verdict(self, session: str, workflow_id: str, value: WorkflowVerdict) -> WorkflowView:
        allowed = await self._grant_allows_new_work(session)
        return await self.access.operate(
            session,
            lambda store: store.record_verdict(
                workflow_id, value.verdict_id, value.passed, allow_new_child=allowed
            ),
        )

    async def cancel_workflow(self, session: str, workflow_id: str) -> WorkflowView:

        async def operation(store: SessionOps) -> WorkflowView:
            view = await store.workflow(workflow_id)
            await store.cancel(
                view.parent_id, HostFence(host_epoch=await store.host_epoch(), build_id=self.lifecycle.build)
            )
            return await store.workflow(workflow_id)

        return await self.access.operate(session, operation)

    async def cancel_workflow_child(self, session: str, workflow_id: str, request_id: str) -> WorkflowView:
        return await self.access.operate(
            session, lambda store: store.cancel_workflow_child(workflow_id, request_id)
        )

    async def save_web_policy(self, session: str, value: WebPolicy) -> WebPolicy:
        saved = value.model_copy(update={"base_url": validate_base_url(value.base_url)})
        return await self.access.operate(session, lambda store: store.save_web_policy(saved))

    async def web_policy(self, session: str) -> WebPolicy:
        return await self.access.operate(
            session, lambda store: store.web_policy(), require_active=False, write=False
        )

    async def _web_question(self, session: str) -> str:

        async def read(store: SessionOps) -> str:
            roots = [item for item in (await store.snapshot()).requests if item.kind == "root"]
            if not roots:
                return ""
            messages = await store.messages(roots[-1].request_id)
            text = next(
                (item.content for item in reversed(messages) if item.role == "user" and item.content.strip()),
                roots[-1].text,
            )
            return original_question(text)

        return await self.access.operate(session, read, require_active=False, write=False)

    async def web_call(self, session: str, value: WebCallRequest) -> WebCallView:
        question = ""
        if value.kind == "search":
            policy = await self.web_policy(session)
            if policy.enabled and policy.send_original_question and self.accounts.web_key():
                question = await self._web_question(session)
        return await self.access.operate(
            session,
            lambda store: execute_web_call(
                store,
                value,
                key=self.accounts.web_key(),
                question=question,
                client=self.web_client,
                contains_secret=contains_secret,
                secrets=self.accounts.secrets(),
            ),
        )

    async def branch_session(self, parent: str, value: BranchSession) -> Session:
        async with self.lifecycle.update_lock:
            self.lifecycle.admit()
            child_id = value.branch_id or secrets.token_hex(16)
            request_key = hashlib.sha256(
                json.dumps([parent, value.model_dump()], sort_keys=True).encode()
            ).hexdigest()
            existing = await self.lifecycle.store.exists(child_id)
            if existing:
                prior = await self.lifecycle.store.create_branch(
                    child_id, parent, value.request_id, value.title, request_key
                )
                if prior.prepared:
                    return prior
            await self.lifecycle.require_session(parent)
            parent_path = session_database(self.lifecycle.profile.path, parent)
            read_settled_root(parent_path, value.request_id)
            web, computer = read_session_policies(parent_path)
            web = web.model_copy(update={"base_url": validate_base_url(web.base_url)})
            source = await self.lifecycle.store.session(parent)
            assert source is not None
            if source.archived:
                raise BackendError("session_archived")
            await self.lifecycle.require_workspace(source.workspace)
            title = value.title.strip() or f"分支：{source.title}"
            await self.lifecycle.store.create_branch(
                child_id, parent, value.request_id, title[:100], request_key
            )
            try:
                async with self.access.maintenance(child_id) as child:
                    await child.prepare_branch(parent_path, value.request_id, web, computer)
            except Exception:
                if not existing:
                    health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
                    service = await self.lifecycle.store.service()
                    if service is None:
                        raise BackendError("supervisor_unavailable", status=503)
                    self.lifecycle.check_supervisor(health.identity, service, fenced=True)
                    owners = [worker for worker in health.workers if worker.session_id == child_id]
                    if all(
                        worker.state == "stopped"
                        and worker.process_lease is not None
                        and exited(worker.process_lease)
                        for worker in owners
                    ):
                        async with self.access.worker_locks.setdefault(child_id, asyncio.Lock()):
                            directory = session_database(self.lifecycle.profile.path, child_id).parent
                            if directory.exists():
                                with lock(directory / SessionRuntimeFile.WRITER_LOCK):
                                    remove_session_directory(directory)
                            await self.lifecycle.store.discard_unopened_branch(child_id)
                raise
            return await self.lifecycle.store.prepared_branch(child_id)

    async def search_session(self, session: str, query: str) -> SearchResults:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            return SearchResults(query=query.strip(), hits=[])
        hits = await self.access.read(session, lambda store: store.search(query))
        return SearchResults(query=query.strip(), hits=hits)

    async def session_history(self, session: str, before: str = "") -> HistoryPage:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        if len(before) > 128:
            raise BackendError("invalid_history_cursor")
        if not session_database(self.lifecycle.profile.path, session).is_file():
            return HistoryPage(session_id=session, requests=[], events=[])
        return await self.access.read(session, lambda store: store.history(before))

    async def input_image(self, session: str, request_id: str, index: int) -> ImagePart:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        if not session_database(self.lifecycle.profile.path, session).is_file():
            raise BackendError("image_not_found", status=404)
        return await self.access.read(session, lambda store: store.input_image(request_id, index))

    async def session_usage(self, session: str) -> UsageReport:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            return UsageReport(session_id=session, priced=True, cost_micro_usd=0)
        return await self.access.read(session, lambda store: store.usage())

    async def session_diagnostic(self, session: str) -> SessionDiagnostic:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            return SessionDiagnostic(session_id=session, present=False, state="absent")
        return await self.access.read(session, lambda store: store.diagnostic())

    async def archive_session(self, session: str, archived: bool) -> Session:
        async with self.session_management_locks.setdefault(session, asyncio.Lock()):
            self.lifecycle.admit()
            if not archived:
                current = next(
                    (item for item in (await self.sessions()).sessions if item.session_id == session), None
                )
                if current is not None and current.archived:
                    await self.cancel_unstarted(session)
                    await self.retire_session_resources(session)
                return await self.lifecycle.store.set_archived(session, False)
            updated = await self.lifecycle.store.set_archived(session, True)
            await self.cancel_unstarted(session)
            await self.retire_session_resources(session)
            return updated

    async def retire_session_resources(self, session: str) -> None:
        driver = self.computer.computer_drivers.get(session)
        if driver is not None:
            code = await self.computer.park_driver(session, driver)
            await self.access.operate(
                session, lambda store: store.note_computer_exit(code), require_active=False
            )
            if code is None:
                raise BackendError("computer_exit_unproven", status=503)
        service = await self.lifecycle.store.service()
        if service is not None and service.state != "stopped":
            await self.lifecycle.ensure_supervisor()
            result = await self.lifecycle.supervisor.call(
                "POST",
                "/sessions/retire",
                Cleanup,
                TerminalSession(**self.lifecycle.fence.model_dump(), session_id=session),
            )
            if result.session_id != session or result.state != "clean" or (not result.proof_id):
                raise BackendError("execution_cleanup_pending", status=503)
            cached = self.access.worker_peers.pop(session, None)
            if cached:
                await cached[1].close()

    async def remove_session(self, session: str) -> None:
        async with self.session_management_locks.setdefault(session, asyncio.Lock()):
            async with self.lifecycle.update_lock:
                self.lifecycle.admit()
                directory = session_database(self.lifecycle.profile.path, session).parent
                if directory.is_symlink() or directory.parent.is_symlink():
                    raise BackendError("branch_cleanup_refused")
                if not await self.lifecycle.store.begin_session_removal(session):
                    return
                await self.cancel_unstarted(session)
                await self.retire_session_resources(session)
                async with self.access.worker_locks.setdefault(session, asyncio.Lock()):
                    await self.retire_session_resources(session)
                    if directory.exists():
                        handle = lock(directory / SessionRuntimeFile.WRITER_LOCK)
                        try:
                            remove_session_directory(directory)
                        finally:
                            handle.close()
                    await self.lifecycle.store.finish_session_removal(session)
                    for attachment_id, attachment in list(self.attachments.items()):
                        if attachment.session_id == session:
                            self.release_attachment(session, attachment_id)

    async def cancel_unstarted(self, session: str) -> None:
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            return

        async def operation(store: SessionOps) -> None:
            fence = HostFence(host_epoch=await store.host_epoch(), build_id=self.lifecycle.build)
            for receipt in (await store.snapshot()).requests:
                if (
                    receipt.kind == "root"
                    and receipt.status not in TERMINAL
                    and (not receipt.cancel_requested)
                ):
                    await store.cancel(receipt.request_id, fence)

        async with self.access.maintenance(session, allow_business=True) as client:
            await operation(client)

    async def compact_session(self, session: str, value: CompactSession) -> Compaction:
        self.lifecycle.admit()
        self.compacting.add(value.compaction_id)
        try:
            return await self._compact_session(session, value)
        finally:
            self.compacting.discard(value.compaction_id)

    async def _compact_session(self, session: str, value: CompactSession) -> Compaction:
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        source = next((item for item in (await self.sessions()).sessions if item.session_id == session))
        if source.archived:
            raise BackendError("session_archived")
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            raise BackendError("compaction_unsettled")
        payloads = await self.access.read(
            session, lambda store: store.message_payloads(value.through_request_id)
        )
        if not payloads:
            raise BackendError("compaction_unsettled")
        basis = compaction_basis(payloads)
        messages = [Message.model_validate_json(payload) for payload in payloads]
        self.lifecycle.profile.reload_provider()
        if contains_secret(
            "\n".join((message.content for message in messages)) + "\n" + value.instructions,
            self.accounts.secrets(),
        ):
            raise BackendError("compaction_secret")
        existing = await self.access.operate(
            session,
            lambda store: store.begin_compaction(
                value.compaction_id, value.through_request_id, value.instructions
            ),
        )
        if existing is not None:
            return existing
        try:
            choice = await self.lifecycle.store.session_model(session)
            selected = select_model(
                self.lifecycle.profile.config.provider,
                choice,
                self.accounts.accounts.read().transports,
                catalog=SELECTION_INDEX,
            )
            configured = await self.accounts.accounts.configured(selected)
            await self.accounts.write_guard()
            summary = await summarize(
                configured,
                messages,
                value.instructions,
                auth=Auth(api_key=configured.api_key, auth_type=configured.auth_type,
                          headers=request_identity(configured.provider)),
            )
        except BackendError:
            try:
                await self.access.operate(
                    session, lambda store: store.release_compaction(value.compaction_id)
                )
            except BackendError:
                pass
            raise
        self.lifecycle.profile.reload_provider()
        if contains_secret(summary, self.accounts.secrets()):
            raise BackendError("compaction_secret")
        return await self.access.operate(
            session,
            lambda store: store.commit_compaction(
                value.compaction_id, value.through_request_id, summary, basis, value.instructions
            ),
        )

    async def attach_session(self, session: str) -> Attachment:
        await self.lifecycle.require_session(session)
        expired = [
            key for key in self.attachments if time.monotonic() - self.attachment_seen.get(key, 0) > 300
        ]
        for key in expired:
            self.attachments.pop(key, None)
            self.attachment_seen.pop(key, None)
        if len(self.attachments) >= 128:
            raise BackendError("attachment_capacity", status=429)
        value = Attachment(
            attachment_id=secrets.token_hex(16),
            session_id=session,
            host_epoch=self.lifecycle.fence.host_epoch,
            build_id=self.lifecycle.build,
        )
        self.attachments[value.attachment_id] = value
        self.attachment_seen[value.attachment_id] = time.monotonic()
        return value

    async def session_snapshot(self, session: str) -> Snapshot:
        self.lifecycle.admit()
        return await (await self.access.reader(session)).call("GET", "/snapshot", Snapshot)

    async def request_receipt(self, session: str, request_id: str) -> Receipt:
        self.lifecycle.admit()
        return await (await self.access.reader(session)).call(
            "GET", "/requests/" + quote(request_id, safe=""), Receipt
        )

    def release_attachment(self, session: str, attachment_id: str) -> None:
        existing = self.attachments.get(attachment_id)
        if existing and existing.session_id != session:
            raise BackendError("attachment_conflict")
        self.attachments.pop(attachment_id, None)
        self.attachment_seen.pop(attachment_id, None)

    def check_attachment(self, identity: str, session: str) -> Attachment:
        value = self.attachments.get(identity)
        if (
            value is None
            or value.session_id != session
            or value.host_epoch != self.lifecycle.fence.host_epoch
            or (value.build_id != self.lifecycle.build)
            or (time.monotonic() - self.attachment_seen.get(identity, 0) > 300)
        ):
            raise BackendError("stale_client_binding")
        self.attachment_seen[identity] = time.monotonic()
        return value

    async def deliver(
        self, session: str, kind: DeliveryKind, key: str, value: Model
    ) -> Receipt:
        self.lifecycle.admit()
        self.lifecycle.profile.reload_provider()
        delivery = await self.lifecycle.store.enqueue(
            session,
            kind,
            key,
            value,
            provider=self.lifecycle.profile.config.provider,
            transports=self.accounts.accounts.read().transports,
        )
        if delivery.state == "rejected":
            raise BackendError(delivery.error_code, status=delivery.error_status)
        if delivery.receipt is not None:
            with contextlib.suppress(httpx.TransportError, BackendError):
                return await (await self.access.worker(session, maintenance=True)).call(
                    "GET", "/requests/" + quote(delivery.receipt.request_id, safe=""), Receipt
                )
            return delivery.receipt
        async with self.delivery_locks.setdefault(session, asyncio.Lock()):
            for pending in await self.lifecycle.store.pending(session):
                result = await self.dispatch(pending)
                if pending.delivery_id == delivery.delivery_id:
                    if result.receipt is not None:
                        return result.receipt
                    raise BackendError(result.error_code, status=result.error_status)
        result = await self.lifecycle.store.enqueue(session, kind, key, value)
        if result.receipt is not None:
            return result.receipt
        raise BackendError(result.error_code or "delivery_pending", status=result.error_status or 503)

    async def dispatch(self, delivery: Delivery) -> Delivery:
        self.lifecycle.admit()
        self.lifecycle.profile.reload_provider()
        delivery = await self.lifecycle.store.pin_delivery_provider(
            delivery.delivery_id,
            self.lifecycle.profile.config.provider,
            self.accounts.accounts.read().transports,
        )
        peer = await self.access.worker(delivery.session_id)
        expected_request = ""
        try:
            if delivery.kind == "submit":
                value = Submit.model_validate_json(delivery.payload)
                expected_request = value.request_id
                receipt = await peer.call(
                    "POST",
                    "/submissions",
                    Receipt,
                    Submission(**self.lifecycle.fence.model_dump(), value=value, provider=delivery.provider),
                )
            elif delivery.kind == "job_notice":
                notice = JobNotice.model_validate_json(delivery.payload)
                expected_request = notice.request_id
                receipt = await peer.call("POST", "/job-notices", Receipt,
                    JobNoticeEnvelope(**self.lifecycle.fence.model_dump(), value=notice))
            elif delivery.kind == "cancel":
                value = Cancel.model_validate_json(delivery.payload)
                expected_request = value.request_id
                receipt = await peer.call(
                    "POST",
                    "/requests/" + quote(value.request_id, safe="") + "/cancel",
                    Receipt,
                    Cancel(**self.lifecycle.fence.model_dump(), request_id=value.request_id),
                )
            elif delivery.kind == "approval":
                approval = ApprovalDecision.model_validate_json(delivery.payload)
                receipt = await peer.call(
                    "POST",
                    "/approvals",
                    Receipt,
                    ApprovalEnvelope(**self.lifecycle.fence.model_dump(), value=approval),
                )
            else:
                resolution = EffectResolution.model_validate_json(delivery.payload)
                receipt = await peer.call(
                    "POST",
                    "/effects/resolve",
                    Receipt,
                    ResolutionEnvelope(**self.lifecycle.fence.model_dump(), value=resolution),
                )
            if expected_request and receipt.request_id != expected_request:
                raise BackendError("receipt_identity_mismatch", status=503)
            await self.lifecycle.faults.hit(
                "delivery", session_id=delivery.session_id, request_id=receipt.request_id
            )
            result = await self.lifecycle.store.delivered(delivery.delivery_id, receipt)
            return result
        except BackendError as error:
            if delivery.kind == "job_notice" and error.code == "queue_full":
                raise
            if error.code in {
                "request_conflict",
                "queue_full",
                "session_busy",
                "scheduled_steer_unsupported",
                "steer_target_settled",
                "context_limit",
                "approval_decision_conflict",
                "approval_not_found",
                "stale_approval",
                "resolution_conflict",
                "effect_not_found",
                "invalid_effect_resolution",
                "stale_effect_resolution",
            }:
                return await self.lifecycle.store.rejected(delivery.delivery_id, error)
            raise
