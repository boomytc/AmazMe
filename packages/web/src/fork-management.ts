import { CONVERSATION_ARCHIVE_MODAL, CONVERSATION_RENAME_MODAL } from "./actions.ts";
import type { Locale } from "./locale.ts";
import type { PanelModal } from "./panels.ts";
import { translate } from "./strings.ts";

export function renameForkModal(locale: Locale, id: string, name: string): PanelModal {
	return { id: CONVERSATION_RENAME_MODAL, title: translate(locale, "dock.renameFork"), data: id,
		fields: [{ id: "name", label: translate(locale, "dock.forkName"), kind: "text", value: name }],
		submit: translate(locale, "modal.save"),
	};
}

export function archiveForkModal(locale: Locale, id: string): PanelModal {
	return { id: CONVERSATION_ARCHIVE_MODAL, title: translate(locale, "dock.archiveFork"), data: id,
		description: translate(locale, "dock.archiveForkHint"), fields: [],
		submit: translate(locale, "project.archive"), danger: true,
	};
}
