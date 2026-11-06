import {
	type FormEvent,
	Fragment,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactElement,
	type ReactNode,
	type RefCallback,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { DOCK_TAB_ACTION, DOCK_TAB_CLOSE_ACTION, DOCK_TOGGLE_ACTION, WORKSPACE_OPEN_ACTION } from "../actions.ts";
import { readDockWidth, storeDockWidth } from "../app/dock-preferences.ts";
import type { DockTab, DockTabId, DockView } from "../dock.ts";
import { errorMessageCopy } from "../errors.ts";
import type { Locale } from "../locale.ts";
import type {
	PanelAction,
	PanelButton,
	PanelGroup,
	PanelInput,
	PanelNotice,
	PanelPending,
	PanelRow,
	PanelSpec,
	PanelText,
} from "../panels.ts";
import { createPtySurface, type PtyPresentation } from "../pty-surface.ts";
import { Hint } from "./hint.tsx";
import { PanelHead } from "./panel-head.tsx";
import { Breadcrumbs } from "./breadcrumbs.tsx";
import { translate } from "../strings.ts";
import {
	type ControlEdits,
	PanelBadge,
	PanelButtonView,
	PanelControlView,
	PanelRowMenu,
	SensitiveText,
	sameActionTarget,
	type UpdateControlEdit,
} from "./management-fields.tsx";

type DockIconName =
	| "activity"
	| "alert"
	| "arrow-up"
	| "check"
	| "chevron-down"
	| "compass"
	| "copy"
	| "file"
	| "folder"
	| "fullscreen"
	| "git-fork"
	| "message"
	| "more"
	| "panel-right"
	| "plus"
	| "refresh"
	| "restore"
	| "search"
	| "square-pen"
	| "terminal"
	| "wrap"
	| "x";

interface SourcePosition {
	readonly top: number;
	readonly left: number;
	readonly line?: string;
	readonly offset?: number;
	readonly revision?: number;
}

export interface ReadingState {
	readonly wrap: Map<string, boolean>;
	readonly expanded: Map<string, boolean>;
	readonly sourcePositions: Map<string, SourcePosition>;
}

type ReaderTextRenderer = (text: string) => ReactNode;

export interface DockProps {
	/** Distinguishes sessions, hosts, and other long-lived Dock owners. */
	readonly scope: string;
	readonly view: DockView;
	readonly locale: Locale;
	/** Over the whole viewport instead of pushed into the right column. */
	readonly fullscreen: boolean;
	readonly visible: boolean;
	readonly onAnimateWidth: (apply: () => void) => void;
	readonly onResizeStart: () => void;
	readonly onToggleFullscreen: () => void;
	readonly onAction: (action: PanelAction) => void;
	readonly onTerminalInput?: (id: string, data: string) => void;
	readonly onTerminalResize?: (id: string, cols: number, rows: number) => void;
}

const DOCK_ICONS: Readonly<Record<DockTabId, DockIconName>> = {
	guide: "compass",
	files: "folder",
	terminal: "terminal",
	jobs: "activity",
	conversations: "message",
	tasks: "activity",
	changes: "git-fork",
	statistics: "activity",
};

function dockBounds(element: HTMLElement): { minimum: number; maximum: number } {
	const style = getComputedStyle(element);
	return {
		minimum: parseFloat(style.getPropertyValue("--dock-min-width")),
		maximum: parseFloat(style.getPropertyValue("--dock-limit")),
	};
}

function clampDockWidth(element: HTMLElement, width: number): number {
	const { minimum, maximum } = dockBounds(element);
	return Math.min(maximum, Math.max(minimum, Math.round(width)));
}

function applyDockWidth(width: number | null): void {
	const style = document.documentElement.style;
	if (width === null) style.removeProperty("--dock-preferred-width");
	else style.setProperty("--dock-preferred-width", `${width}px`);
}

function Icon({
	name,
	className = "icon",
}: {
	readonly name: DockIconName;
	readonly className?: string;
}): ReactElement {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<use href={`#i-${name}`} />
		</svg>
	);
}

function sourceKey(scope: string, text: PanelText): string {
	return `${scope}\u0000${text.id}`;
}

function renderReaderText(
	text: string,
	renderText: ReaderTextRenderer | undefined,
): ReactNode {
	return renderText === undefined ? text : renderText(text);
}

function rememberPosition(
	map: Map<string, SourcePosition>,
	key: string,
	position: SourcePosition,
): void {
	map.delete(key);
	map.set(key, position);
	if (map.size > 32) map.delete(map.keys().next().value ?? "");
}

function captureSource(
	source: HTMLElement,
	key: string,
	revision: number | undefined,
	positions: Map<string, SourcePosition>,
): void {
	if (!source.isConnected || source.getClientRects().length === 0) return;
	const top = source.getBoundingClientRect().top;
	const first = [...source.querySelectorAll<HTMLElement>("[data-line]")].find(
		(row) => row.getBoundingClientRect().bottom > top,
	);
	rememberPosition(positions, key, {
		top: source.scrollTop,
		left: source.scrollLeft,
		...(first?.dataset.line === undefined ? {} : { line: first.dataset.line }),
		...(first === undefined
			? {}
			: { offset: first.getBoundingClientRect().top - top }),
		...(revision === undefined ? {} : { revision }),
	});
}

function scrollableAncestor(node: HTMLElement | null): HTMLElement | undefined {
	for (
		let current = node?.parentElement;
		current;
		current = current.parentElement
	) {
		const style = getComputedStyle(current);
		if (/auto|scroll/.test(style.overflowY)) return current;
	}
	return undefined;
}

function captureReadingPosition(
	node: HTMLElement | null,
):
	| { readonly node: HTMLElement; readonly top: number; readonly left: number }
	| undefined {
	const scrollable = scrollableAncestor(node);
	return scrollable === undefined
		? undefined
		: {
				node: scrollable,
				top: scrollable.scrollTop,
				left: scrollable.scrollLeft,
			};
}

function restoreReadingPosition(
	position:
		| {
				readonly node: HTMLElement;
				readonly top: number;
				readonly left: number;
		  }
		| undefined,
): void {
	if (position === undefined || !position.node.isConnected) return;
	position.node.scrollTop = position.top;
	position.node.scrollLeft = position.left;
}

function usePendingReadingAnchor(anchor: {
	current: ReturnType<typeof captureReadingPosition> | undefined;
}): void {
	useLayoutEffect(() => {
		const pending = anchor.current;
		if (pending === undefined) return;
		anchor.current = undefined;
		restoreReadingPosition(pending);
	});
}

function panelButtonClass(
	action: Pick<PanelButton, "weight" | "danger">,
): string {
	return `panel-button weight-${action.weight}${action.danger === true ? " is-danger" : ""}`;
}

function CopyControl({
	locale,
	label,
	text,
	className,
	visibleLabel = false,
}: {
	readonly locale: Locale;
	readonly label: string;
	readonly text: string;
	readonly className: string;
	readonly visibleLabel?: boolean;
}): ReactElement {
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () => {
			if (timer.current !== undefined) clearTimeout(timer.current);
		},
		[],
	);
	const show = (state: "copied" | "failed"): void => {
		setStatus(state);
		if (timer.current !== undefined) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			setStatus("idle");
		}, 1200);
	};
	const shown =
		status === "copied"
			? translate(locale, "copy.copied")
			: status === "failed"
				? translate(locale, "copy.failed")
				: label;
	const icon: DockIconName =
		status === "copied" ? "check" : status === "failed" ? "x" : "copy";
	return (
		<button
			type="button"
			className={className}
			title={shown}
			aria-label={shown}
			data-copy-label={visibleLabel ? "visible" : undefined}
			onClick={() => {
				const written = navigator.clipboard?.writeText(text);
				if (written === undefined) {
					show("failed");
					return;
				}
				void written.then(
					() => show("copied"),
					() => show("failed"),
				);
			}}
		>
			<Icon name={icon} />
			{visibleLabel ? <span className="copy-label">{shown}</span> : null}
		</button>
	);
}

