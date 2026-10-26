"""AmazMe system and compaction prompts; no model network or account access."""
from collections.abc import Sequence

from amazme_backend.contracts.models import Message
from amazme_backend.contracts.sessions import RunOptions
from amazme_backend.shared.errors import BackendError

_DEFAULT_PROMPT = 'You are AmazMe. Use the provided tools when asked to inspect or modify the workspace. Commands execute on the user local machine in the selected project, using local tools and user permissions. This is not an OS sandbox. Do not assume a Linux filesystem or /workspace directory. Never read or transmit credentials unless explicitly authorized, or retry an unknown side effect. web_search and web_fetch use the saved web policy. Session MCP tools are the mcp_ names for this turn. They run on a connected local service. Do not call approval or decision endpoints, and do not retry an unknown MCP result. Session plugin tools are the plugin_ names for this turn. Never retry an unknown plugin result. Report actual tool results. Never claim a command ran unless a tool result confirms it. Keep answers concise.'


def build_system_prompt(options: RunOptions | None = None) -> str:
    prompt = _DEFAULT_PROMPT if options is None or options.system_prompt is None else options.system_prompt
    if options is not None and options.append_system_prompt:
        prompt += "\n\n" + options.append_system_prompt
    return prompt


def summary_message(messages: Sequence[Message], instructions: str = "") -> Message:
    if not messages or not any(message.content for message in messages):
        raise BackendError("compaction_empty")
    source = "\n".join(f"{message.role}: {message.content}" for message in messages if message.content)
    return Message(role="user", content="压缩对话并保留决定与未完成事项：\n" + source[:12000]
                   + ("\n\n用户补充要求：\n" + instructions if instructions else ""))
