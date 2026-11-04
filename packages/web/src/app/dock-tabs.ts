import { isDockTabId, type DockTabId } from "../dock.ts";

/** One session's presentation only; closing a tab never stops a backend resource. */
export class DockTabs {
	private ids: DockTabId[] = ["guide"];
	private selected: DockTabId = "guide";
	private readonly key: string | undefined;
	constructor(key?: string) {
		this.key = key;
		try {
			const saved: unknown =
				key === undefined
					? null
					: JSON.parse(sessionStorage.getItem(key) ?? "null");
			if (
				typeof saved !== "object" ||
				saved === null ||
				!("tabs" in saved) ||
				!("active" in saved)
			)
				return;
			if (
				!Array.isArray(saved.tabs) ||
				!saved.tabs.every(isDockTabId) ||
				!isDockTabId(saved.active)
			)
				return;
			if (!saved.tabs.includes(saved.active)) return;
			this.ids = [...new Set(saved.tabs)];
			this.selected = saved.active;
		} catch {
			// A refused or obsolete presentation preference starts with the guide.
		}
	}
	get tabs(): readonly DockTabId[] {
		return this.ids;
	}
	get active(): DockTabId {
		return this.selected;
	}
	open(id: DockTabId, replaceGuide = false): void {
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
	/** Returns true only when closing the final content tab should collapse the dock. */
	close(id: DockTabId): boolean {
		const index = this.ids.indexOf(id);
		if (index < 0 || (id === "guide" && this.ids.length === 1)) return false;
		this.ids = this.ids.filter((tab) => tab !== id);
		const empty = this.ids.length === 0;
		if (empty) this.ids = ["guide"];
		if (id === this.selected)
			this.selected = this.ids[index] ?? this.ids[index - 1] ?? "guide";
		this.save();
		return empty;
	}
	private save(): void {
		if (this.key === undefined) return;
		try {
			sessionStorage.setItem(
				this.key,
				JSON.stringify({ tabs: this.ids, active: this.selected }),
			);
		} catch {
			// In-memory tabs remain usable when browser storage is unavailable.
		}
	}
}
