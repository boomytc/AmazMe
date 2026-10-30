from __future__ import annotations

import asyncio
import difflib
import hashlib
from collections.abc import Callable
from pathlib import Path

from amazme_backend.contracts.execution import (
    EditFile,
    FileObservation,
    FilePresent,
    PatchTarget,
    PreparedPatch,
    SupervisorHealth,
)
from amazme_backend.contracts.ipc.host import PreparedFileWrite, PrepareFileWrite, PreparePatch
from amazme_backend.contracts.resources import ResourceCatalog, ResourceOptions
from amazme_backend.contracts.skills import SkillDocument, SkillImport, SkillRemove, SkillWrite
from amazme_backend.contracts.workspaces import (
    CheckpointCreate,
    CheckpointList,
    CheckpointPreview,
    CheckpointRestore,
    CheckpointView,
    FileChange,
    FileContent,
    FileEntry,
    FileList,
    FileWrite,
    WorkspaceGrantRequest,
    WorkspaceGrantView,
    WorkspaceList,
    WorkspaceSelect,
)
from amazme_backend.execution.processes import exited
from amazme_backend.features.resources.service import session_resources
from amazme_backend.features.skills.service import (
    import_skill,
    read_skill,
    remove_skill,
    skill_catalog,
    write_skill,
)
from amazme_backend.host.keys import checkpoint_id
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.files import capture_text, list_files, read_file, write_file
from amazme_backend.workspaces.grants import check_grant_directory
from amazme_backend.workspaces.patches import parse_patch, prepare_patch
from amazme_backend.workspaces.paths import (
    PRIMARY,
    client_path,
    split_client_path,
    tool_path,
    validate_workspace,
)


