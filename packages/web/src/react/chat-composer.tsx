import type {
	ChangeEvent,
	ClipboardEvent,
	DragEvent,
	FormEvent,
	KeyboardEvent,
	ReactNode,
} from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { SUBMIT_MODE_ACTION } from "../actions.ts";
import type { Locale } from "../locale.ts";
import type { PanelButton } from "../panels.ts";
import type { ApprovalPolicy } from "../permission-picker.ts";
import { COMPOSER_PROJECT_ACTION, PROJECT_ADD_ACTION } from "../projects.ts";
import { insertDraftText } from "../quote.ts";
import type { PageRenderer } from "../render.ts";
import { type MessageKey, translate } from "../strings.ts";
import {
	type Attachment,
	composerPlaceholder,
	type QueueItem,
} from "../view.ts";
import type { ComposerProps, ComposerView } from "./chat.tsx";
import {
	ComposerModelControls,
	ComposerStatusMeter,
} from "./chat-controls.tsx";
import { CredentialText } from "./chat-credential.tsx";
import { QuestionForm } from "./questions.tsx";

type IconName =
	| "check"
	| "chevron-down"
	| "folder"
	| "hand"
	| "plus"
	| "shield-alert"
	| "shield-check"
	| "spinner"
	| "stop"
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

function actionButton(
	action: PanelButton,
	actions: PageRenderer,
	className?: string,
): ReactNode {
	return (
		<button
			type="button"
			className={className ?? panelButtonClass(action)}
			data-action={action.id}
			data-action-data={action.data}
			disabled={action.disabled === true}
			aria-pressed={action.pressed}
			title={action.label}
			aria-label={action.label}
			onClick={() => command(actions, action.id, action.data)}
		>
			{action.label}
		</button>
	);
}

function ApprovalCards({
	view,
	actions,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}) {
	if (view.approvals.length === 0) return null;
	return (
		<div className="approvals">
			{view.approvals.map((card) => (
				<div className="approval-card" data-approval-id={card.id} key={card.id}>
					<div className="approval-head">
						<p className="approval-title">
							{translate(view.locale, "approval.title")}
						</p>
						<p className="approval-tool">
							{translate(view.locale, "approval.tool", { tool: card.tool })}
						</p>
					</div>
					<pre className="approval-detail">{card.detail}</pre>
					<div className="approval-actions">
						{actionButton(card.deny, actions)}
						{actionButton(card.approve, actions)}
					</div>
					<p className="approval-hint">
						{translate(view.locale, "approval.hint")}
					</p>
				</div>
			))}
		</div>
	);
}

function QueueRows({
	items,
	locale,
	actions,
}: {
	readonly items: readonly QueueItem[];
	readonly locale: Locale;
	readonly actions: PageRenderer;
}) {
	if (items.length === 0) return null;
	return (
		<div className="queue">
			{items.map((item) => (
				<p className="queue-item" data-submission-id={item.id} key={item.id}>
					<CredentialText
						text={item.text}
						className="queue-text"
						locale={locale}
						textKey="queue"
					/>
					{item.retry === undefined ? null : actionButton(item.retry, actions)}
					{item.cancel === undefined
						? null
						: actionButton(
								item.cancel,
								actions,
								"panel-button weight-text queue-cancel",
							)}
				</p>
			))}
		</div>
	);
}

function Palette({
	view,
	actions,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}) {
	const selected = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		if (view.palette.open)
			selected.current?.scrollIntoView({ block: "nearest" });
	}, [view.palette]);
	if (
		!view.palette.open ||
		(view.attachedId === undefined && view.palette.rows.length === 0)
	)
		return null;
	return (
		<div className="command-palette">
			<div className="palette-card">
				<p className="palette-title">{view.palette.title}</p>
				{view.palette.empty === undefined ? null : (
					<p className="palette-empty">{view.palette.empty}</p>
				)}
				<div className="palette-rows">
					{view.palette.rows.map((row, index) => (
						<button
							ref={row.selected ? selected : undefined}
							type="button"
							className={`palette-row${row.selected ? " selected" : ""}`}
							data-value={row.value}
							key={`${row.value}:${index}`}
							onPointerEnter={() => actions.onPaletteSelection(index)}
							onClick={() => actions.onCommandPick(row.value)}
						>
							<span className="palette-tag">{row.tag ?? ""}</span>
							<span className="palette-name">{row.label}</span>
							{row.hint === undefined ? null : (
								<span className="palette-hint">{row.hint}</span>
							)}
							<span className="palette-desc">{row.description}</span>
						</button>
					))}
				</div>
				<p className="palette-foot">{translate(view.locale, "palette.hint")}</p>
			</div>
		</div>
	);
}

