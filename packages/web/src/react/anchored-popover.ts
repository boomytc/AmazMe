import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import type { Placement, ReferenceElement } from "@floating-ui/dom";
import { useLayoutEffect } from "react";
import type { RefObject } from "react";

export function useAnchoredPopover(
	open: boolean,
	trigger: RefObject<ReferenceElement | null>,
	panel: RefObject<HTMLElement | null>,
	placement: Placement,
) {
	useLayoutEffect(() => {
		const anchor = trigger.current;
		const node = panel.current;
		if (!open || !anchor || !node) return;
		// Fixed panels use the viewport even when their trigger sits in a scrolling pane.
		const viewport = { boundary: [], padding: 8 };
		let revision = 0;
		const stop = autoUpdate(anchor, node, () => {
			const current = ++revision;
			void computePosition(anchor, node, {
				strategy: "fixed",
				placement,
				middleware: [
					offset(6), flip(viewport), shift(viewport),
					size({ ...viewport, apply({ availableHeight }) {
						if (current === revision) node.style.maxHeight = `${Math.max(0, availableHeight)}px`;
					} }),
				],
			}).then(({ x, y }) => {
				if (current !== revision) return;
				node.style.left = `${x}px`;
				node.style.top = `${y}px`;
			});
		});
		return () => {
			revision++;
			stop();
		};
	}, [open, trigger, panel, placement]);
}