function WrapControl({
	locale,
	pressed,
	onToggle,
}: {
	readonly locale: Locale;
	readonly pressed: boolean;
	readonly onToggle: () => void;
}): ReactElement {
	const label = translate(locale, "dock.wrapLines");
	return (
		<button
			type="button"
			className="reader-button reader-wrap"
			title={label}
			aria-label={label}
			aria-pressed={pressed}
			onClick={onToggle}
		>
			<Icon name="wrap" />
		</button>
	);
}

function FileEntry({
	row,
	pending,
	fileBusy,
	onKeyDown,
	onAction,
}: {
	readonly row: PanelRow & { readonly file: NonNullable<PanelRow["file"]> };
	readonly pending?: PanelPending;
	readonly fileBusy: boolean;
	readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
	readonly onAction: (action: PanelAction) => void;
}): ReactElement {
	const action = row.file.action;
	const busy = sameActionTarget(pending, action);
	const disabled = action.disabled === true || busy || fileBusy;
	return (
		<button
			type="button"
			className={`file-entry file-entry-${row.file.kind}${busy || fileBusy ? " pending" : ""}`}
			title={action.data ?? row.title}
			aria-label={`${action.label}: ${row.title}`}
			aria-busy={busy || fileBusy || undefined}
			disabled={disabled}
			data-row-id={row.id}
			data-file-name={row.title}
			data-action={action.id}
			data-action-data={action.data}
			onKeyDown={onKeyDown}
			onClick={() => {
				onAction({ kind: "command", id: action.id, data: action.data });
			}}
		>
			<Icon
				name={
					row.file.kind === "up"
						? "arrow-up"
						: row.file.kind === "dir"
							? "folder"
							: "file"
				}
			/>
			<span className="file-entry-name">{row.title}</span>
			{row.value === undefined ? null : (
				<span className="file-entry-size">{row.value}</span>
			)}
			{row.file.kind === "dir" ? (
				<Icon name="chevron-down" className="icon file-entry-chevron" />
			) : null}
		</button>
	);
}

function recordPath(value: string | undefined): string | undefined {
	return value !== undefined &&
		!value.includes(" · ") &&
		(value.startsWith("/") ||
			value.startsWith("\\") ||
			value.startsWith("~") ||
			/^[A-Za-z]:[\\/]/.test(value))
		? value
		: undefined;
}

function PanelBadges({
	badges,
	locale,
}: {
	readonly badges: NonNullable<PanelRow["badges"]>;
	readonly locale: Locale;
}): ReactElement {
	return (
		<>
			{badges.map((badge, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Badges have no identity beyond their backend source order.
				<PanelBadge key={index} badge={badge} locale={locale} />
			))}
		</>
	);
}

function PanelRowView({
	panelId,
	row,
	locale,
	pending,
	skeleton,
	fileBusy,
	hasError,
	controlEdits,
	updateControlEdit,
	onKeyDown,
	onAction,
}: {
	readonly panelId: string;
	readonly row: PanelRow;
	readonly locale: Locale;
	readonly pending?: PanelPending;
	readonly skeleton: PanelGroup["skeleton"];
	readonly fileBusy: boolean;
	readonly hasError: boolean;
	readonly controlEdits: ControlEdits;
	readonly updateControlEdit: UpdateControlEdit;
	readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
	readonly onAction: (action: PanelAction) => void;
}): ReactElement {
	if (row.file !== undefined) {
		return (
			<FileEntry
				row={{ ...row, file: row.file }}
				pending={pending}
				fileBusy={fileBusy}
				onKeyDown={onKeyDown}
				onAction={onAction}
			/>
		);
	}
	const records = skeleton === "records";
	const path = records ? recordPath(row.value) : undefined;
	return (
		<div
			className={`${records ? "panel-row record-row" : "panel-row"}${row.selected === true ? " selected" : ""}`}
			data-row-id={row.id}
			data-review-open={row.detail === undefined ? undefined : row.id}
		>
			<div className="panel-row-text">
				<div className="panel-row-head">
					<span className="panel-row-title">
						{row.title}
						{row.hint === undefined ? null : (
							<Hint text={row.hint} locale={locale} />
						)}
					</span>
					{records ? null : (
						<PanelBadges badges={row.badges ?? []} locale={locale} />
					)}
				</div>
				{row.description === undefined ? null : (
					<p className="panel-row-desc">{row.description}</p>
				)}
				{path === undefined ? (
					row.value === undefined || records ? null : (
						<code className="panel-row-value">{row.value}</code>
					)
				) : (
					<code className="record-path">{path}</code>
				)}
			</div>
			{records &&
			((row.badges?.length ?? 0) > 0 ||
				(row.value !== undefined && path === undefined)) ? (
				<div className="record-status">
					<PanelBadges badges={row.badges ?? []} locale={locale} />
					{row.value === undefined || path !== undefined ? null : (
						<span className="record-value">{row.value}</span>
					)}
				</div>
			) : null}
			{row.controls === undefined || row.controls.length === 0 ? null : (
				<div className="panel-controls">
					{row.controls.map((control) => (
						<PanelControlView
							key={`${control.id}:${control.data ?? ""}`}
							panelId={panelId}
							row={row}
							control={control}
							locale={locale}
							pending={pending}
							hasError={hasError}
							edits={controlEdits}
							updateEdit={updateControlEdit}
							onAction={onAction}
						/>
					))}
				</div>
			)}
			{(row.actions?.length ?? 0) > 0 || row.menu !== undefined ? (
				<div className="panel-actions">
					{(row.actions ?? []).map((action) => (
						<PanelButtonView
							key={`${action.id}:${action.data ?? ""}`}
							action={action}
							pending={pending}
							onAction={onAction}
						/>
					))}
					{row.menu === undefined ? null : (
						<PanelRowMenu
							menu={row.menu}
							rowTitle={row.title}
							pending={pending}
							onAction={onAction}
						/>
					)}
				</div>
			) : null}
		</div>
	);
}

function diffTone(
	line: string,
): "diff-header" | "diff-hunk" | "addition" | "removal" | "context" {
	if (line.startsWith("+++ ") || line.startsWith("--- ")) return "diff-header";
	if (line.startsWith("@@")) return "diff-hunk";
	if (line.startsWith("+")) return "addition";
	if (line.startsWith("-")) return "removal";
	return "context";
}

