import type {
	MouseEvent as ReactMouseEvent,
	ReactNode,
	RefObject,
} from "react";
import {
	Component,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	DOCK_TAB_ACTION,
	HISTORY_MORE_ACTION,
	MODEL_CONNECTIONS_ACTION,
	MODEL_SCOPE_ACTION,
	TRANSCRIPT_SEARCH_ACTION,
	WELCOME_SESSION_ACTION,
	WORKSPACE_FILE_LINK_ACTION,
} from "../actions.ts";
import { credentialRanges } from "../credentials.ts";
import { errorMessageCopy } from "../errors.ts";
import type { FileLocation } from "../file-links.ts";
import type { Locale } from "../locale.ts";
import type { PanelButton } from "../panels.ts";
import { type ProcessGroup, processGroups } from "../process-groups.ts";
import { SESSION_RESTORE_ACTION } from "../projects.ts";
import { quotedDraft } from "../quote.ts";
import type { PageRenderer } from "../render.ts";
import { type MessageKey, translate } from "../strings.ts";
import { transcriptPosition } from "../transcript-position.ts";
import type { TranscriptBlock, WelcomeCard } from "../view.ts";
import { transcriptSearchHits } from "../view.ts";
import type { TranscriptProps, TranscriptView } from "./chat.tsx";
import { CredentialText } from "./chat-credential.tsx";
import { Markdown } from "./markdown.tsx";

type IconName =
	| "alert"
	| "check"
	| "chevron-down"
	| "copy"
	| "folder"
	| "plus"
	| "sparkles"
	| "spinner"
	| "square-pen"
	| "thumb-down"
	| "thumb-up"
	| "wrench"
	| "x";

interface IconProps {
	readonly name: IconName;
	readonly className?: string;
}

function Icon({ name, className = "icon" }: IconProps) {
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

function command(actions: PageRenderer, id: string, data?: string) {
	actions.onPanelAction({ kind: "command", id, data });
}

function panelButtonClass(action: PanelButton): string {
	return `panel-button weight-${action.weight}${action.danger === true ? " is-danger" : ""}`;
}

interface CopyButtonProps {
	readonly locale: Locale;
	readonly text: string;
	readonly label: MessageKey;
	readonly className?: string;
	readonly visibleLabel?: boolean;
}

function CopyButton({
	locale,
	text,
	label,
	className = "message-action",
	visibleLabel = false,
}: CopyButtonProps) {
	const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<number | undefined>(undefined);

	useEffect(
		() => () => {
			if (timer.current !== undefined) window.clearTimeout(timer.current);
		},
		[],
	);

	const showOutcome = (next: "copied" | "failed") => {
		setOutcome(next);
		if (timer.current !== undefined) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOutcome("idle"), 1200);
	};

	const copy = () => {
		const written = navigator.clipboard?.writeText(text);
		if (written === undefined) {
			showOutcome("failed");
			return;
		}
		void written.then(
			() => showOutcome("copied"),
			() => showOutcome("failed"),
		);
	};

	const shownLabel = translate(
		locale,
		outcome === "idle"
			? label
			: outcome === "copied"
				? "copy.copied"
				: "copy.failed",
	);
	const icon =
		outcome === "copied" ? "check" : outcome === "failed" ? "x" : "copy";
	return (
		<button
			type="button"
			className={className}
			title={shownLabel}
			aria-label={shownLabel}
			onClick={copy}
		>
			<Icon name={icon} />
			{visibleLabel ? <span className="copy-label">{shownLabel}</span> : null}
		</button>
	);
}

function maskedText(text: string): string {
	let from = 0;
	let result = "";
	for (const range of credentialRanges(text)) {
		result += text.slice(from, range.start) + range.masked;
		from = range.end;
	}
	return result + text.slice(from);
}

interface MessageActionsProps {
	readonly block: TranscriptBlock;
	readonly locale: Locale;
	readonly actions: PageRenderer;
}

function MessageActions({ block, locale, actions }: MessageActionsProps) {
	const ranges = useMemo(() => credentialRanges(block.text), [block.text]);
	const feedback = block.feedback;
	return (
		<div className="turn-actions">
			<CopyButton
				locale={locale}
				text={block.text}
				label={ranges.length > 0 ? "copy.sensitive" : "copy.copy"}
				className={`message-action${ranges.length > 0 ? " copy-sensitive" : ""}`}
				visibleLabel={ranges.length > 0}
			/>
			{ranges.length > 0 ? (
				<CopyButton
					locale={locale}
					text={maskedText(block.text)}
					label="copy.masked"
					className="message-action copy-masked"
					visibleLabel
				/>
			) : null}
			{feedback === undefined ? null : (
				<>
					<button
						type="button"
						className={`message-action${feedback.rating === "up" ? " selected" : ""}`}
						data-action={feedback.up.id}
						data-action-data={feedback.up.data}
						title={feedback.up.label}
						aria-label={feedback.up.label}
						aria-pressed={feedback.rating === "up"}
						onClick={() => command(actions, feedback.up.id, feedback.up.data)}
					>
						<Icon name="thumb-up" />
					</button>
					<button
						type="button"
						className={`message-action${feedback.rating === "down" ? " selected" : ""}`}
						data-action={feedback.down.id}
						data-action-data={feedback.down.data}
						title={feedback.down.label}
						aria-label={feedback.down.label}
						aria-pressed={feedback.rating === "down"}
						onClick={() =>
							command(actions, feedback.down.id, feedback.down.data)
						}
					>
						<Icon name="thumb-down" />
					</button>
				</>
			)}
		</div>
	);
}

interface DisclosureProps {
	readonly children: ReactNode;
	readonly className: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly dataBlockId?: string;
}

