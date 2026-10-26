"""Pure public projections, digests and search windows."""
import hashlib
import json
import re
from typing import Literal

from amazme_backend.contracts.models import Message
from amazme_backend.contracts.sessions import (
    SearchHit,
    TranscriptMessage,
)
from amazme_backend.sessions.types import (
    Completion,
    Step,
)

_PUBLIC_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def public_error_code(value: str) -> str:
    return value if _PUBLIC_CODE.fullmatch(value) else "unlisted"


def compaction_basis(payloads: list[str]) -> str:
    return hashlib.sha256("\n".join(payloads).encode()).hexdigest()


def display_message(key: str, ordinal: int, message: Message) -> TranscriptMessage:
    """The public projection cannot carry provider replay fields or image bytes."""
    return TranscriptMessage(key=key, ordinal=ordinal, role=message.role, content=message.content,
        tool_calls=[call.id for call in message.tool_calls])


def event_step_text(step: Step) -> str:
    if step.kind == "model" and step.result:
        result = Completion.model_validate_json(step.result)
        result.message = result.message.model_copy(update={"images": [], "reasoning_signature": ""})
        step = step.model_copy(update={"result": result.model_dump_json()})
    return step.model_dump_json(exclude={"mcp_catalog", "plugin_catalog", "search_catalog", "code_poll_ms", "code_input_state", "code_state"})


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def workflow_body(check: str, correction_limit: int) -> str:
    return json.dumps({"check": check, "correction_limit": correction_limit},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def verdict_body(verdict_id: str, passed: bool) -> str:
    return json.dumps({"passed": passed, "verdict_id": verdict_id},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def correction_text(attempt: int) -> str:
    return f"修正第{attempt}次。上一阶段未通过。只处理这次修正。"


def casefold_index(content: str, target: int) -> int:
    count = 0
    for index, char in enumerate(content):
        if count >= target:
            return index
        count += len(char.casefold())
    return len(content)


def search_text(request_id: str, ordinal: int, role: Literal["user", "assistant", "tool"],
                 content: str, needle: str) -> list[SearchHit]:
    index = content.casefold().find(needle)
    if index < 0:
        return []
    start = casefold_index(content, index)
    end = casefold_index(content, index + len(needle))
    left = max(0, start - 40)
    right = min(len(content), end + 40)
    return [SearchHit(request_id=request_id, ordinal=ordinal, role=role, excerpt=content[left:right])]
