# Use Pi in the terminal

Run `pi` from the folder you want to work in. Pi uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Pi or chosen a model yet, follow the [Quickstart](quickstart.md).

Pi may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="Pi interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, Pi's responses, tool calls, results, and errors. You write prompts and commands in the editor. The top bar owns the session title, folder and branch, context usage, cost, and Dashboard entry. The editor border shows the model and thinking level; the footer keeps actual model routing and extension statuses without repeating location, provider names, or usage statistics. Provider information is available through `/model`.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Use the system's clipboard paste shortcuts below to paste an image. The image is saved to a private temporary file and its path is inserted at the cursor, separated from surrounding text. This also works in the Dashboard's selected reply or new-session input. Copied Finder files retain their original paths; text is the final fallback.
- Drag a file or image into a compatible terminal. The terminal's own paste command may only paste text; use the application shortcut for clipboard images.

Default keys are detected from the operating system; WSL uses the Windows defaults. Startup help and `/hotkeys` show your active bindings, including custom overrides.

| System | Paste | Fallback for clipboard images |
|---|---|---|
| macOS | `Cmd+V` | `Ctrl+V` (Control+V) |
| Windows / WSL | `Ctrl+V` | `Alt+V` |
| Linux | `Ctrl+Shift+V` | `Ctrl+V` |

The primary shortcut can use the terminal's normal paste action. When a terminal reports a paste with no text, AmazMe reads the system clipboard for the image instead of discarding the notification. Nonempty text pastes remain unchanged. The secondary key also reads the clipboard directly. Successful image pastes show a temporary file path in the draft. Clipboard paste also works when running directly from TypeScript with the source resolver.

## Follow Pi's work

Pi shows each tool call and result while it works. Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources Pi loaded. The editor border indicates the current thinking level. The top bar updates current context occupancy and cost as the model works. Click the context indicator for detailed usage statistics.

Pi does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Change direction

You can send more input while Pi is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Ctrl+C` (with a draft it clears the draft first; twice in a row exits) |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task. Aborting returns queued messages to the editor. `Escape` never cancels a turn; it closes menus and overlays, and during a turn it points at `Ctrl+C`.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the same selector.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

Pi saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions.md) for these workflows.

After leaving Pi, run `pi --continue` from the same folder to resume its most recent session.

## Browse sessions in the Dashboard

Open the Dashboard with `Ctrl+\` or `/dashboard`. Every session occupies two lines: its title, then the latest user question on that session's active branch. Questions are kept visible without selection, collapsed to one line, and truncated to fit; an empty session shows `No question yet`. Assistant replies and command output do not replace the question.

The background highlight always identifies the current session, independently of pointer hover or keyboard focus. `Up`/`Down` moves the cursor without moving that highlight: a session row takes a frame around its two lines, while the action and group slots take a `▌` bar. A group heading carries its session count and then its rule on one line; click it to fold or expand the group. Click either session line to open that session. `Tab` switches between the list and composer. The composer placeholder identifies the reply or new-session target, and its chips follow the cursor: `Enter`, `Tab`, `Esc` back to the New Agent action, `Ctrl+X` to stop the working session or close a saved one, and `?` for help. A task can be typed there and sent to the selected session without opening it.

In fullscreen mode, Dashboard uses an independent scroll position and opens at the current session. Keyboard navigation keeps both selected session lines visible whenever there is room; manual wheel scrolling does not pull the list back to the keyboard cursor. Its header and contextual hints stay fixed, and closing Dashboard restores the previous chat scroll position. Regular mode continues to use terminal scrollback.

While the cursor rests on a session, the area above the composer previews that session's latest reply under a `Response` label, clipped to a few lines with the remainder counted in its bottom border. The preview appears only when the terminal can spare its six lines, so it never squeezes the list. Hovering reveals the title line's action buttons in reserved columns, so the title and question do not change their truncation. The current session shows `[rename]` without a close badge, and its blank close column keeps every age on one column; `Ctrl+X` on it reports that the session stays open. Dashboard's header shows session counts and activity, with `◇` marking idle sessions, rather than repeating the folder and branch from the top bar.

Click `[rename]`, or select a session and press `Ctrl+R`, to edit its title inline. `Enter` saves, `Escape` cancels, and `Ctrl+U` clears the field. The title is saved with the session. With fewer than 56 available list columns, the button becomes `[r]`; below 32, it is hidden. Age is also hidden below 32 available list columns, and `[x]` is hidden below 20 to prioritize the title. `Ctrl+R` and `Ctrl+X` remain available at every width; deleting an idle session still requires confirmation.

## Use the web client

The experimental slice can serve the same host to a browser. From the repository root:

```bash
AMAZME_EXPERIMENTAL=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/experimental/cli.ts web
```

It prints the canonical loopback URL, the mode it serves (`source`), the WebSocket URL, and the server ID once
the host accepts connections, and it binds loopback only: a connection to another address of this machine is
refused. Open the printed `http://127.0.0.1:<port>/` URL.