function Disclosure({
	children,
	className,
	open,
	onOpenChange,
	dataBlockId,
}: DisclosureProps) {
	return (
		<details
			className={`disclosure ${className}`.trim()}
			open={open}
			data-block-id={dataBlockId}
			onToggle={(event) => onOpenChange(event.currentTarget.open)}
		>
			{children}
		</details>
	);
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

interface DiffViewProps {
	readonly locale: Locale;
	readonly diff: NonNullable<NonNullable<TranscriptBlock["result"]>["diff"]>;
}

function DiffView({ locale, diff }: DiffViewProps) {
	return (
		<section className="tool-diff text-reader">
			<div className="tool-result-heading">
				<div className="reader-meta">
					{diff.label}
					{diff.path ? (
						<span className="tool-result-path">{diff.path}</span>
					) : null}
				</div>
				<div className="reader-controls">
					<CopyButton
						locale={locale}
						text={diff.patch ?? diff.text}
						label={
							diff.patch === undefined ? "dock.copyContents" : "tool.copyPatch"
						}
						className="reader-button"
						visibleLabel
					/>
				</div>
			</div>
			<pre className="tool-diff-code reader-content" data-text-key="diff">
				{diff.text.split("\n").map((line, index) => {
					const tone =
						line.startsWith("+++ ") || line.startsWith("--- ")
							? "diff-header"
							: line.startsWith("@@")
								? "diff-hunk"
								: line.startsWith("+")
									? "addition"
									: line.startsWith("-")
										? "removal"
										: "context";
					return (
						<span className={`tool-diff-line ${tone}`} key={`${index}:${line}`}>
							{line}
							{"\n"}
						</span>
					);
				})}
			</pre>
		</section>
	);
}

interface ReaderOutputProps {
	readonly locale: Locale;
	readonly text: string;
	readonly className?: string;
	readonly textKey: string;
}

function ReaderOutput({
	locale,
	text,
	className = "tool-output",
	textKey,
}: ReaderOutputProps) {
	const [wrap, setWrap] = useState(false);
	return (
		<section className="tool-output-reader text-reader">
			<div className="tool-result-heading">
				<div className="reader-controls">
					<button
						type="button"
						className="reader-button reader-wrap"
						aria-pressed={wrap}
						title={translate(locale, "dock.wrapLines")}
						onClick={() => setWrap((value) => !value)}
					>
						{translate(locale, "dock.wrapLines")}
					</button>
					<CopyButton
						locale={locale}
						text={text}
						label="tool.copyOutput"
						className="reader-button"
						visibleLabel
					/>
				</div>
			</div>
			<pre
				className={`${className} reader-content${wrap ? " wrap" : ""}`}
				data-text-key={textKey}
			>
				{text}
			</pre>
		</section>
	);
}

interface ImageDialogProps {
	readonly locale: Locale;
	readonly image: { readonly dataUrl: string; readonly alt: string };
	readonly onClose: () => void;
}

function ImageDialog({ locale, image, onClose }: ImageDialogProps) {
	const dialog = useRef<HTMLDialogElement>(null);

	useLayoutEffect(() => {
		const node = dialog.current;
		if (node === null || node.open) return;
		node.showModal();
		return () => node.close();
	}, []);

	return (
		<dialog
			ref={dialog}
			className="tool-image-dialog"
			aria-label={translate(locale, "tool.viewImage")}
			onClose={onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") event.currentTarget.close();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) event.currentTarget.close();
			}}
		>
			<button
				type="button"
				className="tool-image-close"
				aria-label={translate(locale, "tool.closeImage")}
				onClick={() => dialog.current?.close()}
			>
				<Icon name="x" />
			</button>
			<img src={image.dataUrl} alt={image.alt} />
		</dialog>
	);
}

interface ToolBlockProps {
	readonly block: TranscriptBlock;
	readonly locale: Locale;
	readonly open: boolean;
	readonly rawOpen: boolean;
	readonly searchHit: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onRawOpenChange: (open: boolean) => void;
}

