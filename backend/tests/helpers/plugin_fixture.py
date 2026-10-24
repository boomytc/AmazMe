import os
import time

from pydantic import BaseModel

from amazme_backend.contracts import PluginResult
from amazme_backend.plugin_api import ToolDefinition


class Greeting(BaseModel):
    name: str
    mode: str = ''

def setup(api):
    count = 0
    def greet(call_id, params, ctx):
        nonlocal count
        count += 1
        with (ctx.workspace / 'effects.txt').open('a') as f:
            f.write(call_id + ':' + params.name + '\n')
        if params.mode == 'crash':
            os._exit(7)
        if params.mode == 'wait':
            time.sleep(30)
        text = 'Hello, ' + params.name + '!'
        content = [{'type':'text','text':text}]
        if params.mode == 'image':
            content.append({'type':'image','mimeType':'image/png','data':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='})
        return PluginResult(content=content, details={'count':count, 'session':ctx.session_id,
            'secret_inherited':'OPENAI_API_KEY' in os.environ or 'AMAZME_CONTROL_TOKEN' in os.environ})
    api.register_tool(ToolDefinition('hello', 'Greeting', 'Greet a name', Greeting, greet))
    api.register_command('hello', description='Say hello', handler=lambda args,ctx:PluginResult(content=[{'type':'text','text':args}]))
