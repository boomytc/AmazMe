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
| `/changes [file]` | List files changed in the latest turn; with a path, show that file's diff |
| `/limits [calls seconds USD]` | Show or set the shared per-conversation turn budgets: tool calls, elapsed seconds, and reported USD. `0` is unlimited |
| `/resume-run` | Continue a budget-paused turn with another budget |
| `/execution [full-access\|workspace-write\|read-only]` | Show or set the global Unix file-write policy |
| `/agents`, `/tree` | Select a conversation or its history |
| `/fork` | Fork the focused conversation |
| `/older` | Load older history |
| `/compact [instructions]` | Compact the focused conversation |
| `/plugins` | Inspect selected plugin sources and API; present when plugins are selected |
| `/reload` | Re-read prompt resources and rebuild selected plugins while idle |

The terminal favors commands and shortcuts. `Ctrl+L` opens the model selector and `Shift+Tab` cycles the current model's supported reasoning levels in both terminal clients. The composer shows the current selection and a short key guide; typing `/` discovers the other commands. Configure resource selection through `amazme config` and preferences in the settings files. Start or resume sessions through CLI options; see [CLI](cli.md), [Sessions](sessions.md) and [Keybindings](keybindings.md). `Ctrl+C` exits; `Ctrl+D` exits when the editor is empty. Arguments, pauses, and isolation limits for `/changes`, `/limits`, `/resume-run`, and `/execution` are in [Run controls](run-controls.md).

## Hosted terminal

`amazme client` uses local menus for model/thinking selection, scoped models, authentication and conversation navigation. It uses the worker's shared Commands service for compaction, reload, plugin commands and resource expansion. When the session publishes change review, it also accepts `/changes`, `/limits`, `/resume-run`, and `/execution`. Its presentation plugins can add local commands and dialogs.

In both terminals, `/scoped_models` reuses the searchable model configuration list. Enter toggles a row, Ctrl+A enables all, Ctrl+X clears all, and Ctrl+S saves the current scope as the default for new sessions. Changes affect the current terminal/session immediately; Esc closes the list. An empty scope stays empty. Hiding the active model changes the list and cycling choices without switching the active model.

## Web and desktop

Web and desktop share the same clickable controls. The composer lists plugin commands, prompt templates and enabled skills. Built-in settings and navigation use these controls:

| Terminal command | Web / desktop entry |
|---|---|
| `/model`, `/thinking` | Dropdowns beside the send button. Settings → Models and connections has the same dropdowns. The thinking dropdown lists only levels the current model supports and hides when there is no choice. Typing either command is refused |
| `/scoped_models` | Settings → Models and connections → Model list. Typing the command is refused |
| `/login`, `/logout` | Settings → Models and connections → Provider accounts. Typing either command is refused |
| `/changes` | Session tools → Changes. Typing `/changes` opens that tab when change review is available; a file argument is not applied |
| `/limits [calls seconds USD]` | Typing `/limits` only switches to Settings and ignores arguments. Manually choose Conversation to edit budgets |
| `/execution [mode]` | Typing `/execution` only switches to Settings and ignores the mode argument. Manually choose Approvals → File write isolation to change the policy |
| `/resume-run` | Session tools → Changes → Continue with another budget. Typing `/resume-run` continues the paused turn when change review is available |
| `/attachments` | Remove button on each draft attachment thumbnail. Typing the command is refused |
| `/agents` | Session tools → Conversations → Open |
| `/tree` | Session tools → Conversations → Return to; optionally summarize the branch |
| `/fork` | Fork above the conversation or in Session tools → Conversations |
| `/older` | Load older above the transcript |
| `/tasks` | Session tools → Tasks; open a task's conversation or child conversation from its row |
| `/mcp` | Plugins in the navigation rail → MCP servers; enable, choose exposure, reconnect, sign in, reload or configure a global server only for the attached trusted project |
| `/plugins` | Plugins in the navigation rail → Plugin packages |
| `/compact` | Compact context above the conversation. Typing the command is refused |
| `/reload` | Settings → Configuration & diagnostics → Reload session resources. Typing the command is refused |

`/limits` and `/execution` keep the last selected Settings category, or Interface on first use. Neither selects a category or writes settings.

The sidebar session menu provides rename, delete and copy ID; New session creates and attaches a session. Session switching, fork, history and task navigation operate on the attached session's Conversations service. MCP project settings use that session's trusted project directory.

Templates and enabled `/skill:<name>` entries come from the attached worker's resource loader, so a client in another directory uses the session's selected files. The hosted terminal and Web expand these before submitting through the focused conversation's existing prompt path. Session plugin commands execute through the same command service. On the Web page, model, login, session, task, plugin, attachment, compact, and reload names are refused and the page points to the control in the table. `/changes`, `/limits`, `/execution`, and `/resume-run` open that control or continue the paused turn, as the table describes.

Use Reload session resources after adding or changing resource files. Skill changes made in the Web management panel also refresh the attached session's command resources. See [Usage](usage.md) for the hosted interfaces.

## SDK interactive mode

`InteractiveMode` exported by the SDK has its own command surface, including JSONL session menus, export/share, settings and extension UI. It is an optional SDK presentation. Its command list does not describe the default Durable terminal or hosted clients. See [SDK](sdk.md) and [SDK extensions](extensions.md).

## Commands added by resources

- Native plugins register commands and argument completions through the existing registry.
- Each selected prompt template uses its template name and expands `$1`/`$ARGUMENTS`.
- Selected skills use `/skill:<name>` when `enableSkillCommands` is enabled.

Resource selection follows project trust, package filters and explicit paths. See [Native plugins](plugin-runtime.md), [Prompt templates](prompt-templates.md) and [Skills](skills.md).
