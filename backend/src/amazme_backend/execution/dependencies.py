"""Read capabilities and product callbacks supplied when the supervisor is assembled."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from amazme_backend.contracts.mcp import McpOffer, McpServerSettings
from amazme_backend.contracts.models import ToolCall
from amazme_backend.contracts.plugins import PluginOffer
from amazme_backend.contracts.sessions import RunOptions


class SessionWorkspaceQuery(Protocol):
    def __call__(self, session_id: str, /, *, active: bool = False) -> str: ...


@dataclass(frozen=True)
class ExecutionQueries:
    session_workspace: SessionWorkspaceQuery
    load_grants: Callable[[], list[tuple[str, str]]]
    mcp_policy: Callable[[str, str, str], McpServerSettings | None]
    branch_pending: Callable[[str], bool] = lambda _session: False
    session_removed: Callable[[str], bool] = lambda _session: False


type CodeToolDefinitions = Callable[
    [list[McpOffer], RunOptions, list[PluginOffer]], list[dict[str, object]]
]
type ResolveModelCall = Callable[[str, ToolCall, str, str], ToolCall]
