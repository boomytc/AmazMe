"""Cold, journaled relocation of one complete profile; never merges two business stores."""
import argparse
import fcntl
import json
import os
import secrets
import shutil
import sqlite3
import sys
import time
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Literal, cast

import httpx
import psutil
from pydantic import JsonValue

from amazme_backend.bootstrap.local import startup_lock
from amazme_backend.contracts.identity import HostReady, Identity
from amazme_backend.contracts.profiles import ProfileConfig
from amazme_backend.platform.private_files import lock, private_write
from amazme_backend.profiles.locations import local_profile
from amazme_backend.profiles.profile import live_host_ready
from amazme_backend.shared.errors import BackendError
from amazme_backend.shared.model import Model


class _Journal(Model):
    source: str
    target: str
    stage: str
    backup: str
    profile_id: str
    phase: Literal["planned", "staged", "archived", "activated"]


_HUMAN_FIELDS = {"text", "content", "title", "message", "output", "command", "source", "api_key",
                 "key", "access_token", "refresh_token", "digest"}
_PATH_COLUMNS = {"directory", "lease", "log_workspace", "entry", "info", "payload", "result", "record"}


def _config(path: Path) -> ProfileConfig:
    return ProfileConfig.model_validate_json((path / "config.json").read_bytes())


def _database(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)


def _counts(path: Path) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {}
    for database in sorted(path.rglob("*.sqlite")):
        if database.is_symlink():
            raise BackendError("migration_external_database")
        with closing(_database(database)) as db:
            names = [str(row[0]) for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            result[str(database.relative_to(path))] = {
                name: int(db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0])
                for name in names}
    return result


def _blank(path: Path) -> bool:
    if not path.exists():
        return True
    config = _config(path)
    if config.account_profile or config.provider.api_key.get_secret_value() or (config.provider.provider, config.provider.model) != ("faux", "faux"):
        return False
    account_file = path / "accounts.json"
    if account_file.exists():
        accounts = json.loads(account_file.read_bytes())
        if any(provider != "faux" or transport.get("proxy") or transport.get("headers") for provider, transport in accounts.get("transports", {}).items()):
            return False
        if any(accounts.get(key) for key in ("credentials", "logins", "uncertain_refresh", "configuration_receipts")):
            return False
    if (path / "mcp-auth").exists() and any((path / "mcp-auth").iterdir()):
        return False
    host_business = {"deliveries", "updates", "memories", "file_checkpoints", "file_write_preparations",
                     "schedules", "schedule_runs", "automations", "projects", "project_sessions", "product_settings",
                     "feedback", "answer_feedback", "shares", "session_models", "mcp_configuration", "mcp_logins",
                     "plugin_packages", "workspace_grants", "provider_checks", "session_removals"}
    session_metadata = {"metadata", "batches"}
    execution_runtime = {"control", "workers", "epochs", "budgets", "thaws"}
    for database, tables in _counts(path).items():
        if not isinstance(tables, dict):
            raise BackendError("migration_invalid_counts")
        for table, count in tables.items():
            if not count:
                continue
            if database == "host.sqlite" and table not in host_business:
                continue
            if database == "execution.sqlite" and table in execution_runtime:
                continue
            if database.startswith("sessions/") and table in session_metadata:
                continue
            return False
    # Unknown attached files are never silently discarded as an empty profile.
    allowed = {"config.json", "accounts.json", "control.token", "web.token", "host.sqlite", "execution.sqlite",
               "sessions", "processes", "initialized", "execution.initialized", "ready.json"}
    return all(item.name in allowed or item.name.endswith((".lock", ".log", ".err", "-wal", "-shm"))
               for item in path.iterdir())


