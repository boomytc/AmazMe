import type { ScheduleRuleLike } from "./panels.ts";
/**
 * The page's copy, in both shipped languages. Everything a reader sees comes from here: the
 * conversation, the composer, and the management panels, plus the labels for the host's settings
 * catalogue, whose ids and tokens this module turns into prose. Product copy lives in the client
 * the way the TUI's selectors keep their own, so the host publishes data and the presentation
 * publishes words. Desktop shell chrome (menus and dialogs) is the `desktop.*` keys in the same
 * dictionaries. `locale.ts` and this module are the subpath exports an Electron main process
 * imports; neither reads the DOM.
 *
 * `en` is the source of truth: `zh` is typed as a complete record of its keys, so a missing
 * translation is a compile error. The identity maps (settings fields, groups, options, scopes)
 * cannot be checked that way, so `strings.test.ts` and the coding-agent's catalogue test assert
 * that both languages carry the same identities.
 */
import { type Locale, documentLanguage } from "./locale.ts";

/** Message keys for the page and the desktop shell: flat, dotted, and complete in both languages. */
export const EN = {
	"panel.automation.busyQueue": "queue while busy",
	"panel.automation.busySkip": "skip while busy",
	"panel.automation.missedLatest": "coalesce missed runs",
	"panel.automation.missedSkip": "skip beyond grace",
	"panel.automation.timeout": "timeout {seconds}s",
	"panel.automation.finished": "no future trigger",
	"panel.automation.edit": "Edit",
	"panel.automation.history": "Run history",
	"panel.automation.historyFinished": "Finished: {time}",
	"panel.automation.historyDue": "Scheduled: {time}",
	"panel.automation.added": "Plan added",
	"panel.automation.updated": "Plan updated",
	"panel.automation.enabled": "Enabled",
	"panel.automation.idle": "No active prompt",
	"panel.automation.done": "Completed",
	"panel.automation.cancelled": "Cancelled",
	"panel.automation.skipped": "Skipped",
	"panel.automation.refused": "Refused",
	"panel.automation.unanswered": "No answer",
	"panel.automation.timed_out": "Timed out",
	"panel.automation.reasonBusy": "conversation was busy",
	"panel.automation.reasonMissed": "missed the grace period",
	"panel.automation.oneTime": "Once: {at} · {zone}",
	"panel.automation.cronRule": "{expression} · {zone}",
	"modal.scheduleAdd.editTitle": "Edit planned prompt",
	"modal.scheduleAdd.save": "Save",
	"modal.scheduleAdd.kind": "Time rule",
	"modal.scheduleAdd.interval": "Fixed interval",
	"modal.scheduleAdd.once": "Once",
	"modal.scheduleAdd.cron": "Calendar (cron)",
	"modal.scheduleAdd.at": "Local date and time",
	"modal.scheduleAdd.expression": "Cron expression",
	"modal.scheduleAdd.timeZone": "Time zone",
	"modal.scheduleAdd.cronHelp": "Five numeric fields: minute hour day month weekday. 0 9 * * 1-5 means weekdays at 09:00. Use *, lists, ranges and steps; Sunday is 0 or 7. Restricted day and weekday fields match either.",
	"modal.scheduleAdd.zoneHelp": "IANA zone, e.g. Asia/Shanghai. Repeated clock times use the first occurrence. Missing clock times are skipped; one-time rules reject them.",
	"modal.scheduleAdd.busy": "When the conversation is busy",
	"modal.scheduleAdd.queue": "Queue",
	"modal.scheduleAdd.skip": "Skip",
	"modal.scheduleAdd.missed": "When occurrences were missed",
	"modal.scheduleAdd.latest": "Deliver the latest once",
	"modal.scheduleAdd.grace": "Missed-run grace (minutes, 0–10080)",
	"modal.scheduleAdd.timeout": "Timeout (seconds, 1–86400)",
	"nav.chat": "Chat",
	"nav.plugins": "Plugins",
	"nav.skills": "Skills",
	"nav.automation": "Automation",
	"nav.settings": "Settings",

	"sidebar.newSession": "New session",
	"sidebar.creating": "Opening session…",
	"sidebar.untitled": "New session",
	"sidebar.more": "Session actions",
	"sidebar.rename": "Rename",
	"sidebar.copyId": "Copy session ID",
	"modal.sessionRename.title": "Rename session",
	"modal.sessionRename.name": "Session name",
	"page.nameRequired": "Enter a session name.",
	"sidebar.sessions": "Sessions",
	"sidebar.filter": "Filter sessions",
	"sidebar.remove": "Remove",
	"sidebar.localSession": "terminal",
	"sidebar.removeAria": "Remove this session",
	"sidebar.management": "Management",
	"sidebar.waiting": "Waiting for the host…",
	"sidebar.toggle": "Show or hide the sidebar",

	"roster.today": "Today",
	"roster.yesterday": "Yesterday",
	"roster.week": "Previous 7 days",
	"roster.earlier": "Earlier",

	"greeting.title": "What should we work on?",
	"greeting.hint": "Type / for commands. Enter sends, Shift+Enter starts a new line.",
	"greeting.pickTitle": "Pick a session to continue",
	"greeting.pickHint": "Or start a new one.",
	"greeting.startTitle": "Start a session",
	"greeting.startHint": "New sessions appear in the sidebar.",

	"header.noSession": "No session",
	"header.back": "Back to the conversation",
	"header.noSessionAttached": "No session attached.",
	"header.noEntries": "No entries in this session yet.",
	"header.rosterEmpty": "No sessions on this host yet.",
	"header.rosterNoMatch": "No session matches that filter.",
	"header.conversation": "{session} · {conversation}",
	"header.connecting": "Connecting to the host…",
	"header.meter": "Context {context}, tokens {tokens}, cost {cost}",
	"header.pendingApprovals": "Waiting for approval {count}",

	"connection.starting": "starting…",
	"connection.connecting": "connecting…",
	"connection.connected": "connected · {id}",
	"connection.stateConnected": "connected",
	"connection.stateDisconnected": "disconnected",
	"connection.disconnected": "disconnected: {error}",
	"connection.retrying": "disconnected: {error} — retrying",
	"connection.hostGone": "host went away",

	"composer.placeholder": "Send a task to {name}",
	"composer.placeholderDetached": "No session attached",
	"composer.send": "Send",
	"composer.stop": "Stop",
	"composer.steer": "Steer",
	"composer.queue": "Queue",
	"composer.modesAria": "How the next message is applied while a turn runs",
	"composer.attachments": "Attached images",
	"composer.attach": "Attach an image",
	"composer.removeAttachment": "Remove this image",
	"composer.attachmentUnsupported": "{name} is not an image this page can send (PNG, JPEG, WebP, or GIF).",
	"composer.attachmentTooLarge": "{name} is larger than {limit}.",
	"composer.attachmentLimit": "8 MB",

	"queue.cancel": "Withdraw",
	"queue.cancelAria": "Withdraw this queued input",

	"header.compact": "Compact context",
	"header.fork": "Fork",

	"model.none": "No model",
	"model.menuAria": "Model and reasoning effort",
	"model.chipAria": "Model and reasoning effort: {name}",
	"model.heading": "Model",
	"model.effort": "Effort",
	"model.empty": "No models available.",
	"model.levelsEmpty": "This model provides no reasoning effort levels.",
	"model.refresh": "Refresh models",
	"model.refreshing": "Refreshing models…",
	"model.refreshDone": "Models refreshed.",
	"model.refreshWarning": "Refresh failed for {providers}.",
	"auth.title": "Provider accounts",
	"auth.provider": "Provider",
	"auth.method": "Sign-in method or action",
	"auth.configured": "configured",
	"auth.help": "Sign in to make this provider's models available. Sign out removes saved credentials; environment credentials remain available.",
	"auth.logout": "Remove saved credentials",
	"auth.loggedOut": "Saved credentials removed. Environment credentials may still be available.",
	"auth.continue": "Continue",
	"auth.open": "Open authorization page",
	"auth.deviceCode": "Authorization code",
	"auth.cancel": "Cancel sign-in",
	"auth.waiting": "Waiting for the provider. You can close this window and resume from Provider accounts.",
	"auth.done": "Signed in. Select a model from the model menu.",
	"auth.cancelled": "Sign-in cancelled.",
	"auth.failed": "Provider sign-in failed. Retry or check authentication from the CLI.",
	"auth.expired": "This sign-in prompt has expired. Open Provider accounts to continue.",
	"auth.required": "Enter a credential to continue.",
	"auth.invalid": "Choose an available provider and sign-in method.",

	"block.you": "You",
	"block.thinking": "Thinking",
	"block.compaction": "Compaction",
	"block.newContext": "New context",
	"block.truncated": "Truncated",
	"block.truncatedText": "Response was truncated before completion.",
	"block.aborted": "Aborted",
	"block.abortedText": "Operation aborted",
	"block.error": "Error",
	"block.errorText": "Unknown error",
	"tool.noOutput": "(no output)",
	"tool.completed": "Completed",
	"tool.failed": "Failed",
	"tool.duration": "{seconds}s",
	"tool.nested": "Nested call",
	"tool.appliedDiff": "Applied changes",
	"tool.exitCode": "Exit code {code}",
	"tool.copyPatch": "Copy patch",
	"tool.viewImage": "View image",
	"tool.closeImage": "Close image",
	"tool.errorText": "Tool reported an error",
	"tool.notRun": "Not run: the answer was interrupted.",

	"queue.steer": "steer",
	"queue.followUp": "follow-up",
	"queue.write": "write",

	"status.retrying": "Retrying (attempt {attempt}): {error}",
	"status.deferred": "Waiting for deferred response…",
	"status.compactingRetry": "Retrying {reason} compaction (attempt {attempt})…",
	"status.compacting": "Compacting ({reason})…",
	"status.runningTool": "Running {name}…",
	"status.working": "Working…",

	"lane.main": "Main",
	"lane.fork": "Fork",
	"lane.subagent": "Subagent",
	"lane.noModel": "no model",
	"lane.thinking": "thinking {level}",
	"lane.idle": "Idle",
	"lane.retrying": "retrying {detail}",
	"lane.deferred": "waiting",
	"lane.compacting": "compacting ({detail})",
	"lane.tool": "running {detail}",
	"lane.working": "working",

	"dock.toggle": "Session tools",
	"dock.conversations": "Conversations",
	"dock.tasks": "Tasks",
	"dock.main": "main",
	"dock.untitled": "New conversation",
	"dock.child": "subagent",
	"dock.fork": "fork",
	"dock.owner": "owned by {task} in {conversation}",
	"dock.forkedFrom": "forked from conversation {conversation} at entry {entry}",
	"dock.children": "{count} children",
	"dock.selected": "selected",
	"dock.select": "Open",
	"dock.noConversations": "This session has no conversations yet.",
	"dock.noTasks": "No task is running.",
	"dock.taskWaitsOn": "waits on {tasks}",
	"dock.taskOwns": "owns {conversations}",
	"dock.taskPhase": "phase {phase}",
	"dock.background": "background",
	"dock.files": "Files",
	"dock.terminal": "Terminal",
	"dock.cwd": "Working directory",
	"dock.parent": "Up",
	"dock.open": "Open",
	"dock.read": "Read",
	"dock.reload": "Reload",
	"dock.directory": "directory",
	"dock.contents": "Contents",
	"dock.root": "Working directory",
	"dock.emptyDirectory": "This directory is empty.",
	"dock.binary": "This file is not text, so the workspace does not show it.",
	"dock.missing": "That path is not there any more.",
	"dock.truncated": "Only the beginning of this text is shown.",
	"dock.command": "Command",
	"dock.run": "Run",
	"dock.stop": "Stop",
	"dock.runPlaceholder": "Run a command in the session's directory",
	"dock.noOutput": "No output yet.",
	"dock.terminalIdle": "No command has run yet",
	"dock.terminalRunning": "Running {command}",
	"dock.terminalDone": "Finished with exit code {code}",
	"dock.terminalCancelled": "Stopped",
	"dock.terminalFailed": "Could not run it: {error}",

	"feedback.up": "Helpful",
	"feedback.down": "Not helpful",
	"feedback.rated": "Rated {rating}",

	"history.more": "Load older",
	"history.loading": "Loading older entries…",
	"history.start": "Older entries",

	"approval.title": "Waiting for your decision",
	"approval.approve": "Approve",
	"approval.deny": "Deny",
	"approval.tool": "{tool} wants to run",
	"approval.hint": "Denying settles the call as a failed tool result and the turn continues.",

	"welcome.title": "Welcome to the AmazMe web client",
	"welcome.body":
		"This page drives a running AmazMe host: sessions, their conversations, the files of the working directory, and a shell. Nothing is set up yet, so start with a session.",
	"welcome.step.session": "Create a session",
	"welcome.step.files": "Open the session tools",
	"welcome.step.settings": "Open the settings",
	"welcome.dismiss": "Dismiss",
	"welcome.note": "The guide comes back through Settings → Interface → Welcome guide.",

	"palette.title": "Commands",
	"palette.tagTemplate": "template",
	"palette.tagSkill": "skill",
	"palette.tagPlugin": "plugin",
	"palette.tagTerminal": "terminal only",
	"palette.noCommands": "No command starts with that.",
	"palette.noCompletions": "Nothing to complete here.",
	"palette.hint": "Tab completes, Enter runs.",

	"shortcut.newSession": "New session",
	"shortcut.cycleView": "Switch management view",
	"shortcut.focusComposer": "Focus the composer",
	"shortcut.stop": "Stop the turn",

	"copy.copy": "Copy",
	"copy.copied": "Copied",
	"copy.failed": "Copy failed",

	"panel.unavailable": "The host did not offer this service.",
	"panel.empty": "Nothing here yet.",
	"panel.cancel": "Cancel",
	"panel.dismiss": "Close",

	"panel.settings.title": "Settings",
	"panel.settings.description":
		"The agent's settings: provider behaviour, reasoning, tools, and the shell.",
	"panel.settings.filesTitle": "Files",
	"panel.settings.filesDescription": "Where the values above are read from and written to.",
	"panel.settings.reload": "Re-read files",
	"panel.settings.diagnostics": "Read-only diagnostics",
	"panel.settings.diagnosticsHelp": "Local configuration and file observations. The report includes paths, but never credential values. Review it before sharing.",
	"panel.settings.diagnosticsLoading": "Reading local state…",
	"panel.settings.diagnosticsFailed": "Diagnostics could not complete. Check the host connection and retry.",
	"panel.settings.globalPath": "Global settings",
	"panel.settings.projectPath": "Project settings",
	"panel.settings.untrusted": "The project is not trusted, so its settings are not read.",
	"panel.settings.footnote":
		"A write goes to the global settings file. Other processes pick it up at their next start.",
	"panel.settings.notice": "{scope} settings ({path}): {message}",
	"panel.settings.noticePlain": "{scope} settings: {message}",
	"panel.settings.badgeDefault": "default",
	"panel.settings.invalidNumber": "Enter a whole number of at least {min}.",

	"panel.skills.title": "Skills",
	"panel.skills.description":
		"One folder per skill, each with a SKILL.md that carries a name and a description.",
	"panel.skills.loaded": "Loaded skills",
	"panel.skills.new": "New skill",
	"panel.skills.import": "Import…",
	"panel.skills.edit": "Edit",
	"panel.skills.view": "View",
	"panel.skills.remove": "Remove",
	"panel.skills.commandOnly": "command only",
	"panel.skills.empty":
		"No skills yet. New skills live in the agent directory and load when a session starts.",
	"panel.skills.footnote":
		"New and edited skills are written to {directory}. The agent loads skills when a session starts, like the CLI.",

	"panel.plugins.title": "Plugins",
	"panel.plugins.description":
		"Plugin packages the host builds, and the MCP servers the coding agent's tools read.",
	"panel.plugins.packages": "Plugin packages",
	"panel.plugins.packagesDescription":
		"A package is built into the Session's facet generation when a worker starts.",
	"panel.plugins.addPackage": "Add package…",
	"panel.plugins.packagesEmpty": "No plugin packages: sessions load the built-in facets only.",
	"panel.plugins.packagesFootnote":
		"Session packages apply to newly opened sessions. Host services apply after restarting the host. A running session keeps its current version.",
	"panel.plugins.reloadMcp": "Reload connections",
	"panel.plugins.reconnect": "Reconnect",
	"panel.plugins.login": "Sign in",
	"panel.plugins.runtime": "{state} · {tools} tools",
	"panel.plugins.loginFor": "Sign in to {server}",
	"panel.plugins.openAuthorization": "Open authorization page",
	"panel.plugins.pasteRedirect": "Paste redirect URL",
	"panel.plugins.cancelLogin": "Cancel sign-in",
	"panel.plugins.loginExpired": "This sign-in is no longer active. Start a new sign-in.",
	"panel.plugins.redirectHelp": "Approve access in the authorization page. Paste the full redirect URL if the browser cannot reach this host.",
	"panel.plugins.mcp": "MCP servers",
	"panel.plugins.mcpDescription": "Servers the coding agent's MCP extension connects, from mcp.json.",
	"panel.plugins.addServer": "Add server…",
	"panel.plugins.remove": "Remove",
	"panel.plugins.mcpEmpty": "No MCP servers configured in {path}.",
	"panel.plugins.mcpFootnote":
		"Configuration is shared with the CLI and TUI. The attached session owns its live connections.",
	"panel.plugins.fromExtension": "From extension",

	"panel.automation.title": "Automation",
	"panel.automation.description":
		"Prompts the host sends to a session on their own, whether or not this page is open.",
	"panel.automation.schedules": "Planned prompts",
	"panel.automation.conversation": "Conversation {id}",
	"panel.automation.running": "Waiting for result",
	"panel.automation.recoveryPending": "Run record needs recovery",
	"panel.automation.cancelling": "Waiting for cancellation",
	"panel.automation.cancel": "Cancel run",
	"panel.automation.add": "Plan a prompt…",
	"panel.automation.empty":
		"No planned prompts. A schedule sends its prompt to one session on its own and records what that run produced.",
	"panel.automation.unreadable": "Cannot read plans. Repair the file, then re-read it.",
	"panel.automation.noSession": "Attach a session to plan a prompt for it.",
	"panel.automation.everyMinute": "Every minute",
	"panel.automation.everyMinutes": "Every {count} minutes",
	"panel.automation.next": "Next run {when}",
	"panel.automation.dueNow": "now",
	"panel.automation.soon": "in under a minute",
	"panel.automation.inMinutes": "in {count} minutes",
	"panel.automation.inHours": "in {count} hours",
	"panel.automation.paused": "paused",
	"panel.automation.run": "Run now",
	"panel.automation.remove": "Remove",
	"panel.automation.footnote":
		"Stored in {path}. The host runs a due prompt against its session; the answer appears in that session's transcript.",

	"modal.skillNew.title": "New skill",
	"modal.skillNew.description": "The description decides when the agent loads the skill.",
	"modal.skillNew.name": "Name",
	"modal.skillNew.namePlaceholder": "weekly-report",
	"modal.skillNew.descriptionLabel": "Description",
	"modal.skillNew.descriptionPlaceholder": "When to use this skill",
	"modal.skillNew.body": "Instructions",
	"modal.create": "Create",
	"modal.skillEdit.title": "Edit {name}",
	"modal.skillEdit.description":
		"The whole SKILL.md. The frontmatter must keep the skill's name and a description.",
	"modal.skillView.description":
		"This skill lives outside the agent directory, so it is read-only here.",
	"modal.compact.title": "Compact context",
	"modal.compact.description":
		"Summarize the conversation so far and continue from the summary. Optional instructions steer what it keeps.",
	"modal.compact.instructions": "Instructions",
	"modal.compact.placeholder": "What the summary should keep",
	"modal.compact.submit": "Compact",
	"modal.skillFile": "SKILL.md",
	"modal.save": "Save",
	"modal.close": "Close",
	"modal.skillRemove.title": "Remove {name}?",
	"modal.skillRemove.description": "The skill's folder is deleted from the agent directory.",
	"modal.sessionRemove.title": "Remove session {id}?",
	"modal.sessionRemove.description":
		"The session's storage is deleted from the host. Its working directory is left alone.",
	"modal.sessionRemove.submit": "Remove",
	"modal.import.title": "Import a skill",
	"modal.import.description":
		"Copies a skill folder or markdown file into the agent's skills directory.",
	"modal.import.path": "Path",
	"modal.import.pathPlaceholder": "~/skills/weekly-report",
	"modal.import.submit": "Import",
	"modal.package.title": "Add a plugin package",
	"modal.package.description":
		"An absolute path to a package with src/session.ts, built when a session starts.",
	"modal.package.path": "Package path",
	"modal.package.pathPlaceholder": "/path/to/plugin",
	"modal.add": "Add",
	"modal.mcp.title": "Add an MCP server",
	"modal.mcp.description": "The server entry as JSON: a command for stdio, or a url for HTTP.",
	"modal.mcp.name": "Name",
	"modal.mcp.namePlaceholder": "filesystem",
	"modal.mcp.entry": "Entry",
	"modal.scheduleAdd.title": "Plan a prompt",
	"modal.scheduleAdd.description": "The host sends this prompt to conversation {conversation} in {session}. Changing the selected conversation keeps this target.",
	"modal.scheduleAdd.prompt": "Prompt",
	"modal.scheduleAdd.promptPlaceholder": "Summarize what changed since the last run",
	"modal.scheduleAdd.every": "Every (minutes)",
	"modal.scheduleAdd.submit": "Add",
	"modal.scheduleRemove.title": "Remove this planned prompt?",
	"modal.scheduleRemove.description":
		"The schedule is deleted from the host's file. What it already ran stays in the session.",
	"modal.scheduleRemove.submit": "Remove",

	"page.cannotBoot": "cannot boot: {error}",
	"page.noManifest": "the host served this document without its boot manifest",
	"page.attachFailed": "attach failed: {error}",
	"page.paintFailed": "could not render the host's state: {error}",
	"page.commandFailed": "command failed: {error}",
	"page.commandUnknown": "no such command: /{name}",
	"page.commandTargetChanged": "The conversation changed while expanding the command. Run it again in the current conversation.",
	"page.reloadTargetChanged": "The session changed during reload. Run /reload in the current session.",
	"page.pluginsReloaded": "Reloaded this session's plugins and command resources.",
	"page.pluginBuildFailed": "Could not rebuild the plugins. The current version remains active; check the plugin source and retry /reload.",
	"page.pluginActivationFailed": "Could not activate the plugins. Finish or abort active tasks, check plugin setup, then retry /reload.",
	"page.removeFailed": "remove failed: {error}",
	"page.newSessionFailed": "new session failed: {error}",
	"page.modelChangeFailed": "model change failed: {error}",
	"page.thinkingFailed": "thinking level failed: {error}",
	"page.sendFailed": "send failed: {error}",
	"page.abortFailed": "abort failed: {error}",
	"page.sessionName": "Session name: {name}",
	"page.sessionNameSet": "Session name set: {name}",
	"page.sessionNameNormalized": "Session name was normalized from {from} to {name}",
	"page.nameUsage": "Usage: /name <name>",
	"page.nameNeedsSession": "Attach a session before naming it.",
	"page.promptRejected": "prompt rejected: {error}",
	"page.panelFailed": "panel action failed: {error}",
	"page.streamFailed": "stream error: {error}",
	"page.modelStateFailed": "model state failed: {error}",
	"page.attachmentFailed": "could not read {name}",
	"page.compactFailed": "compact failed: {error}",
	"page.queueGone": "that queued input is already gone",
	"page.queueCancelFailed": "withdraw failed: {error}",
	"page.refreshFailed": "model refresh failed: {error}",
	"page.skillNeedsName": "a skill needs a name",
	"page.packageNeedsPath": "a plugin package needs a path",
	"page.scheduleFailed": "schedule failed: {error}",
	"page.scheduleNeedsMinutes": "the gap must be a whole number of minutes, at least one",
	"page.scheduleNeedsPrompt": "a planned prompt needs its text",

	"desktop.menu.undo": "Undo",
	"desktop.menu.redo": "Redo",
	"desktop.menu.cut": "Cut",
	"desktop.menu.copy": "Copy",
	"desktop.menu.paste": "Paste",
	"desktop.menu.selectAll": "Select All",
	"desktop.dialog.reload": "Reload",
	"desktop.dialog.quit": "Quit",
	"desktop.render.gone.title": "Page error",
	"desktop.render.gone.message": "The page process exited ({reason}, exit code {exitCode}).",
	"desktop.render.load.title": "Page failed to load",
	"desktop.render.load.message": "The page did not load ({errorCode} {errorDescription}).",
	"desktop.render.reason.clean-exit": "clean exit",
	"desktop.render.reason.abnormal-exit": "abnormal exit",
	"desktop.render.reason.killed": "killed",
	"desktop.render.reason.crashed": "crashed",
	"desktop.render.reason.oom": "out of memory",
	"desktop.render.reason.launch-failed": "launch failed",
	"desktop.render.reason.integrity-failure": "integrity failure",
	"desktop.render.reason.memory-eviction": "memory eviction",
	"desktop.host.spawn.title": "Host failed to start",
	"desktop.host.spawn.message": "Could not start the web host: {message}",
	"desktop.host.early.title": "Host failed to start",
	"desktop.host.early.message": "The web host exited before it was ready (exit code {code}, signal {signal}).",
	"desktop.host.timeout.title": "Host failed to start",
	"desktop.host.timeout.message": "The web host was not ready in time: {message}",
	"desktop.host.invalid.title": "Host failed to start",
	"desktop.host.invalid.message": "The web host failed while starting: {message}",
	"desktop.host.crashed.title": "Host exited",
	"desktop.host.crashed.message": "The web host exited unexpectedly (exit code {code}, signal {signal}).",
	"desktop.host.none": "none",
	"desktop.host.noOutput": "(no output)",
} as const;

