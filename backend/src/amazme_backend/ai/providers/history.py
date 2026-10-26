"""Opaque provider replay data and tool-result image ordering."""
import json
from typing import cast

from pydantic import JsonValue, TypeAdapter

from amazme_backend.ai.types import ModelMessage
from amazme_backend.contracts.models import ImagePart
from amazme_backend.shared.errors import BackendError

_SIGNATURE_LIMIT = 65536
_BLOCKS = TypeAdapter(list[dict[str, JsonValue]])


def replay_blocks(message: ModelMessage) -> list[dict[str, JsonValue]]:
    return _BLOCKS.validate_json(message.reasoning_signature) if message.reasoning_signature else []
def reasoning_signature(details: list[object]) -> str:
    if not details:
        return ""
    encoded = json.dumps(details, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) > _SIGNATURE_LIMIT:
        raise BackendError("reasoning_signature_limit")
    return encoded


def replay_reasoning_details(signature: str) -> list[object]:
    """Restore a stored signature without rewriting its entries."""
    if not signature:
        return []
    try:
        details = json.loads(signature)
    except json.JSONDecodeError:
        raise BackendError("invalid_reasoning_signature") from None
    if not isinstance(details, list):
        raise BackendError("invalid_reasoning_signature")
    return cast(list[object], details)


def tool_image_messages(messages: list[ModelMessage]) -> list[ModelMessage]:
    expanded: list[ModelMessage] = []
    pending: list[ImagePart] = []

    def flush() -> None:
        for offset in range(0, len(pending), 8):
            expanded.append(ModelMessage(role="user", content="Images returned by the preceding tools.",
                                    images=pending[offset:offset + 8]))
        pending.clear()

    for message in messages:
        if message.role == "tool":
            expanded.append(message.model_copy(update={"images": []}) if message.images else message)
            pending.extend(message.images)
        else:
            flush()
            expanded.append(message)
    flush()
    return expanded
