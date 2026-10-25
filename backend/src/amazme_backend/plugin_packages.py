"""Configured Python entry paths; runtime instances remain owned by their original sessions."""

import hashlib
import sqlite3

from .contracts import BackendError, PluginPackage, PluginPackageAdd, PluginPackages


def plugin_identity(package_id: str, session: str) -> str:
    return hashlib.sha256(f"package:{package_id}:{session}".encode()).hexdigest()[:32]


def listing(db: sqlite3.Connection) -> PluginPackages:
    revision = int(db.execute("SELECT revision FROM plugin_package_revision WHERE id=1").fetchone()[0])
    return PluginPackages(revision=revision, packages=[PluginPackage.model_validate({"package_id": str(row[0]), "entry": str(row[1]), "phase": str(row[2])})
        for row in db.execute("SELECT id,entry,phase FROM plugin_packages WHERE phase!='removed' ORDER BY rowid")])


def check_open(db: sqlite3.Connection) -> None:
    if db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
        raise BackendError("update_frozen", status=503)


def existing(db: sqlite3.Connection, value: PluginPackageAdd) -> PluginPackages | None:
    row = db.execute("SELECT intent FROM plugin_packages WHERE id=?", (value.package_id,)).fetchone()
    if row is None:
        return None
    if str(row[0]) != value.entry:
        raise BackendError("plugin_package_conflict")
    return listing(db)


def add(db: sqlite3.Connection, value: PluginPackageAdd, entry: str) -> PluginPackages:
    check_open(db)
    previous = existing(db, value)
    if previous is not None:
        return previous
    state = listing(db)
    if state.revision != value.expected_revision:
        raise BackendError("plugin_package_revision")
    if any(item.entry == entry and item.phase == "installed" for item in state.packages):
        raise BackendError("plugin_package_duplicate")
    if len(state.packages) >= 32:
        raise BackendError("plugin_package_capacity", status=429)
    db.execute("INSERT INTO plugin_packages(id,entry,intent,phase) VALUES(?,?,?,'installed')", (value.package_id, entry, value.entry))
    db.execute("UPDATE plugin_package_revision SET revision=revision+1 WHERE id=1")
    return listing(db)


def begin_remove(db: sqlite3.Connection, package_id: str, expected_revision: int) -> PluginPackage:
    check_open(db)
    row = db.execute("SELECT entry,phase FROM plugin_packages WHERE id=?", (package_id,)).fetchone()
    if row is None:
        raise BackendError("plugin_package_not_found", status=404)
    value = PluginPackage.model_validate({"package_id": package_id, "entry": str(row[0]), "phase": str(row[1])})
    if value.phase != "installed":
        return value
    if listing(db).revision != expected_revision:
        raise BackendError("plugin_package_revision")
    db.execute("UPDATE plugin_packages SET phase='removing' WHERE id=?", (package_id,))
    db.execute("UPDATE plugin_package_revision SET revision=revision+1 WHERE id=1")
    return value.model_copy(update={"phase": "removing"})


def finish_remove(db: sqlite3.Connection, package_id: str) -> PluginPackages:
    changed = db.execute("UPDATE plugin_packages SET phase='removed' WHERE id=? AND phase='removing'", (package_id,))
    if changed.rowcount:
        db.execute("UPDATE plugin_package_revision SET revision=revision+1 WHERE id=1")
    return listing(db)