export type MessageKey = keyof typeof EN;

export const ZH: Readonly<Record<MessageKey, string>> = {
	"panel.automation.busyQueue": "忙碌时排队",
	"panel.automation.busySkip": "忙碌时跳过",
	"panel.automation.missedLatest": "错过后合并最新一次",
	"panel.automation.missedSkip": "超过宽限期跳过",
	"panel.automation.timeout": "超时 {seconds} 秒",
	"panel.automation.finished": "无后续触发",
	"panel.automation.edit": "编辑",
	"panel.automation.history": "运行记录",
	"panel.automation.historyFinished": "结束：{time}",
	"panel.automation.historyDue": "计划时间：{time}",
	"panel.automation.added": "已添加计划",
	"panel.automation.updated": "已更新计划",
	"panel.automation.enabled": "已启用",
	"panel.automation.idle": "没有正在执行的请求",
	"panel.automation.done": "已完成",
	"panel.automation.cancelled": "已取消",
	"panel.automation.skipped": "已跳过",
	"panel.automation.refused": "未接纳",
	"panel.automation.unanswered": "没有回答",
	"panel.automation.timed_out": "已超时",
	"panel.automation.reasonBusy": "会话忙碌",
	"panel.automation.reasonMissed": "超过错过宽限期",
	"panel.automation.oneTime": "一次性：{at} · {zone}",
	"panel.automation.cronRule": "{expression} · {zone}",
	"modal.scheduleAdd.editTitle": "编辑定时任务",
	"modal.scheduleAdd.save": "保存",
	"modal.scheduleAdd.kind": "时间规则",
	"modal.scheduleAdd.interval": "固定间隔",
	"modal.scheduleAdd.once": "一次性",
	"modal.scheduleAdd.cron": "日历（cron）",
	"modal.scheduleAdd.at": "本地日期与时间",
	"modal.scheduleAdd.expression": "Cron 表达式",
	"modal.scheduleAdd.timeZone": "时区",
	"modal.scheduleAdd.cronHelp": "五个数字字段：分钟 小时 日 月 星期。0 9 * * 1-5 为工作日 09:00。支持 *、列表、范围和步长，周日为 0 或 7。日与星期都指定时满足任一即可。",
	"modal.scheduleAdd.zoneHelp": "IANA 时区，如 Asia/Shanghai。夏令时重复时间只取首次；不存在的时间会跳过，一次性规则则拒绝保存。",
	"modal.scheduleAdd.busy": "会话忙碌时",
	"modal.scheduleAdd.queue": "排队",
	"modal.scheduleAdd.skip": "跳过",
	"modal.scheduleAdd.missed": "错过执行时",
	"modal.scheduleAdd.latest": "合并最新一次",
	"modal.scheduleAdd.grace": "错过宽限（分钟，0–10080）",
	"modal.scheduleAdd.timeout": "超时（秒，1–86400）",
	"nav.chat": "对话",
	"nav.plugins": "插件",
	"nav.skills": "技能",
	"nav.automation": "自动化",
	"nav.settings": "设置",

	"sidebar.newSession": "新建会话",
	"sidebar.creating": "正在打开会话…",
	"sidebar.untitled": "新会话",
	"sidebar.more": "会话操作",
	"sidebar.rename": "重命名",
	"sidebar.copyId": "复制会话 ID",
	"modal.sessionRename.title": "重命名会话",
	"modal.sessionRename.name": "会话名称",
	"page.nameRequired": "请输入会话名称。",
	"sidebar.sessions": "会话",
	"sidebar.filter": "过滤会话",
	"sidebar.remove": "删除",
	"sidebar.localSession": "终端",
	"sidebar.removeAria": "删除这个会话",
	"sidebar.management": "管理",
	"sidebar.waiting": "正在等待宿主…",
	"sidebar.toggle": "显示或隐藏侧栏",

	"roster.today": "今天",
	"roster.yesterday": "昨天",
	"roster.week": "最近七天",
	"roster.earlier": "更早",

	"greeting.title": "今天想做点什么？",
	"greeting.hint": "输入 / 打开命令。Enter 发送，Shift+Enter 换行。",
	"greeting.pickTitle": "选一个会话继续",
	"greeting.pickHint": "也可以新建一个。",
	"greeting.startTitle": "新建一个会话开始",
	"greeting.startHint": "新会话会出现在左侧列表里。",

	"header.noSession": "无会话",
	"header.back": "返回对话",
	"header.noSessionAttached": "尚未附加会话。",
	"header.noEntries": "这个会话还没有内容。",
	"header.rosterEmpty": "这台宿主上还没有会话。",
	"header.rosterNoMatch": "没有匹配这个过滤条件的会话。",
	"header.conversation": "{session} · {conversation}",
	"header.connecting": "正在连接宿主…",
	"header.meter": "上下文 {context}，token {tokens}，费用 {cost}",
	"header.pendingApprovals": "等待审批 {count}",

	"connection.starting": "启动中…",
	"connection.connecting": "连接中…",
	"connection.connected": "已连接 · {id}",
	"connection.stateConnected": "已连接",
	"connection.stateDisconnected": "已断开",
	"connection.disconnected": "连接断开：{error}",
	"connection.retrying": "连接已断开：{error} — 正在重试",
	"connection.hostGone": "宿主已退出",

	"composer.placeholder": "给 {name} 发送任务",
	"composer.placeholderDetached": "尚未附加会话",
	"composer.send": "发送",
	"composer.stop": "停止",
	"composer.steer": "介入",
	"composer.queue": "排队",
	"composer.modesAria": "回合运行中，下一条消息的应用方式",
	"composer.attachments": "已附加的图片",
	"composer.attach": "附加图片",
	"composer.removeAttachment": "移除这张图片",
	"composer.attachmentUnsupported": "{name} 不是本页可以发送的图片（PNG、JPEG、WebP 或 GIF）。",
	"composer.attachmentTooLarge": "{name} 超过了 {limit}。",
	"composer.attachmentLimit": "8 MB",

	"queue.cancel": "撤回",
	"queue.cancelAria": "撤回这条排队输入",

	"header.compact": "压缩上下文",
	"header.fork": "分叉",

	"model.none": "无模型",
	"model.menuAria": "模型与推理强度",
	"model.chipAria": "模型与推理强度：{name}",
	"model.heading": "模型",
	"model.effort": "推理强度",
	"model.empty": "没有可用模型。",
	"model.levelsEmpty": "该模型不提供推理强度档位。",
	"model.refresh": "刷新模型",
	"model.refreshing": "正在刷新模型…",
	"model.refreshDone": "模型已刷新。",
	"model.refreshWarning": "{providers} 刷新失败。",
	"auth.title": "供应商账号",
	"auth.provider": "供应商",
	"auth.method": "登录方式或操作",
	"auth.configured": "已配置",
	"auth.help": "登录后可选择该供应商的模型。退出只删除保存的凭据，环境变量中的凭据仍可使用。",
	"auth.logout": "删除保存的凭据",
	"auth.loggedOut": "已删除保存的凭据；环境变量中的凭据仍可能可用。",
	"auth.continue": "继续",
	"auth.open": "打开授权页面",
	"auth.deviceCode": "授权码",
	"auth.cancel": "取消登录",
	"auth.waiting": "正在等待供应商。关闭此窗口后，可从供应商账号入口继续。",
	"auth.done": "已登录，请从模型菜单选择模型。",
	"auth.cancelled": "已取消登录。",
	"auth.failed": "供应商登录失败，请重试或通过 CLI 检查认证。",
	"auth.expired": "该登录提示已失效，请打开供应商账号继续。",
	"auth.required": "请输入凭据后继续。",
	"auth.invalid": "请选择可用的供应商和登录方式。",

	"block.you": "你",
	"block.thinking": "思考",
	"block.compaction": "上下文压缩",
	"block.newContext": "新上下文",
	"block.truncated": "已截断",
	"block.truncatedText": "回答在完成前被截断。",
	"block.aborted": "已中止",
	"block.abortedText": "操作已中止",
	"block.error": "错误",
	"block.errorText": "未知错误",
	"tool.noOutput": "（无输出）",
	"tool.completed": "已完成",
	"tool.failed": "执行失败",
	"tool.duration": "{seconds} 秒",
	"tool.nested": "嵌套调用",
	"tool.appliedDiff": "已应用的更改",
	"tool.exitCode": "退出码 {code}",
	"tool.copyPatch": "复制补丁",
	"tool.viewImage": "查看图片",
	"tool.closeImage": "关闭图片",
	"tool.errorText": "工具报错",
	"tool.notRun": "未执行：回答被中断。",

	"queue.steer": "介入",
	"queue.followUp": "后续",
	"queue.write": "写入",

	"status.retrying": "重试中（第 {attempt} 次）：{error}",
	"status.deferred": "等待延迟响应…",
	"status.compactingRetry": "重试{reason}压缩（第 {attempt} 次）…",
	"status.compacting": "压缩中（{reason}）…",
	"status.runningTool": "正在运行 {name}…",
	"status.working": "处理中…",

	"lane.main": "主线",
	"lane.fork": "分叉",
	"lane.subagent": "子代理",
	"lane.noModel": "未选模型",
	"lane.thinking": "推理 {level}",
	"lane.idle": "空闲",
	"lane.retrying": "重试 {detail}",
	"lane.deferred": "等待",
	"lane.compacting": "压缩中（{detail}）",
	"lane.tool": "正在运行 {detail}",
	"lane.working": "处理中",

	"dock.toggle": "会话工具",
	"dock.conversations": "会话",
	"dock.tasks": "任务",
	"dock.main": "主线",
	"dock.untitled": "新对话",
	"dock.child": "子代理",
	"dock.fork": "分叉",
	"dock.owner": "由 {conversation} 中的 {task} 创建",
	"dock.forkedFrom": "从会话 {conversation} 的条目 {entry} 分出",
	"dock.children": "{count} 个子会话",
	"dock.selected": "当前",
	"dock.select": "打开",
	"dock.noConversations": "这个会话还没有其他会话。",
	"dock.noTasks": "当前没有运行中的任务。",
	"dock.taskWaitsOn": "等待 {tasks}",
	"dock.taskOwns": "拥有 {conversations}",
	"dock.taskPhase": "阶段 {phase}",
	"dock.background": "后台",
	"dock.files": "文件",
	"dock.terminal": "终端",
	"dock.cwd": "工作目录",
	"dock.parent": "上一层",
	"dock.open": "打开",
	"dock.read": "查看",
	"dock.reload": "重新读取",
	"dock.directory": "目录",
	"dock.contents": "内容",
	"dock.root": "工作目录",
	"dock.emptyDirectory": "这个目录是空的。",
	"dock.binary": "这个文件不是文本，工作区不显示它。",
	"dock.missing": "这个路径已经不在了。",
	"dock.truncated": "这里只显示这段文本的开头。",
	"dock.command": "命令",
	"dock.run": "运行",
	"dock.stop": "停止",
	"dock.runPlaceholder": "在会话目录里运行一条命令",
	"dock.noOutput": "还没有输出。",
	"dock.terminalIdle": "还没有运行过命令",
	"dock.terminalRunning": "正在运行 {command}",
	"dock.terminalDone": "已结束，退出码 {code}",
	"dock.terminalCancelled": "已停止",
	"dock.terminalFailed": "无法运行：{error}",

	"feedback.up": "有帮助",
	"feedback.down": "没帮助",
	"feedback.rated": "已评：{rating}",

	"history.more": "加载更早",
	"history.loading": "正在加载更早的内容…",
	"history.start": "更早的内容",

	"approval.title": "等待你的决定",
	"approval.approve": "通过",
	"approval.deny": "拒绝",
	"approval.tool": "{tool} 想要运行",
	"approval.hint": "拒绝会把这次调用结算成失败的工具结果，回合继续往下走。",

	"welcome.title": "欢迎使用 AmazMe 网页客户端",
	"welcome.body":
		"这个页面驱动一个正在运行的 AmazMe 宿主：会话、它们的对话、工作目录里的文件，以及一个 shell。现在什么都还没有，先建一个会话吧。",
	"welcome.step.session": "新建会话",
	"welcome.step.files": "打开会话工具",
	"welcome.step.settings": "打开设置",
	"welcome.dismiss": "不再显示",
	"welcome.note": "引导可以在「设置 → 界面 → 欢迎引导」里重新打开。",

	"palette.title": "命令",
	"palette.tagTemplate": "模板",
	"palette.tagSkill": "技能",
	"palette.tagPlugin": "插件",
	"palette.tagTerminal": "仅终端",
	"palette.noCommands": "没有以它开头的命令。",
	"palette.noCompletions": "这里没有可补全的取值。",
	"palette.hint": "Tab 补全，Enter 运行。",

	"shortcut.newSession": "新建会话",
	"shortcut.cycleView": "切换管理视图",
	"shortcut.focusComposer": "聚焦输入框",
	"shortcut.stop": "停止回合",

	"copy.copy": "复制",
	"copy.copied": "已复制",
	"copy.failed": "复制失败",

	"panel.unavailable": "宿主未提供该服务。",
	"panel.empty": "这里暂时没有内容。",
	"panel.cancel": "取消",
	"panel.dismiss": "关闭",

	"panel.settings.title": "设置",
	"panel.settings.description": "智能体的设置：供应商行为、推理、工具与 shell。",
	"panel.settings.filesTitle": "文件",
	"panel.settings.filesDescription": "以上取值的读写位置。",
	"panel.settings.reload": "重新读取文件",
	"panel.settings.diagnostics": "只读诊断",
	"panel.settings.diagnosticsHelp": "检查本地配置与文件状态。报告包含路径，不包含凭据值。分享前请检查内容。",
	"panel.settings.diagnosticsLoading": "正在读取本地状态…",
	"panel.settings.diagnosticsFailed": "诊断未完成。检查宿主连接后重试。",
	"panel.settings.globalPath": "全局设置",
	"panel.settings.projectPath": "项目设置",
	"panel.settings.untrusted": "项目未受信任，因此不读取其设置。",
	"panel.settings.footnote": "写入落到全局设置文件，其他进程在下次启动时读取。",
	"panel.settings.notice": "{scope}设置（{path}）：{message}",
	"panel.settings.noticePlain": "{scope}设置：{message}",
	"panel.settings.badgeDefault": "默认",
	"panel.settings.invalidNumber": "请输入不小于 {min} 的整数。",

	"panel.skills.title": "技能",
	"panel.skills.description": "每个技能一个目录，目录里的 SKILL.md 带有名称和描述。",
	"panel.skills.loaded": "已加载技能",
	"panel.skills.new": "新建技能",
	"panel.skills.import": "导入…",
	"panel.skills.edit": "编辑",
	"panel.skills.view": "查看",
	"panel.skills.remove": "删除",
	"panel.skills.commandOnly": "仅命令",
	"panel.skills.empty": "还没有技能。新技能放在智能体目录里，会话启动时加载。",
	"panel.skills.footnote": "新建和编辑的技能写入 {directory}。与 CLI 一样，智能体在会话启动时加载技能。",

	"panel.plugins.title": "插件",
	"panel.plugins.description": "宿主构建的插件包，以及编码智能体工具读取的 MCP 服务。",
	"panel.plugins.packages": "插件包",
	"panel.plugins.packagesDescription": "工作进程启动时，插件包会被构建进会话的 facet 代际。",
	"panel.plugins.addPackage": "添加插件包…",
	"panel.plugins.packagesEmpty": "还没有插件包：会话只加载内置 facet。",
	"panel.plugins.packagesFootnote": "会话插件作用于之后打开的会话，宿主服务在重启宿主后生效；运行中的会话保留当前版本。",
	"panel.plugins.reloadMcp": "重新加载连接",
	"panel.plugins.reconnect": "重连",
	"panel.plugins.login": "登录",
	"panel.plugins.runtime": "{state} · {tools} 个工具",
	"panel.plugins.loginFor": "登录 {server}",
	"panel.plugins.openAuthorization": "打开授权页面",
	"panel.plugins.pasteRedirect": "粘贴重定向 URL",
	"panel.plugins.cancelLogin": "取消登录",
	"panel.plugins.loginExpired": "此次登录已结束，请重新发起登录。",
	"panel.plugins.redirectHelp": "在授权页面批准访问。若浏览器无法连接此宿主，请粘贴完整的重定向 URL。",
	"panel.plugins.mcp": "MCP 服务",
	"panel.plugins.mcpDescription": "编码智能体的 MCP 扩展连接的服务器，来自 mcp.json。",
	"panel.plugins.addServer": "添加服务…",
	"panel.plugins.remove": "删除",
	"panel.plugins.mcpEmpty": "还没有在 {path} 中配置 MCP 服务。",
	"panel.plugins.mcpFootnote": "配置与 CLI 和 TUI 共用，已附加的会话拥有实际连接。",
	"panel.plugins.fromExtension": "来自扩展",

	"panel.automation.title": "自动化",
	"panel.automation.description": "宿主按设定自行发给会话的提示，不需要打开页面。",
	"panel.automation.schedules": "定时任务",
	"panel.automation.conversation": "分支 {id}",
	"panel.automation.running": "等待结果",
	"panel.automation.recoveryPending": "运行记录待恢复",
	"panel.automation.cancelling": "正在等待取消完成",
	"panel.automation.cancel": "取消运行",
	"panel.automation.add": "新建定时任务…",
	"panel.automation.empty": "还没有定时任务。每个任务会自行把提示发给一个会话，并记录这次运行的结果。",
	"panel.automation.unreadable": "无法读取定时任务。修复文件后重新读取。",
	"panel.automation.noSession": "先附加一个会话，才能为它新建定时任务。",
	"panel.automation.everyMinute": "每分钟",
	"panel.automation.everyMinutes": "每 {count} 分钟",
	"panel.automation.next": "下次运行 {when}",
	"panel.automation.dueNow": "就在现在",
	"panel.automation.soon": "不到一分钟后",
	"panel.automation.inMinutes": "{count} 分钟后",
	"panel.automation.inHours": "{count} 小时后",
	"panel.automation.paused": "已暂停",
	"panel.automation.run": "立即运行",
	"panel.automation.remove": "删除",
	"panel.automation.footnote": "保存在 {path}。到点的任务由宿主发给它的会话，回答会出现在该会话的记录里。",

	"modal.skillNew.title": "新建技能",
	"modal.skillNew.description": "描述决定智能体何时加载这个技能。",
	"modal.skillNew.name": "名称",
	"modal.skillNew.namePlaceholder": "weekly-report",
	"modal.skillNew.descriptionLabel": "描述",
	"modal.skillNew.descriptionPlaceholder": "何时使用这个技能",
	"modal.skillNew.body": "指令",
	"modal.create": "创建",
	"modal.skillEdit.title": "编辑 {name}",
	"modal.skillEdit.description": "完整的 SKILL.md。前置元数据必须保留技能名称和描述。",
	"modal.skillView.description": "这个技能位于智能体目录之外，这里只读。",
	"modal.compact.title": "压缩上下文",
	"modal.compact.description": "把到目前为止的对话压缩成摘要并从中继续；可选指令用于引导摘要保留什么。",
	"modal.compact.instructions": "指令",
	"modal.compact.placeholder": "摘要需要保留的内容",
	"modal.compact.submit": "压缩",
	"modal.skillFile": "SKILL.md",
	"modal.save": "保存",
	"modal.close": "关闭",
	"modal.skillRemove.title": "删除 {name}？",
	"modal.skillRemove.description": "这个技能的目录会从智能体目录中删除。",
	"modal.sessionRemove.title": "删除会话 {id}？",
	"modal.sessionRemove.description": "该会话的存储在宿主上被删除；工作目录本身不动。",
	"modal.sessionRemove.submit": "删除",
	"modal.import.title": "导入技能",
	"modal.import.description": "把技能目录或 Markdown 文件复制到智能体的技能目录。",
	"modal.import.path": "路径",
	"modal.import.pathPlaceholder": "~/skills/weekly-report",
	"modal.import.submit": "导入",
	"modal.package.title": "添加插件包",
	"modal.package.description": "插件包的绝对路径，包内要有 src/session.ts，会话启动时构建。",
	"modal.package.path": "插件包路径",
	"modal.package.pathPlaceholder": "/path/to/plugin",
	"modal.add": "添加",
	"modal.mcp.title": "添加 MCP 服务",
	"modal.mcp.description": "以 JSON 描述服务条目：stdio 用 command，HTTP 用 url。",
	"modal.mcp.name": "名称",
	"modal.mcp.namePlaceholder": "filesystem",
	"modal.mcp.entry": "条目",
	"modal.scheduleAdd.title": "新建定时任务",
	"modal.scheduleAdd.description": "宿主会按设定把提示发给 {session} 的分支 {conversation}。切换当前分支不会改变此目标。",
	"modal.scheduleAdd.prompt": "提示",
	"modal.scheduleAdd.promptPlaceholder": "总结上次运行以来的变化",
	"modal.scheduleAdd.every": "间隔（分钟）",
	"modal.scheduleAdd.submit": "添加",
	"modal.scheduleRemove.title": "删除这个定时任务？",
	"modal.scheduleRemove.description": "任务会从宿主的文件里删除；它已经运行过的内容仍留在会话里。",
	"modal.scheduleRemove.submit": "删除",

	"page.cannotBoot": "无法启动：{error}",
	"page.noManifest": "宿主提供的文档缺少启动清单",
	"page.attachFailed": "附加失败：{error}",
	"page.paintFailed": "无法渲染宿主状态：{error}",
	"page.commandFailed": "命令失败：{error}",
	"page.commandUnknown": "没有这个命令：/{name}",
	"page.commandTargetChanged": "命令展开时对话已切换，请在当前对话重试。",
	"page.reloadTargetChanged": "重载期间会话已切换，请在当前会话重新执行 /reload。",
	"page.pluginsReloaded": "已重载当前会话的插件与命令资源。",
	"page.pluginBuildFailed": "无法重新构建插件，当前版本继续可用。请检查插件源码后重试 /reload。",
	"page.pluginActivationFailed": "无法激活插件。请先完成或取消活动任务，检查插件初始化后重试 /reload。",
	"page.removeFailed": "删除失败：{error}",
	"page.newSessionFailed": "新建会话失败：{error}",
	"page.modelChangeFailed": "切换模型失败：{error}",
	"page.thinkingFailed": "切换推理强度失败：{error}",
	"page.sendFailed": "发送失败：{error}",
	"page.abortFailed": "中止失败：{error}",
	"page.sessionName": "会话名：{name}",
	"page.sessionNameSet": "会话名已设为：{name}",
	"page.sessionNameNormalized": "会话名已从 {from} 规范为 {name}",
	"page.nameUsage": "用法：/name <名称>",
	"page.nameNeedsSession": "先附着一个会话再命名。",
	"page.promptRejected": "提示被拒绝：{error}",
	"page.panelFailed": "面板操作失败：{error}",
	"page.streamFailed": "流错误：{error}",
	"page.modelStateFailed": "读取模型状态失败：{error}",
	"page.attachmentFailed": "无法读取 {name}",
	"page.compactFailed": "压缩失败：{error}",
	"page.queueGone": "这条排队输入已经不存在了",
	"page.queueCancelFailed": "撤回失败：{error}",
	"page.refreshFailed": "刷新模型失败：{error}",
	"page.skillNeedsName": "技能需要名称",
	"page.packageNeedsPath": "插件包需要路径",
	"page.scheduleFailed": "定时任务操作失败：{error}",
	"page.scheduleNeedsMinutes": "间隔必须是不少于 1 分钟的整数",
	"page.scheduleNeedsPrompt": "定时任务需要提示内容",

	"desktop.menu.undo": "撤销",
	"desktop.menu.redo": "重做",
	"desktop.menu.cut": "剪切",
	"desktop.menu.copy": "复制",
	"desktop.menu.paste": "粘贴",
	"desktop.menu.selectAll": "全选",
	"desktop.dialog.reload": "重新加载",
	"desktop.dialog.quit": "退出",
	"desktop.render.gone.title": "页面出错",
	"desktop.render.gone.message": "页面进程已退出（{reason}，退出码 {exitCode}）。",
	"desktop.render.load.title": "页面加载失败",
	"desktop.render.load.message": "页面没有加载成功（{errorCode} {errorDescription}）。",
	"desktop.render.reason.clean-exit": "正常退出",
	"desktop.render.reason.abnormal-exit": "异常退出",
	"desktop.render.reason.killed": "被终止",
	"desktop.render.reason.crashed": "崩溃",
	"desktop.render.reason.oom": "内存不足",
	"desktop.render.reason.launch-failed": "启动失败",
	"desktop.render.reason.integrity-failure": "完整性校验失败",
	"desktop.render.reason.memory-eviction": "内存被回收",
	"desktop.host.spawn.title": "宿主启动失败",
	"desktop.host.spawn.message": "无法启动网页宿主：{message}",
	"desktop.host.early.title": "宿主启动失败",
	"desktop.host.early.message": "网页宿主尚未就绪就退出了（退出码 {code}，信号 {signal}）。",
	"desktop.host.timeout.title": "宿主启动失败",
	"desktop.host.timeout.message": "网页宿主没有在时限内就绪：{message}",
	"desktop.host.invalid.title": "宿主启动失败",
	"desktop.host.invalid.message": "网页宿主启动失败：{message}",
	"desktop.host.crashed.title": "宿主已退出",
	"desktop.host.crashed.message": "网页宿主意外退出了（退出码 {code}，信号 {signal}）。",
	"desktop.host.none": "无",
	"desktop.host.noOutput": "（无输出）",
};

