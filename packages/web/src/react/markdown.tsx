import {
	Fragment,
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { FileLocation } from "../file-links.ts";
import type { Locale } from "../locale.ts";
import {
	type CodeToken,
	formatMarkdown,
	type InlineNode,
	type MarkdownNode,
	safeHref,
	type TableAlignment,
	type TableNode,
	tokenizeCode,
} from "../markdown.ts";
import type { ProcessGroup } from "../process-groups.ts";
import { translate } from "../strings.ts";
import type { ToolResultView } from "../tool-results.ts";
import type { TranscriptBlock } from "../view.ts";

type MarkdownIconName =
	| "alert"
	| "check"
	| "chevron-down"
	| "copy"
	| "sparkles"
	| "spinner"
	| "wrench"
	| "wrap"
	| "x";

export interface MarkdownProps {
	readonly text: string;
	readonly onFile?: (location: FileLocation) => void;
}

export interface ToolResultProps {
	readonly locale: Locale;
	readonly result: ToolResultView;
	readonly text: string;
	readonly images?: readonly {
		readonly dataUrl: string;
		readonly alt: string;
	}[];
}

export interface ProcessPanelProps {
	readonly locale: Locale;
	readonly group: ProcessGroup;
	readonly renderBlock: (block: TranscriptBlock) => ReactNode;
	readonly answerId?: string;
	readonly onJumpAnswer?: (answerId: string) => void;
}

interface ScrollAnchor {
	readonly node: HTMLElement;
	readonly top: number;
	readonly left: number;
}

type CopyStatus = "idle" | "copied" | "failed";

function Icon({
	name,
	className = "icon",
}: {
	readonly name: MarkdownIconName;
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

function documentLocale(): Locale {
	return document.documentElement.lang.toLowerCase().startsWith("zh")
		? "zh"
		: "en";
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

function captureScroll(node: HTMLElement | null): ScrollAnchor | undefined {
	const scrollable = scrollableAncestor(node);
	return scrollable === undefined
		? undefined
		: {
				node: scrollable,
				top: scrollable.scrollTop,
				left: scrollable.scrollLeft,
			};
}

function restoreScroll(anchor: ScrollAnchor | undefined): void {
	if (anchor === undefined || !anchor.node.isConnected) return;
	anchor.node.scrollTop = anchor.top;
	anchor.node.scrollLeft = anchor.left;
}

function usePendingScroll(anchor: { current: ScrollAnchor | undefined }): void {
	useLayoutEffect(() => {
		const pending = anchor.current;
		if (pending === undefined) return;
		anchor.current = undefined;
		restoreScroll(pending);
	});
}

function useCopy(text: string): {
	readonly status: CopyStatus;
	readonly copy: () => void;
} {
	const [status, setStatus] = useState<CopyStatus>("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (timer.current !== undefined) clearTimeout(timer.current);
		};
	}, []);
	const finish = (next: Exclude<CopyStatus, "idle">): void => {
		if (!mounted.current) return;
		setStatus(next);
		if (timer.current !== undefined) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			if (mounted.current) setStatus("idle");
		}, 1200);
	};
	return {
		status,
		copy: () => {
			const written = navigator.clipboard?.writeText(text);
			if (written === undefined) {
				finish("failed");
				return;
			}
			void written.then(
				() => finish("copied"),
				() => finish("failed"),
			);
		},
	};
}

function CopyButton({
	label,
	text,
	className,
	visibleLabel = false,
}: {
	readonly label: string;
	readonly text: string;
	readonly className: string;
	readonly visibleLabel?: boolean;
}): ReactElement {
	const copy = useCopy(text);
	const shown =
		copy.status === "copied"
			? translate(documentLocale(), "copy.copied")
			: copy.status === "failed"
				? translate(documentLocale(), "copy.failed")
				: label;
	const icon =
		copy.status === "copied"
			? "check"
			: copy.status === "failed"
				? "x"
				: "copy";
	return (
		<button
			type="button"
			className={className}
			title={shown}
			aria-label={shown}
			data-copy-label={visibleLabel ? "visible" : undefined}
			onClick={copy.copy}
		>
			<Icon name={icon} />
			{visibleLabel ? <span className="copy-label">{shown}</span> : null}
		</button>
	);
}

