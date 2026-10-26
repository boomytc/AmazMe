"""HTTP adaptation for the existing worker operation set."""
from fastapi import FastAPI

from amazme_backend.agent.driver import Worker
from amazme_backend.contracts.events import Replay, Snapshot
from amazme_backend.contracts.identity import HostFence, Identity
from amazme_backend.contracts.ipc.supervisor import (
    StopWorker,
)
from amazme_backend.contracts.ipc.worker import (
    ApprovalEnvelope,
    Cancel,
    FreezeWorker,
    JobNoticeEnvelope,
    ResolutionEnvelope,
    SessionOp,
    SessionOpResult,
    Submission,
    WorkerActivity,
)
from amazme_backend.contracts.sessions import Receipt
from amazme_backend.interfaces.http.transport import MEDIA_BODY_BYTES, app_factory
from amazme_backend.sessions.service import run_session_op
from amazme_backend.shared.errors import BackendError


def application(owner: Worker) -> FastAPI:
    app = app_factory(owner.context.token, body_limits={r"/submissions": MEDIA_BODY_BYTES, r"/session-ops": MEDIA_BODY_BYTES})

    @app.get("/identity")
    async def identity() -> Identity:
        return await owner.identity()

    @app.post("/fence")
    async def fence(value: HostFence) -> Identity:
        return await owner.fence(value)

    @app.get("/snapshot")
    async def snapshot() -> Snapshot:
        await owner.refresh_effect_proofs()
        return await owner.store.snapshot(owner.state)

    @app.post("/session-ops")
    async def session_ops(value: SessionOp) -> SessionOpResult:
        result = await run_session_op(owner.store, value.name, value.payload)
        owner.wake.set()
        return SessionOpResult(payload=result)

    @app.get("/events")
    async def events(after: int = 0, stream_id: str = "") -> Replay:
        await owner.refresh_effect_proofs()
        return await owner.store.events(after, stream_id)

    @app.get("/activity")
    async def activity() -> WorkerActivity:
        return await owner.store.activity()

    @app.post("/submissions", status_code=202)
    async def submit(value: Submission) -> Receipt:
        return await owner.submit(value)

    @app.post("/job-notices", status_code=202)
    async def job_notice(value: JobNoticeEnvelope) -> Receipt:
        return await owner.receive_job_notice(value)

    @app.get("/requests/{request_id}")
    async def lookup(request_id: str) -> Receipt:
        return await owner.store.get(request_id)

    @app.post("/requests/{request_id}/cancel", status_code=202)
    async def cancel(request_id: str, value: Cancel) -> Receipt:
        if request_id != value.request_id:
            raise BackendError("request_identity_mismatch")
        return await owner.cancel(value)

    @app.post("/approvals", status_code=202)
    async def approve(value: ApprovalEnvelope) -> Receipt:
        return await owner.approve(value)

    @app.post("/effects/resolve", status_code=202)
    async def resolve(value: ResolutionEnvelope) -> Receipt:
        return await owner.resolve(value)

    @app.post("/freeze")
    async def freeze(value: FreezeWorker) -> Snapshot:
        return await owner.freeze(value)

    @app.post("/thaw")
    async def thaw(value: FreezeWorker) -> Snapshot:
        return await owner.thaw(value)

    @app.post("/stop")
    async def stop(value: StopWorker) -> Identity:
        return await owner.request_stop(value)

    return app