/** One settings field's copy: the row's title, its one-line explanation, and a control placeholder. */
export interface SettingCopy {
	readonly label: string;
	readonly description: string;
	readonly placeholder?: string;
}

const EN_SETTING_GROUPS: Readonly<Record<string, string>> = {
	interface: "Interface",
	conversation: "Conversation",
	"models-reasoning": "Models & reasoning",
	"skills-tools": "Skills & tools",
	approvals: "Approvals",
	"network-retries": "Network & retries",
	"images-rendering": "Images & rendering",
	projects: "Projects",
	shell: "Shell",
};

const ZH_SETTING_GROUPS: Readonly<Record<string, string>> = {
	interface: "界面",
	conversation: "对话",
	"models-reasoning": "模型与推理",
	"skills-tools": "技能与工具",
	approvals: "审批",
	"network-retries": "网络与重试",
	"images-rendering": "图片与渲染",
	projects: "项目",
	shell: "Shell",
};

const EN_SETTING_FIELDS: Readonly<Record<string, SettingCopy>> = {
	locale: {
		label: "Language",
		description: "The interface language of the web page and other graphical surfaces.",
	},
	appearance: {
		label: "Appearance",
		description: "The palette the web page applies: the system's, or one fixed choice.",
	},
	compactionEnabled: {
		label: "Auto-compact",
		description: "Summarize the context when a conversation outgrows the model window.",
	},
	steeringMode: {
		label: "Steering mode",
		description: "How messages sent while a turn runs are applied.",
	},
	followUpMode: {
		label: "Follow-up mode",
		description: "How a message is queued when the turn would otherwise finish.",
	},
	hideThinkingBlock: {
		label: "Hide thinking blocks",
		description: "Fold the model's reasoning away wherever it is rendered.",
	},
	defaultThinkingLevel: {
		label: "Default thinking level",
		description: "The reasoning effort a conversation starts with.",
	},
	cacheWarming: {
		label: "Cache warming",
		description: "Pre-warm the prompt cache, which costs a call each time it runs.",
	},
	showCacheMissNotices: {
		label: "Cache miss notices",
		description: "Show the cost and provider recovery notices a cache miss produces.",
	},
	enableSkillCommands: {
		label: "Skills as commands",
		description: "Register every loaded skill as a slash command.",
	},
	showWelcome: {
		label: "Welcome guide",
		description: "Show the short first-run guide while this host has no sessions.",
	},
	toolApproval: {
		label: "Tool confirmation",
		description: "Which tool calls wait for a decision before they run.",
	},
	transport: {
		label: "Transport",
		description: "How provider requests are carried.",
	},
	httpIdleTimeoutMs: {
		label: "HTTP idle timeout (ms)",
		description: "Header and body idle timeout for provider requests; 0 disables it.",
	},
	retryEnabled: {
		label: "Provider retries",
		description: "Retry a provider request that failed with a retryable error.",
	},
	imageAutoResize: {
		label: "Auto-resize images",
		description: "Scale attached images down for provider compatibility.",
	},
	blockImages: {
		label: "Block images",
		description: "Keep every image out of provider requests.",
	},
	mermaidRenderingMode: {
		label: "Mermaid diagrams",
		description: "When mermaid blocks in an answer are rendered as diagrams.",
	},
	defaultProjectTrust: {
		label: "Default project trust",
		description: "Whether a project's settings, extensions, and MCP servers load without being asked.",
	},
	quietStartup: {
		label: "Startup output",
		description: "How much the CLI prints when a session starts.",
	},
	shellPath: {
		label: "Shell path",
		description: "Shell used for the bash tool; empty uses the platform default.",
		placeholder: "System default",
	},
	shellCommandPrefix: {
		label: "Shell command prefix",
		description: "Prepended to every bash command, for example to enable aliases.",
		placeholder: "None",
	},
};

