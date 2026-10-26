from __future__ import annotations

from typing import Literal

from pydantic import JsonValue

from amazme_backend.contracts.mcp import McpTool
from amazme_backend.shared.model import Model


class McpResult(Model):
    op: Literal["result"]
    call_id: str
    text: str
    data: dict[str, JsonValue]
    is_error: bool

class McpCatalog(Model):
    op: Literal["catalog"]
    tools: list[McpTool]
    protocol_version: str