class WorkspaceOperations:
    def __init__(self, lifecycle: HostLifecycle):
        self.lifecycle = lifecycle

    def workspace_root(self) -> Path:
        return Path(self.lifecycle.profile.config.workspace)

    async def resources(self, session: str, options: ResourceOptions | None = None) -> ResourceCatalog:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session)
        workspace = await self._session_root(session)
        return await asyncio.to_thread(
            lambda: (
                session_resources(
                    self.lifecycle.profile, session, options or ResourceOptions(), workspace=workspace
                ).catalog
            )
        )

    async def skill_catalog(self, session: str = "") -> ResourceCatalog:
        self.lifecycle.admit()
        if session:
            await self.lifecycle.require_session(session)
        return await asyncio.to_thread(
            skill_catalog, self.lifecycle.profile, session, workspace=await self._session_root(session)
        )

    async def skill_document(self, session: str, name: str) -> SkillDocument:
        self.lifecycle.admit()
        if session:
            await self.lifecycle.require_session(session)
        try:
            return await asyncio.to_thread(
                read_skill, self.lifecycle.profile, session, name, workspace=await self._session_root(session)
            )
        except (OSError, UnicodeError) as error:
            raise BackendError("skill_read_failed") from error

    async def mutate_skills[T](self, session: str, operation: Callable[[Path], T]) -> T:
        async with self.lifecycle.update_lock:
            self.lifecycle.admit()
            if session:
                await self.lifecycle.require_session(session)
            if await self.lifecycle.store.active_update():
                raise BackendError("update_frozen", status=503)
            task = asyncio.create_task(asyncio.to_thread(operation, await self._session_root(session)))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise
            except (OSError, UnicodeError) as error:
                raise BackendError("skill_io_failed") from error

    async def workspaces(self) -> WorkspaceList:
        self.lifecycle.admit()
        primary = self.workspace_root()
        grants = [
            WorkspaceGrantView(name=name, host_path=host)
            for name, host in await self.lifecycle.store.workspace_grants()
        ]
        return WorkspaceList(
            workspaces=[WorkspaceGrantView(name=PRIMARY, host_path=str(primary), primary=True), *grants]
        )

    async def select_workspace(self, value: WorkspaceSelect) -> WorkspaceGrantView:
        current = (await self.workspaces()).workspaces
        if value.name:
            validate_workspace(value.name)
            found = next((item for item in current if item.name == value.name), None)
            if found is None:
                raise BackendError("workspace_not_found", status=404)
            return found
        path = Path(value.host_path)
        if not path.is_absolute():
            raise BackendError("invalid_workspace_path")
        try:
            actual = path.resolve(strict=True)
        except (OSError, ValueError) as error:
            raise BackendError("workspace_not_directory") from error
        if not actual.is_dir():
            raise BackendError("workspace_not_directory")
        for item in current:
            if Path(item.host_path).resolve() == actual:
                return item
        name = "cwd-" + hashlib.sha256(str(actual).encode()).hexdigest()[:24]
        return await self.add_workspace(WorkspaceGrantRequest(name=name, host_path=str(actual)))

    async def add_workspace(self, value: WorkspaceGrantRequest) -> WorkspaceGrantView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        if value.name in {PRIMARY, "grant"}:
            raise BackendError("invalid_workspace_name")
        validate_workspace(value.name)
        host = check_grant_directory(
            Path(value.host_path), self.lifecycle.profile.path, self.workspace_root()
        )
        await self.lifecycle.store.add_workspace_grant(value.name, str(host))
        return WorkspaceGrantView(name=value.name, host_path=str(host))

    async def remove_workspace(self, name: str) -> None:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        if name == PRIMARY:
            raise BackendError("workspace_grant_forbidden")
        await self.lifecycle.store.remove_workspace_grant(name)

    async def _mapped_root(self, relative: str, *, session_name: str | None = None) -> tuple[str, str, Path]:
        name, inner = (
            tool_path(session_name, relative) if session_name is not None else split_client_path(relative)
        )
        if name == "grant":
            raise BackendError("workspace_not_file")
        if name == PRIMARY:
            return (name, inner, self.workspace_root())
        grants = dict(await self.lifecycle.store.workspace_grants())
        host = grants.get(name)
        if host is None:
            raise BackendError("workspace_not_found", status=404)
        return (name, inner, Path(host))

    async def list_workspace(self, relative: str = "", offset: int = 0) -> FileList:
        self.lifecycle.admit()
        name, inner = split_client_path(relative)
        if name == "grant":
            grants = await self.lifecycle.store.workspace_grants()
            page = FileList(path="grant", offset=offset, total=len(grants), entries=[])
            page.entries = [FileEntry(name=item, kind="dir", size=0) for item, _host in grants][
                offset : offset + page.limit
            ]
            page.truncated = offset + page.limit < page.total
            return page
        root_name, inner, root = await self._mapped_root(relative)
        listing = list_files(root, inner, offset)
        listing.path = client_path(root_name, inner)
        listing.absolute_path = str(root / inner)
        return listing

    async def read_workspace(self, relative: str) -> FileContent:
        self.lifecycle.admit()
        name, inner, root = await self._mapped_root(relative)
        content = read_file(root, inner)
        content.path = client_path(name, content.path)
        content.absolute_path = str(root / inner)
        return content

    async def write_workspace(self, value: FileWrite) -> FileChange:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        name, inner, root = await self._mapped_root(value.path)
        shown = client_path(name, inner)
        current = self._current_text(root, inner)
        if current is not None and current[0] != value.expected_digest:
            raise BackendError("file_conflict")
        if current is None and value.expected_digest:
            raise BackendError("file_conflict")
        if current is not None:
            await self.lifecycle.store.save_checkpoint(
                checkpoint_id(name, shown, current[0]), name, shown, current[0], current[1]
            )
        changed = write_file(root, value.model_copy(update={"path": inner}))
        changed.path = shown
        return changed

    def _current_text(self, root: Path, inner: str) -> tuple[str, str] | None:
        return capture_text(root, inner)

    async def create_checkpoint(self, value: CheckpointCreate) -> CheckpointView:
        self.lifecycle.admit()
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        name, inner = split_client_path(value.path)
        if name == "grant" or not inner or name != value.workspace:
            raise BackendError("invalid_workspace_path")
        await self.lifecycle.require_workspace(name)
        _name, _inner, root = await self._mapped_root(value.path)
        current = self._current_text(root, inner)
        if current is None:
            raise BackendError("checkpoint_unavailable")
        await self.lifecycle.store.save_checkpoint(
            value.checkpoint_id, name, client_path(name, inner), current[0], current[1]
        )
        return CheckpointView(
            checkpoint_id=value.checkpoint_id,
            workspace=name,
            path=client_path(name, inner),
            digest=current[0],
        )

    async def _admit_file_preparation(self, value: PrepareFileWrite | PreparePatch) -> None:
        self.lifecycle.admit()
        if value.host_epoch != self.lifecycle.fence.host_epoch or value.build_id != self.lifecycle.build:
            raise BackendError("stale_host_epoch")
        if await self.lifecycle.store.active_update():
            raise BackendError("update_frozen", status=503)
        service = await self.lifecycle.store.service()
        if service is None or service.state != "running" or exited(service.process_lease):
            raise BackendError("supervisor_unavailable", status=503)
        health = await self.lifecycle.supervisor.call("GET", "/health", SupervisorHealth)
        self.lifecycle.check_supervisor(health.identity, service, fenced=True)
        if (
            health.freeze_id
            or health.blocked
            or health.session_errors.get(value.session_id)
            or (health.identity.state != "ready")
            or (health.identity.instance_id != value.supervisor_id)
        ):
            raise BackendError("execution_blocked", status=503)
        worker = next((w for w in health.workers if w.worker_id == value.worker_id), None)
        if (
            worker is None
            or worker.session_id != value.session_id
            or worker.build_id != self.lifecycle.build
            or (worker.host_epoch != value.host_epoch)
            or (worker.fingerprint != self.lifecycle.build)
            or (worker.execution_epoch != value.execution_epoch)
            or (worker.purpose != "business")
            or (worker.state != "ready")
            or (worker.process_lease is None)
            or exited(worker.process_lease)
        ):
            raise BackendError("worker_identity_mismatch", status=503)
        if not any(
            (
                e.session_id == value.session_id
                and e.worker_id == value.worker_id
                and (e.execution_epoch == value.execution_epoch)
                and (e.state == "open")
                for e in health.epochs
            )
        ):
            raise BackendError("execution_cleanup_pending", status=503)

    async def prepare_tool_write(self, value: PrepareFileWrite) -> PreparedFileWrite:
        await self._admit_file_preparation(value)
        prepared = await self.lifecycle.store.file_write_preparation(
            value.session_id, value.call_id, value.write
        )
        if prepared is not None:
            return prepared
        target = await self.lifecycle.store.session(value.session_id)
        if target is None:
            raise BackendError("session_not_found", status=404)
        name, inner, root = await self._mapped_root(value.write.path, session_name=target.workspace)
        try:
            previous = capture_text(root, inner)
        except BackendError as error:
            if error.code == "checkpoint_unavailable":
                raise BackendError("file_too_large") from error
            raise
        observation = value.observation
        if observation is not None and (observation.path != client_path(name, inner)
                                        or observation.root != str(root.resolve())):
            raise BackendError("file_observation_mismatch")
        if isinstance(value.write, EditFile) and not isinstance(observation, FilePresent):
            raise BackendError("workspace_missing" if observation is not None else "file_not_observed")
        if isinstance(observation, FilePresent):
            if previous is None or previous[0] != observation.digest:
                raise BackendError("file_conflict")
        elif previous is not None:
            raise BackendError("file_conflict" if observation is not None else "file_not_observed")
        return await self.lifecycle.store.prepare_file_write(
            value.session_id, value.call_id, value.write, name, client_path(name, inner), previous, str(root.resolve())
        )

    async def prepare_tool_patch(self, value: PreparePatch) -> PreparedPatch:
        await self._admit_file_preparation(value)
        existing = await self.lifecycle.store.patch_preparation(value.session_id, value.call_id, value.input)
        if existing is not None:
            return existing
        session = await self.lifecycle.store.session(value.session_id)
        if session is None:
            raise BackendError("session_not_found", status=404)
        operations = parse_patch(value.input)
        targets: dict[str, PatchTarget] = {}
        for operation in operations:
            for raw in (operation.path, operation.destination):
                if raw is None or raw in targets:
                    continue
                name, inner, root = await self._mapped_root(raw, session_name=session.workspace)
                inner = Path(inner).as_posix()
                if inner == "." or name == "grant":
                    raise BackendError("invalid_workspace_path")
                try:
                    targets[raw] = PatchTarget(path=client_path(name, inner), root=str(root.resolve()), relative=inner)
                except ValueError as error:
                    raise BackendError("invalid_workspace_path") from error
        observations: dict[str, FileObservation] = {}
        for observation in value.observations:
            name, inner = split_client_path(observation.path)
            path = client_path(name, Path(inner).as_posix())
            observations.setdefault(path, observation.model_copy(update={"path": path}))
        try:
            prepared = await asyncio.to_thread(prepare_patch, value.call_id, operations, targets, observations)
        except ValueError as error:
            raise BackendError("patch_capacity", "Prepared patch is too large; split it into smaller patches.") from error
        rows: list[tuple[str, str, str, str]] = []
        for baseline, content in prepared.snapshots:
            if content is not None:
                workspace, _ = split_client_path(baseline.path)
                rows.append((workspace, baseline.path, baseline.expected_digest, content))
        return await self.lifecycle.store.save_patch_preparation(value.session_id, value.input, prepared.plan, rows)

    async def list_checkpoints(self, workspace: str, path: str) -> CheckpointList:
        self.lifecycle.admit()
        rows = await self.lifecycle.store.checkpoints_for(workspace, path)
        return CheckpointList(
            checkpoints=[
                CheckpointView(checkpoint_id=item[0], workspace=item[1], path=item[2], digest=item[3])
                for item in rows
            ]
        )

    async def preview_checkpoint(self, checkpoint_id: str) -> CheckpointPreview:
        self.lifecycle.admit()
        saved = await self.lifecycle.store.checkpoint(checkpoint_id)
        if saved is None:
            raise BackendError("checkpoint_not_found", status=404)
        _cid, workspace, path, digest, content = saved
        _name, inner, root = await self._mapped_root(path)
        current = self._current_text(root, inner) if inner else None
        current_text = "" if current is None else current[1]
        current_digest = "" if current is None else current[0]
        diff = "".join(
            difflib.unified_diff(
                content.splitlines(keepends=True),
                current_text.splitlines(keepends=True),
                fromfile=path,
                tofile=path,
            )
        )
        return CheckpointPreview(
            checkpoint_id=checkpoint_id,
            workspace=workspace,
            path=path,
            absolute_path=str(root / inner),
            digest=digest,
            content=content,
            current_digest=current_digest,
            diff=diff,
        )

    async def restore_checkpoint(self, checkpoint_id: str, value: CheckpointRestore) -> FileChange:
        self.lifecycle.admit()
        saved = await self.lifecycle.store.checkpoint(checkpoint_id)
        if saved is None:
            raise BackendError("checkpoint_not_found", status=404)
        _cid, _workspace, path, _digest, content = saved
        return await self.write_workspace(
            FileWrite(path=path, content=content, expected_digest=value.expected_digest)
        )

    async def _session_root(self, session: str) -> Path:
        if not session:
            return self.workspace_root()
        value = await self.lifecycle.store.session(session)
        if value is None:
            raise BackendError("session_not_found", status=404)
        if value.workspace == PRIMARY:
            return self.workspace_root()
        root = dict(await self.lifecycle.store.workspace_grants()).get(value.workspace)
        if root is None:
            raise BackendError("workspace_not_found", status=404)
        return Path(root)

    async def save_skill(self, session: str, value: SkillWrite) -> SkillDocument:
        return await self.mutate_skills(
            session,
            lambda workspace: write_skill(self.lifecycle.profile, session, value, workspace=workspace),
        )

    async def import_skill(self, session: str, value: SkillImport) -> SkillDocument:
        return await self.mutate_skills(
            session,
            lambda workspace: import_skill(self.lifecycle.profile, session, value, workspace=workspace),
        )

    async def remove_skill(self, session: str, name: str, value: SkillRemove) -> None:
        await self.mutate_skills(
            session,
            lambda workspace: remove_skill(
                self.lifecycle.profile, session, name, value.expected_digest, workspace=workspace
            ),
        )