const ZH_SETTING_FIELDS: Readonly<Record<string, SettingCopy>> = {
	locale: {
		label: "界面语言",
		description: "网页及其他图形界面的语言。",
	},
	appearance: {
		label: "外观",
		description: "网页使用的配色：跟随系统，或固定为浅色、深色。",
	},
	compactionEnabled: {
		label: "自动压缩",
		description: "对话超出模型窗口时，压缩并总结上下文。",
	},
	steeringMode: {
		label: "介入方式",
		description: "回合运行中发送的消息如何应用。",
	},
	followUpMode: {
		label: "后续方式",
		description: "回合即将结束时的消息如何排队。",
	},
	hideThinkingBlock: {
		label: "隐藏思考块",
		description: "在所有呈现中折叠模型的推理内容。",
	},
	defaultThinkingLevel: {
		label: "默认推理强度",
		description: "对话启动时使用的推理强度。",
	},
	cacheWarming: {
		label: "缓存预热",
		description: "提前预热提示缓存，每次运行都会产生一次调用。",
	},
	showCacheMissNotices: {
		label: "缓存未命中提示",
		description: "显示缓存未命中产生的费用与供应商恢复提示。",
	},
	enableSkillCommands: {
		label: "技能作为命令",
		description: "把每个已加载的技能注册为斜杠命令。",
	},
	showWelcome: {
		label: "欢迎引导",
		description: "在这台宿主还没有会话时，显示简短的上手引导。",
	},
	toolApproval: {
		label: "工具确认",
		description: "哪些工具调用在运行前等待确认。",
	},
	transport: {
		label: "传输方式",
		description: "供应商请求的承载方式。",
	},
	httpIdleTimeoutMs: {
		label: "HTTP 空闲超时（毫秒）",
		description: "供应商请求的头部与正文空闲超时；0 表示不超时。",
	},
	retryEnabled: {
		label: "供应商重试",
		description: "对可重试的失败请求再次发起请求。",
	},
	imageAutoResize: {
		label: "自动缩放图片",
		description: "把附带的图片缩小，以提升供应商兼容性。",
	},
	blockImages: {
		label: "拦截图片",
		description: "任何图片都不进入供应商请求。",
	},
	mermaidRenderingMode: {
		label: "Mermaid 图表",
		description: "回答中的 mermaid 代码块何时渲染成图表。",
	},
	defaultProjectTrust: {
		label: "默认项目信任",
		description: "项目的设置、扩展和 MCP 服务是否无需询问即可加载。",
	},
	quietStartup: {
		label: "启动输出",
		description: "会话启动时 CLI 打印多少内容。",
	},
	shellPath: {
		label: "Shell 路径",
		description: "bash 工具使用的 shell；留空使用平台默认值。",
		placeholder: "系统默认",
	},
	shellCommandPrefix: {
		label: "Shell 命令前缀",
		description: "附加在每个 bash 命令之前，例如用于启用别名。",
		placeholder: "无",
	},
};

