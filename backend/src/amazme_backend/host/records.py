from typing import Literal

from amazme_backend.contracts.execution import ServiceInfo
from amazme_backend.contracts.profiles import ProviderConfig
from amazme_backend.contracts.sessions import Receipt
from amazme_backend.shared.model import Model


class Delivery(Model):
    delivery_id: str
    session_id: str
    kind: Literal["submit", "cancel", "approval", "resolve"]
    payload: str
    provider: ProviderConfig | None = None
    state: Literal["pending", "delivered", "rejected"]
    receipt: Receipt | None = None
    error_code: str = ""
    error_status: int = 0


ServiceRecord = ServiceInfo
