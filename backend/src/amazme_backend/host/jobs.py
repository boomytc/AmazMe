"""Session job access and completion handoff through the existing delivery queue."""
from amazme_backend.contracts.execution import JobList, JobOutput, JobOutputView, JobView
from amazme_backend.contracts.ipc.supervisor import JobOutputQuery, JobReference, JobSession
from amazme_backend.contracts.ipc.worker import JobNotice
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.shared.errors import BackendError
from amazme_backend.workspaces.paths import PRIMARY


class JobOperations:
    def __init__(self, lifecycle: HostLifecycle):
        self.lifecycle = lifecycle

    async def list(self, session_id: str) -> JobList:
        await self.lifecycle.require_session(session_id)
        await self.lifecycle.ensure_supervisor()
        return await self.lifecycle.supervisor.list_jobs(JobSession(
            **self.lifecycle.fence.model_dump(), session_id=session_id))

    async def output(self, session_id: str, value: JobOutput) -> JobOutputView:
        await self.lifecycle.require_session(session_id)
        await self.lifecycle.ensure_supervisor()
        return await self.lifecycle.supervisor.job_output(JobOutputQuery(
            **self.lifecycle.fence.model_dump(), session_id=session_id, **value.model_dump()))

    async def kill_job(self, session_id: str, job_id: str) -> JobView:
        self.lifecycle.admit()
        await self.lifecycle.require_session(session_id)
        await self.lifecycle.ensure_supervisor()
        return await self.lifecycle.supervisor.kill_job(JobReference(
            **self.lifecycle.fence.model_dump(), session_id=session_id, job_id=job_id))

    async def deliver_completions(self) -> None:
        pending = await self.lifecycle.supervisor.pending_job_notices(self.lifecycle.fence)
        if not pending.jobs:
            return
        sessions = {item.session_id: item for item in (await self.lifecycle.store.sessions()).sessions}
        grants = dict(await self.lifecycle.store.workspace_grants())
        for job in pending.jobs:
            session = sessions.get(job.session_id)
            if session is not None and not session.archived and (session.workspace == PRIMARY or session.workspace in grants):
                notice = JobNotice.model_validate({"job_id": job.job_id, "session_id": job.session_id,
                    "parent_request_id": job.request_id, "state": job.state,
                    "exit_code": job.exit_code, "stop_reason": job.stop_reason})
                try:
                    # Commit the immutable event before acknowledgement. Retries reuse the same key
                    # and payload even after log expiry, worker retirement or a lost response.
                    await self.lifecycle.store.enqueue(job.session_id, "job_notice", job.job_id, notice)
                except BackendError as error:
                    if error.code not in {"session_not_found", "session_archived"}:
                        raise
            await self.lifecycle.supervisor.acknowledge_job_notice(JobReference(
                **self.lifecycle.fence.model_dump(), session_id=job.session_id, job_id=job.job_id))
