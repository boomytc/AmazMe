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

To browse multiple hosted sessions, use `amazme client` or `amazme web`. The default terminal does not expose the SDK's Dashboard, `/new`, `/resume` picker, `/settings`, direct `!` shell, copy/share or export menus. Those interfaces belong to the optional SDK terminal. Plain `dashboard` is prompt text, and unsupported long options are rejected before session storage.

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

The page lists the host's sessions on the left and the attached session's transcript on the right. The roster
groups the sessions by when they were made (today, yesterday, the previous seven days, earlier), shows each session's age, and marks the attached one; click a row to attach another session, or use the sidebar's
**New session** bar to have the host create one — it appears in the roster, attaches at once, and accepts input.
The transcript
renders the same durable state the TUI shows: user and assistant blocks, thinking, tool calls with their
results or a "Not run" notice, compaction and reset notices, and an error notice for an answer that failed,
was aborted, or was truncated. A turn in flight adds its live status (working, running a tool, retrying,
compacting) as the transcript's last row, and the inputs the session has queued but not started sit as one
strip each above the composer. Assistant answers are formatted: headings, lists, emphasis, links, fenced code
blocks, and pipe tables become elements — a table column that holds only numbers is right-aligned with figures of
one width, so the numbers can be compared down the column — while anything the model writes that looks like markup
stays text. The page's own design is a neutral grey scale with one accent and the primary action in ink, following the
conventions of the Claude, ChatGPT, and Grok chat clients: a centred conversation column, a rounded composer card,
a time-grouped sidebar, and answer actions that show on hover. Its appearance follows the stored preference (see
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
client TUI — sees the same committed state. The chip beside that action carries the attached session's model and,
for a model that reasons, its thinking level; it opens a card listing the host's model catalog grouped by
provider and the levels that model supports, and either choice lands in that session's configuration on the host,
so the next turn resolves its model and level from it.

A draft that starts with `/` opens the command palette. It lists, in one order, what this host runs (`model`,
`thinking`, `compact`, `reload`), what a plugin registered with the session (`plugin`), the prompt templates that
session loaded (`template`), its skills as `/skill:<name>` (`skill`), and — last — the hosted terminal's four navigation commands
(`/tree`, `/agents`, `/fork`, `/older`, marked `terminal only`). The page adds its authentication and naming commands.
Each row shows its argument hint from the resource's
frontmatter, and the runnable rows come first. `Tab` completes the highlighted row and `Enter` runs it. A row marked `terminal only` is refused with that reason on
the connection line, so the text never reaches the model as prose. The session's own
commands run on the host and report their note or problem on the connection line; a template or a skill is expanded
there too, with the same code the TUI expands it with (`$1`/`$ARGUMENTS` substitution, or a `<skill>` block plus the
arguments), and the page then sends that prompt on its normal path, so a focused conversation and the composer's
Steer/Queue mode still apply. A skill written, imported, or removed in **Skills**, or the **Skills as commands** switch
in there, reaches the palette at once; a template file added on disk arrives with `/reload`. Expansion keeps its
session, conversation and submit mode; switching its target while it is pending requires retrying in the new target.

Failures stay visible: losing the host shows `disconnected: …` in the header within seconds, and a document
served without its boot manifest reports `cannot boot: …` in the header, the roster and the body instead of
rendering an empty shell. A page that lost its host keeps the session it was on and retries the connection with
backoff, saying `disconnected: … — retrying` while it does; when the host answers again — a restart on the same port
and server directory — it attaches that session again and repaints, so two tabs on one session pick up where they
were. An interrupted turn is recovered by the host's own runtime, so the session stays busy until that settles and a
prompt sent in the meantime is refused with the reason rather than queued silently. A document request that arrives before the host runtime exists waits for its manifest
instead of serving an unbootable page. Restarting the host keeps sessions: the same server ID and the durable
storage are
reused, so a fresh load shows the committed entries again. Published packages and complete native releases include the Web assets and worker entry points. Source development builds the page at host startup; restart the host after changing page source.

### Run the conversation

The header carries **Compact context** (an optional instruction steers the summary; the host compacts
in the background and appends the summary entry to the transcript), and the model chip's card ends
with **Refresh models** plus the host's last refresh outcome. While a turn runs, the composer shows a
**Steer / Queue** toggle: a message sent in steer mode joins the running turn at its next boundary, and
one sent in queue mode waits for the turn to finish. Each queued input is one strip above the composer
with its own **Withdraw**, which cancels exactly that submission and leaves the others.

Images can be attached with the paperclip, pasted, or dropped onto the composer; each one shows its
name and size with its own remove, and the prompt carries them as image content, so they are part of
the durable entry and come back after a reload. PNG, JPEG, WebP, and GIF up to 8 MB are accepted; an
unsupported or oversized file is refused with the reason.

The sidebar filters sessions by id or working directory, names each session's working directory under
its id, and removes one from a hover control behind a confirmation: its storage is deleted from the
host's session directory while the working directory itself is left alone. A draft in the composer,
the filter text, and the open management view survive attaching, creating, and removing sessions.

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

The dock's **Conversations** tab lists every conversation of the session: `main`, and each subagent
child with the task and conversation that created it. **Open** switches the main area to that
conversation — the root keeps its live transcript, another one is read from the host — and the
composer then talks to whichever conversation is focused. **Tasks** shows the live task graph: each
task's kind, its phase, its status, what it waits on, and the conversations it owns, which is what
makes a long delegation legible while it runs.

**Load older** at the top of the transcript pages stored history in, twenty entries at a time. The
first page starts strictly below the oldest entry the transcript still shows (so a page never repeats
what is above it — after a compaction, the entries the summary replaced), and later pages ride the
host's cursor. The pages read exactly like the transcript above them.

### The session's files and a shell

The **Session tools** control in the header opens a dock beside the conversation with two tabs. **Files**
browses the attached session's working directory: directories open, files read, **Up** steps back out,
and a text file's content is shown whole (a large file says it is truncated). A binary file, a path that
is not there any more, and a path above the working directory each say so — the workspace never resolves
outside the session's directory.

**Terminal** runs a command in that same directory with the shell path and command prefix from settings,
streams its output into the panel, and reports the exit code. **Stop** cancels the running command and
keeps what it printed. One command runs at a time, and the dock answers a second one instead of queueing
it. The terminal uses the same execution path as the agent's own bash tool, so what you run by hand
behaves like what the model runs.

### Commands, shortcuts, and copying

Type `/` in the composer to open the command palette. It lists the session's own commands — `model`,
`thinking`, `compact`, and `reload` — and narrows as you type; after a space it lists the host's
completions for that argument (model ids, reasoning levels). `Tab` completes the highlighted row and
`Enter` runs the line. When the agent registers skills as commands (the **Skills as commands**
setting), each loaded skill appears as `/skill:<name>`; running it expands the skill's own file the
way the CLI does and sends it as the prompt. A command's outcome appears on the header's connection
line.

The product shortcuts follow the same convention DSH uses on the web: `⌘⌥N` (`Ctrl+Alt+N`) creates
and attaches a session, `⌘⌥M` (`Ctrl+Alt+M`) cycles the main area through the conversation and the
management views, and `/` with the focus outside a text field moves it to the composer. While a turn
runs, two `Escape` presses within half a second stop it, the same double-escape the TUI uses; a
single `Escape` still closes the open modal, view card, or model card. Every fenced code block in an
answer carries a copy control whose clipboard content is exactly that code.

### Manage plugins, skills, settings, and automation

The sidebar's **Plugins**, **Skills**, and **Automation** rows and the **Settings** entry at the sidebar's bottom
switch the main area to a management panel; the header then carries the panel's name and a back arrow, and the
conversation and composer return with it. Every panel is a list of groups built from the host's own state, so the
page never shows a field the host cannot read or write.

**Plugins** lists the plugin packages the host builds into a Session's facet generation. **Add package…** takes an
absolute path to a package with `src/session.ts`; the host builds it before the selection lands, and a package that
cannot build is rejected with the panel's error notice. The selection is the server default, so sessions opened
after the change load it while a running session keeps the generation it started with. The **MCP servers** group
shows the effective `mcp.json` entries with their scope, enabled state, and exposure; a row's switch and exposure
select write the same files the CLI and the TUI read, and **Add server…** takes a name plus the server entry as
JSON (a `command` for stdio, a `url` for HTTP). Entries an extension registered are read-only here, and this host
does not connect MCP servers itself, so the panel says so.

**Skills** lists the host working directory's selected resources using the same loader as session workers:
user and project skills, configured paths and package resources, with project trust and resource filters applied.
Sessions in other working directories resolve their own project resources. A user skill can be created, edited, removed, or imported from a
folder or markdown file; **Edit** opens the whole `SKILL.md` so nothing the loader reads is lost, and the host
rejects a name outside the Agent Skills spec or a file without a description. Project and configured-path skills
open read-only. Mutations and **Re-read files** refresh the host catalogue; the page refreshes the attached
session's own resources and command catalogue after its revision changes. `/reload` also re-reads a running
session's resources. New sessions load the current files.

**Settings** is the host's own field catalogue: each row is a field the host can read and write, grouped under its
own heading (the first group, **Interface**, holds **Language** and **Appearance**), with the settings key it maps to,
a `default` marker when no settings file sets it, and a control
that matches its kind — a switch, a select, a number, or a text field. A number outside the host's range is refused in
the page, keeping what was typed. A change writes the global
`settings.json` with the same merge semantics the CLI uses, and the attached session is asked to re-read its
settings, so fields read per turn (compaction, retries, steering, follow-up) apply immediately. The **Files** group
names the global and project settings paths, shows a parse error the files carry, and offers **Re-read files**.
List-valued settings such as `defaultTools` stay in the settings file; the panel edits the scalar surface. The labels,
headings, and option names come from the page's own dictionaries keyed by the catalogue's ids and tokens, so a field the
dictionaries do not know is still listed, under its id, rather than hidden.

A control that started a host call reports itself busy and refuses a second press until the call
settles. When a call is refused or fails, the reason appears next to that control — inside the panel
row or the modal — instead of only on the header's connection line, and a modal that failed keeps
what you typed. Closing a modal with `Esc` or its close control returns the focus to the control that
opened it. Hovering any control paints a state from the design tokens, and every control the page
renders can be reached with `Tab` and shows a focus ring.

**Automation** lists the prompts the host runs on its own. Each row names the prompt, its cadence (at least one
minute), the session it belongs to, when it is next due, and what its last run produced; **Run now** runs it
immediately, the switch pauses or resumes the host's own timer, and **Remove** deletes it behind a confirmation.
**Plan a prompt…** asks for the text and the gap in minutes and attaches the schedule to the session the page has
open, so a tab has to be attached to plan one. The schedules live in `schedules.json` in the agent directory, and
each run goes through the real session — the answer lands in that session's transcript whether or not a browser is
open. A run that the model cannot answer records why instead of a false success.

## Run tools and copy output

Ask the model to use its available tools for shell commands or file changes. The hosted client's **Session tools → Terminal** also runs a command directly through the host's execution environment. Project trust controls resources, while tool execution uses the process's permissions; see [Security](security.md).

Use terminal text selection to copy output. The shared editor also supports its own selected-text copy behavior. The SDK's JSONL session export and share commands use their documented SDK interface rather than the native SQLite session database.

## Terminal settings and diagnostics

Fullscreen mode uses the alternate screen and keeps the editor and status area visible. Regular mode uses terminal scrollback. Set `tuiMode` in settings or use `--tui-mode fullscreen|regular` for a process-local override. `--use-theme` similarly overrides the selected theme without saving it.

Use [Terminal Setup](terminal-setup.md) for terminal capabilities and [Themes](themes.md) for selected palette resources. `amazme doctor` inspects local configuration without provider requests or repairs. `AMAZME_TUI_WRITE_LOG` records raw terminal output when diagnosing rendering; review logs before sharing them because they may contain conversation and file contents.
