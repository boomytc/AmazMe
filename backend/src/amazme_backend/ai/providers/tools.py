"""Project caller-supplied tool declarations into native JSON protocol records."""
from pydantic import JsonValue

from amazme_backend.ai.types import ModelRequest


def tool_records(request: ModelRequest) -> list[dict[str, JsonValue]]:
    return [{"name": request.wire_name(tool.name), "description": tool.description,
             "parameters": tool.parameters} for tool in request.tools]
