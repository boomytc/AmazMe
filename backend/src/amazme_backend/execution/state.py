"""Pure decisions shared by execution admission, observation and recovery."""

from __future__ import annotations

from typing import Literal

from amazme_backend.contracts.identity import HostFence
from amazme_backend.shared.errors import BackendError


def failure_reason(error: BaseException) -> str:
    return error.code if isinstance(error, BackendError) else type(error).__name__


def supervisor_state(*, blocked: str, storage_failure: str, fence_ready: bool,
                     draining: bool, freeze_id: str) -> Literal["blocked", "stopping", "frozen", "ready"]:
    if blocked or storage_failure or not fence_ready:
        return "blocked"
    if draining:
        return "stopping"
    return "frozen" if freeze_id else "ready"


def check_host_fence(fence: HostFence, *, build: str, host_epoch: int) -> None:
    if fence.build_id != build:
        raise BackendError("build_mismatch")
    if fence.host_epoch != host_epoch:
        raise BackendError("stale_host_epoch")


def check_admission(*, storage_failure: str, blocked: str, draining: bool, fence_ready: bool,
                    freeze_id: str, validation: bool) -> None:
    if storage_failure or blocked:
        raise BackendError("execution_blocked", storage_failure or blocked, 503)
    if draining:
        raise BackendError("supervisor_stopping", status=503)
    if not fence_ready:
        raise BackendError("worker_fence_pending", status=503)
    if freeze_id and not validation:
        raise BackendError("supervisor_frozen", status=503)


def resource_state(*, clean: bool, epoch_state: str,
                   phase: str) -> Literal["exited", "stop_unconfirmed", "stopping", "registered", "running"]:
    if clean:
        return "exited"
    if epoch_state == "blocked":
        return "stop_unconfirmed"
    if epoch_state == "closing":
        return "stopping"
    return "registered" if phase == "registered" else "running"


def tool_outcome(outcome: str) -> Literal["pending", "completed", "unknown"]:
    return "completed" if outcome == "completed" else "unknown" if outcome == "unknown" else "pending"


def remote_reply(reply: dict[str, object], *, allow_new: bool) -> tuple[Literal["done", "conflict", "unknown"], str]:
    op, text = reply.get("op"), reply.get("text")
    if op == "result" and isinstance(text, str):
        return "done", text
    if op == "conflict" and allow_new:
        return "conflict", ""
    return "unknown", ""
