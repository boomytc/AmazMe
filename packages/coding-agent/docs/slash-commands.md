# Slash commands

Type `/` in AmazMe's terminal editor to see the commands available in the current session. Native plugins, prompt templates and enabled skill commands can add entries. Each client lists commands it can actually reach.

## Default terminal

The default terminal runs on Durable. Its local commands are:

| Command | Behavior |
|---|---|
| `/model [provider/model]` | Select a model; open the selector when omitted |
| `/thinking [level]` | Select a supported reasoning level; open the selector when omitted |
| `/scoped_models` | Choose the models shown in `/model` and used by model cycling |
| `/login [provider]`, `/logout [provider]` | Manage provider credentials |
| `/attachments` | Remove draft image attachments |
| `/mcp` | Manage MCP connections |
| `/tasks` | Show or hide active tasks |
| `/agents`, `/tree` | Select a conversation or its history |
| `/fork` | Fork the focused conversation |
| `/older` | Load older history |
| `/compact [instructions]` | Compact the focused conversation |
| `/plugins` | Inspect selected plugin sources and API; present when plugins are selected |
| `/reload` | Re-read prompt resources and rebuild selected plugins while idle |

The terminal favors commands and shortcuts. `Ctrl+L` opens the model selector and `Shift+Tab` cycles the current model's supported reasoning levels in both terminal clients. The composer shows the current selection and a short key guide; typing `/` discovers the other commands. Configure resource selection through `amazme config` and preferences in the settings files. Start or resume sessions through CLI options; see [CLI](cli.md), [Sessions](sessions.md) and [Keybindings](keybindings.md). `Ctrl+C` exits; `Ctrl+D` exits when the editor is empty.

## Hosted terminal

`amazme client` uses local menus for model/thinking selection, scoped models, authentication and conversation navigation. It uses the worker's shared Commands service for compaction, reload, plugin commands and resource expansion. Its presentation plugins can add local commands and dialogs.

In both terminals, `/scoped_models` reuses the searchable model configuration list. Enter toggles a row, Ctrl+A enables all, Ctrl+X clears all, and Ctrl+S saves the current scope as the default for new sessions. Changes affect the current terminal/session immediately; Esc closes the list. An empty scope stays empty. Hiding the active model changes the list and cycling choices without switching the active model.

## Web and desktop

Web and desktop share the same clickable controls. The composer lists plugin commands, prompt templates and enabled skills. Built-in settings and navigation use these controls:

| Terminal command | Web / desktop entry |
|---|---|
| `/model`, `/thinking` | Model menu in the composer |
| `/scoped_models` | Configure model list in the model menu or Settings |
| `/login`, `/logout` | Accounts in the model menu or Settings |
| `/attachments` | Remove button on each draft attachment thumbnail |
| `/agents` | Session tools → Conversations → Open |
| `/tree` | Session tools → Conversations → Return to; optionally summarize the branch |
| `/fork` | Fork above the conversation or in Session tools → Conversations |
| `/older` | Load older above the transcript |
| `/tasks` | Session tools → Tasks; open a task's conversation or child conversation from its row |
| `/mcp` | Sidebar Plugins → MCP servers; enable, choose exposure, reconnect, sign in, reload or configure a global server only for the attached trusted project |
| `/plugins` | Sidebar Plugins → Plugin packages |
| `/compact` | Compact context above the conversation |
| `/reload` | Reload session resources in Settings |

The sidebar session menu provides rename, delete and copy ID; New session creates and attaches a session. Session switching, fork, history and task navigation operate on the attached session's Conversations service. MCP project settings use that session's trusted project directory.

Templates and enabled `/skill:<name>` entries come from the attached worker's resource loader, so a client in another directory uses the session's selected files. The hosted terminal and Web expand these before submitting through the focused conversation's existing prompt path. Session plugin commands execute through the same command service. The shared built-in commands are `compact` and `reload`; the Web composer directs users to the corresponding controls instead of running them as slash commands.

Use Reload session resources after adding or changing resource files. Skill changes made in the Web management panel also refresh the attached session's command resources. See [Usage](usage.md) for the hosted interfaces.

## SDK interactive mode

`InteractiveMode` exported by the SDK has its own command surface, including JSONL session menus, export/share, settings and extension UI. It is an optional SDK presentation. Its command list does not describe the default Durable terminal or hosted clients. See [SDK](sdk.md) and [SDK extensions](extensions.md).

## Commands added by resources

- Native plugins register commands and argument completions through the existing registry.
- Each selected prompt template uses its template name and expands `$1`/`$ARGUMENTS`.
- Selected skills use `/skill:<name>` when `enableSkillCommands` is enabled.

Resource selection follows project trust, package filters and explicit paths. See [Native plugins](plugin-runtime.md), [Prompt templates](prompt-templates.md) and [Skills](skills.md).
