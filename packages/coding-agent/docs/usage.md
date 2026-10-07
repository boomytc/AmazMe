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
shows each session's age and marks the attached one; click a row to attach another session. The transcript
renders the same durable state the TUI shows: user and assistant blocks, thinking, tool calls with their
results or a "Not run" notice, compaction and reset notices, and an error notice for an answer that failed,
was aborted, or was truncated. The transcript's last row is the session's live status (working, running a
tool, retrying, compacting); the inputs the session has queued but not started sit as one strip each above
the composer. The theme is the one `deepseek-harness` ships — the same palette, type, radii, elevation, and
frame geometry — and it follows the system's light and dark appearance.

Type in the composer and press `Enter` to submit: while the session is idle the text starts a run, and while a
turn is running it queues as the next input. `Shift+Enter` inserts a newline; the draft grows with its content
up to the composer's cap and scrolls after that. `Stop` withdraws queued input and stops the running turn.
Committed entries appear without reloading, and any other attached presentation — a second browser tab or the
client TUI — sees the same committed state.

Failures stay visible: losing the host shows `disconnected: …` in the header within seconds, and a document
served without its boot manifest reports `cannot boot: …` in the header, the roster and the body instead of
rendering an empty shell. Restarting the host keeps sessions: the same server ID and the durable storage are
reused, so a fresh load shows the committed entries again. Page changes take effect after the host restarts
(the bundle is built in memory when the host starts), and this slice is not part of the packaged `amazme`
binary yet, so it always runs from the repository.

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
