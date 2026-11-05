import {
	useCallback,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import type { ReactElement } from "react";
import { translate } from "../strings.ts";
import type { Presentation, ToastMessage } from "./state.ts";

/** How long a standing message waits before it dismisses itself. */
const TOAST_LIFETIME_MS = 2500;

/**
 * The window's transient messages, drawn as cards in the top-right corner. The layer floats above
 * the page, so a message appearing or leaving never reflows anything. Hovering the stack holds every
 * card; leaving restarts each card's remaining 2.5 seconds from the start.
 */
export function ToastLayer({
	presentation,
}: {
	readonly presentation: Presentation;
}): ReactElement | null {
	const toasts = useSyncExternalStore(
		presentation.toasts.subscribe,
		presentation.toasts.getSnapshot,
	);
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
	const hovering = useRef(false);
	const clearTimers = useCallback(() => {
		for (const timer of timers.current.values()) clearTimeout(timer);
		timers.current.clear();
	}, []);
	const startTimers = useCallback(
		(list: readonly ToastMessage[]) => {
			if (hovering.current) return;
			for (const toast of list) {
				/* A failure the reader must act on stays until it is dismissed. */
				if (toast.persistent) continue;
				if (timers.current.has(toast.id)) continue;
				timers.current.set(
					toast.id,
					setTimeout(() => {
						timers.current.delete(toast.id);
						presentation.dismissToast(toast.id);
					}, TOAST_LIFETIME_MS),
				);
			}
		},
		[presentation],
	);
	const hold = useCallback(() => {
		if (hovering.current) return;
		hovering.current = true;
		clearTimers();
	}, [clearTimers]);
	useEffect(() => {
		startTimers(toasts);
		for (const toast of toasts) {
			if (!toast.persistent) continue;
			/* A transient card upgraded in place loses its old expiry. */
			const timer = timers.current.get(toast.id);
			if (timer === undefined) continue;
			clearTimeout(timer);
			timers.current.delete(toast.id);
		}
		for (const id of [...timers.current.keys()]) {
			if (toasts.some((toast) => toast.id === id)) continue;
			clearTimeout(timers.current.get(id));
			timers.current.delete(id);
		}
	}, [toasts, startTimers]);
	useEffect(() => clearTimers, [clearTimers]);
	if (toasts.length === 0) return null;
	const locale = presentation.view?.locale ?? "en";
	return (
		<div
			className="toast-layer"
			role="region"
			aria-label={translate(locale, "toast.region")}
			/* A card can appear under a resting pointer, so movement inside the layer also holds it. */
			onPointerMove={hold}
			onPointerEnter={hold}
			onPointerLeave={() => {
				hovering.current = false;
				startTimers(toasts);
			}}
		>
			{toasts.map((toast) => (
				<p
					key={toast.id}
					className={`toast-card ${toast.tone}${toast.persistent ? " persistent" : ""}`}
					role={toast.tone === "error" ? "alert" : "status"}
				>
					<span className="toast-text">{toast.text}</span>
					{toast.persistent ? (
						<button
							type="button"
							className="toast-close icon-button icon-button--mini"
							aria-label={translate(locale, "toast.dismiss")}
							title={translate(locale, "toast.dismiss")}
							onClick={() => presentation.dismissToast(toast.id)}
						>
							<svg
								className="icon"
								viewBox="0 0 24 24"
								aria-hidden="true"
								focusable="false"
							>
								<use href="#i-x" />
							</svg>
						</button>
					) : null}
				</p>
			))}
		</div>
	);
}