function SourcePreview({
	text,
	scope,
	locale,
	reading,
	rootRef,
	className,
	renderText,
}: {
	readonly text: PanelText & {
		readonly source: NonNullable<PanelText["source"]>;
	};
	readonly scope: string;
	readonly locale: Locale;
	readonly reading: ReadingState;
	readonly rootRef?: RefCallback<HTMLElement>;
	readonly className?: string;
	readonly renderText?: ReaderTextRenderer;
}): ReactElement {
	const key = sourceKey(scope, text);
	const [wrapped, setWrapped] = useState(() => reading.wrap.get(key) ?? false);
	const content = useRef<HTMLDivElement>(null);
	const pendingAnchor = useRef<
		{ readonly top: number; readonly left: number } | undefined
	>(undefined);
	const all = text.text.length === 0 ? [] : text.text.split("\n");
	if (all.at(-1) === "") all.pop();
	const lines = all.slice(0, 2000);
	const displayed = all.length > lines.length ? lines.join("\n") : text.text;
	const selection = text.source.selection;
	const selectionLine = selection?.line;
	const selectionRevision = selection?.revision;
	const rendered = useRef<{
		readonly key: string;
		readonly text: string;
		readonly startLine: number;
		readonly hasSelection: boolean;
		readonly selectionLine: number | undefined;
		readonly selectionRevision: number | undefined;
	}>(undefined);
	useLayoutEffect(() => {
		const source = content.current;
		if (source === null) return;
		const pending = pendingAnchor.current;
		pendingAnchor.current = undefined;
		const next = {
			key,
			text: text.text,
			startLine: text.source.startLine,
			hasSelection: selection !== undefined,
			selectionLine,
			selectionRevision,
		};
		const previous = rendered.current;
		const changed =
			previous === undefined ||
			previous.key !== next.key ||
			previous.text !== next.text ||
			previous.startLine !== next.startLine ||
			previous.hasSelection !== next.hasSelection ||
			previous.selectionLine !== next.selectionLine ||
			previous.selectionRevision !== next.selectionRevision;
		rendered.current = next;
		if (!changed) return;
		const position = reading.sourcePositions.get(key);
		const navigate =
			selection !== undefined && position?.revision !== selectionRevision;
		const target =
			navigate && selection !== undefined
				? [...source.querySelectorAll<HTMLElement>("[data-line]")].find(
						(row) => row.dataset.line === String(selectionLine),
					)
				: undefined;
		if (target !== undefined) {
			target.focus({ preventScroll: true });
			target.scrollIntoView({ block: "center", inline: "nearest" });
		} else if (position !== undefined) {
			source.scrollTop = position.top;
			source.scrollLeft = position.left;
			const line =
				position.line === undefined
					? undefined
					: [...source.querySelectorAll<HTMLElement>("[data-line]")].find(
							(row) => row.dataset.line === position.line,
						);
			if (line !== undefined && position.offset !== undefined) {
				source.scrollTop +=
					line.getBoundingClientRect().top -
					source.getBoundingClientRect().top -
					position.offset;
			}
		}
		rememberPosition(reading.sourcePositions, key, {
			top: source.scrollTop,
			left: source.scrollLeft,
			...(position?.line === undefined ? {} : { line: position.line }),
			...(position?.offset === undefined ? {} : { offset: position.offset }),
			...(selectionRevision === undefined
				? position?.revision === undefined
					? {}
					: { revision: position.revision }
				: { revision: selectionRevision }),
		});
		captureSource(
			source,
			key,
			selectionRevision ?? position?.revision,
			reading.sourcePositions,
		);
		if (pending !== undefined) {
			source.scrollTop = pending.top;
			source.scrollLeft = pending.left;
		}
	});
	return (
		<div
			ref={rootRef}
			className={`panel-text-block file-source text-reader ${className ?? ""}`.trim()}
			data-text-id={text.id}
		>
			{text.title === undefined ? null : (
				<p className="panel-text-title">{text.title}</p>
			)}
			<div className="file-source-toolbar reader-controls">
				<span className="file-source-caption">
					{translate(locale, "dock.sourceLines", {
						count: String(lines.length),
					})}
				</span>
				<WrapControl
					locale={locale}
					pressed={wrapped}
					onToggle={() => {
						const source = content.current;
						pendingAnchor.current =
							source === undefined || source === null
								? undefined
								: { top: source.scrollTop, left: source.scrollLeft };
						const next = !wrapped;
						setWrapped(next);
						reading.wrap.set(key, next);
					}}
				/>
				<CopyControl
					locale={locale}
					label={translate(locale, "dock.copyContents")}
					text={displayed}
					className="reader-button reader-copy"
					visibleLabel
				/>
			</div>
			{all.length > lines.length ? (
				<p className="panel-notice info">
					{translate(locale, "dock.sourceLimited", {
						count: String(lines.length),
					})}
				</p>
			) : null}
			<section
				ref={content}
				className={`file-source-code reader-content${wrapped ? " wrap" : ""}`}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll container must be keyboard-focusable so arrow and page keys scroll source text.
				tabIndex={0}
				aria-label={translate(locale, "dock.contents")}
				onScroll={() => {
					const source = content.current;
					if (source !== null)
						captureSource(
							source,
							key,
							selection?.revision,
							reading.sourcePositions,
						);
				}}
			>
				{lines.map((line, index) => {
					const lineNumber = index + text.source.startLine;
					const selected = selection?.line === lineNumber;
					return (
						<div
							key={lineNumber}
							className="file-source-line"
							data-line={lineNumber}
							data-selected={selected ? "true" : undefined}
							tabIndex={selected ? -1 : undefined}
						>
							<span className="file-line-number" aria-hidden="true">
								{lineNumber}
							</span>
							<code className="file-line-code">
								{renderReaderText(
									line.replace(/\r$/, "") || "\u200b",
									renderText,
								)}
							</code>
						</div>
					);
				})}
				{lines.length === 0 ? (
					<p className="panel-empty">{translate(locale, "dock.emptyFile")}</p>
				) : null}
			</section>
		</div>
	);
}

function DiffPreview({
	text,
	scope,
	locale,
	reading,
	rootRef,
	className,
	renderText,
}: {
	readonly text: PanelText;
	readonly scope: string;
	readonly locale: Locale;
	readonly reading: ReadingState;
	readonly rootRef?: RefCallback<HTMLElement>;
	readonly className?: string;
	readonly renderText?: ReaderTextRenderer;
}): ReactElement {
	const key = `diff:${scope}\u0000${text.id}\u0000${text.text}`;
	const [wrapped, setWrapped] = useState(() => reading.wrap.get(key) ?? false);
	const [expanded, setExpanded] = useState(
		() => reading.expanded.get(key) ?? false,
	);
	const root = useRef<HTMLPreElement>(null);
	const pendingAnchor = useRef<
		ReturnType<typeof captureReadingPosition> | undefined
	>(undefined);
	const lines = text.text.split("\n");
	const foldable = lines.length > 24;
	const collapsed = foldable && !expanded;
	const foldLabel = translate(
		locale,
		collapsed ? "code.expand" : "code.collapse",
		{ count: String(lines.length) },
	);
	usePendingReadingAnchor(pendingAnchor);
	const mutate = (mutation: () => void): void => {
		pendingAnchor.current = captureReadingPosition(root.current);
		mutation();
	};
	return (
		<section
			ref={rootRef}
			className={`tool-diff text-reader${collapsed ? " collapsed" : ""} ${className ?? ""}`.trim()}
			data-text-id={text.id}
		>
			<div className="tool-result-heading">
				<div className="reader-meta">
					{text.title ?? translate(locale, "review.diff")}
					{text.source === undefined ? null : (
						<span className="tool-result-path">{text.source.startLine}</span>
					)}
				</div>
				<div className="reader-controls">
					<WrapControl
						locale={locale}
						pressed={wrapped}
						onToggle={() => {
							mutate(() => {
								const next = !wrapped;
								setWrapped(next);
								reading.wrap.set(key, next);
							});
						}}
					/>
					{foldable ? (
						<button
							type="button"
							className="reader-button reader-fold code-fold"
							title={foldLabel}
							aria-label={foldLabel}
							aria-expanded={expanded}
							onClick={() => {
								mutate(() => {
									const next = !expanded;
									setExpanded(next);
									reading.expanded.set(key, next);
								});
							}}
						>
							{foldLabel}
						</button>
					) : null}
					<CopyControl
						locale={locale}
						label={translate(locale, "dock.copyContents")}
						text={text.text}
						className="reader-button reader-copy"
						visibleLabel
					/>
				</div>
			</div>
			<pre
				ref={root}
				className={`tool-diff-code reader-content${wrapped ? " wrap" : ""}`}
			>
				{lines.map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: A diff line's source position is its stable identity during streaming.
					<Fragment key={index}>
						{index === 0 ? null : "\n"}
						<span className={`tool-diff-line ${diffTone(line)}`}>
							{renderReaderText(line, renderText)}
						</span>
					</Fragment>
				))}
			</pre>
			{foldable ? (
				<button
					type="button"
					className="reader-button code-expand-bar"
					title={foldLabel}
					aria-label={foldLabel}
					aria-expanded={expanded}
					onClick={() => {
						mutate(() => {
							const next = !expanded;
							setExpanded(next);
							reading.expanded.set(key, next);
						});
					}}
				>
					{foldLabel}
				</button>
			) : null}
		</section>
	);
}