function ToolBlock({
	block,
	locale,
	open,
	rawOpen,
	searchHit,
	onOpenChange,
	onRawOpenChange,
}: ToolBlockProps) {
	const [preview, setPreview] = useState<{
		readonly dataUrl: string;
		readonly alt: string;
	}>();
	const tone = block.running
		? "running"
		: block.tone === "error"
			? "error"
			: "";
	const summary =
		block.toolArgs?.collapsed ||
		firstLine(block.text || block.result?.diagnostics[0]?.text || "");
	return (
		<>
			<Disclosure
				className={`${tone}${searchHit ? " search-hit" : ""}`.trim()}
				open={open}
				onOpenChange={onOpenChange}
				dataBlockId={block.id}
			>
				<summary className="disclosure-row" title={block.toolName}>
					<span className="disclosure-leading">
						<Icon
							name={
								block.running
									? "spinner"
									: block.tone === "error"
										? "alert"
										: "wrench"
							}
							className={`icon${block.running ? " spin" : ""}`}
						/>
					</span>
					<span className="disclosure-title">{block.title}</span>
					<span className="disclosure-summary">{summary}</span>
					<Icon name="chevron-down" className="icon disclosure-chevron" />
				</summary>
				{block.toolArgs !== undefined && block.toolArgs.expanded.length > 0 ? (
					<>
						<div className="tool-result-heading">
							<div className="reader-controls">
								<CopyButton
									locale={locale}
									text={block.toolArgs.source}
									label="tool.copyArgs"
									className="reader-button"
									visibleLabel
								/>
							</div>
						</div>
						<div className="tool-args" data-text-key="args">
							{block.toolArgs.expanded}
						</div>
					</>
				) : null}
				{block.result === undefined ? null : (
					<>
						<div className="tool-result-meta">
							{[
								block.result.nested,
								block.result.status,
								block.result.duration,
								block.result.terminal?.exit,
							]
								.filter(
									(label): label is string =>
										label !== undefined && label.length > 0,
								)
								.map((label) => (
									<span className="tool-result-tag" key={label}>
										{label}
									</span>
								))}
						</div>
						{block.result.terminal?.command ? (
							<pre className="tool-command" title={block.result.terminal.cwd}>
								{block.result.terminal.command}
							</pre>
						) : null}
						{block.result.diff ? (
							<DiffView locale={locale} diff={block.result.diff} />
						) : null}
						{(block.result.fileChanges ?? []).map((change, index) => (
							<section
								className="tool-file-change"
								key={`${change.path}:${index}`}
							>
								<p className="reader-meta">
									{change.path} · {change.status}
									{change.error ? ` · ${change.error}` : ""}
								</p>
								{change.diff ? (
									<DiffView locale={locale} diff={change.diff} />
								) : null}
								{change.truncated ? (
									<p className="tool-diagnostic muted">
										{translate(locale, "tool.diffTruncated")}
									</p>
								) : null}
							</section>
						))}
					</>
				)}
				{block.text.length > 0 ? (
					<ReaderOutput
						locale={locale}
						text={block.text}
						className={
							block.result?.terminal === undefined
								? "tool-output"
								: "tool-output terminal-output"
						}
						textKey="output"
					/>
				) : !block.running &&
					(block.images?.length ?? 0) === 0 &&
					(block.result?.diagnostics.length ?? 0) === 0 ? (
					<div className="tool-output empty">
						{translate(locale, "tool.noOutput")}
					</div>
				) : null}
				{block.images === undefined || block.images.length === 0 ? null : (
					<div className="tool-images">
						{block.images.map((image) => (
							<button
								type="button"
								className="tool-image"
								aria-label={translate(locale, "tool.viewImage")}
								key={`${image.dataUrl}:${image.alt}`}
								onClick={() => setPreview(image)}
							>
								<img src={image.dataUrl} alt={image.alt} loading="lazy" />
							</button>
						))}
					</div>
				)}
				{(block.result?.diagnostics ?? []).map((diagnostic, index) => (
					<p
						className={`tool-diagnostic ${diagnostic.tone}`}
						key={`${index}:${diagnostic.text}`}
					>
						{diagnostic.text}
					</p>
				))}
				{block.raw === undefined ? null : (
					<Disclosure
						className="tool-raw"
						open={rawOpen}
						onOpenChange={onRawOpenChange}
					>
						<summary className="reader-meta">
							{translate(locale, "tool.rawResult")}
						</summary>
						<ReaderOutput locale={locale} text={block.raw} textKey="raw" />
					</Disclosure>
				)}
			</Disclosure>
			{preview === undefined ? null : (
				<ImageDialog
					locale={locale}
					image={preview}
					onClose={() => setPreview(undefined)}
				/>
			)}
		</>
	);
}

interface ReasoningBlockProps {
	readonly block: TranscriptBlock;
	readonly open: boolean;
	readonly searchHit: boolean;
	readonly onOpenChange: (open: boolean) => void;
}

function ReasoningBlock({
	block,
	open,
	searchHit,
	onOpenChange,
}: ReasoningBlockProps) {
	return (
		<Disclosure
			className={searchHit ? "search-hit" : ""}
			open={open}
			onOpenChange={onOpenChange}
			dataBlockId={block.id}
		>
			<summary className="disclosure-row">
				<span className="disclosure-leading">
					<Icon name="sparkles" />
				</span>
				<span className="disclosure-title">{block.title}</span>
				<span className="disclosure-summary" />
				<Icon name="chevron-down" className="icon disclosure-chevron" />
			</summary>
			<div className="reasoning-body" data-text-key="reasoning">
				{block.text}
			</div>
		</Disclosure>
	);
}

interface ProcessRowProps {
	readonly group: ProcessGroup;
	readonly area: "current" | "history";
	readonly answerId?: string;
	readonly locale: Locale;
	readonly open: boolean;
	readonly openBlocks: ReadonlyMap<string, boolean>;
	readonly searchHits: ReadonlySet<string>;
	readonly onOpenChange: (open: boolean) => void;
	readonly onBlockOpenChange: (id: string, open: boolean) => void;
	readonly onRevealFailure: (id: string) => void;
}

function ProcessRow({
	group,
	area,
	answerId,
	locale,
	open,
	openBlocks,
	searchHits,
	onOpenChange,
	onBlockOpenChange,
	onRevealFailure,
}: ProcessRowProps) {
	const stateLabel: Readonly<Record<ProcessGroup["state"], MessageKey>> = {
		running: "process.running",
		completed: "process.completed",
		error: "process.error",
		interrupted: "process.interrupted",
	};
	const counts = [
		translate(locale, stateLabel[group.state]),
		group.tools > 0
			? translate(locale, "process.tools", { count: String(group.tools) })
			: "",
		group.thoughts > 0
			? translate(locale, "process.thoughts", { count: String(group.thoughts) })
			: "",
	].filter((item) => item.length > 0);
	const firstFailure = group.failures[0];
	const answer = () => {
		const root = document.querySelector<HTMLElement>(
			`[data-block-id="${CSS.escape(answerId ?? "")}"]`,
		);
		if (root === null) return;
		root.tabIndex = -1;
		root.focus({ preventScroll: true });
		root.scrollIntoView({ block: "start" });
	};
	return (
		<section
			className="turn-process"
			data-flow-key={`process:${area}:${group.id}`}
			data-open={open}
			data-state={group.state}
		>
			<div className="process-heading">
				<button
					type="button"
					className="process-toggle"
					aria-expanded={open}
					onClick={() => onOpenChange(!open)}
				>
					<Icon name="chevron-down" className="icon process-chevron" />
					<span className="process-title">
						{translate(locale, "process.title")}
					</span>
					<span className="process-meta">{counts.join(" · ")}</span>
				</button>
				{firstFailure === undefined ? null : (
					<button
						type="button"
						className="process-failures"
						title={`${translate(locale, "process.failureHint")}\n${firstLine(
							firstFailure.result?.diagnostics.find(
								(item) => item.tone === "error",
							)?.text || firstFailure.text,
						)}`}
						onClick={() => onRevealFailure(firstFailure.id)}
					>
						{translate(locale, "process.failures", {
							count: String(group.failures.length),
						})}
					</button>
				)}
				{answerId === undefined ? null : (
					<button type="button" className="process-jump" onClick={answer}>
						{translate(locale, "process.jumpAnswer")}
					</button>
				)}
			</div>
			<p className="process-activity" hidden={group.state !== "running"}>
				{group.activity === undefined
					? ""
					: [group.activity.title, group.activity.toolArgs?.collapsed]
							.filter(Boolean)
							.join(" · ")}
			</p>
			<p className="process-alert" hidden={group.state !== "interrupted"}>
				{translate(locale, "process.incomplete")}
			</p>
			<div className="process-rows" hidden={!open}>
				{group.blocks.map((block) =>
					block.kind === "thinking" ? (
						<ReasoningBlock
							block={block}
							open={openBlocks.get(block.id) ?? false}
							searchHit={searchHits.has(block.id)}
							key={block.id}
							onOpenChange={(next) => onBlockOpenChange(block.id, next)}
						/>
					) : (
						<ToolBlock
							block={block}
							locale={locale}
							open={openBlocks.get(block.id) ?? block.running}
							rawOpen={openBlocks.get(`${block.id}:raw`) ?? false}
							searchHit={searchHits.has(block.id)}
							key={block.id}
							onOpenChange={(next) => onBlockOpenChange(block.id, next)}
							onRawOpenChange={(next) =>
								onBlockOpenChange(`${block.id}:raw`, next)
							}
						/>
					),
				)}
			</div>
		</section>
	);
}

