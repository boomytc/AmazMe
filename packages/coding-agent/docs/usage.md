# Use AmazMe in the terminal

Run `amazme` from the directory you want to work in. The default terminal uses a persistent Durable session, configured models and the selected resources. Follow the [Quickstart](quickstart.md) for installation and authentication.

## Enter and direct a task

Type a prompt and press `Enter`. `Shift+Enter` inserts a newline. While work is running, `Enter` steers at the next turn boundary and `Alt+Enter` queues a follow-up after the current work. Custom bindings use `app.message.followUp`.

Press `Esc` to abort the current conversation's work. In a selector, `Esc` closes that selector. `Ctrl+C` exits the terminal; `Ctrl+D` exits when the editor is empty. Closing a persistent session keeps interrupted work recoverable; use `Esc` first when you want an explicit cancellation.

Text paste, path completion and terminal text selection use the shared editor and TUI. CLI `@file` text and images enter the initial prompt; remaining message arguments enter the existing follow-up queue in order. The model can inspect additional files through its selected tools. See [CLI options](cli.md) and [Keybindings](keybindings.md) for the supported invocation and active action names.

Use the configured `app.clipboard.pasteImage` binding to paste clipboard content: macOS defaults to `Cmd+V` with `Ctrl+V` as a fallback, and Linux to `Ctrl+Shift+V` with `Ctrl+V` as a fallback. Copied files keep their paths, an image becomes a draft attachment, and plain text is the final fallback. An empty bracketed-paste notification uses the same reader. A badge shows attached images; `/attachments` removes one or all. `Enter` or the follow-up key can submit an image-only draft. Clipboard images go into the persisted input without an intermediate image file. A read that returns after focus, conversation or terminal ownership changes is discarded.

## Follow execution

The transcript shows prompts, streamed answers, tool arguments, results and failures. `Ctrl+O` expands or collapses tool output. `/tasks` shows or hides the task graph. `/older` pages stored entries into the transcript.

The footer shows the focused conversation, saved title, working directory, context usage, cost and keyboard hints. The editor identifies the selected model and thinking level. Resource counts appear at startup unless `quietStartup` hides them; `--verbose` shows them for the current process. Diagnostics remain visible in quiet mode.

`/changes` reviews the latest turn's file changes; `/limits` configures tool-call, elapsed-time and reported-cost budgets; `/resume-run` grants another budget tranche. `/execution` selects the global file-write policy. See [Run controls](run-controls.md) for arguments, persisted pauses and isolation limits.

## Models, authentication and resources

| Action | Command or key |
|---|---|
| Choose any available model | `/model` or `Ctrl+L` |
| Cycle models forward/backward | `Ctrl+P` / `Shift+Ctrl+P` on Unix |
| Cycle supported thinking levels | `Shift+Tab` |
| Sign in or remove saved credentials | `/login` / `/logout` |
| Manage MCP connections | `/mcp` |
| Remove draft images | `/attachments` |
| Reload resources and selected plugins while idle | `/reload` |
| Inspect selected plugin sources | `/plugins`, when plugins are selected |

`--models` controls startup and cycling; without it, `enabledModels` supplies the saved scope. These operations change the focused conversation without saving global defaults. See [Choose a Model](models.md).

Prompt templates, `/skill:<name>` and selected native plugins contribute commands to the same completion list. Use [Configuration](configuration.md) for resource paths and [Plugin runtime](plugin-runtime.md) to inspect, edit and rebuild native plugin source.

## Continue or branch work

Run `amazme --continue` from the same working directory to reopen the newest native session. `--resume` currently uses this same newest-session selection. `--name` sets its saved title, and `--session-dir` selects the storage root. `--no-session` keeps conversation state in memory for this run.

Use `/tree` or `/agents` to focus a conversation or navigate its stored history. `/fork` forks the current conversation and focuses the fork. `/compact [instructions]` requests a summary. Each branch retains its own model, thinking and tool selection. See [Sessions and Context](sessions.md).

