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
/** Re-read the conversation list, the task graph, and the focused view. */
export const CONVERSATIONS_REFRESH_ACTION = "conversation:refresh";
/** Page in older stored history above the transcript. */
export const HISTORY_MORE_ACTION = "history:more";

/** Drop one pending image before it is sent: `data` is the attachment id. */
export const ATTACHMENT_REMOVE_ACTION = "composer:attachment-remove";
/** Remove one session: `data` is the session id; the page confirms before the host call. */
export const SESSION_REMOVE_ACTION = "session:remove";
/** The confirmation a session's remove opens; `data` is the session id. */
export const SESSION_REMOVE_MODAL = "session:remove-confirm";