/** An enum control's names, keyed by the field's catalogue id and then its stored value. */
const EN_SETTING_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	locale: { auto: "Browser default", zh: "中文", en: "English" },
	appearance: { system: "System", light: "Light", dark: "Dark" },
	steeringMode: { "one-at-a-time": "One at a time", all: "All at once" },
	followUpMode: { "one-at-a-time": "One at a time", all: "All at once" },
	cacheWarming: { off: "Off", streaming: "While streaming", idle: "Between runs too" },
	mermaidRenderingMode: { off: "Off", final: "Settled answers", streaming: "While streaming" },
	transport: { auto: "Auto", websocket: "WebSocket", sse: "SSE" },
	defaultProjectTrust: { ask: "Ask", always: "Always trust", never: "Never trust" },
	toolApproval: { off: "Run without asking", dangerous: "Ask before changes", all: "Ask before every call" },
	quietStartup: { false: "Show startup output", header: "Header only", true: "Hide startup output" },
};

const ZH_SETTING_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	locale: { auto: "跟随浏览器", zh: "中文", en: "English" },
	appearance: { system: "跟随系统", light: "浅色", dark: "深色" },
	steeringMode: { "one-at-a-time": "逐条应用", all: "全部应用" },
	followUpMode: { "one-at-a-time": "逐条排队", all: "全部排队" },
	cacheWarming: { off: "关闭", streaming: "流式过程中", idle: "回合之间也预热" },
	mermaidRenderingMode: { off: "关闭", final: "回答结束后", streaming: "流式过程中" },
	transport: { auto: "自动", websocket: "WebSocket", sse: "SSE" },
	defaultProjectTrust: { ask: "询问", always: "始终信任", never: "从不信任" },
	toolApproval: { off: "直接运行", dangerous: "改动前询问", all: "每次调用都询问" },
	quietStartup: { false: "显示启动输出", header: "只显示标题", true: "隐藏启动输出" },
};

