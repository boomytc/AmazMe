from __future__ import annotations

import asyncio
import base64
import binascii
import json

from amazme_backend.contracts.artifacts import ArtifactBody, ArtifactList, ArtifactView, ArtifactWrite
from amazme_backend.contracts.feedback import (
    AnswerFeedback,
    AnswerFeedbackList,
    AnswerFeedbackWrite,
    FeedbackView,
    FeedbackWrite,
)
from amazme_backend.contracts.management import ExportBundle, ExportMessage, ExportSession, ImportResult
from amazme_backend.contracts.memories import MemoryList, MemoryView, MemoryWrite
from amazme_backend.contracts.projects import ProjectList, ProjectUpdate, ProjectView, ProjectWrite
from amazme_backend.contracts.settings import (
    InterfacePreferences,
    PreferencesUpdate,
    ProductSettings,
    SettingsUpdate,
)
from amazme_backend.contracts.sharing import ShareMessage, ShareView, ShareWrite
from amazme_backend.features.artifacts.service import list_artifacts, read_artifact, save_artifact
from amazme_backend.features.management.rules import (
    bundle_digest,
    bundle_text,
    contains_secret,
    transcript_digest,
)
from amazme_backend.features.management.rules import digest as content_digest
from amazme_backend.features.memories.policy import match_memories, remember
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.sessions import SessionOperations
from amazme_backend.profiles.layout import session_database
from amazme_backend.shared.errors import BackendError