function PlainTextPreview({
	text,
	scope,
	locale,
	reading,
	rootRef,
	className,
	renderText,
}: {
	readonly text: PanelText;
	readonly scope: string;
	readonly locale: Locale;
	readonly reading: ReadingState;
	readonly rootRef?: RefCallback<HTMLElement>;
	readonly className?: string;
	readonly renderText?: ReaderTextRenderer;
}): ReactElement {
	const key = `output:${scope}\u0000${text.id}`;
	const [wrapped, setWrapped] = useState(() => reading.wrap.get(key) ?? false);
	const [expanded, setExpanded] = useState(
		() => reading.expanded.get(key) ?? false,
	);
	const root = useRef<HTMLPreElement>(null);
	const pendingAnchor = useRef<
		ReturnType<typeof captureReadingPosition> | undefined
	>(undefined);
	const lineCount =
		text.text.length === 0
			? 0
			: text.text.replace(/\n$/, "").split("\n").length;
	const foldable = lineCount > 24;
	const collapsed = foldable && !expanded;
	const foldLabel = translate(
		locale,
		collapsed ? "code.expand" : "code.collapse",
		{ count: String(lineCount) },
	);
	usePendingReadingAnchor(pendingAnchor);
	const mutate = (mutation: () => void): void => {
		pendingAnchor.current = captureReadingPosition(root.current);
		mutation();
	};
	return (
		<div
			ref={rootRef}
			className={`panel-text-block text-reader${collapsed ? " collapsed" : ""} ${className ?? ""}`.trim()}
			data-collapsed={String(collapsed)}
			data-text-id={text.id}
		>
			{text.title === undefined ? null : (
				<p className="panel-text-title">{text.title}</p>
			)}
			<div className="file-source-toolbar reader-controls">
				<WrapControl
					locale={locale}
					pressed={wrapped}
					onToggle={() => {
						mutate(() => {
							const next = !wrapped;
							setWrapped(next);
							reading.wrap.set(key, next);
						});
					}}
				/>
				{foldable ? (
					<button
						type="button"
						className="reader-button reader-fold code-fold"
						title={foldLabel}
						aria-label={foldLabel}
						aria-expanded={expanded}
						onClick={() => {
							mutate(() => {
								const next = !expanded;
								setExpanded(next);
								reading.expanded.set(key, next);
							});
						}}
					>
						{foldLabel}
					</button>
				) : null}
				<CopyControl
					locale={locale}
					label={translate(locale, "tool.copyOutput")}
					text={text.text}
					className="reader-button reader-copy"
					visibleLabel
				/>
			</div>
			<pre
				ref={root}
				className={`panel-text reader-content${wrapped ? " wrap" : ""}`}
			>
				{renderReaderText(text.text, renderText)}
			</pre>
			{foldable ? (
				<button
					type="button"
					className="reader-button code-expand-bar"
					title={foldLabel}
					aria-label={foldLabel}
					aria-expanded={expanded}
					onClick={() => {
						mutate(() => {
							const next = !expanded;
							setExpanded(next);
							reading.expanded.set(key, next);
						});
					}}
				>
					{foldLabel}
				</button>
			) : null}
		</div>
	);
}

export function PanelTextReader({
	text,
	scope,
	locale,
	reading,
	rootRef,
	className,
	renderText,
}: {
	readonly text: PanelText;
	readonly scope: string;
	readonly locale: Locale;
	readonly reading: ReadingState;
	readonly rootRef?: RefCallback<HTMLElement>;
	readonly className?: string;
	readonly renderText?: ReaderTextRenderer;
}): ReactElement {
	if (text.text.length === 0 && text.empty !== undefined) {
		return (
			<div
				ref={rootRef}
				className={`panel-text-block ${className ?? ""}`.trim()}
				data-text-id={text.id}
			>
				{text.title === undefined ? null : (
					<p className="panel-text-title">{text.title}</p>
				)}
				<p className="panel-empty">{text.empty}</p>
			</div>
		);
	}
	if (text.source !== undefined) {
		return (
			<SourcePreview
				text={{ ...text, source: text.source }}
				scope={scope}
				locale={locale}
				reading={reading}
				rootRef={rootRef}
				className={className}
				renderText={renderText}
			/>
		);
	}
	if (text.diff === true) {
		return (
			<DiffPreview
				text={text}
				scope={scope}
				locale={locale}
				reading={reading}
				rootRef={rootRef}
				className={className}
				renderText={renderText}
			/>
		);
	}
	return (
		<PlainTextPreview
			text={text}
			scope={scope}
			locale={locale}
			reading={reading}
			rootRef={rootRef}
			className={className}
			renderText={renderText}
		/>
	);
}

function ReviewDetail({
	text,
	scope,
	locale,
	reading,
}: {
	readonly text: PanelText;
	readonly scope: string;
	readonly locale: Locale;
	readonly reading: ReadingState;
}): ReactElement {
	const root = useRef<HTMLElement>(null);
	const rendered = useRef<{
		readonly scope: string;
		readonly id: string;
		readonly text: string;
	}>(undefined);
	const setRoot = (node: HTMLElement | null): void => {
		root.current = node;
	};
	useLayoutEffect(() => {
		const previous = rendered.current;
		if (
			previous?.scope === scope &&
			previous.id === text.id &&
			previous.text === text.text
		)
			return;
		rendered.current = { scope, id: text.id, text: text.text };
		const detail = root.current;
		const body = detail?.closest<HTMLElement>(".dock-scroll");
		const row = detail?.previousElementSibling;
		if (
			detail === null ||
			body === null ||
			body === undefined ||
			row === null ||
			row === undefined
		)
			return;
		const bodyRect = body.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const bottom = detail.getBoundingClientRect().bottom;
		if (rowRect.top < bodyRect.top + 4 || bottom > bodyRect.bottom - 4)
			body.scrollTop += rowRect.top - bodyRect.top - 8;
	});
	return (
		<PanelTextReader
			text={text}
			scope={scope}
			locale={locale}
			reading={reading}
			rootRef={setRoot}
			className="review-detail"
		/>
	);
}

