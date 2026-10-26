"""Canonical digest for the new export format. Provider credentials are not part of it."""

import hashlib
import json

from amazme_backend.contracts.management import ExportBundle


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def transcript_digest(messages: list[tuple[str, str, str]]) -> str:
    payload = [
        {"content": content, "request_id": request_id, "role": role} for request_id, role, content in messages
    ]
    return digest(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def bundle_digest(bundle: ExportBundle) -> str:
    payload = {
        "answer_feedback": [item.model_dump() for item in bundle.answer_feedback],
        "feedback": [item.model_dump() for item in bundle.feedback],
        "format": "amazme-export/1",
        "projects": [item.model_dump() for item in bundle.projects],
        "sessions": [item.model_dump() for item in bundle.sessions],
        "settings": bundle.settings.model_dump(),
    }
    return digest(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def contains_secret(text: str, secret: str | tuple[str, ...]) -> bool:
    values = (secret,) if isinstance(secret, str) else secret
    return any(value and value in text for value in values)


def bundle_text(bundle: ExportBundle) -> str:
    parts = [bundle.settings.display_name]
    parts.extend(item.name for item in bundle.projects)
    parts.extend(item.text for item in bundle.feedback)
    for session in bundle.sessions:
        parts.append(session.title)
        parts.extend(message.content for message in session.messages)
    return "\n".join(parts)
