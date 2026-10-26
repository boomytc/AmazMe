from __future__ import annotations

from pydantic import Field

from amazme_backend.shared.model import Model

FILE_LIMIT = 64 * 1024


class SkillDocument(Model):
    name: str
    path: str
    content: str
    digest: str
    editable: bool

class SkillWrite(Model):
    name: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=64)
    content: str = Field(max_length=FILE_LIMIT)
    expected_digest: str = Field(default="", pattern=r"^(?:[a-f0-9]{64})?$")

class SkillImport(Model):
    path: str = Field(min_length=1, max_length=4096)

class SkillRemove(Model):
    expected_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
