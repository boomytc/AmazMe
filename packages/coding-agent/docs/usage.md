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
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task. Aborting returns queued messages to the editor.

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

The background highlight always identifies the current session, independently of pointer hover or keyboard focus. `Up`/`Down` moves the `▌` action cursor without moving that highlight. The same cursor marks group headings and both New/Previous actions. Click a heading to fold or expand it; click either session line to open that session. `Tab` switches between the list and composer. The composer placeholder identifies the reply or new-session target, and its compact Enter hint follows the selected action.

In fullscreen mode, Dashboard uses an independent scroll position and opens at the current session. Keyboard navigation keeps both selected session lines visible whenever there is room; manual wheel scrolling does not pull the list back to the keyboard cursor. Its header and contextual hints stay fixed, and closing Dashboard restores the previous chat scroll position. Regular mode continues to use terminal scrollback.

Hovering reveals the title line's action buttons in reserved columns, so the title and question do not change their truncation. Dashboard's header shows session counts and activity rather than repeating the folder and branch from the top bar.

Click `[rename]`, or select a session and press `Ctrl+R`, to edit its title inline. `Enter` saves, `Escape` cancels, and `Ctrl+U` clears the field. The title is saved with the session. With fewer than 56 available list columns, the button becomes `[r]`; below 32, it is hidden. Age is also hidden below 32 available list columns, and `[x]` is hidden below 20 to prioritize the title. `Ctrl+R` and `Ctrl+X` remain available at every width; deleting an idle session still requires confirmation.

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

Narrow terminals keep the session title and Dashboard entry ahead of paths and cost. The top-bar Dashboard label becomes `[D]` below 32 columns, and context usage can become a compact percentage. Only hovering the context indicator replaces the count with a compact meter that fits the count's own width (at most six cells). It reserves no extra blank space, leaves the title, cost, and Dashboard in place, and does not change click targets. Moving to the title, Dashboard, transcript, or editor restores the count immediately; terminal focus loss also clears hover. Context, cost, and Dashboard use consistent two-column gaps. Context details remain available by clicking the context indicator. The panel separates current context occupancy from **Session totals** (uncached input, output, cache reads/writes, and cost) and the **Last assistant request** (cache hit rate). Session totals include recorded tool, summary, compaction, and background usage; they are not the current context size. Cache hit rate is also not context occupancy. Small terminals can scroll the detail panel with arrows, Page Up/Down, Home/End, or the mouse wheel; its close badge stays fixed. Escape, `q`, or `[x]` closes it without changing the transcript scroll position.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. Pi writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
