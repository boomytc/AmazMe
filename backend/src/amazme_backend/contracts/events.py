from __future__ import annotations

from typing import Literal

from pydantic import Field

from amazme_backend.contracts.execution import EffectHold
from amazme_backend.contracts.questions import QuestionView
from amazme_backend.contracts.sessions import Approval, Preview, Receipt, TranscriptMessage, WorkerState
from amazme_backend.shared.model import Model


class Event(Model):
    seq: str
    kind: Literal["accepted", "status", "preview", "message", "tool", "cleanup", "approval", "children", "effect",
                  "freeze", "compaction", "question"]
    request_id: str
    text: str
    message: TranscriptMessage | None = None
    receipt: Receipt | None = None
    approval: Approval | None = None
    preview: Preview | None = None
    question: QuestionView | None = None


class Snapshot(Model):
    session_id: str
    stream_id: str
    seq: str
    state: WorkerState
    requests: list[Receipt]
    events: list[Event]
    approvals: list[Approval] = Field(default_factory=lambda: list[Approval]())
    effects: list[EffectHold] = Field(default_factory=lambda: list[EffectHold]())
    previews: list[Preview] = Field(default_factory=lambda: list[Preview]())
    questions: list[QuestionView] = Field(default_factory=lambda: list[QuestionView]())
    next_wake_ms: int = 0
    pending: int = 0
    compaction: str = ""


class EventList(Model):
    events: list[Event]


class HistoryPage(Model):
    session_id: str
    requests: list[Receipt]
    events: list[Event]
    cursor: str = ""
    more: bool = False
    truncated: bool = False


class Stream(Model):
    snapshot: Snapshot | None = None
    batches: list[CommitBatch] = Field(default_factory=lambda: list[CommitBatch]())
    stream_id: str = ""
    binding_id: str = ""
    build_id: str = ""
    resync: str = ""


class CommitBatch(Model):
    stream_id: str
    seq: str
    base_revision: str
    revision: str
    events: list[Event]


class Replay(Model):
    stream_id: str
    seq: str
    batches: list[CommitBatch]
    resync: bool = False


class StreamHello(Model):
    kind: Literal["hello"] = "hello"
    binding_id: str = Field(min_length=1, max_length=128)
    stream_id: str = ""
    after: str = Field(default="0", pattern=r"^(0|[1-9][0-9]{0,17})$")
    build_id: str


class StreamAck(Model):
    kind: Literal["ack"] = "ack"
    binding_id: str
    stream_id: str
    seq: str = Field(pattern=r"^(0|[1-9][0-9]{0,17})$")