def _running(path: Path) -> bool:
    if not path.exists():
        return False
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            if process.pid == os.getpid():
                continue
            arguments = process.cmdline()
            for index, argument in enumerate(arguments[:-1]):
                if argument not in {"--profile", "--source-profile"} or Path(arguments[index + 1]).resolve() != path:
                    continue
                if any(mode in arguments[:index] for mode in ("serve", "supervisor", "worker", "execute", "service-runner")):
                    return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    for item in [path / "host.lock", path / "supervisor.lock", *sorted((path / "processes").glob("*.lock")),
                 *sorted((path / "sessions").glob("*/writer.lock")), path / "accounts.lock"]:
        if not item.exists():
            continue
        fd = os.open(item, os.O_RDWR | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
        finally:
            os.close(fd)
    return False


def _stop(path: Path) -> None:
    if not _running(path):
        return
    ready = HostReady.model_validate_json((path / "ready.json").read_bytes())
    if ready.profile_id != _config(path).profile_id:
        raise BackendError("migration_host_identity_mismatch")
    with httpx.Client(timeout=180, trust_env=False) as client:
        identity = client.get(ready.url + "/api/v1/bootstrap",
                              headers={"Authorization": "Bearer " + (path / "web.token").read_text().strip()})
        if not identity.is_success:
            raise BackendError("migration_host_identity_mismatch")
        ready = live_host_ready(_config(path).profile_id, ready, Identity.model_validate_json(identity.content))
        response = client.post(ready.url + "/control/shutdown",
                               headers={"Authorization": "Bearer " + (path / "control.token").read_text().strip()},
                               json={"host_epoch": ready.host_epoch, "build_id": ready.build_id})
        if not response.is_success:
            raise BackendError("migration_shutdown_failed")
    deadline = time.monotonic() + 180
    while _running(path):
        if time.monotonic() >= deadline:
            raise BackendError("migration_process_exit_unproven")
        time.sleep(0.1)


def _settled(path: Path) -> None:
    database = path / "execution.sqlite"
    if database.exists():
        with closing(_database(database)) as db:
            queries = (
                "SELECT 1 FROM scopes WHERE phase!='result' OR clean!=1 OR outcome IN ('pending','unknown') LIMIT 1",
                "SELECT 1 FROM terminals WHERE phase!='exited' LIMIT 1",
                "SELECT 1 FROM mcp_servers WHERE clean=0 LIMIT 1",
                "SELECT 1 FROM mcp_calls WHERE phase NOT IN ('done','denied') LIMIT 1",
                "SELECT 1 FROM plugin_calls WHERE phase NOT IN ('done','denied','failed') LIMIT 1",
                "SELECT 1 FROM code_runs WHERE phase NOT IN ('success','failed','cancelled') LIMIT 1",
                "SELECT 1 FROM remote_calls WHERE phase NOT IN ('done','failed') LIMIT 1",
            )
            if any(db.execute(query).fetchone() for query in queries):
                raise BackendError("migration_unsettled_execution")
    database = path / "host.sqlite"
    if database.exists():
        with closing(_database(database)) as db:
            if db.execute("SELECT 1 FROM deliveries WHERE state NOT IN ('delivered','failed','cancelled') LIMIT 1").fetchone():
                raise BackendError("migration_unsettled_delivery")
            if db.execute("SELECT 1 FROM control WHERE freeze_id!='' LIMIT 1").fetchone():
                raise BackendError("migration_update_active")


def _rebase(value: JsonValue, source: Path, target: Path, stage: Path, key: str = "") -> JsonValue:
    if key in _HUMAN_FIELDS:
        return value
    if isinstance(value, str):
        before = str(source)
        return str(target) + value[len(before):] if value == before or value.startswith(before + "/") else value
    if isinstance(value, list):
        return [_rebase(item, source, target, stage, key) for item in value]
    if isinstance(value, dict):
        result = {name: _rebase(item, source, target, stage, name) for name, item in value.items()}
        # A copied kernel lease is historical, but its identity must still name the copied inode.
        if {"profile_path", "path", "device", "inode", "instance_id", "role"}.issubset(result):
            lease_path = result["path"]
            if isinstance(lease_path, str) and lease_path.startswith(str(target) + "/"):
                info = (stage / Path(lease_path).relative_to(target)).stat()
                result["device"], result["inode"] = info.st_dev, info.st_ino
        return result
    return value


def _rewrite(text: str, source: Path, target: Path, stage: Path) -> str:
    try:
        original = cast(JsonValue, json.loads(text))
    except ValueError:
        return cast(str, _rebase(text, source, target, stage))
    revised = _rebase(original, source, target, stage)
    return json.dumps(revised, ensure_ascii=False) if revised != original else text


def _snapshot(source: Path, stage: Path, target: Path) -> None:
    shutil.copytree(source, stage, symlinks=True)
    # Rebase leases before SQL references, so every copy has the same final inode identity.
    for path in (stage / "processes").glob("*.lock"):
        private_write(path, _rewrite(path.read_text(), source, target, stage))
    # private_write replaces the inode: a second pass binds records to the final lease inodes.
    for path in (stage / "processes").glob("*.lock"):
        text = _rewrite(path.read_text(), target, target, stage)
        with path.open("w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    for database in sorted(source.rglob("*.sqlite")):
        relative = database.relative_to(source)
        if not ((database.parent == source and database.name in {"host.sqlite", "execution.sqlite"})
                or (relative.parts[0] == "sessions" and database.name == "session.sqlite")):
            continue
        destination = stage / database.relative_to(source)
        for suffix in ("", "-wal", "-shm"):
            Path(str(destination) + suffix).unlink(missing_ok=True)
        with closing(_database(database)) as original, sqlite3.connect(destination) as copied:
            original.backup(copied)
            copied.execute("PRAGMA journal_mode=DELETE")
            tables = [str(row[0]) for row in copied.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                columns = [str(row[1]) for row in copied.execute("PRAGMA table_info(" + quoted + ")")]
                for column in columns:
                    if column not in _PATH_COLUMNS and not (table == "metadata" and column == "value"):
                        continue
                    field = '"' + column.replace('"', '""') + '"'
                    for rowid, text in copied.execute(f"SELECT rowid,{field} FROM {quoted} WHERE instr({field},?)>0", (str(source),)).fetchall():
                        if isinstance(text, str):
                            copied.execute(f"UPDATE {quoted} SET {field}=? WHERE rowid=?", (_rewrite(text, source, target, stage), rowid))
            if copied.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackendError("migration_database_integrity")
        destination.chmod(0o600)
    config = json.loads((stage / "config.json").read_bytes())
    config.pop("resources", None)
    private_write(stage / "config.json", json.dumps(config))
    for path in (stage / "executions").rglob("*.json"):
        if path.is_file() and not path.is_symlink() and path.name in {"runner.json", "tracked.json", "result.json"}:
            revised = _rewrite(path.read_text(), source, target, stage)
            private_write(path, revised)
    for path in stage.rglob("*"):
        if path.is_symlink():
            link = os.readlink(path)
            revised = cast(str, _rebase(link, source, target, stage))
            if link != revised:
                path.unlink()
                path.symlink_to(revised)
    (stage / "ready.json").unlink(missing_ok=True)
    for name in ("host.lock", "supervisor.lock"):
        (stage / name).unlink(missing_ok=True)
    if _counts(source) != _counts(stage):
        raise BackendError("migration_record_count_mismatch")
    for path in stage.rglob("*"):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    for directory in sorted((p for p in stage.rglob("*") if p.is_dir() and not p.is_symlink()), key=lambda p: len(p.parts), reverse=True):
        _sync(directory)
    _sync(stage)


def _sync(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def migrate_profile(source: Path, target: Path, *, apply: bool = False, stop: bool = False) -> dict[str, JsonValue]:
    source, target = source.expanduser().resolve(), target.expanduser().resolve()
    if source == target or source in target.parents or target in source.parents:
        raise BackendError("migration_paths_overlap")
    journal = target.parent / ".profile-migration.json"
    with startup_lock(target), ExitStack() as held:
        if journal.exists():
            if not apply:
                raise BackendError("migration_recovery_required")
            record = _Journal.model_validate_json(journal.read_bytes())
            if record.source != str(source) or record.target != str(target):
                raise BackendError("migration_journal_mismatch")
            backup, stage = Path(record.backup), Path(record.stage)
            if (stage.parent != target.parent or not stage.name.startswith(".profile-stage-")
                    or backup.parent != target.parent or not backup.name.startswith(".profile-retired-")):
                raise BackendError("migration_journal_paths")
            if (target / "config.json").exists() and _config(target).profile_id == record.profile_id:
                # Activation may have admitted new writes after a crash. Never restore an older snapshot.
                if backup.exists():
                    shutil.rmtree(backup)
                journal.unlink()
                _sync(target.parent)
                return {"status": "migrated", "target": str(target)}
            if (backup / "source").exists():
                if source.exists():
                    if any(path.name != "MIGRATED.json" for path in source.iterdir()):
                        raise BackendError("migration_source_changed")
                    shutil.rmtree(source)
                (backup / "source" / "RETIRED.json").unlink(missing_ok=True)
                (backup / "source").rename(source)
            if (backup / "target").exists():
                if target.exists():
                    raise BackendError("migration_target_changed")
                (backup / "target" / "RETIRED.json").unlink(missing_ok=True)
                (backup / "target").rename(target)
            if stage.exists():
                shutil.rmtree(stage)
            if backup.exists():
                shutil.rmtree(backup)
            journal.unlink()
        if (source / "MIGRATED.json").exists():
            previous = json.loads((source / "MIGRATED.json").read_bytes())
            if previous["target"] != str(target) or not (target / "config.json").exists():
                raise BackendError("migration_target_changed")
            if apply:
                private_write(source / "MIGRATED.json", json.dumps({"target": str(target)}))
            return {"status": "migrated", "source": str(source), "target": str(target)}
        original = _config(source)
        if original.account_profile:
            raise BackendError("migration_linked_vault_unsupported")
        if not _blank(target):
            raise BackendError("migration_target_has_data")
        result: dict[str, JsonValue] = {"source": str(source), "target": str(target), "profile_id": original.profile_id,
                                        "counts": _counts(source), "status": "ready"}
        if not apply:
            result["running"] = _running(source) or _running(target)
            return result
        if stop:
            _stop(source)
            _stop(target)
        if _running(source) or _running(target):
            raise BackendError("migration_processes_active")
        for root in (source, target):
            if not root.exists():
                continue
            for item in [root / "host.lock", root / "supervisor.lock", root / "accounts.lock",
                         *sorted((root / "processes").glob("*.lock")), *sorted((root / "sessions").glob("*/writer.lock"))]:
                held.enter_context(lock(item))
            _settled(root)
        # Recheck under all writer/credential/process locks after draining.
        if not _blank(target):
            raise BackendError("migration_target_has_data")
        backup = target.parent / (".profile-retired-" + secrets.token_hex(8))
        backup.mkdir(parents=True, mode=0o700)
        stage = target.parent / (".profile-stage-" + secrets.token_hex(8))
        record = _Journal(source=str(source), target=str(target), stage=str(stage), backup=str(backup),
                          profile_id=original.profile_id, phase="planned")
        private_write(journal, record.model_dump_json())
        _snapshot(source, stage, target)
        record.phase = "staged"
        private_write(journal, record.model_dump_json())
        source.rename(backup / "source")
        private_write(backup / "source" / "RETIRED.json", json.dumps({"target": str(target)}))
        source.mkdir(mode=0o700)
        private_write(source / "MIGRATED.json", json.dumps({"target": str(target)}))
        _sync(source.parent)
        _sync(backup)
        if target.exists():
            target.rename(backup / "target")
            private_write(backup / "target" / "RETIRED.json", json.dumps({"target": str(target)}))
        _sync(backup)
        record.phase = "archived"
        private_write(journal, record.model_dump_json())
        stage.rename(target)
        _sync(target.parent)
        record.phase = "activated"
        private_write(journal, record.model_dump_json())
        shutil.rmtree(backup)
        journal.unlink()
        _sync(target.parent)
        result["status"] = "migrated"
        return result


def main(arguments: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="amazme-backend migrate-profile")
    parser.add_argument("--source-profile", type=Path, required=True)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args(arguments)
    os.umask(0o077)
    try:
        result = migrate_profile(args.source_profile, local_profile(args.profile), apply=args.apply, stop=args.stop)
    except (BackendError, OSError, ValueError, sqlite3.Error, httpx.HTTPError) as exc:
        code = exc.code if isinstance(exc, BackendError) else "migration_failed"
        print(json.dumps({"code": code}), file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result))