/** Reasoning effort names, shared by the settings control and the composer's effort picker. */
const EN_THINKING_LEVELS: Readonly<Record<string, string>> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

const ZH_THINKING_LEVELS: Readonly<Record<string, string>> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
};

/** Where a settings error came from: the agent directory's file, or the checkout's overrides. */
const EN_SETTING_SCOPES: Readonly<Record<string, string>> = { global: "Global", project: "Project" };
const ZH_SETTING_SCOPES: Readonly<Record<string, string>> = { global: "全局", project: "项目" };

/** Which mcp.json an MCP server entry came from, or the extension that registered it. */
const EN_MCP_SCOPES: Readonly<Record<string, string>> = {
	global: "global",
	project: "project",
	extension: "extension",
};
const ZH_MCP_SCOPES: Readonly<Record<string, string>> = { global: "全局", project: "项目", extension: "扩展" };

/** The scopes the skill loader reports. */
const EN_SKILL_SCOPES: Readonly<Record<string, string>> = { user: "user", project: "project", temporary: "temporary" };
const ZH_SKILL_SCOPES: Readonly<Record<string, string>> = { user: "用户", project: "项目", temporary: "临时" };

/** How an MCP server entry is exposed to the model. */
const EN_MCP_EXPOSURES: Readonly<Record<string, string>> = {
	codemode: "Codemode",
	deferred: "Deferred",
	direct: "Direct",
	hidden: "Hidden",
};
const ZH_MCP_EXPOSURES: Readonly<Record<string, string>> = {
	codemode: "代码模式",
	deferred: "延迟",
	direct: "直接",
	hidden: "隐藏",
};

