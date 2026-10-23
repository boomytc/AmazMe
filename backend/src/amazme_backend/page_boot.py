"""The document the desktop reads before the page module runs."""

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


def boot_script(manifest: dict[str, object]) -> str:
    payload = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return (
        "<script>globalThis.__AMAZME_BOOT__=" + payload + ";"
        "document.title=globalThis.__AMAZME_BOOT__.app.name+\" \"+globalThis.__AMAZME_BOOT__.app.version;"
        "</script>"
    )


def boot_page(identity: Identity, origin: str) -> str:
    html = PAGE.read_text()
    script = boot_script(boot_manifest(identity, origin))
    if "</head>" not in html:
        raise BackendError("boot_document_invalid")
    return html.replace("</head>", script + "</head>", 1)