interface AttachmentDialogProps {
	readonly attachment: Attachment;
	readonly locale: Locale;
	readonly onClose: () => void;
}

function AttachmentDialog({
	attachment,
	locale,
	onClose,
}: AttachmentDialogProps) {
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
			<img src={attachment.dataUrl} alt={attachment.name} />
		</dialog>
	);
}

function Attachments({
	items,
	locale,
	actions,
	active,
}: {
	readonly items: readonly Attachment[];
	readonly locale: Locale;
	readonly actions: PageRenderer;
	readonly active: boolean;
}) {
	const [previewId, setPreviewId] = useState<string>();
	const preview = items.find((item) => item.id === previewId);
	useLayoutEffect(() => {
		if (!active) setPreviewId(undefined);
	}, [active]);
	if (items.length === 0) return null;
	return (
		<>
			<ul
				className="attachments"
				aria-label={translate(locale, "composer.attachments")}
				style={{ margin: 0, listStyle: "none" }}
			>
				{items.map((attachment) => (
					<li
						className="attachment"
						data-attachment-id={attachment.id}
						key={attachment.id}
					>
						<button
							type="button"
							className="attachment-preview"
							title={translate(locale, "composer.previewAttachment")}
							aria-label={translate(locale, "composer.previewAttachment")}
							onClick={() => setPreviewId(attachment.id)}
						>
							<img src={attachment.dataUrl} alt={attachment.name} />
						</button>
						<figcaption className="attachment-meta">
							<span className="attachment-name">{attachment.name}</span>
							<span className="attachment-size">{attachment.size}</span>
						</figcaption>
						<button
							type="button"
							className="attachment-remove"
							data-action={attachment.remove.id}
							data-action-data={attachment.remove.data}
							title={attachment.remove.label}
							aria-label={attachment.remove.label}
							onClick={() =>
								command(actions, attachment.remove.id, attachment.remove.data)
							}
						>
							<Icon name="x" />
						</button>
					</li>
				))}
			</ul>
			{preview === undefined ? null : (
				<AttachmentDialog
					attachment={preview}
					locale={locale}
					onClose={() => setPreviewId(undefined)}
				/>
			)}
		</>
	);
}

interface ProjectPickerProps {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}