function WrapButton({
	label,
	pressed,
	onToggle,
}: {
	readonly label: string;
	readonly pressed: boolean;
	readonly onToggle: () => void;
}): ReactElement {
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

function InlineNodes({
	nodes,
	onFile,
}: {
	readonly nodes: readonly InlineNode[];
	readonly onFile?: (location: FileLocation) => void;
}): ReactElement {
	return (
		<>
			{nodes.map((node, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Inline AST nodes are identified by their stable source position during streaming.
				<InlineNodeView key={index} node={node} onFile={onFile} />
			))}
		</>
	);
}

function InlineNodeView({
	node,
	onFile,
}: {
	readonly node: InlineNode;
	readonly onFile?: (location: FileLocation) => void;
}): ReactElement {
	switch (node.kind) {
		case "text":
			return <>{node.text}</>;
		case "code":
			return <code className="md-inline-code">{node.text}</code>;
		case "strong":
			return (
				<strong>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</strong>
			);
		case "em":
			return (
				<em>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</em>
			);
		case "link": {
			const href = safeHref(node.href);
			return href === undefined ? (
				<InlineNodes nodes={node.children} onFile={onFile} />
			) : (
				<a href={href} target="_blank" rel="noreferrer noopener">
					<InlineNodes nodes={node.children} onFile={onFile} />
				</a>
			);
		}
		case "file": {
			const location = node.location;
			const label = `${location.path}${location.line === undefined ? "" : `:${location.line}`}`;
			return onFile === undefined ? (
				<span>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</span>
			) : (
				<button
					type="button"
					className="md-file-link"
					title={label}
					onClick={() => {
						onFile(location);
					}}
				>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</button>
			);
		}
	}
}

function CodeTokens({
	tokens,
}: {
	readonly tokens: readonly CodeToken[];
}): ReactElement {
	return (
		<>
			{tokens.map((token, index) =>
				token.kind === "plain" ? (
					token.text
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: Token positions are stable source coordinates while the line text streams.
					<span key={index} className={`tok-${token.kind}`}>
						{token.text}
					</span>
				),
			)}
		</>
	);
}

function CodeBlock({
	text,
	language,
}: {
	readonly text: string;
	readonly language: string | undefined;
}): ReactElement {
	const locale = documentLocale();
	const lines = useMemo(() => tokenizeCode(text, language), [text, language]);
	const foldable = lines.length > 24;
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);
	usePendingScroll(pendingAnchor);
	const mutateReading = (mutation: () => void): void => {
		pendingAnchor.current = captureScroll(root.current);
		mutation();
	};
	const collapsed = foldable && !expanded;
	const foldLabel = translate(
		locale,
		collapsed ? "code.expand" : "code.collapse",
		{ count: String(lines.length) },
	);
	return (
		<div
			ref={root}
			className={`text-reader code-block${collapsed ? " collapsed" : ""}`}
			data-collapsed={String(collapsed)}
		>
			<div className="code-head">
				<div className="code-meta">
					{language === undefined ? null : (
						<span className="code-language">{language}</span>
					)}
					<span className="code-lines">
						{translate(locale, "code.lines", { count: String(lines.length) })}
					</span>
				</div>
				<div className="code-actions reader-controls">
					<WrapButton
						label={translate(locale, "dock.wrapLines")}
						pressed={wrapped}
						onToggle={() => {
							mutateReading(() => {
								setWrapped((value) => !value);
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
								mutateReading(() => {
									setExpanded((value) => !value);
								});
							}}
						>
							{foldLabel}
						</button>
					) : null}
					<CopyButton
						label={translate(locale, "copy.code")}
						text={text}
						className="reader-button reader-copy"
						visibleLabel
					/>
				</div>
			</div>
			<pre className={`reader-content${wrapped ? " wrap" : ""}`}>
				<code data-language={language}>
					{lines.map((tokens, lineIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: A code line's source position is its identity across streaming updates.
						<Fragment key={lineIndex}>
							{lineIndex === 0 ? null : "\n"}
							<span className="code-line" data-line={lineIndex + 1}>
								<CodeTokens tokens={tokens} />
							</span>
						</Fragment>
					))}
				</code>
			</pre>
			{foldable ? (
				<button
					type="button"
					className="reader-button code-expand-bar"
					title={foldLabel}
					aria-label={foldLabel}
					aria-expanded={expanded}
					onClick={() => {
						mutateReading(() => {
							setExpanded((value) => !value);
						});
					}}
				>
					{foldLabel}
				</button>
			) : null}
		</div>
	);
}

