"""DeepSeek web search and fetch. Chat headers and proxies are not forwarded."""

import json
from typing import cast
from urllib.parse import urlsplit

import httpx

from .contracts import BackendError

DEFAULT_WEB_BASE = "https://api.deepseek.com/v1/tools"
WebOutcome = str


def clip_units(text: str, limit: int) -> str:
    """Keep a UTF-16 window without splitting a surrogate pair."""
    kept: list[str] = []
    used = 0
    for char in text:
        units = 2 if ord(char) > 0xFFFF else 1
        if used + units > limit:
            break
        kept.append(char)
        used += units
    return "".join(kept)


def original_question(text: str) -> str:
    collapsed = " ".join(text.split())
    return "".join(list(collapsed)[:128])


def validate_base_url(value: str) -> str:
    if len(value) > 8192:
        raise BackendError("web_address")
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise BackendError("web_address")
    return value.rstrip("/")


def validate_fetch_url(value: str) -> str:
    if not value or len(value) > 8192:
        raise BackendError("web_address")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise BackendError("web_address")
    return value


def _record(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise BackendError("web_invalid_response")
    raw = cast(dict[object, object], value)
    return {str(key): item for key, item in raw.items()}


def search_result(payload: object, count: int, max_chars: int) -> str:
    body = _record(payload)
    rows = body.get("results")
    if not isinstance(rows, list):
        raise BackendError("web_invalid_response")
    items = cast(list[object], rows)
    sources: list[dict[str, str]] = []
    remaining = max_chars
    truncated = len(items) > count
    for item in items[:count]:
        record = _record(item)
        url, title, snippet, date = record.get("url"), record.get("title"), record.get("snippet"), record.get("date")
        if (not isinstance(url, str) or not isinstance(title, str) or not isinstance(snippet, str)
                or not (date is None or isinstance(date, str))):
            raise BackendError("web_invalid_response")
        validate_fetch_url(url)
        if len(url) > remaining:
            truncated = True
            break
        remaining -= len(url)
        source = {"url": url}
        for key, text in ("title", title), ("snippet", snippet), ("publishedAt", date or ""):
            kept = clip_units(text, remaining)
            if kept:
                source[key] = kept
            remaining -= len(kept)
            if len(kept) < len(text):
                truncated = True
        sources.append(source)
    return json.dumps({"sources": sources, "truncated": truncated}, ensure_ascii=False, separators=(",", ":"))


def fetch_result(payload: object, url: str, max_chars: int) -> str:
    body = _record(payload)
    content, title = body.get("content"), body.get("title", "")
    if not isinstance(content, str) or not isinstance(title, str):
        raise BackendError("web_invalid_response")
    kept = clip_units(content, max_chars)
    kept_title = clip_units(title, max(0, max_chars - len(kept)))
    result: dict[str, object] = {"url": url, "content": kept,
                                 "truncated": len(kept) < len(content) or len(kept_title) < len(title)}
    if kept_title:
        result["title"] = kept_title
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


async def read_web(response: httpx.Response, max_bytes: int) -> bytes | None:
    """Return the body, or None when it exceeds the cap. The caller does not follow redirects."""
    advertised = response.headers.get("content-length")
    if advertised:
        try:
            declared = int(advertised)
        except ValueError:
            declared = max_bytes + 1
        if declared > max_bytes:
            await response.aclose()
            return None
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            await response.aclose()
            return None
        chunks.append(chunk)
    return b"".join(chunks)
