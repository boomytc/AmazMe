"""The original schedule rules, persistent admission and cancellation boundaries."""

import json
from datetime import datetime
from pathlib import Path

import httpx
import pytest

import amazme_backend.features.schedules.policy as schedules
from amazme_backend.contracts import (
    BackendError,
    CreateSession,
    CronRule,
    HostFence,
    IntervalRule,
    OnceRule,
    ProcessLease,
    Receipt,
    ScheduleControl,
    ScheduleInput,
    ScheduleNow,
    Submit,
)
from amazme_backend.host.service import Host
from amazme_backend.host.store import HostStore
from amazme_backend.interfaces.http.application import application
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sdk import Client
from amazme_backend.sessions.service import SessionStore

SESSION = "a" * 32
OTHER = "b" * 32
PLAN = "c" * 32


def epoch(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


def test_calendar_rules_match_original_gap_fold_weekday_and_catchup_behavior() -> None:
    with pytest.raises(BackendError, match="schedule_time_gap"):
        schedules.normalize(OnceRule(kind="once", at="2026-03-08T02:30", time_zone="America/New_York"))
    fold = OnceRule(kind="once", at="2026-11-01T01:30", time_zone="America/New_York")
    assert schedules.first_target(fold, 0) == epoch("2026-11-01T05:30:00+00:00")
    daily = CronRule(kind="cron", expression="30 2 * * *", time_zone="America/New_York")
    assert schedules.first_target(daily, epoch("2026-03-08T05:00+00:00")) == epoch("2026-03-09T06:30+00:00")
    overlap = CronRule(kind="cron", expression="30 1 * * *", time_zone="America/New_York")
    assert schedules.first_target(overlap, epoch("2026-11-01T05:30+00:00")) == epoch("2026-11-02T06:30+00:00")
    weekday = CronRule(kind="cron", expression="0 9 * * 1-5", time_zone="Asia/Shanghai")
    assert schedules.first_target(weekday, epoch("2026-10-23T10:00+08:00")) == epoch("2026-10-26T09:00+08:00")
    either = CronRule(kind="cron", expression="0 9 1 * 0", time_zone="UTC")
    assert schedules.first_target(either, epoch("2026-10-01T10:00+00:00")) == epoch("2026-10-04T09:00+00:00")
    interval = IntervalRule(kind="interval", every_minutes=15)
    assert schedules.latest_due(interval, 1000, 1000 + 10 * 900000 + 200) == 1000 + 10 * 900000
    assert schedules.next_target(interval, 1000, 1000 + 10 * 900000 + 200) == 1000 + 11 * 900000
    assert schedules.latest_due(weekday, epoch("2026-10-23T09:00+08:00"), epoch("2026-10-27T14:00+08:00")) == epoch("2026-10-27T09:00+08:00")
    assert schedules.first_target(CronRule(kind="cron", expression="0 0 30 2 *", time_zone="UTC"), epoch("2026-01-01T00:00Z")) is None


@pytest.mark.parametrize("expression", ["* * * *", "61 * * * *", "*/0 * * * *", "0 3-1 * * *", "x * * * *"])
def test_bad_cron_is_rejected(expression: str) -> None:
    with pytest.raises(BackendError, match="schedule_cron"):
        schedules.normalize(CronRule(kind="cron", expression=expression, time_zone="UTC"))


@pytest.fixture
async def host(tmp_path: Path):
    private_write(tmp_path / "config.json", json.dumps({"format": 2, "profile_id": "schedules",
        "workspace": str(tmp_path / "primary"), "resources": "unused", "provider": {"provider": "faux"}}))
    (tmp_path / "primary").mkdir()
    private_write(tmp_path / "control.token", "control")
    private_write(tmp_path / "web.token", "web")
    owner = Host(Profile(tmp_path))
    owner.lifecycle.fence = HostFence(host_epoch=1, build_id=owner.lifecycle.build)
    owner.origin = "http://127.0.0.1:12345"
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1)
    owner.lifecycle.fence.host_epoch = await owner.lifecycle.store.initialize(owner.lifecycle.instance, owner.lifecycle.build, lease)
    owner.lifecycle.initialized = True
    await owner.lifecycle.store.create_session(SESSION, CreateSession(title="计划"))
    await owner.lifecycle.store.create_session(OTHER, CreateSession(title="另一会话"))
    try:
        yield owner
    finally:
        await owner.close()


async def delivery_count(host: Host) -> int:
    return await host.lifecycle.store.transaction(lambda db: int(db.execute("SELECT count(*) FROM deliveries WHERE kind='submit'").fetchone()[0]))


