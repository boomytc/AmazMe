"""Python form of Pi's extension factory and tool/command registration API."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel

from .contracts import PluginResult, PluginTool

__all__ = ["ExtensionAPI", "ExtensionContext", "PluginResult", "ToolDefinition"]

Params = TypeVar('Params', bound=BaseModel)


@dataclass(frozen=True)
class ExtensionContext:
    session_id: str
    workspace: Path
    config: dict[str, str]
    signal: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass(frozen=True)
class ToolDefinition(Generic[Params]):
    name: str
    label: str
    description: str
    parameters: type[Params]
    execute: Callable[[str, Params, ExtensionContext], PluginResult | Awaitable[PluginResult]]


@dataclass(frozen=True)
class RegisteredTool:
    info: PluginTool
    execute: Callable[[str, dict[str, object], ExtensionContext], Awaitable[PluginResult]]


class ExtensionAPI:
    def __init__(self, context: ExtensionContext):
        self.context = context
        self.config = context.config
        self.tools: dict[str, RegisteredTool] = {}
        self.commands: dict[str, RegisteredTool] = {}

    def register_tool(self, tool: ToolDefinition[Params]) -> None:
        self._register(tool, "tool")

    def _register(self, tool: ToolDefinition[Params], kind: Literal["tool", "command"]) -> None:
        registry = self.tools if kind == "tool" else self.commands
        info = PluginTool.model_validate({'name':tool.name, 'label':tool.label, 'description':tool.description,
                                         'parameters':tool.parameters.model_json_schema(), 'kind':kind})
        if info.parameters.get('type') != 'object':
            raise ValueError('Tool parameters must be an object schema')
        if info.name not in registry and len(self.tools) + len(self.commands) >= 64:
            raise ValueError('Plugin tool limit exceeded')

        async def execute(call_id: str, arguments: dict[str, object], context: ExtensionContext) -> PluginResult:
            params = tool.parameters.model_validate(arguments, strict=True)
            if inspect.iscoroutinefunction(tool.execute):
                result = tool.execute(call_id, params, context)
            else:
                result = await asyncio.to_thread(tool.execute, call_id, params, context)
            return await result if inspect.isawaitable(result) else result
        registry[info.name] = RegisteredTool(info, execute)

    def register_command(self, name: str, *, description: str,
                         handler: Callable[[str, ExtensionContext], PluginResult | Awaitable[PluginResult]]) -> None:
        class Arguments(BaseModel):
            arguments: str = ''

        def execute(_call_id: str, params: Arguments, context: ExtensionContext) -> PluginResult | Awaitable[PluginResult]:
            return handler(params.arguments, context)

        self._register(ToolDefinition(name, '/' + name, description, Arguments, execute), "command")
