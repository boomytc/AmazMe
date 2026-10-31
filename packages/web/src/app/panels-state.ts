import type { PanelModal, PanelNotice, PanelView } from "../panels.ts";
import { CHAT_VIEW } from "../panels.ts";

export class PanelsState {
	current = CHAT_VIEW;
	settingsSection?: PanelView["settingsSection"];
	modal?: PanelModal;
	notice?: PanelNotice;
	pendingModal?: PanelModal;
	generation = 0;
	get modalPending(): boolean {
		return this.modal !== undefined && this.pendingModal === this.modal;
	}
}
