from __future__ import annotations

import asyncio
import time
from typing import Literal

import amazme_backend.features.schedules.policy as schedules
from amazme_backend.contracts.ipc.worker import Cancel
from amazme_backend.contracts.schedules import (
    ScheduleControl,
    ScheduleInput,
    ScheduleNow,
    ScheduleOutcome,
    SchedulesView,
    ScheduleView,
)
from amazme_backend.host.accounts import AccountOperations
from amazme_backend.host.lifecycle import HostLifecycle
from amazme_backend.host.session_access import WorkerSessions
from amazme_backend.host.sessions import SessionOperations
from amazme_backend.profiles.layout import session_database
from amazme_backend.shared.errors import BackendError


class Scheduling:
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
        self.schedule_lock = asyncio.Lock()
        self.schedule_tick_ms = 0

    async def list_schedules(self) -> SchedulesView:
        return SchedulesView(
            path=str(self.lifecycle.profile.path / "host.sqlite"),
            schedules=await self.lifecycle.store.list_schedules(),
        )

    async def save_schedule(self, value: ScheduleInput) -> ScheduleView:
        self.lifecycle.admit()
        async with self.schedule_lock:
            return await self.lifecycle.store.save_schedule(
                value, time.time_ns() // 1000000, self.accounts.secrets()
            )

    async def _schedule_busy(self, record: ScheduleView) -> bool:
        if record.target.kind != "session":
            return False
        session_id = record.target.session_id
        if not session_database(self.lifecycle.profile.path, session_id).is_file():
            return False
        activity = await self.access.read(session_id, lambda store: store.activity())
        return activity.pending > 0

    async def _reconcile_schedule(self, record: ScheduleView, now: int) -> ScheduleView:
        pending = record.pending
        if pending is None:
            return record
        try:
            path = session_database(self.lifecycle.profile.path, pending.session_id)
            receipt = None
            if path.is_file():
                try:
                    receipt = await self.access.read(
                        pending.session_id, lambda store: store.get(pending.request_id)
                    )
                except BackendError as error:
                    if error.code != "request_not_found":
                        raise
            if receipt is None:
                delivery = await self.lifecycle.store.submitted_delivery(pending.session_id, pending.request_id)
                if delivery and delivery.state == "rejected":
                    return await self.lifecycle.store.finish_schedule(record, ScheduleOutcome(
                        session_id=pending.session_id, request_id=pending.request_id,
                        started_at=pending.started_at, finished_at=now, scheduled_for=pending.scheduled_for,
                        status=pending.cancel_reason or "refused", detail=delivery.error_code or None,
                    ), now)
            if receipt is None or receipt.status not in {
                "succeeded",
                "cancelled",
                "interrupted",
                "failed",
                "unknown",
            }:
                if now < pending.deadline_at and (not pending.cancel_reason):
                    return record
                pending.cancel_reason = pending.cancel_reason or "timed_out"
                await self.lifecycle.store.persist_schedule(record)
                await self.sessions.deliver(
                    pending.session_id,
                    "cancel",
                    pending.request_id,
                    Cancel(host_epoch=0, build_id="", request_id=pending.request_id),
                )
                receipt = await self.access.read(
                    pending.session_id, lambda store: store.get(pending.request_id)
                )
            if receipt.status == "unknown":
                record.enabled = False
                pending.problem = "结果未知，计划已暂停；核对原调用和资源后，可取消本次运行。"
                if pending.cancel_reason and await self.access.read(
                    pending.session_id, lambda store: store.request_cleanup_complete(pending.request_id)
                ):
                    return await self.lifecycle.store.finish_schedule(
                        record,
                        ScheduleOutcome(
                            session_id=pending.session_id,
                            request_id=pending.request_id,
                            started_at=pending.started_at,
                            finished_at=now,
                            scheduled_for=pending.scheduled_for,
                            status="unanswered",
                            detail="unknown_reconciled",
                        ),
                        now,
                    )
            elif receipt.status in {"succeeded", "cancelled", "interrupted", "failed"}:
                if not await self.access.read(
                    pending.session_id, lambda store: store.request_cleanup_complete(pending.request_id)
                ):
                    record.enabled = False
                    pending.problem = "原任务或子任务仍有待核对的效果或资源，计划已暂停。"
                    return await self.lifecycle.store.persist_schedule(record)
                outcome = ScheduleOutcome(
                    session_id=pending.session_id,
                    request_id=pending.request_id,
                    started_at=pending.started_at,
                    finished_at=now,
                    scheduled_for=pending.scheduled_for,
                    status="done"
                    if receipt.status == "succeeded"
                    else pending.cancel_reason
                    or ("cancelled" if receipt.status == "cancelled" else "unanswered"),
                    detail=receipt.error or None,
                )
                return await self.lifecycle.store.finish_schedule(record, outcome, now)
            else:
                pending.problem = None
        except BackendError as error:
            if error.code not in {"request_not_found", "storage_missing"}:
                pending.problem = error.code
        return await self.lifecycle.store.persist_schedule(record)

    async def tick_schedules(self, *, force: bool = False) -> SchedulesView:
        self.lifecycle.admit()
        now = time.time_ns() // 1000000
        async with self.schedule_lock:
            due = force or now - self.schedule_tick_ms >= 5000
            if due:
                self.schedule_tick_ms = now
            if await self.lifecycle.store.active_update():
                return await self.list_schedules()
            self.lifecycle.profile.reload_provider()
            records = (await self.list_schedules()).schedules
            records.sort(
                key=lambda item: (
                    item.pending.started_at if item.pending else item.next_run_at or schedules.MAX_TIME
                )
            )
            for record in records:
                try:
                    if record.pending:
                        await self._reconcile_schedule(record, now)
                    elif (
                        due
                        and record.enabled
                        and (record.next_run_at is not None)
                        and (record.next_run_at <= now)
                    ):
                        busy = record.busy == "skip" and await self._schedule_busy(record)
                        await self.lifecycle.store.claim_schedule(
                            record.schedule_id,
                            now,
                            self.lifecycle.profile.config.provider,
                            self.accounts.secrets(),
                            busy=busy,
                            transports=self.accounts.accounts.read().transports,
                        )
                except BackendError as error:
                    if error.code not in {
                        "schedule_not_found",
                        "schedule_running_capacity",
                        "delivery_capacity",
                    }:
                        raise
            return await self.list_schedules()

    async def run_schedule(self, schedule_id: str, value: ScheduleNow) -> ScheduleView:
        self.lifecycle.admit()
        async with self.schedule_lock:
            record = await self.lifecycle.store.schedule(schedule_id)
            busy = record.busy == "skip" and await self._schedule_busy(record)
            self.lifecycle.profile.reload_provider()
            return await self.lifecycle.store.claim_schedule(
                schedule_id,
                time.time_ns() // 1000000,
                self.lifecycle.profile.config.provider,
                self.accounts.secrets(),
                operation_id=value.operation_id,
                generation=value.expected_generation,
                busy=busy,
                transports=self.accounts.accounts.read().transports,
            )

    async def control_schedule(
        self, schedule_id: str, value: ScheduleControl, action: Literal["enabled", "cancel", "remove"]
    ) -> ScheduleView:
        self.lifecycle.admit()
        async with self.schedule_lock:
            record = await self.lifecycle.store.control_schedule(schedule_id, value, action)
            if action in {"cancel", "remove"}:
                record = await self._reconcile_schedule(record, time.time_ns() // 1000000)
            if action == "remove":
                if record.pending:
                    raise BackendError("schedule_cleanup_pending")
                await self.lifecycle.store.delete_schedule(schedule_id)
            return record