function PanelGroupView({
	panelId,
	group,
	scope,
	locale,
	pending,
	reading,
	fileQuery,
	hasError,
	controlEdits,
	updateControlEdit,
	onAction,
}: {
	readonly panelId: string;
	readonly group: PanelGroup;
	readonly scope: string;
	readonly locale: Locale;
	readonly pending?: PanelPending;
	readonly reading: ReadingState;
	readonly fileQuery: string;
	readonly hasError: boolean;
	readonly controlEdits: ControlEdits;
	readonly updateControlEdit: UpdateControlEdit;
	readonly onAction: (action: PanelAction) => void;
}): ReactElement {
	const fileBusy = pending?.id.startsWith("workspace:") === true;
	const query = fileQuery.trim().toLocaleLowerCase();
	const visibleRows =
		query.length === 0
			? group.rows
			: group.rows.filter(
					(row) =>
						row.file === undefined ||
						row.file.kind === "up" ||
						row.title.toLocaleLowerCase().includes(query),
				);
	const hasFileRows = group.rows.some((row) => row.file !== undefined);
	const noQueryMatch =
		query.length > 0 &&
		visibleRows.every(
			(row) => row.file === undefined || row.file.kind === "up",
		);
	const moveFileFocus = (event: KeyboardEvent<HTMLButtonElement>): void => {
		if (
			!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
			event.nativeEvent.isComposing
		)
			return;
		const entries = [
			...(event.currentTarget
				.closest(".file-entries")
				?.querySelectorAll<HTMLButtonElement>(".file-entry:not(:disabled)") ??
				[]),
		];
		const index = entries.indexOf(event.currentTarget);
		if (index < 0) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? entries.length - 1
					: Math.max(
							0,
							Math.min(
								entries.length - 1,
								index + (event.key === "ArrowUp" ? -1 : 1),
							),
						);
		entries[next]?.focus();
	};
	return (
		<section
			className="panel-group"
			data-group-id={group.id}
			data-skeleton={group.skeleton}
		>
			{group.title.length === 0 &&
			group.description === undefined &&
			group.hint === undefined &&
			(group.actions?.length ?? 0) === 0 ? null : (
				<header className="panel-group-head">
					<div className="panel-group-titles">
						{group.title.length === 0 ? null : (
							<h2 className="panel-group-title" aria-label={group.title}>
								{group.title}
								{group.hint === undefined ? null : (
									<Hint text={group.hint} locale={locale} />
								)}
							</h2>
						)}
						{group.description === undefined ? null : (
							<p className="panel-group-desc">{group.description}</p>
						)}
					</div>
					{(group.actions?.length ?? 0) === 0 ? null : (
						<div className="panel-actions">
							{group.actions?.map((action) => (
								<PanelButtonView
									key={`${action.id}:${action.data ?? ""}`}
									action={action}
									pending={pending}
									onAction={onAction}
								/>
							))}
						</div>
					)}
				</header>
			)}
			{group.lead === undefined ? null : (
				<div className="panel-lead">
					<div>
						<p className="panel-lead-title">{group.lead.title}</p>
						{group.lead.description === undefined ? null : (
							<p className="panel-lead-desc">{group.lead.description}</p>
						)}
					</div>
					<div className="panel-actions">
						{group.lead.actions.map((action) => (
							<PanelButtonView
								key={`${action.id}:${action.data ?? ""}`}
								action={action}
								pending={pending}
								onAction={onAction}
							/>
						))}
					</div>
				</div>
			)}
			<div className={hasFileRows ? "panel-rows file-entries" : "panel-rows"}>
				{visibleRows.map((row) => (
					<Fragment key={row.id}>
						<PanelRowView
							panelId={panelId}
							row={row}
							locale={locale}
							pending={pending}
							skeleton={group.skeleton}
							fileBusy={fileBusy}
							hasError={hasError}
							controlEdits={controlEdits}
							updateControlEdit={updateControlEdit}
							onKeyDown={hasFileRows ? moveFileFocus : undefined}
							onAction={onAction}
						/>
						{row.detail === undefined ? null : (
							<ReviewDetail
								text={row.detail}
								scope={scope}
								locale={locale}
								reading={reading}
							/>
						)}
					</Fragment>
				))}
				{group.rows.length === 0 &&
				query.length === 0 &&
				group.empty !== undefined ? (
					<p className="panel-empty" data-cause={group.empty.cause}>
						{group.empty.text}
					</p>
				) : null}
				{noQueryMatch ? (
					<p className="panel-empty file-filter-empty">
						{translate(locale, "dock.noMatchingFiles")}
					</p>
				) : null}
			</div>
			{group.footnote === undefined ? null : (
				<p className="panel-footnote">{group.footnote}</p>
			)}
		</section>
	);
}

function FileNavigation({
	panel,
	locale,
	pending,
	query,
	onQuery,
	matchCount,
	onAction,
}: {
	readonly panel: PanelSpec & {
		readonly files: NonNullable<PanelSpec["files"]>;
	};
	readonly locale: Locale;
	readonly pending?: PanelPending;
	readonly query: string;
	readonly onQuery: (query: string) => void;
	readonly matchCount: number;
	readonly onAction: (action: PanelAction) => void;
}): ReactElement {
	const files = panel.files;
	const busy = pending?.id.startsWith("workspace:") === true;
	const reload = files.reload;
	const filter = useRef<HTMLInputElement>(null);
	return (
		<div className="file-navigation">
			<Breadcrumbs
				label={translate(locale, "dock.filePath")}
				levels={files.breadcrumbs.map((crumb) => ({
					key: crumb.path,
					label: crumb.label,
				}))}
				disabled={busy}
				onNavigate={(path) => {
					onAction({
						kind: "command",
						id: WORKSPACE_OPEN_ACTION,
						data: path,
					});
				}}
			/>
			<div className="file-navigation-meta">
				{files.page === undefined ? null : (
					<span className="file-page-range">{files.page}</span>
				)}
				{reload === undefined ? null : (
					<button
						type="button"
						className="file-icon-button icon-button"
						aria-label={reload.label}
						title={reload.label}
						disabled={busy || reload.disabled === true}
						onClick={() =>
							onAction({
								kind: "command",
								id: reload.id,
								data: reload.data,
							})
						}
					>
						<Icon name="refresh" />
					</button>
				)}
				<CopyControl
					locale={locale}
					label={translate(locale, "dock.copyPath")}
					text={files.breadcrumbs.at(-1)?.path ?? files.cwd}
					className="file-icon-button icon-button"
				/>
			</div>
			{files.filterScope === undefined ? null : (
				<>
					<div className="file-filter">
						<Icon name="search" />
						<input
							ref={filter}
							type="search"
							className="file-filter-input"
							placeholder={translate(locale, "dock.filterFiles")}
							aria-label={translate(locale, "dock.filterFiles")}
							autoComplete="off"
							spellCheck={false}
							value={query}
							onChange={(event) => {
								onQuery(event.currentTarget.value);
							}}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return;
								if (event.key === "Escape" && query.length > 0) {
									event.preventDefault();
									event.stopPropagation();
									onQuery("");
									queueMicrotask(() => filter.current?.focus());
								}
								if (event.key === "ArrowDown") {
									event.preventDefault();
									event.currentTarget
										.closest(".panel")
										?.querySelector<HTMLButtonElement>(
											".file-entry:not(:disabled):not([hidden])",
										)
										?.focus();
								}
							}}
						/>
						<button
							type="button"
							className="file-icon-button icon-button"
							title={translate(locale, "dock.clearFilter")}
							aria-label={translate(locale, "dock.clearFilter")}
							hidden={query.length === 0}
							onClick={() => {
								onQuery("");
								queueMicrotask(() => filter.current?.focus());
							}}
						>
							<Icon name="x" />
						</button>
					</div>
					<p
						className="file-filter-status"
						aria-live="polite"
						aria-atomic="true"
						hidden={query.trim().length === 0}
					>
						{translate(locale, "dock.matchingFiles", {
							count: String(matchCount),
						})}
					</p>
				</>
			)}
			{busy ? (
				<p
					className="file-operation-status"
					aria-live="polite"
					aria-atomic="true"
				>
					{translate(locale, "dock.readingFiles")}
				</p>
			) : null}
		</div>
	);
}

function PanelInputView({
	input,
	draftKey,
	drafts,
	onAction,
}: {
	readonly input: PanelInput;
	readonly draftKey: string;
	readonly drafts: Map<string, string>;
	readonly onAction: (action: PanelAction) => void;
}): ReactElement {
	const [value, setValue] = useState(() => drafts.get(draftKey) ?? input.value);
	const composing = useRef(false);
	const submit = (): void => {
		if (input.submit.disabled === true || composing.current) return;
		onAction({ kind: "command", id: input.submit.id, data: value });
	};
	return (
		<form
			className="panel-input-row"
			data-input-row={input.id}
			onSubmit={(event: FormEvent<HTMLFormElement>) => {
				event.preventDefault();
				submit();
			}}
		>
			<input
				type="text"
				className="panel-input panel-input-wide"
				value={value}
				placeholder={input.placeholder}
				aria-label={input.placeholder}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => {
					const next = event.currentTarget.value;
					setValue(next);
					drafts.set(draftKey, next);
				}}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && event.nativeEvent.isComposing)
						event.preventDefault();
				}}
			/>
			<button
				type="submit"
				className={panelButtonClass(input.submit)}
				disabled={input.submit.disabled === true}
				data-action={input.submit.id}
			>
				{input.submit.label}
			</button>
		</form>
	);
}