function ProjectPicker({ view, actions }: ProjectPickerProps) {
	const context = view.sessionDraft;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const dialog = useRef<HTMLDialogElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);

	useLayoutEffect(() => {
		const node = dialog.current;
		if (!open || node === null || node.open) return;
		node.showModal();
		const rect = trigger.current?.getBoundingClientRect();
		if (rect !== undefined) {
			node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8))}px`;
			node.style.top = `${Math.max(8, rect.top - node.offsetHeight - 8)}px`;
		}
		search.current?.focus();
		return () => {
			if (node.open) node.close();
		};
	}, [open]);

	if (context === undefined) return null;

	const chooseProject = (id: string | undefined) => {
		setOpen(false);
		command(actions, COMPOSER_PROJECT_ACTION, id);
	};
	const addProject = () => {
		setOpen(false);
		command(actions, PROJECT_ADD_ACTION);
	};
	const needle = query.trim().toLowerCase();
	const projects = context.projects.filter((project) =>
		project.name.toLowerCase().includes(needle),
	);
	return (
		<div className="composer-context">
			<button
				ref={trigger}
				type="button"
				className="composer-project"
				disabled={context.disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${translate(view.locale, "project.choose")}: ${context.label}`}
				onClick={() => setOpen(true)}
			>
				<Icon name={context.projectId === null ? "x" : "folder"} />
				<span>{context.label}</span>
			</button>
			{!open ? null : (
				<dialog
					ref={dialog}
					className="project-picker"
					aria-label={translate(view.locale, "project.choose")}
					onClose={() => {
						setOpen(false);
						trigger.current?.focus({ preventScroll: true });
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget)
							event.currentTarget.close();
					}}
					onKeyDown={(event) => {
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						event.preventDefault();
						const options = [
							...event.currentTarget.querySelectorAll<HTMLButtonElement>(
								".project-picker-option",
							),
						];
						const index =
							document.activeElement instanceof HTMLButtonElement
								? options.indexOf(document.activeElement)
								: -1;
						const step = event.key === "ArrowDown" ? 1 : options.length - 1;
						options[
							index < 0
								? event.key === "ArrowDown"
									? 0
									: options.length - 1
								: (index + step) % options.length
						]?.focus();
					}}
				>
					<input
						ref={search}
						type="search"
						placeholder={translate(view.locale, "project.search")}
						aria-label={translate(view.locale, "project.search")}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
					/>
					<div className="project-picker-list">
						{projects.map((project) => (
							<button
								type="button"
								className="project-picker-option"
								aria-pressed={project.id === context.projectId}
								key={project.id}
								onClick={() => chooseProject(project.id)}
							>
								<Icon name="folder" />
								<span>{project.name}</span>
								{project.id === context.projectId ? (
									<Icon name="check" />
								) : null}
							</button>
						))}
						{projects.length === 0 ? (
							<p className="project-picker-empty">
								{translate(view.locale, "project.noMatch")}
							</p>
						) : null}
					</div>
					<button
						type="button"
						className="project-picker-option"
						onClick={addProject}
					>
						<Icon name="plus" />
						<span>{translate(view.locale, "project.add")}</span>
					</button>
					<button
						type="button"
						className="project-picker-option"
						onClick={() => chooseProject(undefined)}
					>
						<Icon name="x" />
						<span>{translate(view.locale, "project.standalone")}</span>
					</button>
				</dialog>
			)}
		</div>
	);
}

interface PermissionOption {
	readonly value: ApprovalPolicy;
	readonly icon: IconName;
	readonly label: MessageKey;
	readonly description: MessageKey;
}

const PERMISSIONS = [
	{
		value: "all",
		icon: "hand",
		label: "permission.ask",
		description: "permission.askDescription",
	},
	{
		value: "mutations",
		icon: "shield-check",
		label: "permission.assist",
		description: "permission.assistDescription",
	},
	{
		value: "auto",
		icon: "shield-alert",
		label: "permission.full",
		description: "permission.fullDescription",
	},
] satisfies readonly PermissionOption[];

