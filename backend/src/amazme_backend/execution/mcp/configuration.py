"""MCP configuration and reconnect receipts. Processes remain in the existing supervisor."""

from __future__ import annotations

import os
import re

from amazme_backend.shared.errors import BackendError


def expand_reference(value: str) -> str:
    def substitute(match: re.Match[str]) -> str:
        if match[0] in {"$$", "$!"}:
            return match[0][1:]
        name = match[1] or match[2]
        content = os.environ.get(name)
        if not content:
            raise BackendError("mcp_env_missing", name)
        return content

    return re.sub(r"\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", substitute, value)