function PanelNoticeView({
	notice,
	locale,
}: {
	readonly notice: PanelNotice;
	readonly locale: Locale;
}): ReactElement | null {
	const [shown, setShown] = useState(true);
	const persistence =
		notice.persistence ?? (notice.tone === "info" ? "transient" : "pinned");
	useEffect(() => {
		if (persistence !== "transient") return;
		const timer = setTimeout(() => {
			setShown(false);
		}, 2400);
		return () => {
			clearTimeout(timer);
		};
	}, [persistence]);
	if (!shown) return null;
	const text =
		notice.tone === "error"
			? errorMessageCopy(locale, notice.text)
			: notice.text;
	return (
		<p
			className={`panel-notice ${notice.tone}`}
			data-notice-key={`${notice.tone}\u0000${notice.text}`}
		>
			{text}
		</p>
	);
}

function PanelSpecView({
	panel,
	scope,
	locale,
	onAction,
	reading,
	inputDrafts,
}: {
	readonly panel: PanelSpec;
	readonly scope: string;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
	readonly reading: ReadingState;
	readonly inputDrafts: Map<string, string>;
}): ReactElement {
	const files = panel.files;
	const filterScope = `${scope}\u0000${files?.filterScope ?? ""}`;
	const [fileFilter, setFileFilter] = useState<{
		readonly scope: string;
		readonly query: string;
	}>(() => ({
		scope: filterScope,
		query: "",
	}));
	const [controlEdits, setControlEdits] = useState<ControlEdits>({});
	const updateControlEdit = useCallback<UpdateControlEdit>((key, update) => {
		setControlEdits((current) => {
			const next = update(current[key]);
			return current[key] === next ? current : { ...current, [key]: next };
		});
	}, []);
	const query = fileFilter.scope === filterScope ? fileFilter.query : "";
	useEffect(() => {
		setFileFilter((current) =>
			current.scope === filterScope
				? current
				: { scope: filterScope, query: "" },
		);
	}, [filterScope]);
	const entries = panel.groups.flatMap((group) =>
		group.rows.filter(
			(row) => row.file !== undefined && row.file.kind !== "up",
		),
	);
	const queryLower = query.trim().toLocaleLowerCase();
	const matchCount =
		queryLower.length === 0
			? entries.length
			: entries.filter((row) =>
					row.title.toLocaleLowerCase().includes(queryLower),
				).length;
	const readerScope = `${scope}\u0000${
		files === undefined ? panel.id : `${files.cwd}\u0000${files.path}`
	}`;
	const inputDraftScope = `${scope}\u0000${panel.id}`;
	const hasError = panel.notices.some((notice) => notice.tone === "error");
	const updateFilter = (next: string): void => {
		setFileFilter({ scope: filterScope, query: next });
	};
	return (
		<div
			className="panel"
			data-panel-id={panel.id}
			aria-busy={
				panel.pending?.id.startsWith("workspace:") === true || undefined
			}
		>
			{files === undefined ? null : (
				<FileNavigation
					panel={{ ...panel, files }}
					locale={locale}
					pending={panel.pending}
					query={query}
					onQuery={updateFilter}
					matchCount={matchCount}
					onAction={onAction}
				/>
			)}
			{panel.notices.map((notice, index) => (
				<PanelNoticeView
					key={`${notice.tone}:${notice.text}:${index}`}
					notice={notice}
					locale={locale}
				/>
			))}
			{(panel.inputs ?? []).map((input) => (
				<PanelInputView
					key={input.id}
					input={input}
					draftKey={`${inputDraftScope}\u0000${input.id}`}
					drafts={inputDrafts}
					onAction={onAction}
				/>
			))}
			{panel.groups.map((group) => (
				<PanelGroupView
					key={`${readerScope}\u0000${group.id}`}
					panelId={panel.id}
					group={group}
					scope={readerScope}
					locale={locale}
					pending={panel.pending}
					reading={reading}
					fileQuery={files?.filterScope === undefined ? "" : query}
					hasError={hasError}
					controlEdits={controlEdits}
					updateControlEdit={updateControlEdit}
					onAction={onAction}
				/>
			))}
			{(panel.texts ?? []).map((text) => (
				<PanelTextReader
					key={`${readerScope}\u0000${text.id}`}
					text={text}
					scope={readerScope}
					locale={locale}
					reading={reading}
				/>
			))}
		</div>
	);
}

function DockPtySurface({
	view,
	onTerminalInput,
	onTerminalResize,
}: {
	readonly view: PtyPresentation;
	readonly onTerminalInput?: (id: string, data: string) => void;
	readonly onTerminalResize?: (id: string, cols: number, rows: number) => void;
}): ReactElement {
	const host = useRef<HTMLDivElement>(null);
	const surface = useRef<ReturnType<typeof createPtySurface> | undefined>(
		undefined,
	);
	const input = useRef(onTerminalInput);
	const resize = useRef(onTerminalResize);
	const renderedViewId = useRef(view.id);
	const [error, setError] = useState<string>();
	useLayoutEffect(() => {
		input.current = onTerminalInput;
		resize.current = onTerminalResize;
	}, [onTerminalInput, onTerminalResize]);
	useEffect(() => {
		const node = host.current;
		if (node === null) return;
		const adapter = createPtySurface({
			data: (id, data) => {
				input.current?.(id, data);
			},
			resize: (id, cols, rows) => {
				resize.current?.(id, cols, rows);
			},
			error: (failure) => {
				setError(failure instanceof Error ? failure.message : String(failure));
			},
		});
		surface.current = adapter;
		node.replaceChildren(adapter.element);
		return () => {
			if (surface.current === adapter) surface.current = undefined;
			adapter.dispose();
			if (node.contains(adapter.element)) node.removeChild(adapter.element);
		};
	}, []);
	useEffect(() => {
		surface.current?.update(view);
	}, [view]);
	useEffect(() => {
		if (renderedViewId.current === view.id) return;
		renderedViewId.current = view.id;
		setError(undefined);
	});
	return (
		<>
			<div ref={host} className="pty-host" />
			{error === undefined ? null : (
				<p className="panel-notice error" role="alert">
					{error}
				</p>
			)}
		</>
	);
}

/** The new tab is a doorway: choosing a tool replaces it or selects the tool's existing tab. */
function DockGuide({ tabs, onOpenTab }: {
	readonly tabs: readonly DockTab[];
	readonly onOpenTab: (id: DockTabId) => void;
}): ReactElement {
	return (
		<div className="dock-guide" data-panel-id="guide">
			<Icon name="compass" className="icon dock-guide-hero" />
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					className="dock-guide-entry"
					onClick={() => onOpenTab(tab.id)}
				>
					<Icon name={DOCK_ICONS[tab.id]} />
					<span>{tab.label}</span>
				</button>
			))}
		</div>
	);
}