To browse multiple hosted sessions, use `amazme client` or `amazme web`. The default terminal does not expose `/new`, `/resume` picker, `/settings`, direct `!` shell, copy/share or export menus. Those interfaces belong to the optional SDK terminal. Its `/share` destination follows [`sessionShareDestination`](settings.md#interaction): `auto`, `gist`, or `radius`. Plain `dashboard` is prompt text, and unsupported long options are rejected before session storage.

## Use the web client

The installed CLI serves the same durable host to a browser:

```bash
amazme web --port 0
```

It prints the canonical loopback URL, the mode it serves (`installed`, or `source` during development), the WebSocket URL, and the server ID with
`started` when this launch began the server or `already running` when it attached to one, once
the host accepts connections, and it binds loopback only: a connection to another address of this machine is
refused. Open the printed `http://127.0.0.1:<port>/` URL.

A server already running in the server directory under the resolved server ID — one started by
`amazme server`, by an earlier `amazme web`, or by `amazme client` activating one — is reused: the page's
WebSocket endpoint stays this launch's and each page connection is forwarded to that server, so a second web
launch and the terminal client show one session list and one live state. Prompts from either client appear in
the other without a reload; `amazme client <prompt>` needs the conversation to be idle, where the page steers or
queues instead.

The roster lists the Sessions this host owns, plus the terminal sessions of the host's own working
directory, tagged `terminal` on the row. Attaching a terminal session adopts it: the host stores it under the same
id, seeds its transcript from that session's JSONL file (user prompts, replies, and tool results carry over; the
session's model, thinking level, and labels do not), and from then on keeps that file current, so the terminal's own
list shows the same session with everything committed on the host. What a projection cannot carry is counted in the
host's log rather than dropped quietly.

A persistent navigation rail separates chat from management pages. In chat, the sidebar groups sessions by
**Project → Session**, shows each session's age, and marks the attached one. Projects can contain multiple source
folders; the first folder supplies the execution directory for new sessions, while existing sessions retain theirs.
Create a project or edit its folders from the project controls. Click a session to attach it, or use **New session**
or a project's new-session button to create one and return to chat.
The transcript
renders the same durable state the TUI shows: user and assistant blocks, thinking, tool calls with their
results or a "Not run" notice, compaction and reset notices, and an error notice for an answer that failed,
was aborted, or was truncated. A definite image-payload rejection may trigger one request-only retry without images,
within the enabled retry budget. The transcript explicitly warns that the reply could not see them; original
attachments and model capabilities remain unchanged. Authentication and safety rejections never trigger this fallback.
Resize or convert the images, or switch models before asking about their contents again. A turn in flight adds its live status (working, running a tool, retrying,
compacting) as the transcript's last row, and the inputs the session has queued but not started sit as one
strip each above the composer. Assistant answers are formatted: headings, lists, emphasis, links, fenced code
blocks, and pipe tables become elements — a table column that holds only numbers is right-aligned with figures of
one width, so the numbers can be compared down the column — while anything the model writes that looks like markup
stays text. The page's own design is a neutral grey scale with one accent and the primary action in ink, following the
conventions of the Claude, ChatGPT, and Grok chat clients: a centred conversation column, a rounded composer card,
a project-grouped sidebar, and answer actions that show on hover. Its appearance follows the stored preference (see
below), defaulting to the system's light and dark appearance.

The page's language is a stored preference too. With no choice made, a browser asking for Chinese gets Chinese and any
other browser gets English; the host resolves that from the request and serves the document already localized, so the
first paint is not English. Switch it in **Settings → Interface → Language**, or set `locale` in `settings.json` to
`auto`, `zh`, or `en`. The switch and the appearance switch apply without a reload, and both persist for the next load
and for other browsers on the same agent directory. What the page cannot translate is text the host itself writes —
skill loader diagnostics, `mcp.json` validation, settings parse errors — which stays as the host wrote it, and the
TUI's own interface stays English.

Type in the composer and press `Enter` to submit: while the session is idle the text starts a run, and while a
turn is running it queues as the next input. `Shift+Enter` inserts a newline; the draft grows with its content
up to the composer's cap and scrolls after that. The circular action on the right sends the draft. While a turn runs, an outlined `Stop` button sits beside it and
stops the turn, the same as `Ctrl+C`.
Committed entries appear without reloading, and any other attached presentation — a second browser tab or the
client TUI — sees the same committed state. Compact model and thinking dropdowns sit beside the send action.
The model dropdown only lists the session's scoped models, grouped by provider. The thinking dropdown offers
only levels supported by the current model and hides when there is no choice. Changes apply to the current
conversation's next model request.

A draft that starts with `/` opens the work-action palette: plugin commands, prompt templates and skills (`/skill:<name>`). `Tab` completes the highlighted row and `Enter` runs it. Plugins run through `Commands.run`; templates and skills expand through `Commands.expand` and use the page's normal submit path, preserving the focused conversation and Steer/Queue mode. Unknown names are refused without sending them to the model. Changes in **Skills** or **Skills as commands** refresh the catalog; use **Settings → Configuration & diagnostics → Reload session resources** for new files or plugin changes.

Choose models and reasoning with the composer dropdowns or **Settings → Models and connections**. Manage provider accounts in that settings page. The searchable checkbox model list controls the picker and model cycling, without switching a hidden current model. Scope changes apply to this session unless **Use this list by default for new sessions** is checked. Choosing a model or reasoning level changes the current conversation; the defaults action explicitly saves new-session defaults. Session naming, branching, history and compaction have their own click controls.

Failures stay visible: losing the host shows `disconnected: …` in the header within seconds, and a document
served without its boot manifest reports `cannot boot: …` in the header, the roster and the body instead of
rendering an empty shell. A page that lost its host keeps the session it was on and retries the connection with
backoff, saying `disconnected: … — retrying` while it does. When the host answers again, it synchronizes the latest
project and session catalogue before restoring an eligible saved selection. A session newly archived or removed
while disconnected is not automatically attached; one already being viewed in the archive can be restored. An interrupted turn is recovered by the host's own runtime, so the session stays busy until that settles and a
prompt sent in the meantime is refused with the reason rather than queued silently. A document request that arrives before the host runtime exists waits for its manifest
instead of serving an unbootable page. Restarting the host keeps sessions: the same server ID and the durable
storage are
reused, so a fresh load shows the committed entries again. Published packages and complete native releases include the Web assets and worker entry points. Source development builds the page at host startup; restart the host after changing page source.

### Run the conversation

The header carries **Compact context** (an optional instruction steers the summary; the host compacts
in the background and appends the summary entry to the transcript), and **Settings → Models and connections** offers
**Refresh models** plus the host's last refresh outcome. While a turn runs, the composer shows an
**Adjust task / Continue after** dropdown: a message sent in steer mode joins the running turn at its next boundary, and
one sent in queue mode waits for the turn to finish. Each queued input is one strip above the composer
with its own **Withdraw**, which cancels exactly that submission and leaves the others.

Images can be attached with the paperclip, pasted, or dropped onto the composer; each one shows its
name and size with its own remove, and the prompt carries them as image content, so they are part of
the durable entry and come back after a reload. PNG, JPEG, WebP, and GIF up to 8 MB are accepted; an
unsupported or oversized file is refused with the reason.

The sidebar filters sessions by name, ID, working directory and project. Each session's more menu offers
rename, **Archive**, copy ID and confirmed deletion. Archiving confirms that running tasks, background work,
queued inputs and terminal commands will stop. History and file changes are kept, and new work is refused until
the session is restored; cancelled tasks are not automatically replayed. Removing a project also archives and
stops its sessions without deleting source folders. **Settings → Archived** lists all archived sessions, including
those in removed projects, with their project, archive time and retention reminder. **Open** shows history read-only
and pins only that archive beneath the sidebar projects. **Restore session** returns it to its project and clears the
old sidebar filter so the restored session remains visible. An open archive's more menu offers confirmed deletion;
deleting a session removes its history, not its project folders. Retention reminders never delete automatically.

Project and current session selection, including an open archive, survive refresh in the current tab. The host also saves a fallback for a
new window or changed Web port, but checks current project and archive metadata before attaching. Switching
between chat and settings retains the attached session, draft and chat scroll position; changing a setting leaves
you on that settings page.

### Manage conversation forks

**Session tools → Conversations** shows the main line, manual forks and task-owned subagent conversations,
including running state and queued-input counts. A manual fork's more menu offers **Rename** and confirmed
**Archive**. Only manual forks are managed this way; the main line is managed through the session itself.
Archived forks and their owned children stay in the panel's **Archived forks** group for read-only viewing;
manual forks offer **Restore fork**. Restoring an archived session is required before restoring one of its forks.

Fork archiving stops that fork's task-owned work, including background children, and withdraws queued input.
It does not follow history ancestry to cancel the main line or other forks, and does not stop the shared session
terminal. Restoring waits for cancellation and never replays cancelled work. Names and archive state survive
restart without being inherited by newly created forks. Forks share project files: there is no automatic file
rollback, isolated workspace, hard deletion or merge action.

### Review changes and continue a paused run

**Session tools → Changes** shows file changes, read-only diffs and recognized validation-command results.
Changes can include concurrent human edits; a successful command is not proof that the result is correct.

Configure tool-call, elapsed-time and reported-cost budgets in **Settings → Conversation**. Zero means unlimited.
Budgets pause before the next model or tool execution, including nested tools, rather than killing a command
already running. **Continue with another budget** in the changes tab resets the current tranche without
repeating completed calls. The pause survives restart and still requires explicit continuation. See
[Run controls](run-controls.md) for replay rules, snapshot limits, context cleanup and file-write isolation.

### Confirming tool calls
**Settings → Approvals → Tool confirmation** decides which tool calls wait for you: `Run without asking`,
`Ask before changes` (bash, powershell, write, edit), or `Ask before every call`. A call that the policy
covers appears as a card above the composer with the tool's own arguments; **Approve** lets it run and
**Deny** settles it as a failed tool result — *Denied by the reader: …* — which the turn continues from.
Aborting a turn denies whatever it was waiting on. This is a pause at the tool boundary, not a rule
engine: nothing about network or filesystem scope is enforced by it.

### Rating an answer, and the first-run guide

Every committed answer carries a thumbs up and a thumbs down under it. Rating writes to
`feedback.json` in the agent directory, so the same file the CLI can read holds the reader's verdict;
rating the same answer again replaces the record, and pressing the same thumb again withdraws it.
The controls only appear on an answer that has already settled, and only when the host offers the
service.

A host with no sessions yet shows a welcome card instead of an empty conversation: **New session**,
**Session tools**, and **Settings** each jump to the thing they name, and **Don't show this again**
writes `showWelcome: false` to the agent's `settings.json`. Turn it back on any time under
**Settings → Interface → Welcome guide**.

### Watching a long run, and older history

The dock's **Conversations** tab lists the main conversation, branches and subagent conversations with their
origin and focus. **Open** focuses an existing conversation without starting another task, and the composer then
talks to that conversation. **Tasks** shows readable task kinds and phases, status, waited-task counts and ownership.
**View conversation** and **View child conversation** have separate labels and focus the named conversation;
they do not restart its task.

**Load older** at the top of the transcript pages stored history in, twenty entries at a time. The
first page starts strictly below the oldest entry the transcript still shows (so a page never repeats
what is above it — after a compaction, the entries the summary replaced), and later pages ride the
host's cursor. The pages read exactly like the transcript above them.

### The session's files and a shell

The **Session tools** control in the header opens a dock with **Files**, **Terminal**, **Conversations**, **Tasks**
and, when available, **Changes**. **Files** can switch between the project's source folders: directories open,
files read, and **Up** steps back out. Large text files are marked as truncated; binary and missing files have
separate notices. Relative paths resolve from the selected folder, and absolute paths can select another project
folder. Canonical paths and symlink targets must remain inside a project source folder. This browser boundary
is not a tool sandbox. The separate file-write policy limits tool writes, not reading or network access.

**Terminal** runs in the session's execution directory using the configured command prefix and the shared host
execution environment, including its file-write policy. It streams bounded output and reports the exit code.
**Stop** cancels the command and keeps its output. One command runs at a time; a second is refused, not queued.

### Commands, shortcuts, and copying

Type `/` in the composer to open the work-action palette for plugin commands, prompt templates and enabled
`/skill:<name>` commands. It filters by prefix and offers plugin argument completions; `Tab` completes a row and
`Enter` runs it. Resource expansion retains the focused conversation and the chosen Steer/Queue mode.

Use the model and thinking dropdowns, provider-account controls, and the session's history, branch and compaction
controls instead of typing terminal settings commands. `/model`, `/thinking`, `/scoped_models` and `/login` are not
Web model-setting commands. **Settings → Configuration & diagnostics → Reload session resources** picks up new templates or plugin
changes; unknown command names are refused rather than submitted to the model.

The product shortcuts follow the same convention DSH uses on the web: `⌘⌥N` (`Ctrl+Alt+N`) creates
and attaches a session, `⌘⌥M` (`Ctrl+Alt+M`) cycles the main area through the conversation and the
management views, and `/` with the focus outside a text field moves it to the composer. While a turn
runs, **Stop** or `Ctrl+C` cancels it; `Ctrl+C` remains copy when text is selected. `Escape` closes menus,
modals or the sidebar drawer, and otherwise focuses the stop control during a run; it never cancels the turn. Every fenced code block in an
answer carries a copy control whose clipboard content is exactly that code.

### Manage plugins, skills, settings, and automation

The persistent navigation rail opens **Plugins**, **Skills**, **Settings** and other management pages provided by
the host. Each management page has a category sidebar and shows only the selected category. Settings starts at
**Interface** and remembers category choices while navigating. The back arrow or chat navigation returns to the
same attached session, draft and scroll position; no detach or new session is needed. Settings edits, including
model and reasoning changes, stay on the current page.

**Plugins** lists the plugin packages the host builds into a Session's facet generation. **Add package…** takes an
absolute path to a native plugin package; the host builds it before the selection lands, and a package that
cannot build is rejected with the panel's error notice. The selection is the server default, so sessions opened
after the change load it while a running session keeps the generation it started with. The **MCP servers** group
shows the effective `mcp.json` entries with their scope, enabled state, and exposure; a row's switch and exposure
select write the same files the CLI and the TUI read, and **Add server…** takes a name plus the server entry as
JSON (a `command` for stdio, a `url` for HTTP). With an attached session, the panel shows that worker's effective
configuration, connection state, tool count and errors, and offers reconnect and login where supported. Trusted
projects can override supported settings for their own servers. Without a session, the panel manages global
configuration; the browser itself never connects to MCP servers.

**Skills** lists the host working directory's selected resources using the same loader as session workers:
user and project skills, configured paths and package resources, with project trust and resource filters applied.
Sessions in other working directories resolve their own project resources. A user skill can be created, edited, removed, or imported from a
folder or markdown file; **Edit** opens the whole `SKILL.md` so nothing the loader reads is lost, and the host
rejects a name outside the Agent Skills spec or a file without a description. Project and configured-path skills
open read-only. Mutations and **Re-read files** refresh the host catalogue; the page refreshes the attached
session's own resources and command catalogue after its revision changes. `/reload` also re-reads a running
session's resources. New sessions load the current files.

**Settings** is the host's own field catalogue: each row is a field the host can read and write, grouped under its
own category (**Interface** holds **Language** and **Appearance**), with a readable label and description,
a `default` marker when no settings file sets it, and a control
that matches its kind — a switch, a select, a number, or a text field. A number outside the host's range is refused in
the page, keeping what was typed. A change writes the global
`settings.json` with the same merge semantics the CLI uses, and the attached session is asked to re-read its
settings, so fields read per turn (compaction, retries, steering, follow-up) apply immediately. **Configuration & diagnostics**
names the global and project settings paths, shows parse errors, and offers **Reload settings**, **Reload session resources**
and **View diagnostic report**.
List-valued settings such as `defaultTools` stay in the settings file; the panel edits the scalar surface. The labels,
headings, and option names come from the page's own dictionaries keyed by the catalogue's ids and tokens, so a field the
dictionaries do not know is still listed, under its id, rather than hidden.

A control that started a host call reports itself busy and refuses a second press until the call
settles. When a call is refused or fails, the reason appears next to that control — inside the panel
row or the modal — instead of only on the header's connection line, and a modal that failed keeps
what you typed. Closing a modal with `Esc` or its close control returns the focus to the control that
opened it. Hovering any control paints a state from the design tokens, and every control the page
renders can be reached with `Tab` and shows a focus ring.

**Automation** appears only when the host selects the [optional automation plugin](../plugins/automation/README.md)
and restarts. Plans support positive-integer minute intervals, one-time local dates or five-field cron with an IANA
time zone. Creation captures the session and conversation; later focus changes do not redirect the plan. Configure
busy and missed-run handling, grace time and an execution timeout in the same form.

Rows provide **Run now**, edit, enable/pause, cancel, recent execution records and confirmed removal. Pausing stops
future triggers but still permits manual runs. One plan cannot overlap itself; the host holds at most four runs.
Deleting waits for cancellation of that plan's admitted work without cancelling other user inputs. The agent-directory
`schedules.json` preserves delivery IDs and pending receipts across restart, and records refusal, cancellation or
timeout rather than a false success. Invalid or older files remain read-only until repaired. The target conversation
owns the actual answer, so execution does not depend on an open browser.

## Run tools and copy output

Ask the model to use its available tools for shell commands or file changes. The hosted client's **Session tools → Terminal** also runs a command directly through the host's execution environment. Project trust controls resources, while tool execution uses the process's permissions; see [Security](security.md).

Use terminal text selection to copy output. The shared editor also supports its own selected-text copy behavior. The SDK's JSONL session export and share commands use their documented SDK interface rather than the native SQLite session database.

## Terminal settings and diagnostics

Fullscreen mode uses the alternate screen and keeps the editor and status area visible. Regular mode uses terminal scrollback. Set `tuiMode` in settings or use `--tui-mode fullscreen|regular` for a process-local override. `--use-theme` similarly overrides the selected theme without saving it.

Use [Terminal Setup](terminal-setup.md) for terminal capabilities and [Themes](themes.md) for selected palette resources. `amazme doctor` inspects local configuration without provider requests or repairs. `AMAZME_TUI_WRITE_LOG` records raw terminal output when diagnosing rendering; review logs before sharing them because they may contain conversation and file contents.