The page lists the host's sessions on the left and the attached session's transcript on the right. The roster
shows each session's age and marks the attached one; click a row to attach another session, or use the sidebar's
**New session** bar to have the host create one — it appears in the roster, attaches at once, and accepts input.
The transcript
renders the same durable state the TUI shows: user and assistant blocks, thinking, tool calls with their
results or a "Not run" notice, compaction and reset notices, and an error notice for an answer that failed,
was aborted, or was truncated. A turn in flight adds its live status (working, running a tool, retrying,
compacting) as the transcript's last row, and the inputs the session has queued but not started sit as one
strip each above the composer. Assistant answers are formatted: headings, lists, emphasis, links, fenced code
blocks, and pipe tables become elements — a table column that holds only numbers is right-aligned with figures of
one width, so the numbers can be compared down the column — while anything the model writes that looks like markup
stays text. The theme is the one
`deepseek-harness` ships — the same palette, type,
radii, elevation, and frame geometry — and its appearance follows the stored preference (see below), defaulting to the
system's light and dark appearance.

The page's language is a stored preference too. With no choice made, a browser asking for Chinese gets Chinese and any
other browser gets English; the host resolves that from the request and serves the document already localized, so the
first paint is not English. Switch it in **Settings → Interface → Language**, or set `locale` in `settings.json` to
`auto`, `zh`, or `en`. The switch and the appearance switch apply without a reload, and both persist for the next load
and for other browsers on the same agent directory. What the page cannot translate is text the host itself writes —
skill loader diagnostics, `mcp.json` validation, settings parse errors — which stays as the host wrote it, and the
TUI's own interface stays English.

Type in the composer and press `Enter` to submit: while the session is idle the text starts a run, and while a
turn is running it queues as the next input. `Shift+Enter` inserts a newline; the draft grows with its content
up to the composer's cap and scrolls after that. The circular action on the right sends the draft, and becomes
`Stop` — withdrawing queued input and stopping the running turn — while a turn runs with an empty draft.
Committed entries appear without reloading, and any other attached presentation — a second browser tab or the
client TUI — sees the same committed state. The chip beside that action carries the attached session's model and,
for a model that reasons, its thinking level; it opens a card listing the host's model catalog grouped by
provider and the levels that model supports, and either choice lands in that session's configuration on the host,
so the next turn resolves its model and level from it.

Failures stay visible: losing the host shows `disconnected: …` in the header within seconds, and a document
served without its boot manifest reports `cannot boot: …` in the header, the roster and the body instead of
rendering an empty shell. A document request that arrives before the host runtime exists waits for its manifest
instead of serving an unbootable page. Restarting the host keeps sessions: the same server ID and the durable
storage are
reused, so a fresh load shows the committed entries again. Page changes take effect after the host restarts
(the bundle is built in memory when the host starts), and this slice is not part of the packaged `amazme`
binary yet, so it always runs from the repository.

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

**Skills** lists what the agent loads: the agent directory's own skills (scope `user`), the workspace's
`.amazme/skills`, and configured skill paths. A user skill can be created, edited, removed, or imported from a
folder or markdown file; **Edit** opens the whole `SKILL.md` so nothing the loader reads is lost, and the host
rejects a name outside the Agent Skills spec or a file without a description. Project and configured-path skills
open read-only. Like the CLI, the agent loads skills when a session starts, so a new or edited skill applies to
the sessions started afterwards.

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

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` when you want to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Successful copies, including fullscreen text selection and editor selection, show a short-lived, right-aligned `Copied!` line immediately above the composer. The feedback does not take focus or add a chat message. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. With Radius authentication, the artifact is visible to your Radius organization. Otherwise, Pi creates a private GitHub gist through the GitHub CLI. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Fullscreen mode, the default, keeps the editor and status area fixed while the transcript scrolls within the terminal window. Regular mode uses the terminal's normal scrollback. Choose a mode through `/settings` or `--tui-mode`.

Narrow terminals keep the session title and Dashboard entry ahead of paths and cost. The top-bar Dashboard label becomes `[D]` below 32 columns, and context usage can become a compact percentage. Only hovering the context indicator replaces the count with a compact meter that fits the count's own width (at most six cells). It reserves no extra blank space, leaves the title, cost, and Dashboard in place, and does not change click targets. Moving to the title, Dashboard, transcript, or editor restores the count immediately; terminal focus loss also clears hover. Context, cost, and Dashboard use consistent two-column gaps. Context details remain available by clicking the context indicator. The panel separates current context occupancy from **Session totals** (uncached input, output, cache reads/writes, and cost) and the **Last assistant request** (cache hit rate). Session totals include recorded tool, summary, compaction, and background usage; they are not the current context size. Cache hit rate is also not context occupancy. Small terminals can scroll the detail panel with arrows, Page Up/Down, Home/End, or the mouse wheel; with a pointer its close badge stays fixed. `Escape` or `q` closes it without changing the transcript scroll position (in fullscreen the `[x]` badge closes it too).

Regular mode has no pointer input, so nothing is drawn as a click target: the top bar names the `Ctrl+\` dashboard chord instead of showing a `[Dashboard]` button, popups name `Escape` instead of an `[x]` badge, and background commands say `Command in background` rather than offering `[open]`/`[close]`. Press `F2` for the tasks list, where `Up`/`Down` select a row and `Enter` opens its transcript or output.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. Pi writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
