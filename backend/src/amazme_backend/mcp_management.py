"""MCP configuration and reconnect receipts. Processes remain in the existing supervisor."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

from .contracts import (
    BackendError,
    McpConfigPatch,
    McpConfiguration,
    McpConfiguredServer,
    McpConfigWrite,
    McpExposure,
    McpLaunch,
    McpStdioSettings,
)


@dataclass(frozen=True)
class Configured:
    config_id: str
    launch_id: str
    name: str
    settings: McpStdioSettings
    overridden: bool


def effective(db: sqlite3.Connection, workspace: str) -> list[Configured]:
    result: list[Configured] = []
    for row in db.execute("SELECT id,name,launch,payload FROM mcp_configuration WHERE workspace='' ORDER BY name"):
        settings = McpStdioSettings.model_validate_json(str(row[3]))
        patch = db.execute("SELECT payload,launch FROM mcp_configuration WHERE name=? AND workspace=?", (str(row[1]), workspace)).fetchone()
        if patch is not None:
            settings = McpStdioSettings.model_validate({**settings.model_dump(by_alias=True), **json.loads(str(patch[0]))})
        launch_id = str(row[2])
        if patch is not None and patch[1]:
            launch_id = hashlib.sha256(f"{launch_id}:{patch[1]}".encode()).hexdigest()[:32]
        result.append(Configured(config_id=str(row[0]), name=str(row[1]), launch_id=launch_id, settings=settings, overridden=patch is not None))
    return result


def listing(db: sqlite3.Connection, workspace: str, path: Path) -> McpConfiguration:
    revision = int(db.execute("SELECT revision FROM mcp_config_revision WHERE id=1").fetchone()[0])
    return McpConfiguration(revision=revision, workspace=workspace, path=str(path), servers=[McpConfiguredServer(
        config_id=item.config_id, launch_id=item.launch_id, name=item.name, detail=shlex.join([item.settings.command, *item.settings.args]),
        scope="global", overridden=item.overridden, enabled=item.settings.enabled, exposure=item.settings.exposure)
        for item in effective(db, workspace)])


def change(db: sqlite3.Connection, value: McpConfigWrite | McpConfigPatch, workspace: str, path: Path) -> McpConfiguration:
    body = value.model_dump_json(by_alias=True)
    digest = hashlib.sha256(json.dumps([workspace, body]).encode()).hexdigest()
    previous = db.execute("SELECT digest,result FROM mcp_config_changes WHERE id=?", (value.operation_id,)).fetchone()
    if previous is not None:
        if str(previous[0]) != digest:
            raise BackendError("mcp_config_operation_conflict")
        return McpConfiguration.model_validate_json(str(previous[1]))
    if db.execute("SELECT freeze_id FROM control WHERE id=1").fetchone()[0]:
        raise BackendError("update_frozen", status=503)
    if listing(db, workspace, path).revision != value.expected_revision:
        raise BackendError("mcp_config_revision")
    row = db.execute("SELECT id,launch,payload FROM mcp_configuration WHERE name=? AND workspace=''", (value.name,)).fetchone()
    if isinstance(value, McpConfigWrite):
        clash = db.execute("SELECT name FROM mcp_configuration WHERE workspace='' AND replace(name,'-','_')=? AND name!=?",
                           (value.name.replace("-", "_"), value.name)).fetchone()
        if clash is not None:
            raise BackendError("mcp_config_namespace_conflict")
        if row is None and len(effective(db, workspace)) >= 8:
            raise BackendError("mcp_config_capacity", status=429)
        config_id = str(row[0]) if row else value.operation_id
        db.execute("INSERT INTO mcp_configuration(workspace,name,id,launch,payload) VALUES('',?,?,?,?) "
                   "ON CONFLICT(workspace,name) DO UPDATE SET launch=excluded.launch,payload=excluded.payload",
                   (value.name, config_id, value.operation_id, value.entry.model_dump_json(by_alias=True)))
    else:
        if row is None:
            raise BackendError("mcp_config_not_found", status=404)
        scope = workspace if value.scope == "project" else ""
        if value.remove:
            if not scope:
                db.execute("DELETE FROM mcp_configuration WHERE name=?", (value.name,))
            else:
                db.execute("DELETE FROM mcp_configuration WHERE name=? AND workspace=?", (value.name, scope))
        else:
            patch = value.model_dump(include={"enabled", "exposure"}, exclude_none=True)
            if not patch:
                raise BackendError("mcp_config_patch_empty")
            existing = db.execute("SELECT payload,launch FROM mcp_configuration WHERE name=? AND workspace=?", (value.name, scope)).fetchone()
            before: dict[str, JsonValue] = TypeAdapter(dict[str, JsonValue]).validate_json(str(existing[0])) if existing else {}
            data = {**before, **patch}
            was_enabled = before.get("enabled", McpStdioSettings.model_validate_json(str(row[2])).enabled)
            launch_id = value.operation_id if value.enabled is True and not was_enabled else str(existing[1]) if existing else ""
            db.execute("INSERT INTO mcp_configuration(workspace,name,id,launch,payload) VALUES(?,?,?,?,?) "
                       "ON CONFLICT(workspace,name) DO UPDATE SET payload=excluded.payload,launch=excluded.launch",
                       (scope, value.name, str(row[0]), launch_id, json.dumps(data)))
    db.execute("UPDATE mcp_config_revision SET revision=revision+1 WHERE id=1")
    result = listing(db, workspace, path)
    db.execute("INSERT INTO mcp_config_changes(id,digest,result) VALUES(?,?,?)", (value.operation_id, digest, result.model_dump_json()))
    return result


def server_id(item: Configured, session: str, reconnect: str = "") -> str:
    return hashlib.sha256(f"mcp-config:{item.config_id}:{item.launch_id}:{session}:{reconnect}".encode()).hexdigest()[:32]


def launch(item: Configured, workspace: str) -> McpLaunch:
    def template(value: str) -> str:
        def substitute(match: re.Match[str]) -> str:
            if match[0] in {"$$", "$!"}:
                return match[0][1:]
            name = match[1] or match[2]
            content = os.environ.get(name)
            if not content:
                raise BackendError("mcp_env_missing", name)
            return content
        return re.sub(r"\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", substitute, value)
    environment = {key: template(value) for key, value in item.settings.env.items() if not value.startswith("!")}
    commands = {key: value[1:] for key, value in item.settings.env.items() if value.startswith("!")}
    return McpLaunch(command=shlex.join([os.path.expanduser(item.settings.command), *(os.path.expanduser(arg) for arg in item.settings.args)]), workspace=workspace,
                     cwd=item.settings.cwd, environment=environment, environment_commands=commands, timeout_seconds=item.settings.timeout, managed_id=item.config_id, name=item.name)


def current_server(db: sqlite3.Connection, item: Configured, session: str) -> str:
    row = db.execute("SELECT server FROM mcp_reconnects WHERE session=? AND name=? AND launch=? ORDER BY rowid DESC LIMIT 1",
                     (session, item.name, item.launch_id)).fetchone()
    return str(row[0]) if row else server_id(item, session)


def policy(profile: Path, session: str, config_id: str, server: str) -> McpStdioSettings | None:
    if not config_id:
        return None
    db = sqlite3.connect((profile / "host.sqlite").resolve().as_uri() + "?mode=ro", uri=True)
    try:
        row = db.execute("SELECT workspace FROM sessions WHERE id=?", (session,)).fetchone()
        if row is None:
            return None
        item = next((item for item in effective(db, str(row[0])) if item.config_id == config_id), None)
        if item is None or current_server(db, item, session) != server:
            return None
        return item.settings
    finally:
        db.close()


def exposure(default: McpExposure, overrides: dict[str, McpExposure], name: str) -> McpExposure:
    if name in overrides:
        return overrides[name]
    for pattern, value in overrides.items():
        if "*" in pattern and re.fullmatch(re.escape(pattern).replace(r"\*", ".*"), name):
            return value
    return default
