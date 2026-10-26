import sqlite3
from collections.abc import Callable
from typing import Protocol

from amazme_backend.host.persistence.database import HostDatabase

"The sole Host transaction executor, shared by private query modules."


class PersistenceOwner(Protocol):
    db: HostDatabase

    async def call[T](self, operation: Callable[[sqlite3.Connection], T]) -> T: ...

    async def transaction[T](self, operation: Callable[[sqlite3.Connection], T]) -> T: ...