function PermissionPicker({
	view,
	actions,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const policy = view.approvalPolicy ?? "mutations";
	const selected =
		PERMISSIONS.find((option) => option.value === policy) ?? PERMISSIONS[1];
	const disabled = view.readOnly === true || view.attachedId === undefined;

	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				root.current?.contains(event.target) === true
			)
				return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);

	return (
		<div ref={root} className="permission-control">
			<button
				ref={trigger}
				type="button"
				className="permission-trigger"
				data-policy={policy}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${translate(view.locale, "permission.heading")}: ${translate(view.locale, selected.label)}`}
				title={translate(view.locale, "permission.nextRequest")}
				onClick={() => setOpen((value) => !value)}
			>
				<Icon name={selected.icon} />
				{translate(view.locale, selected.label)}
				<Icon name="chevron-down" />
			</button>
			{!open ? null : (
				<div
					className="permission-menu"
					role="dialog"
					aria-label={translate(view.locale, "permission.heading")}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						setOpen(false);
						trigger.current?.focus({ preventScroll: true });
					}}
				>
					<div role="menu">
						{PERMISSIONS.map((option) => (
							<button
								type="button"
								className="permission-option"
								data-policy={option.value}
								role="menuitemradio"
								aria-checked={option.value === policy}
								key={option.value}
								onClick={() => {
									setOpen(false);
									actions.onSelectPermission(option.value);
									trigger.current?.focus({ preventScroll: true });
								}}
							>
								<Icon name={option.icon} />
								<span className="permission-copy">
									<span className="permission-label">
										{translate(view.locale, option.label)}
									</span>
									<span className="permission-description">
										{translate(view.locale, option.description)}
									</span>
								</span>
								<Icon name="check" className="icon permission-check" />
							</button>
						))}
					</div>
					<p className="permission-hint">
						{translate(view.locale, "permission.nextRequest")}
					</p>
				</div>
			)}
		</div>
	);
}

interface SuggestionProps {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
	readonly composing: boolean;
	readonly draft: string;
	readonly dismissed: string | undefined;
	readonly onDismiss: (key: string) => void;
	readonly onFocus: () => void;
}

function Suggestion({
	view,
	actions,
	composing,
	draft,
	dismissed,
	onDismiss,
	onFocus,
}: SuggestionProps) {
	const [preview, setPreview] = useState(false);
	const candidate = view.suggestion;
	const visible =
		candidate !== undefined &&
		candidate.key !== dismissed &&
		!composing &&
		!view.busy &&
		view.attachedId !== undefined &&
		view.readOnly !== true &&
		!view.palette.open &&
		view.approvals.length === 0 &&
		view.queue.length === 0 &&
		view.attachments.length === 0 &&
		draft.length === 0;
	if (!visible || candidate === undefined) return null;
	const dismiss = () => {
		onDismiss(candidate.key);
		actions.onDismissSuggestion();
		onFocus();
	};
	const accept = () => {
		onDismiss(candidate.key);
		actions.onDismissSuggestion();
		actions.setDraft(candidate.text);
	};
	return (
		<>
			<div className="composer-suggestion">
				<span className="suggestion-text">{candidate.text}</span>
				<button
					type="button"
					className="suggestion-accept"
					title={translate(view.locale, "composer.acceptSuggestion")}
					aria-label={`${translate(view.locale, "composer.acceptSuggestion")}: ${candidate.text}`}
					onClick={accept}
				>
					<kbd>{translate(view.locale, "composer.tabAccept")}</kbd>
				</button>
				<button
					type="button"
					className="suggestion-preview-toggle"
					title={translate(view.locale, "composer.previewSuggestion")}
					aria-label={translate(view.locale, "composer.previewSuggestion")}
					aria-expanded={preview}
					onClick={() => setPreview((value) => !value)}
				>
					<Icon name="chevron-down" />
				</button>
				<button
					type="button"
					className="suggestion-dismiss"
					title={translate(view.locale, "composer.dismissSuggestion")}
					aria-label={translate(view.locale, "composer.dismissSuggestion")}
					onClick={dismiss}
				>
					<Icon name="x" />
				</button>
			</div>
			<span
				id="suggestion-hint"
				hidden
			>{`${candidate.text} ${translate(view.locale, "composer.suggestionHint")}`}</span>
			{preview ? (
				<section
					className="suggestion-preview"
					aria-label={translate(view.locale, "composer.previewSuggestion")}
				>
					{candidate.text}
				</section>
			) : null}
		</>
	);
}

interface DraftFocusDetail {
	readonly text: string;
	readonly focus: boolean;
}

const DRAFT_FOCUS_EVENT = "amazme:draft-focus";
const DRAFT_INSERT_EVENT = "amazme:draft-insert";

interface EditorSelection {
	readonly start: number;
	readonly end: number;
	readonly direction: "forward" | "backward" | "none";
}

function isDraftFocusDetail(value: unknown): value is DraftFocusDetail {
	return (
		value !== null &&
		typeof value === "object" &&
		"text" in value &&
		typeof value.text === "string" &&
		"focus" in value &&
		typeof value.focus === "boolean"
	);
}

/**
 * The composer owns only draft display and transient input state. The current business draft arrives
 * from the page owner; direct input is published immediately with `onDraftChange`.
 */
export function ChatComposer({
	view,
	actions,
	draft,
	active,
	restoreFocusRequest,
}: ComposerProps) {
	const editor = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const selection = useRef<EditorSelection>({
		start: draft.length,
		end: draft.length,
		direction: "none",
	});
	const handledFocusRequest = useRef(restoreFocusRequest);
	const emittedDraft = useRef(draft);
	const valueRef = useRef(draft);
	const [value, setValue] = useState(draft);
	const [composing, setComposing] = useState(false);
	const composingRef = useRef(false);
	const [dragging, setDragging] = useState(false);
	const [dismissedSuggestion, setDismissedSuggestion] = useState<string>();

	const updateValue = useCallback((next: string) => {
		valueRef.current = next;
		setValue(next);
	}, []);

	useEffect(() => {
		if (draft === emittedDraft.current) return;
		emittedDraft.current = draft;
		updateValue(draft);
	}, [draft, updateValue]);

	useLayoutEffect(() => {
		const node = editor.current;
		if (node === null || node.value !== value) return;
		node.style.height = "auto";
		node.style.height = `${node.scrollHeight}px`;
	}, [value]);

	const rememberSelection = useCallback(() => {
		const node = editor.current;
		if (node === null) return;
		selection.current = {
			start: node.selectionStart,
			end: node.selectionEnd,
			direction: node.selectionDirection ?? "none",
		};
	}, []);

	const focusEditor = useCallback(
		(target?: EditorSelection) => {
			window.requestAnimationFrame(() => {
				const node = editor.current;
				if (
					node === null ||
					node.disabled ||
					node.closest("[hidden], [inert]") ||
					document.querySelector("dialog[open]")
				)
					return;
				node.focus({ preventScroll: true });
				if (target !== undefined)
					node.setSelectionRange(target.start, target.end, target.direction);
				rememberSelection();
			});
		},
		[rememberSelection],
	);

	useEffect(() => {
		if (restoreFocusRequest === handledFocusRequest.current) return;
		handledFocusRequest.current = restoreFocusRequest;
		focusEditor(
			valueRef.current.length === 0
				? { start: 0, end: 0, direction: "none" }
				: selection.current,
		);
	}, [focusEditor, restoreFocusRequest]);

	useEffect(() => {
		const seen = new WeakSet<Event>();
		const focusEvent = (event: Event) => {
			if (seen.has(event)) return;
			seen.add(event);
			if (!(event instanceof CustomEvent) || !isDraftFocusDetail(event.detail))
				return;
			updateValue(event.detail.text);
			emittedDraft.current = event.detail.text;
			selection.current = {
				start: event.detail.text.length,
				end: event.detail.text.length,
				direction: "none",
			};
			if (event.detail.focus)
				focusEditor({
					start: event.detail.text.length,
					end: event.detail.text.length,
					direction: "none",
				});
		};
		const insertEvent = (event: Event) => {
			if (seen.has(event)) return;
			seen.add(event);
			if (!(event instanceof CustomEvent) || !isDraftFocusDetail(event.detail))
				return;
			const inserted = insertDraftText(
				valueRef.current,
				selection.current.start,
				selection.current.end,
				event.detail.text,
			);
			updateValue(inserted.text);
			emittedDraft.current = inserted.text;
			selection.current = {
				start: inserted.cursor,
				end: inserted.cursor,
				direction: "none",
			};
			actions.onDraftChange(inserted.text);
			if (event.detail.focus)
				focusEditor({
					start: inserted.cursor,
					end: inserted.cursor,
					direction: "none",
				});
		};
		window.addEventListener(DRAFT_FOCUS_EVENT, focusEvent);
		window.addEventListener(DRAFT_INSERT_EVENT, insertEvent);
		return () => {
			window.removeEventListener(DRAFT_FOCUS_EVENT, focusEvent);
			window.removeEventListener(DRAFT_INSERT_EVENT, insertEvent);
		};
	}, [actions, focusEditor, updateValue]);

	useEffect(() => {
		const focusComposer = (event: globalThis.KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.code !== "Slash" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey
			)
				return;
			const node = editor.current;
			if (
				node === null ||
				!node.isConnected ||
				node.closest("[hidden]") !== null
			)
				return;
			const modal =
				event.target instanceof Element &&
				event.target.closest("dialog[open]") !== null;
			if (modal) return;
			const target = event.target;
			if (
				target instanceof Element &&
				(target.closest("#view") !== null ||
					target.closest(".pty-surface") !== null)
			)
				return;
			if (
				target instanceof HTMLElement &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable)
			)
				return;
			event.preventDefault();
			node.focus();
		};
		document.addEventListener("keydown", focusComposer);
		return () => document.removeEventListener("keydown", focusComposer);
	}, []);

	const canCompose =
		view.readOnly !== true &&
		(view.sessionDraft === undefined
			? view.attachedId !== undefined
			: !view.sessionDraft.disabled);
	const pendingImages = view.attachments.length;
	const newSessionNeedsModel =
		view.sessionDraft !== undefined &&
		(view.model.disabled || view.model.groups.length === 0);
	const canSubmit =
		canCompose &&
		!newSessionNeedsModel &&
		(value.trim().length > 0 || pendingImages > 0);
	const suggestionVisible =
		view.suggestion !== undefined &&
		view.suggestion.key !== dismissedSuggestion &&
		!composing &&
		!view.busy &&
		view.attachedId !== undefined &&
		view.readOnly !== true &&
		!view.palette.open &&
		view.approvals.length === 0 &&
		view.queue.length === 0 &&
		view.attachments.length === 0 &&
		value.length === 0;

	const submitDraft = () => {
		if (!canCompose) return;
		const text = value.trim();
		if (text.startsWith("/") && view.palette.open) {
			const selected = view.palette.rows.find((row) => row.selected);
			if (!view.commandLine && selected !== undefined) {
				actions.onCommandPick(selected.value);
				return;
			}
		}
		if (text.length === 0 && pendingImages === 0) return;
		actions.onSubmit(text);
	};

	const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		submitDraft();
	};

	const onInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
		const next = event.currentTarget.value;
		updateValue(next);
		emittedDraft.current = next;
		rememberSelection();
		actions.onDraftChange(next);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			composingRef.current ||
			event.nativeEvent.isComposing ||
			event.keyCode === 229
		)
			return;
		if (view.palette.open && view.palette.rows.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				const current = view.palette.rows.findIndex((row) => row.selected);
				const next =
					(current + step + view.palette.rows.length) %
					view.palette.rows.length;
				actions.onPaletteSelection(next);
				return;
			}
			if (event.key === "Tab") {
				event.preventDefault();
				const selected =
					view.palette.rows.find((row) => row.selected) ?? view.palette.rows[0];
				if (selected !== undefined) actions.onCommandPick(selected.value);
				return;
			}
		}
		if (
			suggestionVisible &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.shiftKey &&
			(event.key === "Tab" || event.key === "Escape")
		) {
			event.preventDefault();
			event.stopPropagation();
			const candidate = view.suggestion;
			if (candidate === undefined) return;
			if (event.key === "Tab") {
				setDismissedSuggestion(candidate.key);
				actions.onDismissSuggestion();
				actions.setDraft(candidate.text);
			} else {
				setDismissedSuggestion(candidate.key);
				actions.onDismissSuggestion();
				focusEditor();
			}
			return;
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		submitDraft();
	};

	const attachFiles = (files: readonly File[]) => {
		if (files.length > 0) actions.onAttachFiles(files);
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = [...(event.clipboardData.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		attachFiles(files);
	};

	const onDrop = (event: DragEvent<HTMLFormElement>) => {
		const files = [...(event.dataTransfer.files ?? [])];
		setDragging(false);
		if (files.length === 0) return;
		event.preventDefault();
		attachFiles(files);
	};

	const extras =
		view.approvals.length > 0 ||
		(view.questions?.length ?? 0) > 0 ||
		view.queue.length > 0 ||
		view.palette.open;
	const questionSessionId = view.attachedId;
	return (
		<div className="composer-dock" id="composer-dock">
			{!extras ? null : (
				<div className="composer-extras" id="composer-extras">
					<ApprovalCards view={view} actions={actions} />
					{(view.questions?.length ?? 0) === 0 ||
					questionSessionId === undefined ? null : (
						<div className="questions">
							{(view.questions ?? []).map((question) => (
								<QuestionForm
									question={question}
									locale={view.locale}
									sessionId={questionSessionId}
									readOnly={view.readOnly === true}
									actions={actions}
									key={`${view.attachedId}:${question.request_id}:${question.question_id}:${question.proposal_digest}:${question.generation}`}
								/>
							))}
						</div>
					)}
					<QueueRows
						items={view.queue}
						locale={view.locale}
						actions={actions}
					/>
					<Palette view={view} actions={actions} />
				</div>
			)}
			<ProjectPicker view={view} actions={actions} />
			<form
				className={`composer${dragging ? " dropping" : ""}`}
				id="composer"
				onSubmit={onSubmitForm}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={onDrop}
			>
				<Attachments
					items={view.attachments}
					locale={view.locale}
					actions={actions}
					active={active}
				/>
				<div className="composer-editor">
					<textarea
						ref={editor}
						className="composer-input"
						id="prompt"
						rows={1}
						placeholder={
							view.sessionDraft === undefined
								? composerPlaceholder(view.locale, canCompose)
								: translate(view.locale, "composer.placeholderDraft")
						}
						aria-label={translate(view.locale, "composer.promptLabel")}
						aria-describedby={suggestionVisible ? "suggestion-hint" : undefined}
						value={value}
						disabled={!canCompose}
						onChange={onInput}
						onKeyDown={onKeyDown}
						onCompositionStart={() => {
							composingRef.current = true;
							setComposing(true);
						}}
						onCompositionEnd={() => {
							composingRef.current = false;
							setComposing(false);
							rememberSelection();
						}}
						onKeyUp={rememberSelection}
						onClick={rememberSelection}
						onSelect={rememberSelection}
						onFocus={rememberSelection}
						onBlur={rememberSelection}
						onPaste={onPaste}
					/>
					<Suggestion
						view={view}
						actions={actions}
						composing={composing}
						draft={value}
						dismissed={dismissedSuggestion}
						onDismiss={setDismissedSuggestion}
						onFocus={() => focusEditor()}
					/>
				</div>
				<div className="composer-row">
					<div className="composer-leading">
						<input
							ref={fileInput}
							type="file"
							accept="image/*"
							multiple
							hidden
							onChange={(event) => {
								const files = [...(event.currentTarget.files ?? [])];
								event.currentTarget.value = "";
								attachFiles(files);
							}}
						/>
						<button
							type="button"
							className="composer-attach"
							aria-label={translate(view.locale, "composer.attach")}
							title={translate(view.locale, "composer.attach")}
							disabled={!canCompose}
							onClick={() => fileInput.current?.click()}
						>
							<Icon name="plus" />
						</button>
						<PermissionPicker view={view} actions={actions} />
						{!view.busy ? null : (
							<div className="submit-modes">
								<select
									className="composer-select"
									aria-label={translate(view.locale, "composer.modesAria")}
									value={
										view.run.submitModes.find((option) => option.selected)
											?.mode ?? "followUp"
									}
									title={translate(
										view.locale,
										view.run.submitModes.find((option) => option.selected)
											?.mode === "steer"
											? "composer.steerHelp"
											: "composer.queueHelp",
									)}
									onChange={(event) =>
										command(
											actions,
											SUBMIT_MODE_ACTION,
											event.currentTarget.value,
										)
									}
								>
									{view.run.submitModes.map((option) => (
										<option value={option.mode} key={option.mode}>
											{option.label}
										</option>
									))}
								</select>
							</div>
						)}
					</div>
					<div className="composer-trailing">
						<div className="composer-model-control">
							<ComposerStatusMeter view={view} actions={actions} />
							<ComposerModelControls view={view} actions={actions} />
						</div>
						{!view.busy || view.attachedId === undefined ? null : (
							<button
								type="button"
								className="stop"
								aria-label={translate(view.locale, "composer.stop")}
								title={
									view.shortcuts.find((row) => row.id === "run.stop")?.keys ??
									translate(view.locale, "composer.stop")
								}
								onClick={() => actions.onAbort()}
							>
								<Icon name="stop" />
							</button>
						)}
						<button
							type="submit"
							className="primary"
							aria-label={translate(view.locale, "composer.send")}
							disabled={!canSubmit}
						>
							<svg
								className="icon"
								viewBox="0 0 24 24"
								aria-hidden="true"
								focusable="false"
							>
								<use href="#i-arrow-up" />
							</svg>
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
