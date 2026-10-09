/**
 * The action ids the page's own controls report. Panels carry their ids in `panels.ts`; these are
 * the run controls around the conversation — the queue strips, the composer's submit mode, the
 * header's compaction control, and the model card's refresh — which are reported through the same
 * generic `command` action the panels use, so the page entry has one dispatch path.
 *
 * A control is a `PanelButton` whose id is one of these and whose `data` is its subject (a queued
 * entry id, a submit mode), so the renderer stays free of feature knowledge.
 */

/** Withdraw one queued input: `data` is the inbox submission id. */
export const QUEUE_CANCEL_ACTION = "run:queue-cancel";
/** Open the compaction modal; the modal itself submits under `COMPACT_MODAL`. */
export const COMPACT_ACTION = "run:compact";
/** The compaction modal's submit: `fields.instructions` carries optional guidance. */
export const COMPACT_MODAL = "run:compact-submit";
/** Ask the attached session's host to re-read the provider catalog. */
export const REFRESH_MODELS_ACTION = "run:model-refresh";
/** How the next submit is applied while a turn runs: `data` is `steer` or `followUp`. */
export const SUBMIT_MODE_ACTION = "run:submit-mode";
/** Show or hide the session dock; the page owns whether it is open. */
export const DOCK_TOGGLE_ACTION = "dock:toggle";
/** Switch the dock to one tab: `data` is the tab id. */
export const DOCK_TAB_ACTION = "dock:tab";
/** List a directory in the workspace: `data` is the path relative to the working directory. */
export const WORKSPACE_OPEN_ACTION = "workspace:open";
/** Re-list the workspace's current directory. */
export const WORKSPACE_RELOAD_ACTION = "workspace:reload";
/** Read one file as text: `data` is the path relative to the working directory. */
export const WORKSPACE_READ_ACTION = "workspace:read";
/** Run a terminal command: `data` is the command line. */
export const TERMINAL_RUN_ACTION = "terminal:run";
/** Stop the running terminal command. */
export const TERMINAL_STOP_ACTION = "terminal:stop";

/** Focus one conversation in the dock: `data` is the conversation id. */
export const CONVERSATION_SELECT_ACTION = "conversation:select";
/** Fork one conversation at its newest entry and open the fork: `data` is the conversation id. */
export const CONVERSATION_FORK_ACTION = "conversation:fork";
/** Re-read the conversation list, the task graph, and the focused view. */
export const CONVERSATIONS_REFRESH_ACTION = "conversation:refresh";
/** Approve one pending tool call: `data` is the approval id. */
export const APPROVAL_APPROVE_ACTION = "approval:approve";
/** Deny one pending tool call: `data` is the approval id. */
export const APPROVAL_DENY_ACTION = "approval:deny";

/** The first-run guide's steps: open a session, the session tools, or the settings. */
export const WELCOME_SESSION_ACTION = "welcome:session";
export const WELCOME_FILES_ACTION = "welcome:files";
export const WELCOME_SETTINGS_ACTION = "welcome:settings";
/** Stop offering the guide until the reader turns it back on in the settings. */
export const WELCOME_DISMISS_ACTION = "welcome:dismiss";

/** Rate one answer as helpful: `data` is the entry id the answer belongs to. */
export const FEEDBACK_UP_ACTION = "feedback:up";
/** Rate one answer as not helpful; rating it again withdraws the rating. */
export const FEEDBACK_DOWN_ACTION = "feedback:down";

/** Page in older stored history above the transcript. */
export const HISTORY_MORE_ACTION = "history:more";

/** Plan a prompt for the attached session: the page opens the add modal under `SCHEDULE_ADD_MODAL`. */
export const SCHEDULE_ADD_ACTION = "schedule:add";
/** The add modal's submit: `fields.prompt` and `fields.everyMinutes` describe the schedule. */
export const SCHEDULE_ADD_MODAL = "schedule:add-submit";
/** Remove one planned prompt: `data` is the schedule id; the page confirms first. */
export const SCHEDULE_REMOVE_ACTION = "schedule:remove";
/** The confirmation a schedule's remove opens; `data` is the schedule id. */
export const SCHEDULE_REMOVE_MODAL = "schedule:remove-confirm";
/** Run one planned prompt now, whether or not it is due: `data` is the schedule id. */
export const SCHEDULE_RUN_ACTION = "schedule:run";
/** Cancel the plan's current durable admission and join its cleanup. */
export const SCHEDULE_CANCEL_ACTION = "schedule:cancel";
/** Re-read the plan file after the reader repairs or edits it. */
export const SCHEDULE_RELOAD_ACTION = "schedule:reload";
/** Pause or resume one planned prompt: `data` is the schedule id, the control's value the state. */
export const SCHEDULE_ENABLED_ACTION = "schedule:enabled";

/** Drop one pending image before it is sent: `data` is the attachment id. */
export const ATTACHMENT_REMOVE_ACTION = "composer:attachment-remove";
/** Remove one session: `data` is the session id; the page confirms before the host call. */
export const SESSION_REMOVE_ACTION = "session:remove";
/** The confirmation a session's remove opens; `data` is the session id. */
export const SESSION_REMOVE_MODAL = "session:remove-confirm";
/** Session row menu and its rename dialog. */
export const SESSION_RENAME_ACTION = "session:rename";
export const SESSION_RENAME_MODAL = "session:rename-submit";
export const SESSION_COPY_ID_ACTION = "session:copy-id";
