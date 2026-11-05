import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useLayoutEffect } from "react";
import type { RefObject } from "react";

export function useComposerPopover(
	open: boolean,
	trigger: RefObject<HTMLElement | null>,
	panel: RefObject<HTMLElement | null>,
	placement: "top-start" | "top" | "top-end",
) {
	useLayoutEffect(() => {
		const anchor = trigger.current;
		const node = panel.current;
		if (!open || !anchor || !node) return;
		// These panels paint in the top layer or the body, outside the scrolling dock.
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
