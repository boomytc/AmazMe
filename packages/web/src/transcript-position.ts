type Point = { key: string; region?: string; offset: number; domOffset: number; node: Node };

function blockOf(node: Node | null): HTMLElement | null {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>("[data-flow-key]") ?? null;
}

function point(root: HTMLElement, node: Node | null, offset: number): Point | undefined {
	if (node === null || !root.contains(node)) return undefined;
	const block = blockOf(node);
	if (block === null || block.dataset.flowKey === undefined) return undefined;
	const element = node instanceof Element ? node : node.parentElement;
	const region = element?.closest<HTMLElement>("[data-text-key]");
	const range = document.createRange();
	range.selectNodeContents(region ?? block);
	range.setEnd(node, offset);
	return {
		key: block.dataset.flowKey,
		...(region?.dataset.textKey === undefined ? {} : { region: region.dataset.textKey }),
		offset: range.toString().length,
		domOffset: offset,
		node,
	};
}

function textPoint(block: HTMLElement, offset: number): { node: Node; offset: number } {
	const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	let last: Node = block;
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		last = node;
		const length = node.textContent?.length ?? 0;
		if (offset <= length) return { node, offset };
		offset -= length;
	}
	return { node: last, offset: last === block ? 0 : (last.textContent?.length ?? 0) };
}

/** Snapshot the reader's DOM position, not session or model state. */
export function transcriptPosition(root: HTMLElement, viewport: HTMLElement, following: boolean): () => void {
	const selection = document.getSelection();
	const anchor = point(root, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
	const focus = point(root, selection?.focusNode ?? null, selection?.focusOffset ?? 0);
	const active =
		document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
			? document.activeElement
			: undefined;
	// Selecting a live paragraph or inspecting its controls is reading, even at the current bottom.
	following = following && (selection?.isCollapsed !== false || anchor === undefined) && active === undefined;
	const activeBlock = active === undefined ? null : blockOf(active);
	const controls =
		activeBlock === null
			? []
			: Array.from(activeBlock.querySelectorAll<HTMLElement>("button,summary,a[href],input,textarea,select"));
	const activeIndex = active === undefined ? -1 : controls.indexOf(active);
	const activeKey = activeBlock?.dataset.flowKey;
	const activeAction = active?.dataset.action;
	const top = viewport.getBoundingClientRect().top;
	const visible = following
		? undefined
		: Array.from(root.querySelectorAll<HTMLElement>('[data-flow-key^="block:"]')).find(
				(node) => node.getBoundingClientRect().bottom > top,
			);
	const visibleKey = visible?.dataset.flowKey;
	const visibleTop = visible?.getBoundingClientRect().top;
	const oldScroll = viewport.scrollTop;
	return () => {
		const nodes = new Map(
			Array.from(root.querySelectorAll<HTMLElement>("[data-flow-key]")).map((node) => [node.dataset.flowKey, node]),
		);
		if (active !== undefined && !active.isConnected && activeKey !== undefined) {
			const candidates = Array.from(
				nodes.get(activeKey)?.querySelectorAll<HTMLElement>("button,summary,a[href],input,textarea,select") ?? [],
			);
			const target =
				activeAction === undefined
					? candidates[activeIndex]
					: candidates.find((node) => node.dataset.action === activeAction);
			if (target?.tagName === active.tagName) target.focus({ preventScroll: true });
		}
		if (
			anchor !== undefined &&
			focus !== undefined &&
			(selection?.anchorNode !== anchor.node ||
				selection?.focusNode !== focus.node ||
				selection?.anchorOffset !== anchor.domOffset ||
				selection?.focusOffset !== focus.domOffset)
		) {
			const regionOf = (point: Point): HTMLElement | undefined => {
				const block = nodes.get(point.key);
				return point.region === undefined
					? block
					: Array.from(block?.querySelectorAll<HTMLElement>("[data-text-key]") ?? []).find(
							(node) => node.dataset.textKey === point.region,
						);
			};
			const a = regionOf(anchor),
				f = regionOf(focus);
			if (a !== undefined && f !== undefined && selection !== null) {
				const start = textPoint(a, anchor.offset),
					end = textPoint(f, focus.offset);
				selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
			}
		}
		if (following) viewport.scrollTop = viewport.scrollHeight;
		else if (visibleKey !== undefined && visibleTop !== undefined && nodes.has(visibleKey)) {
			viewport.scrollTop += nodes.get(visibleKey)!.getBoundingClientRect().top - visibleTop;
		} else viewport.scrollTop = oldScroll;
	};
}
