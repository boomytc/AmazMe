"""The document the desktop reads before the page module runs."""

import base64
import hashlib
import json
import sys
from pathlib import Path

from .contracts import BackendError, Identity

PAGE = Path(__file__).with_name("web") / "index.html"


def transport_url(origin: str) -> str:
    if origin.startswith("https://"):
        base = "wss://" + origin.removeprefix("https://")
    elif origin.startswith("http://"):
        base = "ws://" + origin.removeprefix("http://")
    else:
        raise BackendError("boot_origin_invalid")
    return base.rstrip("/") + "/api/v1/events"


def boot_manifest(identity: Identity, origin: str) -> dict[str, object]:
    return {
        "app": {"name": "AmazMe", "version": identity.version},
        "mode": "installed" if getattr(sys, "frozen", False) else "source",
        "protocol": identity.protocol,
        "server": {"id": identity.profile_id},
        "transport": {"url": transport_url(origin), "path": "/api/v1/events"},
    }


def boot_script_source(manifest: dict[str, object]) -> str:
    payload = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return (
        "globalThis.__AMAZME_BOOT__=" + payload + ";"
        "document.title=globalThis.__AMAZME_BOOT__.app.name+\" \"+globalThis.__AMAZME_BOOT__.app.version;"
    )


def boot_script(manifest: dict[str, object]) -> str:
    return "<script>" + boot_script_source(manifest) + "</script>"


def page_content_security_policy(source: str) -> str:
    digest = base64.b64encode(hashlib.sha256(source.encode()).digest()).decode()
    return (
        "default-src 'self'; "
        f"script-src 'self' 'sha256-{digest}'; "
        "frame-ancestors 'none'; connect-src 'self'; style-src 'self'"
    )


def boot_document(identity: Identity, origin: str) -> tuple[str, str]:
    source = boot_script_source(boot_manifest(identity, origin))
    html = PAGE.read_text()
    if "</head>" not in html:
        raise BackendError("boot_document_invalid")
    return html.replace("</head>", "<script>" + source + "</script></head>", 1), page_content_security_policy(source)


def boot_page(identity: Identity, origin: str) -> str:
    html, _policy = boot_document(identity, origin)
    return html
