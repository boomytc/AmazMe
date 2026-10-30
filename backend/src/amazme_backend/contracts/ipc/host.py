from __future__ import annotations

from pydantic import Field, JsonValue

from amazme_backend.contracts.execution import ApplyPatch, EditFile, FileObservation, Lease, WriteFile
from amazme_backend.contracts.identity import HostFence
from amazme_backend.contracts.models import ImagePart, ToolCall
from amazme_backend.contracts.sessions import Receipt
from amazme_backend.shared.model import Model


class CodeToolDispatch(HostFence):
    session_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    sequence: int = Field(ge=1, le=128)
    name: str = Field(min_length=1, max_length=128)
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    cancel: bool = False


class CodeToolBinding(Model):
    request_id: str
    call: ToolCall
    parent_request_id: str = ""
    parent_step_id: str = ""


class CodeToolReceipt(Model):
    receipt: Receipt
    images: list[ImagePart] = Field(default_factory=lambda: list[ImagePart]())


class PrepareFileWrite(Lease):
    host_epoch: int
    call_id: str = Field(min_length=1, max_length=128)
    write: WriteFile | EditFile
    observation: FileObservation | None = None


class PreparedFileWrite(Model):
    call_id: str
    path: str
    expected_digest: str = Field(pattern=r"^(?:[a-f0-9]{64})?$")
    checkpoint_id: str = ""
    root: str = ""


class PreparePatch(Lease, ApplyPatch):
    host_epoch: int
    call_id: str = Field(min_length=1, max_length=128)
    observations: list[FileObservation] = Field(default_factory=lambda: list[FileObservation](), max_length=256,
                                               description="Newest observations first; the first canonical path wins.")
