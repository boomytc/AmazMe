from __future__ import annotations

from amazme_backend.shared.model import Model


class ErrorBody(Model):
    code: str
    message: str
    request_id: str = ""
    retryable: bool = False


class BackendError(Exception):
    def __init__(self, code: str, message: str = "", status: int = 409):
        self.code, self.message, self.status = code, message or code, status
        super().__init__(self.message)