function searchableText(block: TranscriptBlock): string {
	return [
		block.title,
		block.text,
		block.raw,
		block.toolArgs?.collapsed,
		block.toolArgs?.expanded,
		block.result?.status,
		block.result?.duration,
		block.result?.nested,
		block.result?.terminal?.command,
		block.result?.terminal?.cwd,
		block.result?.terminal?.exit,
		block.result?.diff?.text,
		block.result?.diff?.patch,
		...(block.result?.fileChanges ?? []).flatMap((change) => [
			change.path,
			change.status,
			change.error,
			change.diff?.text,
		]),
		...(block.result?.diagnostics ?? []).map((item) => item.text),
		...(block.images ?? []).map((image) => image.alt),
	]
		.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		)
		.join("\n");
}

interface TranscriptEntriesProps {
	readonly blocks: readonly TranscriptBlock[];
	readonly area: "current" | "history";
	readonly locale: Locale;
	readonly actions: PageRenderer;
	readonly sessionId: string | undefined;
	readonly busy: boolean;
	readonly openBlocks: ReadonlyMap<string, boolean>;
	readonly searchHits: ReadonlySet<string>;
	readonly onBlockOpenChange: (id: string, open: boolean) => void;
	readonly onRevealFailure: (id: string) => void;
}

function TranscriptEntries({
	blocks,
	area,
	locale,
	actions,
	sessionId,
	busy,
	openBlocks,
	searchHits,
	onBlockOpenChange,
	onRevealFailure,
}: TranscriptEntriesProps) {
	const items = processGroups(blocks, area === "current" && busy);
	const openFile = (file: FileLocation) => {
		if (sessionId === undefined) return;
		command(
			actions,
			WORKSPACE_FILE_LINK_ACTION,
			JSON.stringify({ kind: "link", sessionId, ...file }),
		);
	};
	return items.map((item, index) => {
		if (item.kind === "process") {
			const next = items[index + 1];
			const answerId =
				next?.kind === "block" && next.block.kind === "assistant"
					? next.block.id
					: undefined;
			return (
				<ProcessRow
					group={item}
					area={area}
					answerId={answerId}
					locale={locale}
					open={openBlocks.get(`process:${area}:${item.id}`) ?? false}
					openBlocks={openBlocks}
					searchHits={searchHits}
					key={`process:${area}:${item.id}`}
					onOpenChange={(open) =>
						onBlockOpenChange(`process:${area}:${item.id}`, open)
					}
					onBlockOpenChange={onBlockOpenChange}
					onRevealFailure={onRevealFailure}
				/>
			);
		}
		const block = item.block;
		if (block.kind === "user") {
			return (
				<div
					className={`turn-user${searchHits.has(block.id) ? " search-hit" : ""}`}
					data-block-id={block.id}
					data-flow-key={`block:${block.id}`}
					key={block.id}
				>
					<div className="bubble">
						{(block.images ?? []).map((image, imageIndex) => (
							<img
								className="bubble-image"
								src={image.dataUrl}
								alt={image.alt}
								key={`${block.id}:image:${imageIndex}`}
							/>
						))}
						{block.text.length > 0 ? (
							<CredentialText
								text={block.text}
								className="bubble-text"
								locale={locale}
								textKey="message"
							/>
						) : null}
					</div>
					{block.text.length > 0 ? (
						<MessageActions block={block} locale={locale} actions={actions} />
					) : null}
				</div>
			);
		}
		if (block.kind === "assistant") {
			return (
				<div
					className={`turn-response${searchHits.has(block.id) ? " search-hit" : ""}`}
					data-block-id={block.id}
					data-flow-key={`block:${block.id}`}
					tabIndex={-1}
					key={block.id}
				>
					<div className="markdown" data-text-key="answer">
						<Markdown text={block.text} onFile={openFile} />
					</div>
					<MessageActions block={block} locale={locale} actions={actions} />
				</div>
			);
		}
		return block.tone === "error" ? (
			<div
				className={`error-row${searchHits.has(block.id) ? " search-hit" : ""}`}
				data-block-id={block.id}
				data-flow-key={`block:${block.id}`}
				key={block.id}
			>
				<Icon name="alert" className="icon error-icon" />
				<div className="error-copy">
					<span className="error-title">{block.title}</span>
					<span className="error-message">
						{errorMessageCopy(locale, block.text)}
					</span>
				</div>
			</div>
		) : (
			<div
				className={`notice${searchHits.has(block.id) ? " search-hit" : ""}`}
				data-block-id={block.id}
				data-flow-key={`block:${block.id}`}
				key={block.id}
			>
				<p className="notice-rule">{block.title}</p>
				{block.text.length > 0 ? (
					<div className="notice-body" data-text-key="notice">
						{block.text}
					</div>
				) : null}
			</div>
		);
	});
}

