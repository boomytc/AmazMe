"""Register this file using Client.register_plugin(PluginDraft(..., entry=absolute_path))."""
from pydantic import BaseModel

from amazme_backend.plugin_api import (
    ExtensionAPI,
    ExtensionContext,
    PluginResult,
    ToolDefinition,
)


class Greeting(BaseModel):
    name: str


def setup(api: ExtensionAPI) -> None:
    def greet(call_id: str, params: Greeting, context: ExtensionContext) -> PluginResult:
        return PluginResult(content=[{'type': 'text', 'text': f'Hello, {params.name}!'}])
    api.register_tool(ToolDefinition('hello', 'Greeting', 'Greet a name', Greeting, greet))
