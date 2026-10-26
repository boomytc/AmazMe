from __future__ import annotations

from pydantic import Field

from amazme_backend.shared.model import Model


class ProjectWrite(Model):
    project_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=80)
    workspaces: list[str] = Field(default_factory=lambda: ["primary"], min_length=1, max_length=8)


class ProjectUpdate(Model):
    name: str = Field(min_length=1, max_length=80)
    workspaces: list[str] = Field(min_length=1, max_length=8)
    expected_revision: int = Field(ge=0)
    removed: bool = False


class ProjectView(Model):
    project_id: str
    name: str
    workspaces: list[str] = Field(default_factory=lambda: ["primary"])
    revision: int = 0
    removed: bool = False


class ProjectList(Model):
    projects: list[ProjectView] = Field(default_factory=lambda: list[ProjectView]())