class ContentOperations:
    def __init__(
        self,
        access: WorkerSessions,
        accounts: AccountOperations,
        lifecycle: HostLifecycle,
        sessions: SessionOperations,
    ):
        self.access = access
        self.accounts = accounts
        self.lifecycle = lifecycle
        self.sessions = sessions

    async def _open_transcript(self, session: str) -> list[tuple[str, str, str]]:
        path = session_database(self.lifecycle.profile.path, session)
        if not path.is_file():
            return []
        return await self.access.read(session, lambda store: store.transcript())

    async def save_project(self, value: ProjectWrite) -> ProjectView:
        self.lifecycle.admit()
        if not value.name.strip():
            raise BackendError("project_name_required")
        for workspace in value.workspaces:
            await self.lifecycle.require_workspace(workspace)
        return await self.lifecycle.store.save_project(
            value.project_id, value.name.strip(), list(dict.fromkeys(value.workspaces))
        )

    async def projects(self) -> ProjectList:
        self.lifecycle.admit()
        return ProjectList(projects=await self.lifecycle.store.projects())

    async def update_project(self, project_id: str, value: ProjectUpdate) -> ProjectView:
        self.lifecycle.admit()
        if not value.name.strip():
            raise BackendError("project_name_required")
        if not value.removed:
            for workspace in value.workspaces:
                await self.lifecycle.require_workspace(workspace)
        updated = await self.lifecycle.store.update_project(
            project_id,
            value.model_copy(
                update={"name": value.name.strip(), "workspaces": list(dict.fromkeys(value.workspaces))}
            ),
        )
        if value.removed:
            for session in (await self.sessions.sessions()).sessions:
                if session.project_id == project_id:
                    async with self.sessions.session_management_locks.setdefault(
                        session.session_id, asyncio.Lock()
                    ):
                        current = next(
                            (
                                item
                                for item in (await self.sessions.sessions()).sessions
                                if item.session_id == session.session_id
                            ),
                            None,
                        )
                        if current is not None and current.archived:
                            await self.sessions.cancel_unstarted(session.session_id)
                            await self.sessions.retire_session_resources(session.session_id)
        return updated

    async def product_settings(self) -> ProductSettings:
        self.lifecycle.admit()
        return await self.lifecycle.store.product_settings()

    async def save_product_settings(self, value: SettingsUpdate) -> ProductSettings:
        self.lifecycle.admit()
        return await self.lifecycle.store.save_product_settings(
            value.display_name.strip(), value.expected_revision
        )

    async def save_preferences(self, value: PreferencesUpdate) -> ProductSettings:
        self.lifecycle.admit()
        return await self.lifecycle.store.save_preferences(value.preferences, value.expected_revision)

    async def save_feedback(self, value: FeedbackWrite) -> FeedbackView:
        self.lifecycle.admit()
        text = value.text.strip()
        if contains_secret(text, self.accounts.secrets()):
            raise BackendError("feedback_secret")
        if value.session_id:
            if not await self.lifecycle.store.exists(value.session_id):
                raise BackendError("session_not_found", status=404)
        key = content_digest(
            json.dumps(
                {"session_id": value.session_id, "text": text},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
        )
        feedback_id, session_id, stored = await self.lifecycle.store.save_feedback(
            value.feedback_id, value.session_id, text, key
        )
        return FeedbackView(feedback_id=feedback_id, session_id=session_id, text=stored)

    async def answer_feedback(self, session: str) -> AnswerFeedbackList:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        return AnswerFeedbackList(
            session_id=session, records=await self.lifecycle.store.answer_feedback(session)
        )

    async def save_answer_feedback(self, session: str, value: AnswerFeedbackWrite) -> AnswerFeedback:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        receipt = await self.access.read(session, lambda store: store.get(value.request_id))
        if receipt.kind != "root" or receipt.status != "succeeded" or (not receipt.answer):
            raise BackendError("feedback_answer_missing")
        return await self.lifecycle.store.save_answer_feedback(session, value)

    def _reject_artifact_secret(self, value: ArtifactWrite) -> None:
        secret = self.accounts.secrets()
        if not secret:
            return
        if contains_secret(value.name, secret):
            raise BackendError("artifact_secret")
        try:
            raw = base64.b64decode(value.data_base64, validate=True)
        except (binascii.Error, ValueError):
            return
        if any((item.encode() in raw for item in secret)):
            raise BackendError("artifact_secret")

    async def put_artifact(self, session: str, value: ArtifactWrite) -> ArtifactView:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        self._reject_artifact_secret(value)
        return save_artifact(self.lifecycle.profile.path, session, value)

    async def artifacts(self, session: str) -> ArtifactList:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        return list_artifacts(self.lifecycle.profile.path, session)

    async def artifact(self, session: str, artifact_id: str) -> ArtifactBody:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        return read_artifact(self.lifecycle.profile.path, session, artifact_id)

    async def share_session(self, session: str, value: ShareWrite) -> ShareView:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session):
            raise BackendError("session_not_found", status=404)
        messages = await self._open_transcript(session)
        key = transcript_digest(messages)
        current = await self.lifecycle.store.share_record(value.share_id)
        if current is not None and current != (key, session):
            raise BackendError("share_conflict")
        if contains_secret(
            "\n".join((content for _request, _role, content in messages)), self.accounts.secrets()
        ):
            raise BackendError("share_secret")
        view = ShareView(
            share_id=value.share_id,
            session_id=session,
            digest=key,
            messages=[
                ShareMessage.model_validate({"request_id": request_id, "role": role, "content": content})
                for request_id, role, content in messages
            ],
        )
        payload = await self.lifecycle.store.save_share(
            value.share_id, session, view.digest, view.model_dump_json()
        )
        return ShareView.model_validate_json(payload)

    async def read_share(self, session: str, share_id: str) -> ShareView:
        self.lifecycle.admit()
        return ShareView.model_validate_json(await self.lifecycle.store.read_share(share_id, session))

    async def export_bundle(self) -> ExportBundle:
        self.lifecycle.admit()
        projects = await self.projects()
        settings = await self.lifecycle.store.product_settings()
        feedback = [
            FeedbackView(feedback_id=feedback_id, session_id=session_id, text=text)
            for feedback_id, session_id, text in await self.lifecycle.store.feedback_rows()
        ]
        sessions: list[ExportSession] = []
        for item in (await self.sessions.sessions()).sessions:
            messages = await self._open_transcript(item.session_id)
            sessions.append(
                ExportSession(
                    session_id=item.session_id,
                    title=item.title,
                    project_id=item.project_id,
                    workspace=item.workspace,
                    messages=[
                        ExportMessage.model_validate(
                            {"request_id": request_id, "role": role, "content": content}
                        )
                        for request_id, role, content in messages
                        if content
                    ],
                )
            )
        bundle = ExportBundle(
            format="amazme-export/1",
            projects=projects.projects,
            sessions=sessions,
            feedback=feedback,
            answer_feedback=await self.lifecycle.store.answer_feedback(),
            settings=settings,
        )
        if contains_secret(bundle_text(bundle), self.accounts.secrets()):
            raise BackendError("export_secret")
        return bundle.model_copy(update={"digest": bundle_digest(bundle)})

    async def import_bundle(self, bundle: ExportBundle) -> ImportResult:
        self.lifecycle.admit()
        if bundle.format != "amazme-export/1":
            raise BackendError("import_format")
        if bundle.digest != bundle_digest(bundle):
            raise BackendError("import_digest")
        if contains_secret(bundle_text(bundle), self.accounts.secrets()):
            raise BackendError("import_secret")
        if (
            len(bundle.sessions) > 32
            or len(bundle.projects) > 32
            or len(bundle.feedback) > 32
            or (len(bundle.answer_feedback) > 4096)
        ):
            raise BackendError("import_capacity", status=429)
        existing = {item.session_id: item for item in (await self.sessions.sessions()).sessions}
        known_projects = {project.project_id: project for project in (await self.projects()).projects}
        for project in bundle.projects:
            current = known_projects.get(project.project_id)
            if current is not None and (current.name, current.workspaces, current.removed) != (
                project.name,
                project.workspaces,
                project.removed,
            ):
                raise BackendError("import_conflict")
            for workspace in project.workspaces:
                await self.lifecycle.require_workspace(workspace)
        current_settings = await self.lifecycle.store.product_settings()
        if (
            bundle.settings.display_name
            and current_settings.revision
            and (current_settings.display_name != bundle.settings.display_name)
        ):
            raise BackendError("import_conflict")
        if (
            current_settings.revision
            and bundle.settings.preferences != InterfacePreferences()
            and (current_settings.preferences != bundle.settings.preferences)
        ):
            raise BackendError("import_conflict")
        known_feedback = {
            feedback_id: (session_id, text)
            for feedback_id, session_id, text in await self.lifecycle.store.feedback_rows()
        }
        for item in bundle.feedback:
            current = known_feedback.get(item.feedback_id)
            if current is not None and current != (item.session_id, item.text):
                raise BackendError("import_conflict")
        incoming_projects = {project.project_id for project in bundle.projects}
        incoming_sessions = {item.session_id for item in bundle.sessions}
        for item in bundle.sessions:
            await self.lifecycle.require_workspace(item.workspace)
            if (
                item.project_id
                and item.project_id not in known_projects
                and (item.project_id not in incoming_projects)
            ):
                raise BackendError("import_conflict")
        for item in bundle.feedback:
            if (
                item.session_id
                and item.session_id not in existing
                and (item.session_id not in incoming_sessions)
            ):
                raise BackendError("import_conflict")
        if len({item.operation_id for item in bundle.answer_feedback}) != len(bundle.answer_feedback) or len(
            {(item.session_id, item.request_id) for item in bundle.answer_feedback}
        ) != len(bundle.answer_feedback):
            raise BackendError("import_conflict")
        await self.lifecycle.store.check_answer_feedback_import(bundle.answer_feedback)
        incoming_transcripts = {item.session_id: item.messages for item in bundle.sessions}
        for item in bundle.answer_feedback:
            if item.session_id not in existing and item.session_id not in incoming_sessions:
                raise BackendError("import_conflict")
            messages = (
                [
                    (message.request_id, message.role, message.content)
                    for message in incoming_transcripts[item.session_id]
                ]
                if item.session_id in incoming_transcripts
                else await self._open_transcript(item.session_id)
            )
            if not any(
                (
                    request == item.request_id and role == "assistant" and content
                    for request, role, content in messages
                )
            ):
                raise BackendError("import_conflict")
        created = 0
        for item in bundle.sessions:
            incoming = [(message.request_id, message.role, message.content) for message in item.messages]
            record = existing.get(item.session_id)
            if record is None:
                created += 1
                continue
            current = await self._open_transcript(item.session_id)
            if (
                record.title != item.title
                or record.workspace != item.workspace
                or record.project_id != item.project_id
                or (transcript_digest(current) != transcript_digest(incoming))
            ):
                raise BackendError("import_conflict")
        for project in bundle.projects:
            if project.project_id not in known_projects:
                await self.lifecycle.store.save_project(project.project_id, project.name, project.workspaces)
                if project.removed:
                    await self.lifecycle.store.update_project(
                        project.project_id,
                        ProjectUpdate(
                            name=project.name,
                            workspaces=project.workspaces,
                            expected_revision=0,
                            removed=True,
                        ),
                    )
        if current_settings.revision == 0:
            if bundle.settings.display_name:
                current_settings = await self.lifecycle.store.save_product_settings(
                    bundle.settings.display_name, 0
                )
            if bundle.settings.preferences != InterfacePreferences():
                current_settings = await self.lifecycle.store.save_preferences(
                    bundle.settings.preferences, current_settings.revision
                )
        for item in bundle.feedback:
            key = content_digest(
                json.dumps(
                    {"session_id": item.session_id, "text": item.text},
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
            )
            await self.lifecycle.store.save_feedback(item.feedback_id, item.session_id, item.text, key)
        for item in bundle.sessions:
            await self.lifecycle.require_workspace(item.workspace)
            await self.lifecycle.store.ensure_import_session(
                item.session_id, item.title, item.workspace, item.project_id
            )
            messages = [(message.request_id, message.role, message.content) for message in item.messages]
            await self.access.operate(
                item.session_id, lambda store: store.import_transcript(messages), require_active=False
            )
        await self.lifecycle.store.import_answer_feedback(bundle.answer_feedback)
        return ImportResult(format="amazme-export/1", sessions=len(bundle.sessions), created=created)

    async def save_memory(self, value: MemoryWrite) -> MemoryView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        text = value.text.strip()
        if contains_secret(text, self.accounts.secrets()):
            raise BackendError("memory_secret")
        digest = remember(value.workspace, text)
        await self.lifecycle.require_workspace(value.workspace)
        memory_id, workspace, stored = await self.lifecycle.store.save_memory(
            value.memory_id, value.workspace, text, digest
        )
        return MemoryView(memory_id=memory_id, workspace=workspace, text=stored)

    async def memories_for(self, workspace: str, query: str) -> MemoryList:
        self.lifecycle.admit()
        await self.lifecycle.require_workspace(workspace)
        rows = await self.lifecycle.store.memory_rows()
        if query.strip():
            found = match_memories(rows, workspace, query)
        else:
            found = [
                MemoryView(memory_id=memory_id, workspace=item_workspace, text=text)
                for memory_id, item_workspace, text in rows
                if item_workspace == workspace
            ][:50]
        return MemoryList(workspace=workspace, memories=found)

    async def injection_preview(self, session_id: str, query: str) -> MemoryList:
        self.lifecycle.admit()
        if not await self.lifecycle.store.exists(session_id):
            raise BackendError("session_not_found", status=404)
        session = next(
            (item for item in (await self.sessions.sessions()).sessions if item.session_id == session_id)
        )
        found = match_memories(await self.lifecycle.store.memory_rows(), session.workspace, query)
        return MemoryList(workspace=session.workspace, memories=found)