function clean(text: string, values: Record<string, string> | undefined): string {
	if (values === undefined) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** One message in the reader's language, with `{name}` placeholders filled from `values`. */
export function translate(locale: Locale, key: MessageKey, values?: Record<string, string>): string {
	return clean((locale === "zh" ? ZH : EN)[key], values);
}

/**
 * A settings field's copy. The catalogue's id is the key; a field the dictionaries do not know
 * shows its id rather than an empty row, so a new host field is visible instead of invisible.
 */
export function settingFieldCopy(locale: Locale, id: string): SettingCopy {
	const table = locale === "zh" ? ZH_SETTING_FIELDS : EN_SETTING_FIELDS;
	return table[id] ?? { label: id, description: "" };
}

/** A settings heading's name; an unknown group token shows the token itself. */
export function settingGroupCopy(locale: Locale, group: string): string {
	const table = locale === "zh" ? ZH_SETTING_GROUPS : EN_SETTING_GROUPS;
	return table[group] ?? group;
}

/** An enum control's name for one stored value; an unknown value shows the value itself. */
export function settingOptionCopy(locale: Locale, id: string, value: string): string {
	const table = locale === "zh" ? ZH_SETTING_OPTIONS : EN_SETTING_OPTIONS;
	return table[id]?.[value] ?? value;
}

/** The settings error's scope name. */
export function settingScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_SETTING_SCOPES : EN_SETTING_SCOPES;
	return table[scope] ?? scope;
}

