import { isDockTabId, type DockTabId } from "../dock.ts";

/** One stored arrangement per profile and session; the window's width preference stays separate. */
const KEY_PREFIX = "amazme.dock-layout:";

/** The panel a session's dock starts on, and the one closing the last tab falls back to. */
const DEFAULT_TAB = "guide" satisfies DockTabId;

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
	private ids: DockTabId[] = [DEFAULT_TAB];
	private selected: DockTabId = DEFAULT_TAB;
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
			if (!Array.isArray(saved.tabs) || typeof saved.open !== "boolean") return;
			const tabs = [...new Set(saved.tabs.filter(isDockTabId))];
			const active = saved.active;
			if (
				tabs.length === 0 ||
				!isDockTabId(active) ||
				!tabs.includes(active)
			)
				return;
			this.ids = tabs;
			this.selected = active;
			this.opened = saved.open;
		} catch {
			// A refused or obsolete arrangement starts collapsed on the default panel.
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
	openTab(id: DockTabId): void {
		const alreadyOpen = this.ids.includes(id);
		if (this.selected === DEFAULT_TAB && id !== DEFAULT_TAB) {
			this.ids = this.ids.flatMap((tab) =>
				tab === DEFAULT_TAB ? (alreadyOpen ? [] : [id]) : [tab],
			);
		} else if (!alreadyOpen) this.ids = [...this.ids, id];
		this.selected = id;
		this.save();
	}
	/** Closing the last tab collapses the column; reopening starts from the default panel. */
	close(id: DockTabId): void {
		const index = this.ids.indexOf(id);
		if (index < 0 || (id === DEFAULT_TAB && this.ids.length === 1)) return;
		const remaining = this.ids.filter((tab) => tab !== id);
		if (remaining.length === 0) {
			this.ids = [DEFAULT_TAB];
			this.selected = DEFAULT_TAB;
			this.opened = false;
		} else {
			this.ids = remaining;
			if (id === this.selected)
				this.selected = remaining[index] ?? remaining[index - 1] ?? DEFAULT_TAB;
		}
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
