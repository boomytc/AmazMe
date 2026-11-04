import { isDockTabId, type DockTabId } from "../dock.ts";

/** One stored arrangement per profile and session; the window's width preference stays separate. */
const KEY_PREFIX = "amazme.dock-layout:";

/**
 * One session's dock arrangement: whether the column is open, its tab set, and the selected tab.
 * The whole arrangement is a single browser-local record, so reloading or reopening a session
 * restores exactly what the reader left. Two layers stay outside on purpose: the window's width and
 * presentation are one preference for every session, and transient reading positions stay in memory.
 */
export class DockLayout {
	/** The storage key one profile and session use for their arrangement. */
	static keyFor(profileId: string, sessionId: string): string {
		return `${KEY_PREFIX}${JSON.stringify([profileId, sessionId])}`;
	}
	private ids: DockTabId[] = ["guide"];
	private selected: DockTabId = "guide";
	private opened = false;
	private readonly key: string | undefined;
	constructor(key?: string) {
		this.key = key;
		try {
			const saved: unknown =
				key === undefined || typeof localStorage === "undefined"
					? null
					: JSON.parse(localStorage.getItem(key) ?? "null");
			if (
				typeof saved !== "object" ||
				saved === null ||
				!("tabs" in saved) ||
				!("active" in saved) ||
				!("open" in saved)
			)
				return;
			if (
				!Array.isArray(saved.tabs) ||
				!saved.tabs.every(isDockTabId) ||
				!isDockTabId(saved.active) ||
				typeof saved.open !== "boolean"
			)
				return;
			if (saved.tabs.length === 0 || !saved.tabs.includes(saved.active)) return;
			this.ids = [...new Set(saved.tabs)];
			this.selected = saved.active;
			this.opened = saved.open;
		} catch {
			// A refused or obsolete arrangement starts collapsed on the guide.
		}
	}
	get tabs(): readonly DockTabId[] {
		return this.ids;
	}
	get active(): DockTabId {
		return this.selected;
	}
	get open(): boolean {
		return this.opened;
	}
	set open(value: boolean) {
		if (this.opened === value) return;
		this.opened = value;
		this.save();
	}
	openTab(id: DockTabId, replaceGuide = false): void {
		if (!this.ids.includes(id)) {
			this.ids =
				this.selected === "guide"
					? this.ids.map((tab) => (tab === "guide" ? id : tab))
					: [...this.ids, id];
		} else if (replaceGuide && this.selected === "guide" && id !== "guide") {
			this.ids = this.ids.filter((tab) => tab !== "guide");
		}
		this.selected = id;
		this.save();
	}
	/** Closing the last content tab also collapses the column; closing the lone guide is refused. */
	close(id: DockTabId): void {
		const index = this.ids.indexOf(id);
		if (index < 0 || (id === "guide" && this.ids.length === 1)) return;
		this.ids = this.ids.filter((tab) => tab !== id);
		if (this.ids.length === 0) {
			this.ids = ["guide"];
			this.opened = false;
		}
		if (id === this.selected)
			this.selected = this.ids[index] ?? this.ids[index - 1] ?? "guide";
		this.save();
	}
	private save(): void {
		if (this.key === undefined || typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(
				this.key,
				JSON.stringify({
					tabs: this.ids,
					active: this.selected,
					open: this.opened,
				}),
			);
		} catch {
			// In-memory layout remains usable when browser storage is unavailable.
		}
	}
}