const numericCell = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

function numericText(nodes: readonly InlineNode[]): string | undefined {
	const only = nodes.length === 1 ? nodes[0] : undefined;
	return only?.kind === "text" || only?.kind === "code"
		? only.text.trim()
		: undefined;
}

function columnAlignment(
	node: TableNode,
	column: number,
): TableAlignment | undefined {
	const declared = node.align[column];
	if (declared !== undefined) return declared;
	if (node.rows.length === 0) return undefined;
	return node.rows.every((row) => {
		const value = numericText(row[column] ?? []);
		return value !== undefined && numericCell.test(value);
	})
		? "right"
		: undefined;
}

function MarkdownTable({
	node,
	onFile,
}: {
	readonly node: TableNode;
	readonly onFile?: (location: FileLocation) => void;
}): ReactElement {
	return (
		<div className="table-scroll">
			<table className="markdown-table">
				<thead>
					<tr>
						{node.head.map((cell, column) => {
							const align = columnAlignment(node, column);
							return (
								<th
									// biome-ignore lint/suspicious/noArrayIndexKey: A table column is identified by its source position.
									key={column}
									scope="col"
									className={align === undefined ? undefined : `align-${align}`}
								>
									<InlineNodes nodes={cell} onFile={onFile} />
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{node.rows.map((row, rowIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: A table row is identified by its source position.
						<tr key={rowIndex}>
							{row.map((cell, column) => {
								const align = columnAlignment(node, column);
								return (
									<td
										// biome-ignore lint/suspicious/noArrayIndexKey: A table cell is identified by its source column.
										key={column}
										className={
											align === undefined ? undefined : `align-${align}`
										}
									>
										<InlineNodes nodes={cell} onFile={onFile} />
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function MarkdownHeading({
	node,
	onFile,
}: {
	readonly node: Extract<MarkdownNode, { readonly kind: "heading" }>;
	readonly onFile?: (location: FileLocation) => void;
}): ReactElement {
	const level = Math.min(6, Math.max(1, node.level));
	switch (level) {
		case 1:
			return (
				<h1>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h1>
			);
		case 2:
			return (
				<h2>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h2>
			);
		case 3:
			return (
				<h3>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h3>
			);
		case 4:
			return (
				<h4>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h4>
			);
		case 5:
			return (
				<h5>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h5>
			);
		case 6:
			return (
				<h6>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h6>
			);
		default:
			return (
				<h6>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</h6>
			);
	}
}

function MarkdownBlock({
	node,
	codeIndex,
	onFile,
}: {
	readonly node: MarkdownNode;
	readonly codeIndex: number;
	readonly onFile?: (location: FileLocation) => void;
}): ReactElement {
	switch (node.kind) {
		case "paragraph":
			return (
				<p>
					<InlineNodes nodes={node.children} onFile={onFile} />
				</p>
			);
		case "heading":
			return <MarkdownHeading node={node} onFile={onFile} />;
		case "list": {
			const items = node.items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: A list item is identified by its source ordinal.
				<li key={index}>
					<InlineNodes nodes={item} onFile={onFile} />
				</li>
			));
			return node.ordered ? (
				<ol start={node.start}>{items}</ol>
			) : (
				<ul>{items}</ul>
			);
		}
		case "code":
			return (
				<CodeBlock key={codeIndex} text={node.text} language={node.language} />
			);
		case "table":
			return <MarkdownTable node={node} onFile={onFile} />;
	}
}

export function Markdown({ text, onFile }: MarkdownProps): ReactElement {
	const nodes = useMemo(() => formatMarkdown(text), [text]);
	let codeIndex = 0;
	return (
		<div className="markdown">
			{nodes.map((node, index) => (
				<MarkdownBlock
					// biome-ignore lint/suspicious/noArrayIndexKey: Markdown blocks retain their source position while adjacent text streams.
					key={index}
					node={node}
					codeIndex={node.kind === "code" ? codeIndex++ : 0}
					onFile={onFile}
				/>
			))}
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

function DiffView({
	text,
	patch,
	label,
	path,
}: {
	readonly text: string;
	readonly patch?: string;
	readonly label: string;
	readonly path?: string;
}): ReactElement {
	const locale = documentLocale();
	const lines = text.split("\n");
	const foldable = lines.length > 24;
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const root = useRef<HTMLElement>(null);
	const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);
	usePendingScroll(pendingAnchor);
	const mutateReading = (mutation: () => void): void => {
		pendingAnchor.current = captureScroll(root.current);
		mutation();
	};
	const collapsed = foldable && !expanded;
	const foldLabel = translate(
		locale,
		collapsed ? "code.expand" : "code.collapse",
		{ count: String(lines.length) },
	);
	return (
		<section
			ref={root}
			className={`tool-diff text-reader${collapsed ? " collapsed" : ""}`}
			data-collapsed={String(collapsed)}
		>
			<div className="tool-result-heading">
				<div className="reader-meta">
					{label}
					{path === undefined ? null : (
						<span className="tool-result-path">{path}</span>
					)}
				</div>
				<div className="reader-controls">
					<WrapButton
						label={translate(locale, "dock.wrapLines")}
						pressed={wrapped}
						onToggle={() => {
							mutateReading(() => {
								setWrapped((value) => !value);
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
								mutateReading(() => {
									setExpanded((value) => !value);
								});
							}}
						>
							{foldLabel}
						</button>
					) : null}
					<CopyButton
						label={translate(
							locale,
							patch === undefined ? "dock.copyContents" : "tool.copyPatch",
						)}
						text={patch ?? text}
						className="reader-button reader-copy"
						visibleLabel
					/>
				</div>
			</div>
			<pre className={`tool-diff-code reader-content${wrapped ? " wrap" : ""}`}>
				{lines.map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: A diff line is identified by its source line position.
					<Fragment key={index}>
						{index === 0 ? null : "\n"}
						<span className={`tool-diff-line ${diffTone(line)}`}>{line}</span>
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
						mutateReading(() => {
							setExpanded((value) => !value);
						});
					}}
				>
					{foldLabel}
				</button>
			) : null}
		</section>
	);
}

function ToolOutput({
	locale,
	text,
}: {
	readonly locale: Locale;
	readonly text: string;
}): ReactElement {
	const lines = text.replace(/\n$/, "").split("\n");
	const foldable = lines.length > 24;
	const [wrapped, setWrapped] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const root = useRef<HTMLElement>(null);
	const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);
	usePendingScroll(pendingAnchor);
	const mutateReading = (mutation: () => void): void => {
		pendingAnchor.current = captureScroll(root.current);
		mutation();
	};
	const collapsed = foldable && !expanded;
	const foldLabel = translate(
		locale,
		collapsed ? "code.expand" : "code.collapse",
		{ count: String(lines.length) },
	);
	return (
		<section
			ref={root}
			className={`tool-output-reader text-reader${collapsed ? " collapsed" : ""}`}
			data-collapsed={String(collapsed)}
		>
			<div className="tool-result-heading reader-controls">
				<WrapButton
					label={translate(locale, "dock.wrapLines")}
					pressed={wrapped}
					onToggle={() => {
						mutateReading(() => {
							setWrapped((value) => !value);
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
							mutateReading(() => {
								setExpanded((value) => !value);
							});
						}}
					>
						{foldLabel}
					</button>
				) : null}
				<CopyButton
					label={translate(locale, "tool.copyOutput")}
					text={text}
					className="reader-button reader-copy"
					visibleLabel
				/>
			</div>
			<pre className={`tool-output reader-content${wrapped ? " wrap" : ""}`}>
				{text}
			</pre>
			{foldable ? (
				<button
					type="button"
					className="reader-button code-expand-bar"
					title={foldLabel}
					aria-label={foldLabel}
					aria-expanded={expanded}
					onClick={() => {
						mutateReading(() => {
							setExpanded((value) => !value);
						});
					}}
				>
					{foldLabel}
				</button>
			) : null}
		</section>
	);
}

function ImageGallery({
	images,
	locale,
}: {
	readonly images: NonNullable<ToolResultProps["images"]>;
	readonly locale: Locale;
}): ReactElement {
	const [selected, setSelected] = useState<(typeof images)[number]>();
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (selected !== undefined && !dialog.current?.open)
			dialog.current?.showModal();
	}, [selected]);
	return (
		<>
			<div className="tool-images">
				{images.map((image, index) => (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: Streamed tool images retain their source-order position.
						key={index}
						type="button"
						className="tool-image"
						aria-label={translate(locale, "tool.viewImage")}
						onClick={() => {
							setSelected(image);
						}}
					>
						<img src={image.dataUrl} alt={image.alt} loading="lazy" />
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog Escape fires cancel and close; this handler only adds backdrop-pointer closing. */}
			<dialog
				ref={dialog}
				className="tool-image-dialog"
				aria-label={translate(locale, "tool.viewImage")}
				onClose={() => {
					setSelected(undefined);
				}}
				onClick={(event) => {
					if (event.target === event.currentTarget) event.currentTarget.close();
				}}
			>
				<button
					type="button"
					className="tool-image-close"
					aria-label={translate(locale, "tool.closeImage")}
					onClick={() => {
						dialog.current?.close();
					}}
				>
					<Icon name="x" />
				</button>
				{selected === undefined ? null : (
					<img src={selected.dataUrl} alt={selected.alt} />
				)}
			</dialog>
		</>
	);
}

export function ToolResult({
	locale,
	result,
	text,
	images = [],
}: ToolResultProps): ReactElement {
	const meta = [
		result.nested,
		result.status,
		result.duration,
		result.terminal?.exit,
	].filter((value): value is string => value !== undefined && value.length > 0);
	return (
		<>
			{meta.length === 0 ? null : (
				<div className="tool-result-meta">
					{meta.map((label) => (
						<span key={label} className="tool-result-tag">
							{label}
						</span>
					))}
				</div>
			)}
			{result.terminal?.command === undefined ? null : (
				<pre className="tool-command" title={result.terminal.cwd}>
					{result.terminal.command}
				</pre>
			)}
			{result.diff === undefined ? null : (
				<DiffView
					text={result.diff.text}
					patch={result.diff.patch}
					path={result.diff.path}
					label={result.diff.label}
				/>
			)}
			{(result.fileChanges ?? []).map((change, index) => (
				<section key={`${change.path}:${index}`} className="tool-file-change">
					<p className="reader-meta">
						{change.path} · {change.status}
						{change.error === undefined ? "" : ` · ${change.error}`}
					</p>
					{change.diff === undefined ? null : (
						<DiffView
							text={change.diff.text}
							patch={change.diff.patch}
							path={change.diff.path}
							label={change.diff.label}
						/>
					)}
					{change.truncated === true ? (
						<p className="tool-diagnostic muted">
							{translate(locale, "tool.diffTruncated")}
						</p>
					) : null}
				</section>
			))}
			{text.length === 0 ? null : <ToolOutput locale={locale} text={text} />}
			{images.length === 0 ? null : (
				<ImageGallery images={images} locale={locale} />
			)}
			{result.diagnostics.map((diagnostic, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Streamed diagnostics retain their source-order position.
				<p key={index} className={`tool-diagnostic ${diagnostic.tone}`}>
					{diagnostic.text}
				</p>
			))}
			{text.length === 0 &&
			images.length === 0 &&
			result.diagnostics.length === 0 ? (
				<div className="tool-output empty">
					{translate(locale, "tool.noOutput")}
				</div>
			) : null}
		</>
	);
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
}

export function ProcessPanel({
	locale,
	group,
	renderBlock,
	answerId,
	onJumpAnswer,
}: ProcessPanelProps): ReactElement {
	const [open, setOpen] = useState(false);
	const [, setFailureRequest] = useState(0);
	const root = useRef<HTMLElement>(null);
	const rows = useRef<HTMLDivElement>(null);
	const pendingFailure = useRef<string | undefined>(undefined);
	const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);
	const rowsId = `process-rows-${useId().replaceAll(":", "")}-${encodeURIComponent(group.id)}`;
	useLayoutEffect(() => {
		const anchor = pendingAnchor.current;
		pendingAnchor.current = undefined;
		restoreScroll(anchor);
		if (!open || pendingFailure.current === undefined) return;
		const failureId = pendingFailure.current;
		pendingFailure.current = undefined;
		const wrapper = [
			...(rows.current?.querySelectorAll<HTMLElement>(
				"[data-process-block-id]",
			) ?? []),
		].find((node) => node.dataset.processBlockId === failureId);
		const target =
			wrapper?.querySelector<HTMLElement>("[data-block-id]") ?? wrapper;
		const details =
			target instanceof HTMLDetailsElement
				? target
				: target?.querySelector<HTMLDetailsElement>("details");
		if (details !== null && details !== undefined) details.open = true;
		const summary = details?.querySelector<HTMLElement>("summary");
		if (summary === undefined && target !== undefined) target.tabIndex = -1;
		const focusTarget = summary ?? target;
		focusTarget?.focus({ preventScroll: true });
		(details ?? target)?.scrollIntoView({ block: "nearest" });
	});
	const counts = [
		translate(locale, `process.${group.state}`),
		group.tools > 0
			? translate(locale, "process.tools", { count: String(group.tools) })
			: "",
		group.thoughts > 0
			? translate(locale, "process.thoughts", { count: String(group.thoughts) })
			: "",
	].filter(Boolean);
	const firstFailure = group.failures[0];
	const failureHint =
		firstFailure === undefined
			? ""
			: `${translate(locale, "process.failureHint")}\n${firstLine(
					firstFailure.result?.diagnostics.find((item) => item.tone === "error")
						?.text || firstFailure.text,
				)}`;
	const toggle = (): void => {
		pendingAnchor.current = captureScroll(root.current);
		setOpen((value) => !value);
	};
	return (
		<section
			ref={root}
			className="turn-process"
			data-state={group.state}
			data-open={String(open)}
		>
			<div className="process-heading">
				<button
					type="button"
					className="process-toggle"
					aria-controls={rowsId}
					aria-expanded={open}
					onClick={toggle}
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
						aria-controls={rowsId}
						aria-label={`${translate(locale, "process.failures", { count: String(group.failures.length) })} · ${translate(locale, "process.jumpFailure")}`}
						title={failureHint}
						onClick={() => {
							pendingAnchor.current = captureScroll(root.current);
							pendingFailure.current = firstFailure.id;
							setFailureRequest((value) => value + 1);
							setOpen(true);
						}}
					>
						{translate(locale, "process.failures", {
							count: String(group.failures.length),
						})}
					</button>
				)}
				{answerId === undefined || onJumpAnswer === undefined ? null : (
					<button
						type="button"
						className="process-jump"
						onClick={() => {
							onJumpAnswer(answerId);
						}}
					>
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
			<div ref={rows} className="process-rows" id={rowsId} hidden={!open}>
				{group.blocks.map((block) => (
					<div key={block.id} data-process-block-id={block.id}>
						{renderBlock(block)}
					</div>
				))}
			</div>
		</section>
	);
}
