/** Values in a projected view are immutable, JSON-shaped presentation data. */
export function sameViewValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameViewValue(value, right[index]))
		);
	}
	const a = left as Record<string, unknown>,
		b = right as Record<string, unknown>;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameViewValue(a[key], b[key]))
	);
}

/** Keep nodes already in order in place; prepending history never detaches later turns. */
export function reconcileChildren(parent: HTMLElement, nodes: readonly HTMLElement[]): void {
	const wanted = new Set<Node>(nodes);
	let cursor = parent.firstChild;
	for (const node of nodes) {
		while (cursor !== null && !wanted.has(cursor)) {
			const next = cursor.nextSibling;
			parent.removeChild(cursor);
			cursor = next;
		}
		if (node === cursor) cursor = cursor.nextSibling;
		else parent.insertBefore(node, cursor);
	}
	while (cursor !== null) {
		const next = cursor.nextSibling;
		parent.removeChild(cursor);
		cursor = next;
	}
}

/** DOM ownership only: a changed projection replaces its own node, never its neighbours. */
export class DomCache {
	readonly #nodes = new Map<string, { value: unknown; node: HTMLElement }>();
	readonly #seen = new Set<string>();
	#scope: string | undefined;
	begin(scope: string): boolean {
		const changed = this.#scope !== scope;
		if (changed) this.#nodes.clear();
		this.#scope = scope;
		this.#seen.clear();
		return changed;
	}
	get(key: string, value: unknown, create: () => HTMLElement): HTMLElement {
		this.#seen.add(key);
		const old = this.#nodes.get(key);
		if (old !== undefined && sameViewValue(old.value, value)) return old.node;
		const node = create();
		node.dataset.flowKey = key;
		node.querySelectorAll<HTMLElement>("pre code").forEach((code, index) => {
			code.dataset.textKey = `code:${index}`;
		});
		if (old?.node instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
			const selection = document.getSelection();
			if (
				(!selection?.isCollapsed && old.node.contains(selection?.anchorNode ?? null)) ||
				old.node.contains(document.activeElement)
			)
				node.open = old.node.open;
		}
		old?.node.parentNode?.replaceChild(node, old.node);
		this.#nodes.set(key, { value, node });
		return node;
	}
	finish(): void {
		for (const key of this.#nodes.keys()) if (!this.#seen.has(key)) this.#nodes.delete(key);
	}
}
