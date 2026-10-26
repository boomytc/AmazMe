from pathlib import Path

from amazme_backend.contracts.mcp import McpServerSettings
from amazme_backend.host.persistence import mcp, metadata

"Read-only Host metadata capabilities for explicitly composed consumers."


class HostQueries:
    def __init__(self, profile: Path):
        self.profile = profile

    def session_workspace(self, session: str, *, active: bool = False) -> str:
        return metadata.session_workspace(self.profile, session, active=active)

    def workspace_grants(self) -> list[tuple[str, str]]:
        return metadata.load_grants(self.profile)

    def memory_rows(self) -> list[tuple[str, str, str]]:
        return metadata.load_memory_rows(self.profile)

    def mcp_policy(self, session: str, config_id: str, server: str) -> McpServerSettings | None:
        return mcp.policy(self.profile, session, config_id, server)

    def branch_pending(self, session: str) -> bool:
        return metadata.branch_pending(self.profile, session)
