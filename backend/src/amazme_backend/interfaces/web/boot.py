"""The document the desktop reads before the page module runs."""

import base64
import hashlib
import json
import re
import secrets
import sys

from amazme_backend.contracts.identity import Identity
from amazme_backend.contracts.settings import InterfacePreferences
from amazme_backend.platform.resources import frontend_directory
from amazme_backend.shared.errors import BackendError


def transport_url(origin: str) -> str:
    if origin.startswith("https://"):
        base = "wss://" + origin.removeprefix("https://")
    elif origin.startswith("http://"):
        base = "ws://" + origin.removeprefix("http://")
    else:
        raise BackendError("boot_origin_invalid")
    return base.rstrip("/") + "/api/v1/events"


def boot_manifest(identity: Identity, origin: str, preferences: InterfacePreferences | None = None) -> dict[str, object]:
    return {
        "app": {"name": "AmazMe", "version": identity.version},
        "mode": "installed" if getattr(sys, "frozen", False) else "source",
        "protocol": identity.protocol,
        "server": {"id": identity.profile_id},
        "transport": {"url": transport_url(origin), "path": "/api/v1/events"},
        "preferences": (preferences or InterfacePreferences()).model_dump(mode="json"),
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


def page_content_security_policy(source: str, html: str = "", style_nonce: str = "") -> str:
    digest = base64.b64encode(hashlib.sha256(source.encode()).digest()).decode()
    scripts = [f"'sha256-{digest}'"]
    styles: list[str] = []
    if style_nonce:
        styles.append(f"'nonce-{style_nonce}'")
    for tag, content in re.findall(r"<(script|style)(?:\s[^>]*)?>(.*?)</\1>", html, re.DOTALL):
        if not content.strip():
            continue
        digest = base64.b64encode(hashlib.sha256(content.encode()).digest()).decode()
        (scripts if tag == "script" else styles).append(f"'sha256-{digest}'")
    return (
        "default-src 'self'; "
        f"script-src 'self' {' '.join(scripts)}; "
        "frame-ancestors 'none'; connect-src 'self'; img-src 'self' data: blob:; "
        f"style-src 'self' {' '.join(styles)}"
    )


def boot_document(identity: Identity, origin: str, preferences: InterfacePreferences | None = None) -> tuple[str, str]:
    source = boot_script_source(boot_manifest(identity, origin, preferences))
    html = (frontend_directory() / "index.html").read_text()
    if "</head>" not in html:
        raise BackendError("boot_document_invalid")
    nonce = secrets.token_urlsafe(24)
    marker = '<meta name="amazme-style-nonce" content="' + nonce + '">'
    injection = marker + "<script>" + source + "</script>"
    document = (html.replace("<!--amazme-boot-->", injection, 1) if "<!--amazme-boot-->" in html
                else html.replace("</head>", injection + "</head>", 1))
    return document, page_content_security_policy(source, html, nonce)


def boot_page(identity: Identity, origin: str) -> str:
    html, _policy = boot_document(identity, origin)
    return html
