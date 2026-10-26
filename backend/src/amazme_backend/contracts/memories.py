from __future__ import annotations

from pydantic import Field

from amazme_backend.shared.model import Model


class MemoryWrite(Model):
    memory_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = "primary"
    text: str = Field(min_length=1, max_length=500)


class MemoryView(Model):
    memory_id: str
    workspace: str
    text: str


class MemoryList(Model):
    workspace: str
    memories: list[MemoryView]
