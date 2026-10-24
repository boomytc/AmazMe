"""Load a pinned Python extension in the registered native service process."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import inspect
import os
import sys
from pathlib import Path
from typing import Literal

from pydantic import Field, JsonValue

from .contracts import Model, PluginReply
from .plugin_api import ExtensionAPI, ExtensionContext

LIMIT = 8 * 1024 * 1024


class Permit(Model):
    session_id: str
    workspace: str
    entry: str
    digest: str
    config: dict[str, str]


class Request(Model):
    op: Literal['call', 'cancel', 'close']
    kind: Literal['tool', 'command'] = 'tool'
    call_id: str = ''
    name: str = ''
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    workspace: str = ''
    session_id: str = ''


async def run() -> int:
    output = sys.stdout
    # Plugin prints are diagnostics, not protocol responses.
    sys.stdout = sys.stderr

    def send(reply: PluginReply) -> None:
        raw = reply.model_dump_json()
        if len(raw.encode()) > LIMIT:
            raise ValueError('plugin_output_limit')
        output.write(raw + '\n')
        output.flush()

    def line() -> bytes:
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        if len(raw) > LIMIT or (raw and not raw.endswith(b'\n')):
            raise ValueError('plugin_protocol_limit')
        return raw

    try:
        permit = Permit.model_validate_json(await asyncio.to_thread(line))
        entry = Path(permit.entry)
        with entry.open("rb") as stream:
            source = stream.read(1024 * 1024 + 1)
        if len(source) > 1024 * 1024:
            raise ValueError("plugin_source_limit")
        if hashlib.sha256(source).hexdigest() != permit.digest:
            raise ValueError('plugin_source_changed')
        if not permit.session_id or not os.path.isabs(permit.workspace):
            raise ValueError("plugin_context_required")
        os.chdir(permit.workspace)
        spec = importlib.util.spec_from_file_location('amazme_user_plugin', entry)
        if spec is None or spec.loader is None:
            raise ValueError('plugin_entry_invalid')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        # Execute the bytes that were hashed, even if the source path changes afterward.
        exec(compile(source, str(entry), 'exec'), module.__dict__)
        setup = getattr(module, 'setup', None)
        if not callable(setup):
            raise ValueError('Plugin must export setup(api)')
        api = ExtensionAPI(ExtensionContext(permit.session_id, Path(permit.workspace), permit.config))
        loaded = setup(api)
        if inspect.isawaitable(loaded):
            await loaded
        send(PluginReply(phase='ready', tools=[tool.info for tool in [*api.tools.values(), *api.commands.values()]]))
    except Exception as error:
        send(PluginReply(phase='failed', error=str(error)[:500]))
        return 1

    current: asyncio.Task[None] | None = None
    context: ExtensionContext | None = None
    current_id = ''

    async def invoke(request: Request, ctx: ExtensionContext) -> None:
        try:
            tool = (api.tools if request.kind == "tool" else api.commands)[request.name]
            # Validation happens in the registered API closure before user execution.
            result = await tool.execute(request.call_id, dict(request.arguments), ctx)
            send(PluginReply(phase='done', call_id=request.call_id, result=result))
        except Exception as error:
            send(PluginReply(phase='failed', call_id=request.call_id, error=str(error)[:500]))

    try:
        while raw := await asyncio.to_thread(line):
            request = Request.model_validate_json(raw)
            if request.op == 'close':
                return 0
            if request.op == 'cancel':
                if context is not None and request.call_id == current_id:
                    context.signal.set()
                continue
            if current is not None and not current.done():
                raise ValueError('plugin_busy')
            if request.workspace != permit.workspace or request.session_id != permit.session_id or not request.call_id:
                raise ValueError('plugin_context_required')
            context = ExtensionContext(permit.session_id, Path(permit.workspace), permit.config)
            current_id = request.call_id
            current = asyncio.create_task(invoke(request, context))
    finally:
        if context is not None:
            context.signal.set()
        if current is not None:
            current.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await current
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == '__main__':
    raise SystemExit(main())
