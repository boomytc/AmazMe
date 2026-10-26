from __future__ import annotations

from typing import Annotated

from pydantic import Field

from amazme_backend.shared.model import Model


class ResourceOptions(Model):
    no_context_files: bool = False
    no_skills: bool = False
    skill_paths: list[Annotated[str, Field(min_length=1, max_length=1024)]] = Field(default_factory=list, max_length=32)
    no_prompt_templates: bool = False
    prompt_paths: list[Annotated[str, Field(min_length=1, max_length=1024)]] = Field(default_factory=list, max_length=32)



class ResourceItem(Model):
    name: str
    path: str
    description: str = ""
    disable_model_invocation: bool = False
    scope: str = "user"
    editable: bool = False

class ResourceCatalog(Model):
    context_files: list[str]
    skills: list[ResourceItem]
    prompts: list[ResourceItem]
    diagnostics: list[str]
    skill_directory: str = ""