export function Dock({
	scope,
	view,
	locale,
	fullscreen,
	visible,
	onAnimateWidth,
	onResizeStart,
	onToggleFullscreen,
	onAction,
	onTerminalInput,
	onTerminalResize,
}: DockProps): ReactElement {
	const tabs = useRef(new Map<string, HTMLButtonElement>());
	const reading = useRef<ReadingState>({
		wrap: new Map(),
		expanded: new Map(),
		sourcePositions: new Map(),
	});
	const inputDrafts = useRef(new Map<string, string>());
	const dock = useRef<HTMLElement>(null);
	const tabRow = useRef<HTMLDivElement>(null);
	/* The chips whose titles are wider than their box, so only those fade at the clipped edge. */
	const tabLabels = useRef(new Map<string, HTMLSpanElement>());
	/* Opening moves focus into the revealed panel; collapsing hands it back to the header's button. */
	const restoreFocus = useRef(false);
	const previousOpen = useRef(view.open);
	const focusAfterNavigation = useRef(false);
	/* The stored preference, read once per mounted dock; the page clamps it again for the window. */
	const preferred = useRef<number | null>(null);
	const resize = useRef<{
		readonly target: HTMLDivElement;
		readonly pointerId: number;
		readonly startX: number;
		readonly startWidth: number;
	} | null>(null);
	const [overflow, setOverflow] = useState<"start" | "end" | "both" | "none">(
		"none",
	);
	useLayoutEffect(() => {
		preferred.current = readDockWidth();
		applyDockWidth(preferred.current);
		return () => applyDockWidth(null);
	}, []);
	const active = view.tabs.find((tab) => tab.active)?.id ?? view.tabs[0]?.id;
	useLayoutEffect(() => {
		if (!focusAfterNavigation.current) return;
		focusAfterNavigation.current = false;
		if (view.open && active !== undefined) tabs.current.get(active)?.focus({ preventScroll: true });
	}, [view.tabs, view.open, active]);
	/* The grip reports the rendered width, not the preference: the window can clamp either side. */
	const [splitter, setSplitter] = useState({ width: 0, minimum: 0, maximum: 0 });
	const measureSplitter = useCallback(() => {
		const element = dock.current;
		if (element === null) return;
		const width = Math.round(element.getBoundingClientRect().width);
		const { minimum, maximum } = dockBounds(element);
		setSplitter((current) => current.width === width && current.minimum === minimum && current.maximum === maximum
			? current : { width, minimum, maximum });
	}, []);
	useLayoutEffect(() => {
		if (!visible || fullscreen) return;
		const element = dock.current;
		if (element === null) return;
		const sync = (): void => {
			// A drag reports its final width on release; between moves the size is the pointer's.
			if (resize.current === null) measureSplitter();
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(element);
		window.addEventListener("resize", sync);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", sync);
		};
	}, [visible, fullscreen, measureSplitter]);
	/* Which ends of the tab strip are scrolled out of view; the row fades exactly those ends. */
	const syncOverflow = useCallback(() => {
		const row = tabRow.current;
		if (row === null) return;
		const start = row.scrollLeft > 1;
		const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
		const next = start && end ? "both" : start ? "start" : end ? "end" : "none";
		setOverflow((current) => (current === next ? current : next));
	}, []);
	/* Keep the active chip visible without scrolling the page while the dock itself slides. */
	const syncTabLayout = useCallback(() => {
		for (const node of tabLabels.current.values()) {
			if (node.scrollWidth > node.clientWidth + 1) node.dataset.clipped = "";
			else delete node.dataset.clipped;
		}
		const row = tabRow.current;
		const tab = active === undefined ? undefined : tabs.current.get(active);
		if (row !== null && tab !== undefined) {
			const box = (tab.closest(".dock-chip") ?? tab).getBoundingClientRect();
			const left = row.scrollLeft + box.left - row.getBoundingClientRect().left;
			if (left < row.scrollLeft) row.scrollTo({ left });
			else if (left + box.width > row.scrollLeft + row.clientWidth)
				row.scrollTo({ left: left + box.width - row.clientWidth });
		}
		syncOverflow();
	}, [active, syncOverflow]);
	useLayoutEffect(() => {
		if (visible) syncTabLayout();
	}, [view.tabs, locale, visible, syncTabLayout]);
	useEffect(() => {
		if (!visible) return;
		const row = tabRow.current;
		if (row === null) return;
		row.addEventListener("scroll", syncOverflow, { passive: true });
		const observer = new ResizeObserver(syncTabLayout);
		observer.observe(row);
		return () => {
			row.removeEventListener("scroll", syncOverflow);
			observer.disconnect();
		};
	}, [visible, syncOverflow, syncTabLayout]);
	/* A panel that opens takes focus to its selected tab; a panel that closes gives it back to the
	   conversation header's expand button instead of leaving it on hidden content. A panel mounted
	   while open does not steal focus from the page. This runs after paint because the panel is
	   still visibility:hidden while its opening commit's layout effects run (the frame owns that
	   class), and a hidden element cannot take focus. The selected chip is retried for a few frames
	   so every opener (header button, Cmd/Ctrl+Alt+M, panel toggle) ends on the same tab instead of
	   leaving focus on the body when the reveal paints a frame late. */
	useEffect(() => {
		if (previousOpen.current === view.open) return;
		previousOpen.current = view.open;
		if (!view.open) {
			if (!restoreFocus.current) return;
			restoreFocus.current = false;
			if (
				document.activeElement === document.body ||
				dock.current?.contains(document.activeElement)
			)
				document
					.querySelector<HTMLElement>("[data-dock-expand]")
					?.focus({ preventScroll: true });
			return;
		}
		let frames = 0;
		let cancelled = false;
		const focusSelected = (): void => {
			if (cancelled) return;
			const node = active === undefined ? undefined : tabs.current.get(active);
			if (node === undefined) {
				if (frames++ < 4) requestAnimationFrame(focusSelected);
				return;
			}
			node.focus({ preventScroll: true });
			if (document.activeElement !== node && frames++ < 4)
				requestAnimationFrame(focusSelected);
		};
		focusSelected();
		return () => {
			cancelled = true;
		};
	}, [view.open, active]);
	const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const element = dock.current;
		if (event.button !== 0 || element === null) return;
		event.preventDefault();
		onResizeStart();
		resize.current = {
			target: event.currentTarget,
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth: element.getBoundingClientRect().width,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		document.body.classList.add("dock-resizing");
	};
	const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const state = resize.current;
		const element = dock.current;
		if (state === null || state.pointerId !== event.pointerId || element === null) return;
		const width = clampDockWidth(
			element,
			state.startWidth - (event.clientX - state.startX),
		);
		preferred.current = width;
		applyDockWidth(width);
	};
	const finishResize = useCallback((): void => {
		const state = resize.current;
		if (state === null) return;
		resize.current = null;
		if (state.target.hasPointerCapture(state.pointerId)) state.target.releasePointerCapture(state.pointerId);
		document.body.classList.remove("dock-resizing");
		storeDockWidth(preferred.current);
		measureSplitter();
	}, [measureSplitter]);
	const endResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (resize.current?.pointerId === event.pointerId) finishResize();
	};
	useEffect(() => {
		if (!visible || fullscreen) finishResize();
	}, [visible, fullscreen, finishResize]);
	useEffect(() => () => finishResize(), [finishResize]);
	const resetWidth = (): void => {
		preferred.current = null;
		storeDockWidth(null);
		onAnimateWidth(() => applyDockWidth(null));
	};
	/* Arrow keys move the grip in 16px steps, so the width is not a pointer-only control. The step
	   starts from the rendered width, like the drag does: a window-clamped panel would otherwise
	   spend its first presses moving a preference the render cannot show. */
	const stepWidth = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const element = dock.current;
		if (element === null) return;
		onResizeStart();
		const current = element.getBoundingClientRect().width;
		const width = clampDockWidth(
			element,
			current + (event.key === "ArrowLeft" ? 16 : -16),
		);
		preferred.current = width;
		applyDockWidth(width);
		storeDockWidth(width);
	};
	/* Arrow keys move focus through the strip; selecting stays a separate Enter, Space, or click, the
	   WAI-ARIA tabs pattern with manual activation. */
	const moveTab = (
		event: KeyboardEvent<HTMLButtonElement>,
		current: DockTabId,
	): void => {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
			return;
		if (event.key === "Delete") {
			event.preventDefault();
			closeTab(current);
			return;
		}
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const index = view.tabs.findIndex((tab) => tab.id === current);
		const next =
			event.key === "Home"
				? view.tabs[0]
				: event.key === "End"
					? view.tabs.at(-1)
					: view.tabs[
							(Math.max(0, index) +
								(event.key === "ArrowLeft" ? -1 : 1) +
								view.tabs.length) %
								view.tabs.length
						];
		if (next === undefined) return;
		event.preventDefault();
		tabs.current.get(next.id)?.focus();
	};
	const closeTab = (id: DockTabId): void => {
		focusAfterNavigation.current = true;
		onAction({ kind: "command", id: DOCK_TAB_CLOSE_ACTION, data: id });
	};
	const openTab = (id: DockTabId): void => {
		focusAfterNavigation.current = true;
		onAction({ kind: "command", id: DOCK_TAB_ACTION, data: id });
	};
	const activeTab = view.tabs.find((tab) => tab.active);
	const repeated = view.panel.groups.find(
		(group) => group.title.length > 0 && group.title === view.panel.title,
	);
	const deduped =
		repeated === undefined
			? view.panel
			: {
					...view.panel,
					actions: repeated.actions ?? view.panel.actions,
					groups: view.panel.groups.map((group) =>
						group === repeated
							? { ...group, title: "", actions: undefined }
							: group,
					),
				};
	// The tab already names the panel; repeating it as an H1 adds a line without information.
	const panel =
		activeTab !== undefined && deduped.title === activeTab.label
			? { ...deduped, title: "" }
			: deduped;
	const panelActions = panel.actions ?? [];
	/* A tab-named panel keeps icon actions in the strip; any labeled action still needs a head row. */
	const stripActions =
		panel.title.length === 0
			? panelActions.filter((action) => action.stripIcon !== undefined)
			: [];
	const headActions = panelActions.filter(
		(action) => !stripActions.includes(action),
	);
	const pinnedHead = panel.title.length > 0 || headActions.length > 0;
	const panelView = (
		<PanelSpecView
			key={`${scope}\u0000${panel.id}`}
			panel={panel}
			scope={scope}
			locale={locale}
			onAction={onAction}
			reading={reading.current}
			inputDrafts={inputDrafts.current}
		/>
	);
	return (
		<aside
			ref={dock}
			className="dock"
			id="dock"
			aria-label={translate(locale, "dock.toggle")}
			data-open={visible ? "true" : undefined}
			data-presentation={fullscreen ? "fullscreen" : "push"}
			aria-hidden={visible ? undefined : true}
			inert={!visible}
			onFocusCapture={() => {
				restoreFocus.current = true;
			}}
			onBlurCapture={(event) => {
				if (
					event.relatedTarget instanceof Node &&
					!event.currentTarget.contains(event.relatedTarget)
				)
					restoreFocus.current = false;
			}}
		>
			{/* The strip is the panel's whole top edge: the tab chips, then the two panel controls at
			    its far end. A tab click selects; the arrows only move focus between chips. */}
			<div className="dock-strip">
				<div
					ref={tabRow}
					className="dock-chips"
					role="tablist"
					aria-label={translate(locale, "dock.toggle")}
					data-overflow={overflow === "none" ? undefined : overflow}
				>
					{view.tabs.map((tab, index) => (
						<Fragment key={tab.id}>
							{index > 0 ? (
								<span className="dock-slot" aria-hidden="true" />
							) : null}
							<div className={`dock-chip${tab.active ? " active" : ""}`} role="presentation">
								<button
									ref={(node) => {
										if (node === null) tabs.current.delete(tab.id);
										else tabs.current.set(tab.id, node);
									}}
									type="button"
									className={`dock-tab${tab.active ? " active" : ""}`}
									id={`dock-tab-${tab.id}`}
									role="tab"
									aria-selected={tab.active}
									aria-controls="dock-body"
									tabIndex={tab.active ? 0 : -1}
									title={
										tab.id === "terminal"
											? translate(locale, "dock.terminalTabTitle")
											: tab.label
									}
									data-tab={tab.id}
									onClick={() => {
										onAction({
											kind: "command",
											id: DOCK_TAB_ACTION,
											data: tab.id,
										});
									}}
									onKeyDown={(event) => {
										moveTab(event, tab.id);
									}}
								>
									<Icon
										name={DOCK_ICONS[tab.id]}
										className="icon dock-tab-icon"
									/>
									<span
										className="dock-tab-label"
										ref={(node) => {
											if (node === null) tabLabels.current.delete(tab.id);
											else tabLabels.current.set(tab.id, node);
										}}
									>
										{tab.label}
									</span>
								</button>
								{tab.id === "guide" && view.tabs.length === 1 ? null : <button
									type="button"
									className="dock-tab-close"
									tabIndex={tab.active ? 0 : -1}
									aria-label={translate(locale, tab.id === "terminal" ? "dock.closeTerminalTab" : "dock.closeTab", { name: tab.label })}
									title={translate(locale, tab.id === "terminal" ? "dock.closeTerminalTab" : "dock.closeTab", { name: tab.label })}
									onClick={() => closeTab(tab.id)}
								><Icon name="x" /></button>}
							</div>
						</Fragment>
					))}
				</div>
				<button
					type="button"
					className="icon-button icon-button--compact dock-add-tab"
					aria-label={translate(locale, "dock.newTab")}
					title={translate(locale, "dock.newTab")}
					onClick={() => openTab("guide")}
				><Icon name="plus" /></button>
				<span className="dock-strip-fill" />
				{stripActions.length === 0 ? null : (
					<div className="dock-chrome">
						{stripActions.map((action) => (
							<button
								key={`${action.id}\u0000${action.data ?? ""}`}
								className="icon-button icon-button--compact"
								type="button"
								aria-label={action.label}
								title={action.label}
								disabled={action.disabled === true}
								onClick={() =>
									onAction({
										kind: "command",
										id: action.id,
										data: action.data,
									})
								}
							>
								<Icon name={action.stripIcon ?? "refresh"} />
							</button>
						))}
					</div>
				)}
				<div className="dock-chrome">
					<button
						className="icon-button icon-button--compact"
						type="button"
						aria-label={translate(
							locale,
							fullscreen ? "dock.exitFullscreen" : "dock.fullscreen",
						)}
						title={translate(
							locale,
							fullscreen ? "dock.exitFullscreen" : "dock.fullscreen",
						)}
						aria-pressed={fullscreen}
						data-dock-fullscreen
						onClick={onToggleFullscreen}
					>
						<Icon name={fullscreen ? "restore" : "fullscreen"} />
					</button>
					<button
						className="icon-button icon-button--compact"
						type="button"
						aria-label={translate(locale, "dock.collapse")}
						title={translate(locale, "dock.collapse")}
						aria-controls="dock"
						data-dock-collapse
						onClick={() => {
							onAction({
								kind: "command",
								id: DOCK_TOGGLE_ACTION,
								data: undefined,
							});
						}}
					>
						<Icon name="panel-right" />
					</button>
				</div>
			</div>
			<div
				className="dock-body"
				id="dock-body"
				role="tabpanel"
				aria-labelledby={
					active === undefined ? undefined : `dock-tab-${active}`
				}
			>
				<>
					{pinnedHead ? (
						<div className="dock-panel-head">
							<PanelHead
								panel={{ ...panel, description: undefined, actions: headActions }}
								locale={locale}
								onAction={onAction}
							/>
						</div>
					) : null}
					{active === "guide" ? (
						<div className="dock-scroll">
							<DockGuide tabs={view.availableTabs} onOpenTab={openTab} />
						</div>
					) : view.pty === undefined ? (
						<div className="dock-scroll">
							{panel.description === undefined ? null : (
								<p className="dock-panel-desc">
									<SensitiveText
										text={panel.description}
										locale={locale}
									/>
								</p>
							)}
							{panelView}
						</div>
					) : (
						/* The tab is the shell's screen: the terminal takes every pixel left in the panel. */
						<div className="dock-terminal">
							{visible ? (
								<DockPtySurface
									view={view.pty}
									onTerminalInput={onTerminalInput}
									onTerminalResize={onTerminalResize}
								/>
							) : null}
						</div>
					)}
				</>
			</div>
			<div
				className="dock-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label={translate(locale, "dock.resize")}
				aria-valuemin={splitter.minimum}
				aria-valuemax={splitter.maximum}
				aria-valuenow={splitter.width}
				tabIndex={0}
				onKeyDown={stepWidth}
				onPointerDown={startResize}
				onPointerMove={moveResize}
				onPointerUp={endResize}
				onPointerCancel={endResize}
				onLostPointerCapture={endResize}
				onDoubleClick={resetWidth}
			/>
		</aside>
	);
}
