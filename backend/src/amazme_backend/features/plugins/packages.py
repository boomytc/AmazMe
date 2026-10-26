"""Configured Python entry paths; runtime instances remain owned by their original sessions."""

import hashlib


def plugin_identity(package_id: str, session: str) -> str:
    return hashlib.sha256(f"package:{package_id}:{session}".encode()).hexdigest()[:32]