async def test_schedules_api_idempotent_edits_pause_future_rules_and_authenticated_listing(host: Host) -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin) as client:
        assert (await client.get("/api/v1/schedules")).status_code == 401
        client.headers.update({"Authorization": "Bearer web", "x-amazme-build": host.lifecycle.build, "x-amazme-epoch": str(host.lifecycle.fence.host_epoch)})
        payload = {"schedule_id": PLAN, "session_id": SESSION, "text": "定期检查", "rule": {"kind": "interval", "every_minutes": 15}}
        first = await client.post("/api/v1/schedules", json=payload)
        assert first.status_code == 200
        assert first.json()["next_run_at"] > first.json()["created_at"]
        assert (await client.post("/api/v1/schedules", json=payload)).json() == first.json()
        edit = {**payload, "expected_generation": 1, "text": "调整检查"}
        changed = await client.post("/api/v1/schedules", json=edit)
        assert changed.json()["generation"] == 2
        assert (await client.post("/api/v1/schedules", json=edit)).json() == changed.json()
        assert (await client.post("/api/v1/schedules", json={**edit, "text": "过期编辑"})).status_code == 409
        assert (await client.post(f"/api/v1/schedules/{PLAN}/enabled", json={"expected_generation": 2, "enabled": False})).json()["enabled"] is False
        state = (await client.get("/api/v1/schedules")).json()
        assert len(state["schedules"]) == 1 and state["schedules"][0]["text"] == "调整检查"
        assert (await client.post("/api/v1/schedules", json={**payload, "schedule_id": "d" * 32, "rule": {"kind": "once", "at": "2020-01-01T09:00", "time_zone": "UTC"}})).status_code == 409
        await host.lifecycle.store.transaction(lambda db: db.execute("UPDATE control SET freeze_id='update' WHERE id=1"))
        assert (await client.post(f"/api/v1/schedules/{PLAN}/run", json={"operation_id": "f" * 32, "expected_generation": 2})).status_code == 503
        assert await delivery_count(host) == 0


async def test_due_claim_and_model_snapshot_survive_restart_without_replay(host: Host) -> None:
    now = epoch("2026-01-01T00:00Z")
    value = ScheduleInput(schedule_id=PLAN, session_id=SESSION, text="检查", rule=IntervalRule(kind="interval", every_minutes=1))
    await host.lifecycle.store.save_schedule(value, now, ())
    due = now + 10 * 60000 + 123
    record = await host.lifecycle.store.claim_schedule(PLAN, due, host.lifecycle.profile.config.provider, ())
    assert record.pending and record.pending.scheduled_for == now + 10 * 60000
    original = record.pending.request_id
    assert await delivery_count(host) == 1
    delivery = (await host.lifecycle.store.pending())[0]
    assert delivery.provider is not None and delivery.provider.provider == "faux"
    await host.lifecycle.store.db.close()
    host.lifecycle.store = HostStore(host.lifecycle.profile.path / "host.sqlite", require_existing=True)
    again = await host.lifecycle.store.claim_schedule(PLAN, due + 60000, host.lifecycle.profile.config.provider, ())
    assert again.pending and again.pending.request_id == original
    assert await delivery_count(host) == 1


async def test_missed_busy_secret_and_missing_target_never_enqueue(host: Host) -> None:
    now = epoch("2026-01-01T00:00Z")
    for digit, options, reason in [("c", {"missed": "skip", "grace_minutes": 0}, "missed"), ("d", {"busy": "skip"}, "busy")]:
        value = ScheduleInput.model_validate({"schedule_id": digit * 32, "session_id": SESSION, "text": "检查", "rule": {"kind": "interval", "every_minutes": 1}, **options})
        await host.lifecycle.store.save_schedule(value, now, ())
        result = await host.lifecycle.store.claim_schedule(digit * 32, now + 60001, host.lifecycle.profile.config.provider, (), busy=True)
        assert result.history[-1].detail == reason and result.pending is None
    value = ScheduleInput(schedule_id="e" * 32, session_id=OTHER, text="检查", rule=IntervalRule(kind="interval", every_minutes=1))
    await host.lifecycle.store.save_schedule(value, now, ())
    await host.lifecycle.store.set_archived(OTHER, True)
    result = await host.lifecycle.store.claim_schedule("e" * 32, now + 60001, host.lifecycle.profile.config.provider, ())
    assert not result.enabled and result.history[-1].detail == "target_missing"
    with pytest.raises(BackendError, match="schedule_text"):
        await host.lifecycle.store.save_schedule(value.model_copy(update={"schedule_id": "f" * 32, "text": "secret-token"}), now, ("secret-token",))
    assert await delivery_count(host) == 0


