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
/** Drop one pending image before it is sent: `data` is the attachment id. */
export const ATTACHMENT_REMOVE_ACTION = "composer:attachment-remove";
/** Remove one session: `data` is the session id; the page confirms before the host call. */
export const SESSION_REMOVE_ACTION = "session:remove";
/** The confirmation a session's remove opens; `data` is the session id. */
export const SESSION_REMOVE_MODAL = "session:remove-confirm";
