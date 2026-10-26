from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from amazme_backend.shared.model import Model


class IntervalRule(Model):
    kind: Literal["interval"]
    every_minutes: int = Field(ge=1, le=4223371679)


class OnceRule(Model):
    kind: Literal["once"]
    at: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$")
    time_zone: str = Field(min_length=1, max_length=64)


class CronRule(Model):
    kind: Literal["cron"]
    expression: str = Field(min_length=1, max_length=256)
    time_zone: str = Field(min_length=1, max_length=64)


ScheduleRule = Annotated[IntervalRule | OnceRule | CronRule, Field(discriminator="kind")]


class ScheduleInput(Model):
    schedule_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    text: str = Field(min_length=1, max_length=8000)
    rule: ScheduleRule
    busy: Literal["queue", "skip"] = "queue"
    missed: Literal["latest", "skip"] = "latest"
    grace_minutes: int = Field(default=10, ge=0, le=10080)
    timeout_seconds: int = Field(default=600, ge=1, le=86400)
    expected_generation: int = Field(default=0, ge=0)


class ScheduleRun(Model):
    request_id: str
    started_at: int
    deadline_at: int
    scheduled_for: int | None = None
    cancel_reason: Literal["cancelled", "timed_out"] | None = None
    problem: str | None = None


class ScheduleOutcome(Model):
    request_id: str
    started_at: int
    finished_at: int
    scheduled_for: int | None = None
    status: Literal["done", "unanswered", "refused", "cancelled", "timed_out", "skipped"]
    detail: str | None = None


class ScheduleView(ScheduleInput):
    workspace: str
    generation: int = 1
    enabled: bool = True
    created_at: int
    next_run_at: int | None
    pending: ScheduleRun | None = None
    history: list[ScheduleOutcome] = Field(default_factory=lambda: list[ScheduleOutcome]())


class SchedulesView(Model):
    path: str
    tick_ms: int = 5000
    schedules: list[ScheduleView]


class ScheduleControl(Model):
    expected_generation: int = Field(ge=1)
    enabled: bool | None = None
    request_id: str = Field(default="", pattern=r"^(?:[a-f0-9]{32})?$")


class ScheduleNow(Model):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    expected_generation: int = Field(ge=1)