async def test_cancel_waits_for_final_receipt_and_remove_pauses_before_cleanup(host: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    record = await host.scheduling.save_schedule(ScheduleInput(schedule_id=PLAN, session_id=SESSION, text="检查", rule=IntervalRule(kind="interval", every_minutes=1)))
    running = await host.scheduling.run_schedule(PLAN, ScheduleNow(operation_id="e" * 32, expected_generation=1))
    assert running.pending
    request = running.pending.request_id
    path = session_database(host.lifecycle.profile.path, SESSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    current = [Receipt(request_id=request, text="检查", status="running", cancel_requested=True)]
    cancelled: list[str] = []
    proved = [False]

    class PendingSession:
        async def get(self, request_id: str):
            assert request_id == request
            return current[0]

        async def request_cleanup_complete(self, request_id: str):
            assert request_id == request
            return proved[0]

    async def read(session: str, operation):
        assert session == SESSION
        return await operation(PendingSession())

    async def deliver(session: str, kind: str, key: str, value):
        assert session == SESSION and kind == "cancel"
        cancelled.append(key)
        return current[0]

    monkeypatch.setattr(host.access, 'read', read)
    monkeypatch.setattr(host.sessions, 'deliver', deliver)
    with pytest.raises(BackendError, match="schedule_run_changed"):
        await host.scheduling.control_schedule(PLAN, ScheduleControl(expected_generation=1, request_id="0" * 32), "cancel")
    with pytest.raises(BackendError, match="schedule_cleanup_pending"):
        await host.scheduling.control_schedule(PLAN, ScheduleControl(expected_generation=1, request_id=request), "remove")
    waiting = (await host.scheduling.list_schedules()).schedules[0]
    assert waiting.pending and waiting.pending.cancel_reason == "cancelled" and not waiting.enabled
    assert cancelled == [request]
    current[0] = current[0].model_copy(update={"status": "unknown"})
    await host.scheduling.tick_schedules(force=True)
    assert (await host.scheduling.list_schedules()).schedules[0].pending
    assert await delivery_count(host) == 1
    proved[0] = True
    await host.scheduling.tick_schedules(force=True)
    settled = (await host.scheduling.list_schedules()).schedules[0]
    assert settled.pending is None and settled.history[-1].status == "unanswered"
    assert settled.history[-1].detail == "unknown_reconciled"
    assert not settled.enabled
    assert (await host.scheduling.run_schedule(PLAN, ScheduleNow(operation_id="e" * 32, expected_generation=1))).pending is None
    assert await delivery_count(host) == 1
    await host.scheduling.control_schedule(PLAN, ScheduleControl(expected_generation=1), "remove")
    await host.scheduling.control_schedule(PLAN, ScheduleControl(expected_generation=1), "remove")
    assert not (await host.scheduling.list_schedules()).schedules
    with pytest.raises(BackendError, match="schedule_removed"):
        await host.scheduling.save_schedule(ScheduleInput.model_validate(record.model_dump(include=set(ScheduleInput.model_fields))))


async def test_deadline_cancels_before_unaccepted_submission(host: Host, monkeypatch: pytest.MonkeyPatch) -> None:
    await host.scheduling.save_schedule(ScheduleInput(schedule_id=PLAN, session_id=SESSION, text="never start", rule=IntervalRule(kind="interval", every_minutes=1)))
    record = await host.scheduling.run_schedule(PLAN, ScheduleNow(operation_id="e" * 32, expected_generation=1))
    assert record.pending
    request = record.pending.request_id
    path = session_database(host.lifecycle.profile.path, SESSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    store = SessionStore(path, SESSION, build=host.lifecycle.build, config=host.lifecycle.profile.config.provider)
    dispatched: list[str] = []

    async def dispatch(delivery):
        dispatched.append(delivery.kind)
        receipt = await store.cancel(request, host.lifecycle.fence) if delivery.kind == "cancel" else await store.accept(Submit.model_validate_json(delivery.payload), host.lifecycle.fence)
        return await host.lifecycle.store.delivered(delivery.delivery_id, receipt)

    monkeypatch.setattr(host.sessions, 'dispatch', dispatch)
    try:
        await store.initialize()
        await store.fence(host.lifecycle.fence)
        monkeypatch.setattr("amazme_backend.host.scheduling.time.time_ns", lambda: record.pending.deadline_at * 1000000)
        finished = (await host.scheduling.tick_schedules(force=True)).schedules[0]
        assert finished.pending is None and finished.history[-1].status == "timed_out"
        assert dispatched == ["cancel"]
        for pending in await host.lifecycle.store.pending(SESSION):
            await dispatch(pending)
        assert (await store.get(request)).status == "cancelled"
        assert (await store.get(request)).error == "cancelled_before_acceptance"
        activity = await store.activity()
        assert activity.pending == 0 and not activity.runnable
    finally:
        await store.close()


async def test_sdk_and_rpc_use_the_same_schedule_and_run_ids(host: Host) -> None:
    client = Client(host.origin, "web")
    await client._http.aclose()
    client._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=application(host)), base_url=host.origin)
    async with client:
        value = ScheduleInput(schedule_id=PLAN, session_id=SESSION, text="检查", rule=IntervalRule(kind="interval", every_minutes=1))
        created = await client.save_schedule(value)
        assert (await client.schedules()).schedules == [created]
        listed = await client.rpc("schedule.list")
        assert listed["schedules"][0]["schedule_id"] == PLAN
        first = await client.run_schedule(PLAN, ScheduleNow(operation_id="d" * 32, expected_generation=1))
        replay = await client.rpc("schedule.run", schedule_id=PLAN, schedule_now={"operation_id": "d" * 32, "expected_generation": 1})
        assert first.pending and replay["pending"]["request_id"] == first.pending.request_id
        assert await delivery_count(host) == 1
        await client.control_schedule(PLAN, ScheduleControl(expected_generation=1, enabled=False), "enabled")
        assert (await client.schedules()).schedules[0].enabled is False
