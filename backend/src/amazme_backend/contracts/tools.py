from pydantic import Field

from amazme_backend.shared.model import Model


class ToolSearchInput(Model):
    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=8, gt=0, le=64)


class LoadedTools(Model):
    loaded: list[str]


class ToolSearchOutput(Model):
    content: list[dict[str, str]]
    details: LoadedTools