interface WelcomeProps {
	readonly welcome: WelcomeCard;
	readonly view: TranscriptView;
	readonly actions: PageRenderer;
}

function Welcome({ welcome, view, actions }: WelcomeProps) {
	const pending = view.newSession.pending === true;
	return (
		<div className="welcome-card">
			<span className="brand-mark welcome-mark">
				<Icon name="sparkles" className="icon" />
			</span>
			<h2 className="welcome-title">{welcome.title}</h2>
			<p className="welcome-body">{welcome.body}</p>
			<div className="welcome-steps">
				{welcome.steps.map((step) => {
					const disabled =
						step.disabled === true || !view.newSession.enabled || pending;
					return (
						<button
							type="button"
							className={panelButtonClass(step)}
							disabled={disabled}
							aria-busy={pending}
							key={step.id}
							onClick={() => {
								if (step.id === WELCOME_SESSION_ACTION)
									actions.onCreateSession();
								else command(actions, step.id, step.data);
							}}
						>
							{pending ? <Icon name="spinner" className="icon spin" /> : null}
							{pending
								? translate(view.locale, "sidebar.creating")
								: step.label}
						</button>
					);
				})}
			</div>
			<p className="welcome-note">{welcome.note}</p>
			<button
				type="button"
				className="panel-button weight-text welcome-dismiss"
				onClick={() =>
					command(actions, welcome.dismiss.id, welcome.dismiss.data)
				}
			>
				{welcome.dismiss.label}
			</button>
		</div>
	);
}

