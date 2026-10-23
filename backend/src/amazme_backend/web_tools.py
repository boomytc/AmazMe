"""DeepSeek web search and fetch. Chat headers and proxies are not forwarded."""

import json
from typing import Literal, Protocol, cast
from urllib.parse import urlsplit

import httpx

from .contracts import BackendError, WebCallRequest, WebCallView, WebPolicy

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


class WebCaller(Protocol):
    async def web_policy(self) -> WebPolicy: ...

    async def begin_web_call(self, call_id: str, kind: Literal["search", "fetch"],
                             body: str) -> tuple[WebCallView, bool]: ...

    async def settle_web_call(self, call_id: str, phase: Literal["unknown", "done", "failed"],
                              error: str, result: str) -> WebCallView: ...


async def dispatch_web(endpoint: str, body: dict[str, object], key: str, policy: WebPolicy,
                       client: httpx.AsyncClient | None) -> tuple[str, int, bytes]:
    """POST one paid call. The chat proxy and extra headers are not available here."""
    owns = client is None
    http = client or httpx.AsyncClient(follow_redirects=False)
    try:
        async with http.stream(
            "POST", endpoint, json=body, headers={
                "authorization": f"Bearer {key}", "content-type": "application/json", "accept": "application/json",
            }, timeout=policy.timeout_ms / 1000,
        ) as response:
            if 300 <= response.status_code < 400:
                await response.aclose()
                return "redirect", response.status_code, b""
            if response.status_code >= 400:
                await response.aclose()
                return "http", response.status_code, b""
            raw = await read_web(response, policy.max_response_bytes)
            if raw is None:
                return "limit", response.status_code, b""
            return "ok", response.status_code, raw
    except httpx.TransportError:
        return "transport", 0, b""
    finally:
        if owns:
            await http.aclose()


async def execute_web_call(store: WebCaller, value: WebCallRequest, *, key: str, question: str,
                           client: httpx.AsyncClient | None) -> WebCallView:
    """Reserve the call before sending. A disabled policy or a missing key leaves no row."""
    policy = await store.web_policy()
    if not policy.enabled:
        raise BackendError("web_disabled")
    if not key:
        raise BackendError("web_credential_missing")
    search_count = policy.count
    if value.kind == "search":
        query = value.query.strip()
        if not query or len(list(query)) > 128:
            raise BackendError("web_query")
        search_count = min(policy.count, value.count if value.count is not None else policy.count)
        outbound: dict[str, object] = {"query": query, "count": search_count, "need_content": False}
        if policy.send_original_question:
            clipped = original_question(question)
            if clipped:
                outbound["ori_question"] = clipped
        endpoint = policy.base_url + "/search"
    else:
        query = ""
        target = validate_fetch_url(value.url)
        outbound = {"url": target}
        endpoint = policy.base_url + "/fetch"
    canonical = json.dumps({"count": value.count, "kind": value.kind, "query": query, "url": value.url},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    view, send = await store.begin_web_call(value.call_id, value.kind, canonical)
    if not send:
        return view
    outcome, status, raw = await dispatch_web(endpoint, outbound, key, policy, client)
    phase: Literal["unknown", "done", "failed"] = "unknown"
    error, result = "", ""
    if outcome == "ok":
        try:
            parsed = json.loads(raw)
            result = (search_result(parsed, search_count, policy.max_content_chars) if value.kind == "search"
                      else fetch_result(parsed, str(outbound["url"]), policy.max_content_chars))
            phase = "done"
        except (json.JSONDecodeError, BackendError):
            error = "web_invalid_response"
    elif outcome == "redirect":
        phase, error = "failed", "web_redirect"
    elif outcome == "http":
        phase, error = "failed", f"web_http_{status}"
    elif outcome == "limit":
        error = "web_response_limit"
    else:
        error = "web_transport"
    return await store.settle_web_call(value.call_id, phase, error, result)


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
