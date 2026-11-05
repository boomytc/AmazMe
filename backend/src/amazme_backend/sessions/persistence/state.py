"""The original session configuration and injected capabilities; durable state stays in SQLite."""
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from amazme_backend.contracts.models import CatalogModel
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.resources import ResourceOptions
from amazme_backend.contracts.sessions import ApprovalPolicy

type ResourceExpander = Callable[[str, ResourceOptions], tuple[str, str]]
type SecretSource = Callable[[], Sequence[str]]

@dataclass
class SessionContext:
    session_id: str
    config: ProviderConfig
    approval_policy: ApprovalPolicy
    workspace: str
    instance: str
    catalog: Mapping[tuple[str, str], CatalogModel]
    expand_resources: ResourceExpander | None
    secrets: SecretSource