function EmptyState({ view, actions }: TranscriptProps) {
	if (view.welcome !== undefined)
		return <Welcome welcome={view.welcome} view={view} actions={actions} />;
	if (view.sessionDraft !== undefined) {
		return (
			<div className="empty-block" id="transcript-empty">
				<h2 className="greeting">
					{view.sessionDraft.projectId === null
						? translate(view.locale, "greeting.standaloneDraft")
						: translate(view.locale, "greeting.projectDraft", {
								name: view.sessionDraft.label,
							})}
				</h2>
			</div>
		);
	}
	if (view.attachedId !== undefined) {
		const scopeEmpty =
			view.model.empty === translate(view.locale, "model.scopeEmpty");
		return (
			<div className="empty-block" id="transcript-empty">
				<h2 className="greeting">
					{translate(
						view.locale,
						view.readOnly === true
							? "greeting.readOnlyTitle"
							: "greeting.title",
					)}
				</h2>
				<p className="greeting-hint">
					{translate(
						view.locale,
						view.readOnly === true ? "greeting.readOnlyHint" : "greeting.hint",
					)}
				</p>
				{view.readOnly === true ? (
					<div className="welcome-steps">
						{view.archivedAttached === undefined ? (
							<button
								type="button"
								className="panel-button weight-filled"
								onClick={() =>
									command(actions, DOCK_TAB_ACTION, "conversations")
								}
							>
								{translate(view.locale, "greeting.openConversations")}
							</button>
						) : (
							<button
								type="button"
								className="panel-button weight-filled"
								onClick={() =>
									command(actions, SESSION_RESTORE_ACTION, view.attachedId)
								}
							>
								{translate(view.locale, "project.restore")}
							</button>
						)}
					</div>
				) : view.model.empty !== undefined ? (
					<>
						<p className="greeting-hint">{view.model.empty}</p>
						<div className="welcome-steps">
							{scopeEmpty ? (
								<button
									type="button"
									className="panel-button weight-filled"
									disabled={view.model.disabled}
									onClick={() => command(actions, MODEL_SCOPE_ACTION)}
								>
									{translate(view.locale, "model.configureModels")}
								</button>
							) : null}
							<button
								type="button"
								className={`panel-button weight-${scopeEmpty ? "line" : "filled"}`}
								disabled={view.model.disabled}
								onClick={() => command(actions, MODEL_CONNECTIONS_ACTION)}
							>
								{translate(view.locale, "model.connectProvider")}
							</button>
						</div>
					</>
				) : null}
			</div>
		);
	}
	const unavailable =
		!view.newSession.enabled && view.newSession.pending !== true;
	const filtered =
		view.rosterFilter.trim().length > 0 && view.roster.length === 0;
	const hasSessions = view.roster.length > 0;
	const title = unavailable
		? "greeting.waitTitle"
		: filtered
			? "greeting.filterTitle"
			: hasSessions
				? "greeting.pickTitle"
				: "greeting.startTitle";
	const hint = unavailable
		? "greeting.waitHint"
		: filtered
			? "greeting.filterHint"
			: hasSessions
				? "greeting.pickHint"
				: "greeting.startHint";
	return (
		<div className="empty-block" id="transcript-empty">
			<h2 className="greeting">{translate(view.locale, title)}</h2>
			<p className="greeting-hint">{translate(view.locale, hint)}</p>
			{unavailable ? null : (
				<div className="welcome-steps">
					{filtered ? (
						<button
							type="button"
							className="panel-button weight-filled"
							onClick={() => actions.onFilterRoster("")}
						>
							{translate(view.locale, "greeting.clearFilter")}
						</button>
					) : (
						<>
							{hasSessions ? (
								<button
									type="button"
									className="panel-button weight-filled"
									onClick={() =>
										document
											.querySelector<HTMLButtonElement>(".session-select")
											?.focus()
									}
								>
									{translate(view.locale, "greeting.pickAction")}
								</button>
							) : null}
							<button
								type="button"
								className={`panel-button weight-${hasSessions ? "line" : "filled"}`}
								disabled={
									!view.newSession.enabled || view.newSession.pending === true
								}
								onClick={() => actions.onCreateSession()}
							>
								{view.newSession.pending === true
									? translate(view.locale, "sidebar.creating")
									: translate(view.locale, "sidebar.newSession")}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}

interface SearchDetail {
	readonly loadHistory?: boolean;
}

function isSearchDetail(value: unknown): value is SearchDetail {
	return (
		value === undefined ||
		(value !== null &&
			typeof value === "object" &&
			(!("loadHistory" in value) || typeof value.loadHistory === "boolean"))
	);
}

function jumpPrompt(direction: 1 | -1) {
	const turns = [...document.querySelectorAll<HTMLElement>(".turn-user")];
	if (turns.length === 0) return;
	const first = turns[0];
	if (first === undefined) return;
	const viewport = first.closest<HTMLElement>(".transcript");
	if (viewport === null) return;
	const top = viewport.getBoundingClientRect().top;
	const target =
		direction > 0
			? turns.find((node) => node.getBoundingClientRect().top > top + 8)
			: [...turns]
					.reverse()
					.find((node) => node.getBoundingClientRect().top < top - 8);
	(target ?? (direction > 0 ? turns.at(-1) : turns[0]))?.scrollIntoView({
		block: "start",
	});
}

interface TranscriptViewportProps {
	readonly scope: string | undefined;
	readonly signature: string;
	readonly following: RefObject<boolean>;
	readonly viewportRef: RefObject<HTMLDivElement | null>;
	readonly columnRef: RefObject<HTMLDivElement | null>;
	readonly onScroll: () => void;
	readonly onCommitted: (change: {
		readonly scopeChanged: boolean;
		readonly contentChanged: boolean;
		readonly following: boolean;
	}) => void;
	readonly children: ReactNode;
}

interface TranscriptViewportSnapshot {
	readonly scopeChanged: boolean;
	readonly contentChanged: boolean;
	readonly following: boolean;
	readonly restore: () => void;
}

/**
 * getSnapshotBeforeUpdate runs before React mutates descendants. A layout-effect cleanup would
 * observe the already-expanded history and lose the reader's pre-pagination position.
 */
class TranscriptViewport extends Component<
	TranscriptViewportProps,
	Readonly<Record<string, never>>,
	TranscriptViewportSnapshot
> {
	componentDidMount(): void {
		const viewport = this.props.viewportRef.current;
		if (viewport === null) return;
		this.props.following.current = true;
		viewport.scrollTop = viewport.scrollHeight;
	}

	getSnapshotBeforeUpdate(
		previous: Readonly<TranscriptViewportProps>,
		_previousState: Readonly<Record<string, never>>,
	): TranscriptViewportSnapshot | null {
		const viewport = this.props.viewportRef.current;
		const column = this.props.columnRef.current;
		if (viewport === null || column === null) return null;
		const scopeChanged = previous.scope !== this.props.scope;
		const contentChanged = previous.signature !== this.props.signature;
		const following = this.props.following.current || scopeChanged;
		return {
			scopeChanged,
			contentChanged,
			following,
			restore: transcriptPosition(column, viewport, following),
		};
	}

	componentDidUpdate(
		_previous: Readonly<TranscriptViewportProps>,
		_previousState: Readonly<Record<string, never>>,
		snapshot: TranscriptViewportSnapshot | null | undefined,
	): void {
		if (snapshot === null || snapshot === undefined) return;
		const viewport = this.props.viewportRef.current;
		if (viewport !== null) {
			if (snapshot.scopeChanged) {
				this.props.following.current = true;
				viewport.scrollTop = viewport.scrollHeight;
			} else {
				snapshot.restore();
			}
		}
		this.props.onCommitted(snapshot);
	}

	render() {
		return (
			<div
				ref={this.props.viewportRef}
				className="transcript"
				onScroll={this.props.onScroll}
			>
				<div ref={this.props.columnRef} className="column">
					{this.props.children}
				</div>
			</div>
		);
	}
}

/** React owner of the conversation flow. All session and command state remains above this component. */
export function ChatTranscript({ view, actions }: TranscriptProps) {
	const viewport = useRef<HTMLDivElement>(null);
	const column = useRef<HTMLDivElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const searchReturnFocus = useRef<HTMLElement | null>(null);
	const searchOpenRef = useRef(false);
	const following = useRef(true);
	const signature = useMemo(
		() =>
			JSON.stringify([
				view.status,
				view.blocks.map((block) => [
					block.id,
					block.text.length,
					block.raw?.length,
					block.running,
					block.tone,
					block.result?.status,
				]),
			]),
		[view.blocks, view.status],
	);
	const signatureSeen = useRef(signature);
	const [awayFromBottom, setAwayFromBottom] = useState(false);
	const [unread, setUnread] = useState(false);
	const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeHit, setActiveHit] = useState(0);
	const requestedSearch = useRef<string | undefined>(undefined);
	const [quote, setQuote] = useState<{
		readonly text: string;
		readonly left: number;
		readonly top: number;
	}>();
	const openSearch = useCallback(() => {
		const firstOpen = !searchOpenRef.current;
		if (firstOpen) {
			const active = document.activeElement;
			searchReturnFocus.current =
				active instanceof HTMLElement &&
				active !== document.body &&
				active.closest(".transcript-search") === null
					? active
					: null;
			searchOpenRef.current = true;
		}
		setSearchOpen(true);
		window.requestAnimationFrame(() => {
			const input = searchInput.current;
			input?.focus();
			if (firstOpen) input?.select();
		});
	}, []);
	const closeSearch = useCallback(() => {
		const returnFocus = searchReturnFocus.current;
		searchOpenRef.current = false;
		searchReturnFocus.current = null;
		setSearchOpen(false);
		setQuery("");
		setActiveHit(0);
		requestedSearch.current = undefined;
		window.requestAnimationFrame(() => {
			if (
				returnFocus?.isConnected &&
				!returnFocus.matches(":disabled") &&
				returnFocus.closest("[hidden], [inert]") === null &&
				!document.querySelector("dialog[open]")
			)
				returnFocus.focus({ preventScroll: true });
		});
	}, []);

	const allEntries = useMemo(
		() =>
			[...view.history.blocks, ...view.blocks].map((block) => ({
				id: block.id,
				text: searchableText(block),
			})),
		[view.blocks, view.history.blocks],
	);
	const hits = useMemo(
		() => transcriptSearchHits(allEntries, query),
		[allEntries, query],
	);
	const hitSet = useMemo(() => new Set(hits), [hits]);
	const activeHitId = hits[activeHit];
	const processOwners = useMemo(() => {
		const owners = new Map<string, string>();
		const collect = (
			blocks: readonly TranscriptBlock[],
			area: "current" | "history",
			active: boolean,
		) => {
			for (const item of processGroups(blocks, active)) {
				if (item.kind !== "process") continue;
				const key = `process:${area}:${item.id}`;
				for (const block of item.blocks) owners.set(block.id, key);
			}
		};
		collect(view.history.blocks, "history", false);
		collect(view.blocks, "current", view.busy);
		return owners;
	}, [view.blocks, view.busy, view.history.blocks]);

	const setBlockOpen = (id: string, open: boolean) => {
		setExpanded((current) => {
			const next = new Map(current);
			next.set(id, open);
			return next;
		});
	};

	const revealFailure = (id: string) => {
		const group = processOwners.get(id);
		setExpanded((current) => {
			const next = new Map(current);
			next.set(id, true);
			if (group !== undefined) next.set(group, true);
			return next;
		});
		window.requestAnimationFrame(() => {
			column.current
				?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
				?.scrollIntoView({ block: "nearest" });
		});
	};

	useEffect(() => {
		const onSearchRequest = (event: Event) => {
			if (!(event instanceof CustomEvent) || !isSearchDetail(event.detail))
				return;
			const surface = viewport.current;
			if (surface === null || surface.closest("[hidden]") !== null) return;
			openSearch();
		};
		window.addEventListener("amazme:transcript-search", onSearchRequest);
		return () =>
			window.removeEventListener("amazme:transcript-search", onSearchRequest);
	}, [openSearch]);

	useEffect(() => {
		if (activeHitId === undefined) return;
		const group = processOwners.get(activeHitId);
		setExpanded((current) => {
			const next = new Map(current);
			next.set(activeHitId, true);
			if (group !== undefined) next.set(group, true);
			return next;
		});
		const frame = window.requestAnimationFrame(() => {
			column.current
				?.querySelector<HTMLElement>(
					`[data-block-id="${CSS.escape(activeHitId)}"]`,
				)
				?.scrollIntoView({ block: "center" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activeHitId, processOwners]);

	useEffect(() => {
		let timer: number | undefined;
		const hide = () => setQuote(undefined);
		const update = () => {
			if (view.readOnly === true || view.attachedId === undefined) {
				hide();
				return;
			}
			const selection = document.getSelection();
			if (
				selection === null ||
				selection.isCollapsed ||
				selection.rangeCount === 0
			) {
				hide();
				return;
			}
			const range = selection.getRangeAt(0);
			const node = range.commonAncestorContainer;
			const element = node instanceof Element ? node : node.parentElement;
			const answer = element?.closest<HTMLElement>(".turn-response");
			if (answer === undefined || column.current?.contains(answer) !== true) {
				hide();
				return;
			}
			const text = quotedDraft(selection.toString());
			const rect = range.getBoundingClientRect();
			if (text === undefined || (rect.width === 0 && rect.height === 0)) {
				hide();
				return;
			}
			const left = Math.min(
				window.innerWidth - 128,
				Math.max(8, rect.left + rect.width / 2 - 52),
			);
			const below = rect.bottom + 8;
			const top =
				below + 36 <= window.innerHeight - 8
					? below
					: Math.max(8, rect.top - 40);
			setQuote({ text, left, top });
		};
		const schedule = () => {
			if (timer !== undefined) window.clearTimeout(timer);
			timer = window.setTimeout(update, 40);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("mouseup", schedule);
		document.addEventListener("keyup", schedule);
		document.addEventListener("keydown", onKey);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			if (timer !== undefined) window.clearTimeout(timer);
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("mouseup", schedule);
			document.removeEventListener("keyup", schedule);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, [view.attachedId, view.readOnly]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const surface = viewport.current;
			if (
				surface === null ||
				!surface.isConnected ||
				surface.closest("[hidden]") !== null
			)
				return;
			if (
				event.target instanceof Element &&
				(event.target.closest(".pty-surface") !== null ||
					event.target.closest("#view") !== null)
			)
				return;
			const primary = navigator.platform.toLowerCase().includes("mac")
				? event.metaKey
				: event.ctrlKey;
			if (
				event.code === "KeyF" &&
				primary &&
				!event.altKey &&
				!event.shiftKey
			) {
				const modal =
					event.target instanceof Element &&
					event.target.closest("dialog[open]") !== null;
				if (modal) return;
				event.preventDefault();
				openSearch();
				return;
			}
			if (
				event.altKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.shiftKey &&
				(event.code === "ArrowUp" || event.code === "ArrowDown")
			) {
				const target = event.target;
				if (
					target instanceof HTMLElement &&
					(target.tagName === "INPUT" ||
						target.tagName === "TEXTAREA" ||
						target.tagName === "SELECT" ||
						target.isContentEditable)
				)
					return;
				event.preventDefault();
				jumpPrompt(event.code === "ArrowDown" ? 1 : -1);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [openSearch]);

	const handleSearch = (value: string) => {
		setQuery(value);
		setActiveHit(0);
		const nextHits = transcriptSearchHits(allEntries, value);
		const needle = value.trim();
		if (
			nextHits.length === 0 &&
			needle.length > 0 &&
			view.history.more &&
			!view.history.loading &&
			requestedSearch.current !== needle
		) {
			requestedSearch.current = needle;
			command(actions, TRANSCRIPT_SEARCH_ACTION, needle);
		}
	};

	const stepSearch = (delta: 1 | -1) => {
		if (hits.length === 0) return;
		setActiveHit((current) => (current + delta + hits.length) % hits.length);
	};

	const onViewportScroll = () => {
		const node = viewport.current;
		if (node === null) return;
		const atBottom =
			node.scrollHeight - node.scrollTop - node.clientHeight < 24;
		following.current = atBottom;
		setAwayFromBottom(!atBottom);
		if (atBottom && unread) {
			setUnread(false);
			signatureSeen.current = signature;
		}
	};

	const jumpLatest = () => {
		const node = viewport.current;
		if (node === null) return;
		node.scrollTop = node.scrollHeight;
		following.current = true;
		signatureSeen.current = signature;
		setAwayFromBottom(false);
		setUnread(false);
	};

	const onViewportCommitted = (change: {
		readonly scopeChanged: boolean;
		readonly contentChanged: boolean;
		readonly following: boolean;
	}) => {
		const node = viewport.current;
		if (node === null) return;
		if (change.scopeChanged) {
			following.current = true;
			signatureSeen.current = signature;
			setAwayFromBottom(false);
			setUnread(false);
			return;
		}
		const atBottom =
			node.scrollHeight - node.scrollTop - node.clientHeight < 24;
		const follows = change.following && atBottom;
		if (!follows) following.current = false;
		setAwayFromBottom(!following.current);
		if (follows) {
			signatureSeen.current = signature;
			setUnread(false);
		} else if (change.contentChanged && signatureSeen.current !== signature) {
			signatureSeen.current = signature;
			setUnread(true);
		}
	};

	const quoteSelection = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (quote === undefined) return;
		const text = quote.text;
		setQuote(undefined);
		document.getSelection()?.removeAllRanges();
		actions.insertDraft(text, true);
	};

	const historyEntries = (
		<>
			{view.history.blocks.length === 0 ? null : (
				<div className="history-pages">
					<TranscriptEntries
						blocks={view.history.blocks}
						area="history"
						locale={view.locale}
						actions={actions}
						sessionId={view.attachedId}
						busy={false}
						openBlocks={expanded}
						searchHits={hitSet}
						onBlockOpenChange={setBlockOpen}
						onRevealFailure={revealFailure}
					/>
				</div>
			)}
			{(view.blocks.length > 0 || view.history.blocks.length > 0) &&
			(view.history.more || view.history.loading) ? (
				<div className="history-more">
					<button
						type="button"
						className={`history-more-button${view.history.loading ? " loading" : ""}`}
						data-action={HISTORY_MORE_ACTION}
						disabled={view.history.loading || view.attachedId === undefined}
						onClick={() => command(actions, HISTORY_MORE_ACTION)}
					>
						{translate(
							view.locale,
							view.history.loading ? "history.loading" : "history.more",
						)}
					</button>
				</div>
			) : null}
		</>
	);

	return (
		<>
			{searchOpen ? (
				<search
					className="transcript-search"
					style={{ position: "fixed", top: 10, right: 96, zIndex: 40 }}
				>
					<input
						ref={searchInput}
						className="transcript-search-input"
						type="search"
						autoComplete="off"
						spellCheck={false}
						placeholder={translate(view.locale, "transcript.search")}
						aria-label={translate(view.locale, "transcript.searchLabel")}
						value={query}
						onChange={(event) => handleSearch(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.keyCode === 229)
								return;
							if (event.key === "Escape") {
								event.preventDefault();
								closeSearch();
								return;
							}
							if (event.key !== "Enter") return;
							event.preventDefault();
							stepSearch(event.shiftKey ? -1 : 1);
						}}
					/>
					<span className="transcript-search-count" aria-live="polite">
						{hits.length === 0
							? query.trim().length === 0
								? ""
								: translate(view.locale, "transcript.searchNone")
							: `${activeHit + 1}/${hits.length}`}
					</span>
					<button
						type="button"
						className="icon-button transcript-search-close"
						aria-label={translate(view.locale, "transcript.searchClose")}
						title={translate(view.locale, "transcript.searchClose")}
						onClick={closeSearch}
					>
						<Icon name="x" />
					</button>
				</search>
			) : null}
			<TranscriptViewport
				scope={view.transcriptScope}
				signature={signature}
				following={following}
				viewportRef={viewport}
				columnRef={column}
				onScroll={onViewportScroll}
				onCommitted={onViewportCommitted}
			>
				{historyEntries}
				<TranscriptEntries
					blocks={view.blocks}
					area="current"
					locale={view.locale}
					actions={actions}
					sessionId={view.attachedId}
					busy={view.busy}
					openBlocks={expanded}
					searchHits={hitSet}
					onBlockOpenChange={setBlockOpen}
					onRevealFailure={revealFailure}
				/>
				{view.blocks.length === 0 ? (
					<EmptyState view={view} actions={actions} />
				) : null}
				{view.status.length === 0 ? null : (
					<div className="running">
						<span className="running-dot" aria-hidden="true" />
						<span className="running-text">{view.status}</span>
					</div>
				)}
			</TranscriptViewport>
			<div className="transcript-jump">
				<button
					type="button"
					className="transcript-latest"
					hidden={!awayFromBottom}
					data-unread={unread ? "true" : undefined}
					title={translate(
						view.locale,
						unread ? "transcript.newContent" : "transcript.jumpLatest",
					)}
					aria-label={translate(
						view.locale,
						unread ? "transcript.newContent" : "transcript.jumpLatest",
					)}
					onClick={jumpLatest}
				>
					{unread ? (
						<span className="running-dot latest-dot" aria-hidden="true" />
					) : null}
					<span className="transcript-latest-label">
						{translate(
							view.locale,
							unread ? "transcript.newContent" : "transcript.jumpLatest",
						)}
					</span>
					<Icon name="chevron-down" className="icon transcript-latest-icon" />
				</button>
			</div>
			{quote === undefined ? null : (
				<button
					type="button"
					className="quote-action"
					style={{ left: quote.left, top: quote.top }}
					onMouseDown={(event) => event.preventDefault()}
					onClick={quoteSelection}
				>
					{translate(view.locale, "composer.quote")}
				</button>
			)}
		</>
	);
}
