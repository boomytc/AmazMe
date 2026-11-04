import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";
import { Icon, SensitiveText } from "./management-fields.tsx";

/**
 * One title's help, revealed only while the reader asks for it. Static guidance used to sit under
 * every row title as a paragraph; the info control keeps that copy reachable while the row keeps
 * its single line. The card is portalled so a scrolling panel cannot clip it.
 */
export function Hint({
	text,
	locale,
}: {
	readonly text: string;
	readonly locale: Locale;
}) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: 8, top: 8 });
	const descriptionId = `hint-${useId().replaceAll(":", "")}`;
	const trigger = useRef<HTMLButtonElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<number | undefined>(undefined);

	const cancelClose = (): void => {
		if (closeTimer.current === undefined) return;
		window.clearTimeout(closeTimer.current);
		closeTimer.current = undefined;
	};
	const show = (): void => {
		cancelClose();
		setOpen(true);
	};
	const scheduleClose = (): void => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 120);
	};

	useEffect(
		() => () => {
			if (closeTimer.current !== undefined)
				window.clearTimeout(closeTimer.current);
		},
		[],
	);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);
	useLayoutEffect(() => {
		if (!open) return;
		const anchor = trigger.current?.getBoundingClientRect();
		const element = card.current;
		if (anchor === undefined || element === null) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		const left = Math.min(
			Math.max(8, anchor.left),
			window.innerWidth - width - 8,
		);
		const below = anchor.bottom + 6;
		const above = anchor.top - height - 6;
		const top =
			below + height <= window.innerHeight - 8 || above < 8 ? below : above;
		setPosition({ left: Math.round(left), top: Math.round(top) });
	}, [open]);

	return (
		<span className="hint">
			<button
				ref={trigger}
				type="button"
				className="hint-trigger"
				aria-label={translate(locale, "hint.show")}
				aria-expanded={open}
				aria-describedby={descriptionId}
				onPointerEnter={show}
				onPointerLeave={scheduleClose}
				onFocus={show}
				onBlur={(event) => {
					const next = event.relatedTarget;
					if (
						next instanceof Node &&
						(card.current?.contains(next) === true ||
							event.currentTarget.contains(next))
					)
						return;
					setOpen(false);
				}}
				onClick={show}
			>
				<Icon name="info" />
			</button>
			<span id={descriptionId} className="sr-only">
				<SensitiveText text={text} locale={locale} />
			</span>
			{open
				? createPortal(
						<div
							ref={card}
							className="hint-card"
							role="tooltip"
							style={position}
							onPointerEnter={show}
							onPointerLeave={scheduleClose}
							onBlur={(event) => {
								if (event.currentTarget.contains(event.relatedTarget as Node))
									return;
								setOpen(false);
							}}
						>
							<SensitiveText text={text} locale={locale} />
						</div>,
						/* A modal is in the top layer, above anything portalled to the body. */
						trigger.current?.closest("dialog") ?? document.body,
					)
				: null}
		</span>
	);
}