export function skillScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_SKILL_SCOPES : EN_SKILL_SCOPES;
	return table[scope] ?? scope;
}

export function mcpScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_MCP_SCOPES : EN_MCP_SCOPES;
	return table[scope] ?? scope;
}

export function mcpExposureCopy(locale: Locale, exposure: string): string {
	const table = locale === "zh" ? ZH_MCP_EXPOSURES : EN_MCP_EXPOSURES;
	return table[exposure] ?? exposure;
}

/** Rule labels keep calendar clock values in their declared zone. */
export function scheduleRuleCopy(locale: Locale, rule: ScheduleRuleLike): string {
	if (rule.kind === "once") return translate(locale, "panel.automation.oneTime", { at: rule.at.replace("T", " "), zone: rule.timeZone });
	if (rule.kind === "cron") return translate(locale, "panel.automation.cronRule", { expression: rule.expression, zone: rule.timeZone });
	return rule.everyMinutes === 1 ? translate(locale, "panel.automation.everyMinute") : translate(locale, "panel.automation.everyMinutes", { count: String(rule.everyMinutes) });
}

export function scheduleActionCopy(locale: Locale, code: string): string {
	const keys: Record<string, MessageKey> = {
		added: "panel.automation.added", updated: "panel.automation.updated", enabled: "panel.automation.enabled", paused: "panel.automation.paused", idle: "panel.automation.idle",
		done: "panel.automation.done", cancelled: "panel.automation.cancelled", skipped: "panel.automation.skipped", refused: "panel.automation.refused", unanswered: "panel.automation.unanswered", timed_out: "panel.automation.timed_out",
	};
	return keys[code] === undefined ? code : translate(locale, keys[code]!);
}

export function scheduleOutcomeCopy(locale: Locale, receipt: { readonly status: string; readonly detail: string | null }): string {
	const detail = receipt.detail === "busy" ? translate(locale, "panel.automation.reasonBusy") : receipt.detail === "missed" ? translate(locale, "panel.automation.reasonMissed") : receipt.detail;
	return scheduleActionCopy(locale, receipt.status) + (detail === null ? "" : `: ${detail}`);
}

/** When a schedule is next due, as the reader's language expresses it, such as "in 12 minutes". */
export function scheduleDueCopy(locale: Locale, nextRunAt: number | null, now: number): string {
	if (nextRunAt === null) return translate(locale, "panel.automation.finished");
	const seconds = Math.floor((nextRunAt - now) / 1000);
	if (seconds <= 0) return translate(locale, "panel.automation.dueNow");
	if (seconds < 60) return translate(locale, "panel.automation.soon");
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return translate(locale, "panel.automation.inMinutes", { count: String(minutes) });
	return translate(locale, "panel.automation.inHours", { count: String(Math.floor(minutes / 60)) });
}

/** A reasoning effort's name; a level the dictionaries do not know is shown capitalized. */
export function thinkingLevelCopy(locale: Locale, level: string): string {
	const table = locale === "zh" ? ZH_THINKING_LEVELS : EN_THINKING_LEVELS;
	if (table[level] !== undefined) return table[level];
	return level.length === 0 ? level : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
}

/**
 * The served document in one language: the `<html lang>` attribute and every `{{message.key}}`
 * marker of the static shell. The host localizes the document before it answers, so the first
 * paint is already in the reader's language instead of the bundle's English placeholders.
 */
export function localizeDocument(html: string, locale: Locale): string {
	const localized = html.replace(/\{\{([A-Za-z0-9._-]+)\}\}/g, (marker, key: string) => {
		if (!(key in EN)) return marker;
		return translate(locale, key as MessageKey);
	});
	return localized.replace(/<html lang="[^"]*"/, `<html lang="${documentLanguage(locale)}"`);
}

/** Every identity the dictionaries carry, for the coverage tests. */
export function copyIdentities(locale: Locale): {
	readonly messages: readonly string[];
	readonly settingGroups: readonly string[];
	readonly settingFields: readonly string[];
	readonly settingOptions: Readonly<Record<string, readonly string[]>>;
} {
	const fields = locale === "zh" ? ZH_SETTING_FIELDS : EN_SETTING_FIELDS;
	const options = locale === "zh" ? ZH_SETTING_OPTIONS : EN_SETTING_OPTIONS;
	return {
		messages: Object.keys(locale === "zh" ? ZH : EN),
		settingGroups: Object.keys(locale === "zh" ? ZH_SETTING_GROUPS : EN_SETTING_GROUPS),
		settingFields: Object.keys(fields),
		settingOptions: Object.fromEntries(Object.entries(options).map(([id, values]) => [id, Object.keys(values)])),
	};
}
