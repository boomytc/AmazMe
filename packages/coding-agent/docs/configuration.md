# Configuration

AmazMe supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.amazme/agent`. Project configuration lives in `.amazme` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which AmazMe reads before resolving trust so it can locate sessions.

Edit the configuration files or use the Web settings panel. In the default terminal, `/reload` re-reads prompt resources and settings while idle and rebuilds selected plugins. Startup defaults do not overwrite an existing conversation’s saved model or tool selection. Restart after changing keybindings, selected plugin sources or terminal settings. SDK applications can provide their own settings UI.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `AMAZME_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and AmazMe package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/mcp.json` | [MCP servers](mcp.md) available in every project. |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces the default system-prompt prefix; context and skills remain. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to AmazMe’s system prompt. |
| `<agent-dir>/extensions/` | User [native plugins](plugin-runtime.md) for the default terminal; [SDK extensions](extensions.md) use their own entry point. |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) for native, hosted and SDK commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |

## Project `.amazme` directory

| Path | Responsibility |
|---|---|
| `.amazme/settings.json` | Project-level [settings](settings.md), resource paths, and AmazMe package declarations. |
| `.amazme/mcp.json` | Project [MCP servers](mcp.md). |
| `.amazme/SYSTEM.md` | Replaces the system-prompt prefix for the trusted project. |
| `.amazme/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.amazme/extensions/` | Project native plugins or SDK extensions, selected by the application entry point. |
| `.amazme/skills/` | Project skills and supporting files. |
| `.amazme/prompts/` | Project prompt templates for native, hosted and SDK commands. |
| `.amazme/themes/` | Project theme files. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

## Context files

Context files are separate from project `.amazme` configuration. AmazMe loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever AmazMe runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust. The default terminal supports `--no-context-files` to disable it. `--no-skills` disables configured and discovered skills, while explicit `--skill` paths remain available. `--system-prompt` and repeated `--append-system-prompt` sources override automatic system-file discovery for the current process; relative file paths resolve against the working directory.
