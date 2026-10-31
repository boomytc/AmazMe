import type {
	CSSProperties,
	KeyboardEvent as ReactKeyboardEvent,
	ReactNode,
	PointerEvent as ReactPointerEvent,
	RefObject,
} from "react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { credentialRanges } from "../credentials.ts";
import type { DirectoryListing } from "../directories.ts";
import type { Locale } from "../locale.ts";
import {
	type PanelAction,
	type PanelButton,
	type PanelControl,
	type PanelOption,
	type PanelPending,
	type PanelRow,
	SETTINGS_FIELD_ACTION,
} from "../panels.ts";
import { translate } from "../strings.ts";
import { FONT_FAMILY_FIELDS, normalizeFontFamily } from "../typography.ts";

export type IconName =
	| "arrow-up"
	| "check"
	| "chevron-down"
	| "file"
	| "folder"
	| "more"
	| "search"
	| "square-pen"
	| "x";

export interface IconProps {
	readonly name: IconName;
	readonly className?: string;
}

export function Icon({ name, className = "icon" }: IconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" aria-hidden="true">
			<use href={`#i-${name}`} />
		</svg>
	);
}

interface CredentialSecretProps {
	readonly text: string;
	readonly masked: string;
	readonly locale: Locale;
}

function CredentialSecret({ text, masked, locale }: CredentialSecretProps) {
	const [shown, setShown] = useState(false);
	const label = translate(
		locale,
		shown ? "secret.hideAria" : "secret.showAria",
	);
	return (
		<span className="credential-secret">
			<span className="credential-value">{shown ? text : masked}</span>
			<button
				type="button"
				className="credential-toggle"
				aria-label={label}
				aria-pressed={shown}
				onClick={() => setShown((current) => !current)}
			>
				{translate(locale, shown ? "secret.hide" : "secret.show")}
			</button>
		</span>
	);
}

interface SensitiveTextProps {
	readonly text: string;
	readonly locale: Locale;
	readonly className?: string;
}

/** Panel text may carry credentials copied from provider or extension output. */
export function SensitiveText({ text, locale, className }: SensitiveTextProps) {
	const ranges = credentialRanges(text);
	if (ranges.length === 0) return <>{text}</>;
	const content: ReactNode[] = [];
	let from = 0;
	for (const range of ranges) {
		if (range.start > from) content.push(text.slice(from, range.start));
		content.push(
			<CredentialSecret
				key={`${range.start}:${range.end}`}
				text={text.slice(range.start, range.end)}
				masked={range.masked}
				locale={locale}
			/>,
		);
		from = range.end;
	}
	if (from < text.length) content.push(text.slice(from));
	return <span className={className}>{content}</span>;
}

export function sameActionTarget(
	pending: PanelPending | undefined,
	action: { readonly id: string; readonly data?: string },
): boolean {
	return (
		pending !== undefined &&
		pending.id === action.id &&
		(pending.data ?? "") === (action.data ?? "")
	);
}

function panelButtonClass(
	action: Pick<PanelButton, "weight" | "danger">,
): string {
	return `panel-button weight-${action.weight}${action.danger === true ? " is-danger" : ""}`;
}

export interface PanelButtonViewProps {
	readonly action: PanelButton;
	readonly pending?: PanelPending;
	readonly onAction: (action: PanelAction) => void;
	readonly forceDisabled?: boolean;
	readonly className?: string;
}

export function PanelButtonView({
	action,
	pending,
	onAction,
	forceDisabled = false,
	className = "",
}: PanelButtonViewProps) {
	const isPending = sameActionTarget(pending, action);
	return (
		<button
			type="button"
			className={`${panelButtonClass(action)}${action.placement === "start" ? " is-footer-start" : ""}${isPending ? " pending" : ""}${className.length === 0 ? "" : ` ${className}`}`}
			data-action={action.id}
			data-action-data={action.data}
			title={action.label}
			aria-pressed={action.pressed}
			aria-busy={isPending || undefined}
			disabled={action.disabled === true || isPending || forceDisabled}
			onClick={() =>
				onAction({ kind: "command", id: action.id, data: action.data })
			}
		>
			{action.label}
		</button>
	);
}

export type ControlSaveStatus = "idle" | "saving" | "saved";

export interface ControlEdit {
	readonly value: string;
	readonly dirty: boolean;
	readonly committed?: string;
	readonly status: ControlSaveStatus;
}

export type ControlEdits = Readonly<Record<string, ControlEdit>>;
export type UpdateControlEdit = (
	key: string,
	update: (current: ControlEdit | undefined) => ControlEdit,
) => void;

const FONT_FAMILY_SET: ReadonlySet<string> = new Set(FONT_FAMILY_FIELDS);

export function controlKey(
	panelId: string,
	rowId: string,
	control: Pick<PanelControl, "id" | "data">,
): string {
	return `${panelId}\u0000${rowId}\u0000${control.id}\u0000${control.data ?? ""}`;
}

export function normalizeControlValue(
	control: PanelControl,
	value: string,
): string {
	if (control.kind === "number") {
		if (value.trim().length === 0) return value;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? String(parsed) : value;
	}
	if (
		control.id === SETTINGS_FIELD_ACTION &&
		control.data !== undefined &&
		FONT_FAMILY_SET.has(control.data)
	) {
		try {
			return normalizeFontFamily(value);
		} catch {
			return value;
		}
	}
	return value;
}

export function sameControlValue(
	control: PanelControl,
	left: string,
	right: string,
): boolean {
	return (
		normalizeControlValue(control, left) ===
		normalizeControlValue(control, right)
	);
}

function inRange(control: PanelControl, value: string): boolean {
	if (value.trim().length === 0) return false;
	const parsed = Number(value);
	if (
		!Number.isFinite(parsed) ||
		((control.step ?? 1) >= 1 && !Number.isSafeInteger(parsed))
	)
		return false;
	return (
		parsed >= (control.min ?? Number.NEGATIVE_INFINITY) &&
		parsed <= (control.max ?? Number.POSITIVE_INFINITY)
	);
}

function initialControlEdit(control: PanelControl): ControlEdit {
	return { value: control.value, dirty: false, status: "idle" };
}

function sameControlEdit(left: ControlEdit, right: ControlEdit): boolean {
	return (
		left.value === right.value &&
		left.dirty === right.dirty &&
		left.committed === right.committed &&
		left.status === right.status
	);
}

export interface PanelControlViewProps {
	readonly panelId: string;
	readonly row: PanelRow;
	readonly control: PanelControl;
	readonly locale: Locale;
	readonly pending: PanelPending | undefined;
	readonly hasError: boolean;
	readonly edits: ControlEdits;
	readonly updateEdit: UpdateControlEdit;
	readonly onAction: (action: PanelAction) => void;
}

export function PanelControlView({
	panelId,
	row,
	control,
	locale,
	pending,
	hasError,
	edits,
	updateEdit,
	onAction,
}: PanelControlViewProps) {
	const key = controlKey(panelId, row.id, control);
	const edit = edits[key] ?? initialControlEdit(control);
	const errorId = `panel-control-error-${useId().replaceAll(":", "")}`;
	const statusId = `panel-control-status-${useId().replaceAll(":", "")}`;
	const pendingSeen = useRef(false);
	const accessibleName =
		control.label === undefined ? row.title : `${row.title} · ${control.label}`;
	const isPending = sameActionTarget(pending, control);
	const disabled = control.disabled === true || isPending;
	const numberError =
		control.kind === "number" && !inRange(control, edit.value);
	const errorText = numberError
		? translate(
				locale,
				control.max !== undefined
					? "panel.settings.invalidRange"
					: (control.step ?? 1) < 1
						? "panel.settings.invalidDecimal"
						: "panel.settings.invalidNumber",
				{
					min: String(control.min ?? 0),
					max: String(control.max ?? ""),
				},
			)
		: "";

	const update = useCallback(
		(next: ControlEdit): void => {
			updateEdit(key, (current) => {
				const base = current ?? initialControlEdit(control);
				return sameControlEdit(base, next) ? base : next;
			});
		},
		[control, key, updateEdit],
	);

	useEffect(() => {
		updateEdit(key, (current) => {
			const value = current ?? initialControlEdit(control);
			if (value.dirty) {
				if (
					value.committed !== undefined &&
					sameControlValue(control, value.committed, control.value)
				) {
					return {
						...value,
						value: control.value,
						dirty: false,
					};
				}
				return value;
			}
			if (sameControlValue(control, value.value, control.value)) return value;
			return { ...value, value: control.value };
		});
	}, [control, key, updateEdit]);

	useEffect(() => {
		if (isPending) {
			pendingSeen.current = true;
			if (edit.status !== "saving") {
				update({ ...edit, status: "saving" });
			}
			return;
		}
		if (hasError) {
			pendingSeen.current = false;
			if (edit.status !== "idle" || edit.committed !== undefined) {
				update({ ...edit, status: "idle", committed: undefined });
			}
			return;
		}
		if (edit.status !== "saving" || edit.committed === undefined) return;
		if (
			!pendingSeen.current &&
			!sameControlValue(control, control.value, edit.committed)
		)
			return;
		pendingSeen.current = false;
		if (sameControlValue(control, control.value, edit.committed)) {
			update({
				value: control.value,
				dirty: false,
				committed: edit.committed,
				status: "saved",
			});
			return;
		}
		update({ ...edit, status: "idle", committed: undefined });
	}, [control, edit, hasError, isPending, update]);

	useEffect(() => {
		if (edit.status !== "saved") return;
		const timer = window.setTimeout(() => {
			updateEdit(key, (current) => {
				if (current === undefined || current.status !== "saved") {
					return current ?? { value: "", dirty: false, status: "idle" };
				}
				return { ...current, status: "idle", committed: undefined };
			});
		}, 2400);
		return () => window.clearTimeout(timer);
	}, [edit.status, key, updateEdit]);

	const emit = (nextValue: string): void => {
		const normalized = normalizeControlValue(control, nextValue);
		if (sameControlValue(control, normalized, control.value)) {
			update({ value: control.value, dirty: false, status: "idle" });
			return;
		}
		update({
			value: normalized,
			dirty: true,
			committed: normalized,
			status: "saving",
		});
		onAction({
			kind: "control",
			id: control.id,
			data: control.data,
			value: normalized,
		});
	};

	const status = isPending
		? translate(locale, "panel.settings.saving")
		: edit.status === "saved"
			? translate(locale, "panel.settings.saved")
			: translate(locale, "panel.settings.commitHint");

	if (control.kind === "switch") {
		return (
			<>
				<label
					className={`panel-switch${isPending ? " pending" : ""}`}
					aria-busy={isPending || undefined}
				>
					<input
						type="checkbox"
						data-control-key={key}
						aria-label={accessibleName}
						checked={edit.value === "true"}
						disabled={disabled}
						onChange={(event) => emit(String(event.currentTarget.checked))}
					/>
					<span className="panel-switch-track" />
				</label>
				{(isPending || edit.status !== "idle") && (
					<output
						className="panel-control-status"
						data-control-status={key}
						data-state={isPending ? "saving" : edit.status}
						aria-live="polite"
					>
						{translate(
							locale,
							isPending || edit.status === "saving"
								? "panel.settings.saving"
								: "panel.settings.saved",
						)}
					</output>
				)}
			</>
		);
	}

	if (control.kind === "select") {
		const ungrouped: PanelOption[] = [];
		const grouped = new Map<string, PanelOption[]>();
		for (const option of control.options ?? []) {
			if (option.group === undefined) {
				ungrouped.push(option);
				continue;
			}
			const rows = grouped.get(option.group) ?? [];
			if (!grouped.has(option.group)) grouped.set(option.group, rows);
			rows.push(option);
		}
		return (
			<>
				<select
					className={`panel-select${isPending ? " pending" : ""}`}
					data-control-key={key}
					aria-label={accessibleName}
					aria-busy={isPending || undefined}
					value={edit.value}
					disabled={disabled}
					onChange={(event) => emit(event.currentTarget.value)}
				>
					{ungrouped.map((option) => (
						<option
							key={`${option.group ?? ""}\u0000${option.value}`}
							value={option.value}
							disabled={option.disabled}
						>
							{option.label}
						</option>
					))}
					{[...grouped].map(([group, options]) => (
						<optgroup key={group} label={group}>
							{options.map((option) => (
								<option
									key={`${group}\u0000${option.value}`}
									value={option.value}
									disabled={option.disabled}
								>
									{option.label}
								</option>
							))}
						</optgroup>
					))}
				</select>
				{(isPending || edit.status !== "idle") && (
					<output
						className="panel-control-status"
						data-control-status={key}
						data-state={isPending ? "saving" : edit.status}
						aria-live="polite"
					>
						{translate(
							locale,
							isPending || edit.status === "saving"
								? "panel.settings.saving"
								: "panel.settings.saved",
						)}
					</output>
				)}
			</>
		);
	}

	const commit = (): void => {
		if (disabled || numberError) return;
		emit(edit.value);
	};
	return (
		<div className="panel-field">
			<input
				type={control.kind === "number" ? "number" : "text"}
				className={`${control.kind === "number" ? "panel-input panel-number" : "panel-input"}${numberError ? " invalid" : ""}${isPending ? " pending" : ""}`}
				data-control-key={key}
				aria-label={accessibleName}
				aria-invalid={numberError || undefined}
				aria-describedby={numberError ? errorId : statusId}
				aria-busy={isPending || undefined}
				value={edit.value}
				placeholder={control.placeholder}
				min={control.min}
				max={control.max}
				step={control.step}
				disabled={disabled}
				onChange={(event) => {
					update({
						value: event.currentTarget.value,
						dirty: true,
						status: "idle",
					});
				}}
				onBlur={commit}
				onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
					if (
						event.key !== "Enter" ||
						event.nativeEvent.isComposing ||
						event.keyCode === 229
					)
						return;
					event.preventDefault();
					commit();
				}}
			/>
			<p
				id={errorId}
				className="panel-field-error"
				role="alert"
				hidden={!numberError}
			>
				{errorText}
			</p>
			<output
				id={statusId}
				className="panel-field-status"
				data-control-status={key}
				data-state={
					isPending
						? "saving"
						: edit.status === "saved"
							? "saved"
							: edit.dirty
								? "dirty"
								: "hint"
				}
				aria-live="polite"
				hidden={numberError}
			>
				{status}
			</output>
		</div>
	);
}

export function PanelBadge({
	badge,
	locale,
}: {
	readonly badge: string | { readonly added: number; readonly removed: number };
	readonly locale: Locale;
}) {
	if (typeof badge === "string") {
		return (
			<span className="panel-badge">
				<SensitiveText text={badge} locale={locale} />
			</span>
		);
	}
	return (
		<span className="panel-delta">
			<span className="delta-add">+{badge.added}</span>
			<span className="delta-remove">−{badge.removed}</span>
		</span>
	);
}

type PanelMenu = NonNullable<PanelRow["menu"]>;

export interface PanelRowMenuProps {
	readonly menu: PanelMenu;
	readonly rowTitle: string;
	readonly pending: PanelPending | undefined;
	readonly onAction: (action: PanelAction) => void;
}

export function PanelRowMenu({
	menu,
	rowTitle,
	pending,
	onAction,
}: PanelRowMenuProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({ left: 8, top: 8 });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const disabled = menu.actions.every(
		(action) => action.disabled === true || sameActionTarget(pending, action),
	);

	const close = useCallback((restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) {
			triggerRef.current?.focus({ preventScroll: true });
		}
	}, []);

	useLayoutEffect(() => {
		if (!open || triggerRef.current === null) return;
		const rect = triggerRef.current.getBoundingClientRect();
		const width = menuRef.current?.offsetWidth ?? 212;
		const height = menuRef.current?.offsetHeight ?? 0;
		setPosition({
			left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
			top: Math.max(
				8,
				Math.min(rect.bottom + 4, window.innerHeight - height - 8),
			),
		});
	}, [open]);

	useEffect(() => {
		if (!open) return;
		menuRef.current
			?.querySelector<HTMLButtonElement>("button:not(:disabled)")
			?.focus();
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (
				menuRef.current?.contains(target) ||
				triggerRef.current?.contains(target)
			)
				return;
			setOpen(false);
		};
		const onScrollOrResize = (): void => setOpen(false);
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("resize", onScrollOrResize);
		window.addEventListener("scroll", onScrollOrResize, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("resize", onScrollOrResize);
			window.removeEventListener("scroll", onScrollOrResize, true);
		};
	}, [open]);

	const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close(true);
			return;
		}
		if (event.key === "Tab") {
			close(false);
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const controls = [
			...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
				"button:not(:disabled)",
			) ?? []),
		];
		if (controls.length === 0) return;
		const current =
			document.activeElement instanceof HTMLButtonElement
				? controls.indexOf(document.activeElement)
				: -1;
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? controls.length - 1
					: (current + (event.key === "ArrowUp" ? -1 : 1) + controls.length) %
						controls.length;
		controls[next]?.focus();
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className="panel-button weight-text panel-more"
				title={menu.label}
				aria-label={`${menu.label}: ${rowTitle.trim()}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				disabled={disabled}
				onClick={() => setOpen((current) => !current)}
			>
				<Icon name="more" />
			</button>
			{open &&
				createPortal(
					<div
						ref={menuRef}
						id={menuId}
						className="session-menu"
						style={position}
						role="menu"
						aria-label={menu.label}
						onKeyDown={onMenuKeyDown}
					>
						{menu.actions.map((action) => {
							const isPending = sameActionTarget(pending, action);
							return (
								<button
									key={`${action.id}\u0000${action.data ?? ""}`}
									type="button"
									className={
										action.danger === true
											? "session-menu-item danger"
											: "session-menu-item"
									}
									role="menuitem"
									tabIndex={-1}
									disabled={action.disabled === true || isPending}
									onClick={() => {
										close(true);
										onAction({
											kind: "command",
											id: action.id,
											data: menu.data,
										});
									}}
								>
									<Icon name={action.glyph} />
									<span>{action.label}</span>
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</>
	);
}

type ParsedDirectories =
	| { readonly kind: "all-invalid" }
	| { readonly kind: "directories"; readonly paths: readonly string[] };

function isStringArray(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) return false;
	for (const item of value) if (typeof item !== "string") return false;
	return true;
}

function parseDirectories(value: string): ParsedDirectories {
	try {
		const parsed: unknown = JSON.parse(value);
		return isStringArray(parsed)
			? { kind: "directories", paths: parsed }
			: { kind: "all-invalid" };
	} catch {
		return { kind: "all-invalid" };
	}
}

function directoryName(path: string): string {
	return (
		path
			.split(/[\\/]+/u)
			.filter(Boolean)
			.at(-1) ?? path
	);
}

export interface DirectoryFieldProps {
	readonly id: string;
	readonly locale: Locale;
	readonly value: string;
	readonly disabled: boolean;
	readonly onValueChange: (value: string) => void;
	readonly browseDirectories?: (path?: string) => Promise<DirectoryListing>;
	readonly pickDirectories?: () => Promise<readonly string[] | undefined>;
}

export function DirectoryField({
	id,
	locale,
	value,
	disabled,
	onValueChange,
	browseDirectories,
	pickDirectories,
}: DirectoryFieldProps) {
	const parsed = parseDirectories(value);
	const selected = parsed.kind === "directories" ? parsed.paths : [];
	const selectedRef = useRef<readonly string[]>(selected);
	const mounted = useRef(true);
	const operation = useRef(0);
	const browseRevision = useRef(0);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [listing, setListing] = useState<DirectoryListing>();
	const [path, setPath] = useState(selected[0] ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const addRef = useRef<HTMLButtonElement>(null);
	const pathRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		selectedRef.current = selected;
		if (!browserOpen)
			setPath((current) =>
				current.length === 0 ? (selected[0] ?? "") : current,
			);
	}, [browserOpen, selected]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const append = (paths: readonly string[]): void => {
		const next = [...new Set([...selectedRef.current, ...paths])];
		selectedRef.current = next;
		onValueChange(JSON.stringify(next));
	};

	const browse = async (directory?: string): Promise<void> => {
		if (browseDirectories === undefined) {
			setError(translate(locale, "project.folderFailed"));
			return;
		}
		const revision = ++browseRevision.current;
		setError("");
		setBusy(true);
		try {
			const next = await browseDirectories(directory);
			if (!mounted.current || revision !== browseRevision.current) return;
			setListing(next);
			setPath(next.path);
		} catch {
			if (mounted.current && revision === browseRevision.current) {
				setError(translate(locale, "project.folderFailed"));
			}
		} finally {
			if (mounted.current && revision === browseRevision.current)
				setBusy(false);
		}
	};

	const pick = async (): Promise<void> => {
		const revision = ++operation.current;
		setError("");
		setBusy(true);
		try {
			const paths =
				pickDirectories === undefined ? undefined : await pickDirectories();
			if (!mounted.current || revision !== operation.current) return;
			if (paths !== undefined) {
				append(paths);
				return;
			}
			setBrowserOpen(true);
			await browse(listing?.path ?? selectedRef.current[0]);
			if (mounted.current && revision === operation.current) {
				pathRef.current?.focus({ preventScroll: true });
			}
		} catch {
			if (mounted.current && revision === operation.current) {
				setError(translate(locale, "project.folderFailed"));
			}
		} finally {
			if (mounted.current && revision === operation.current) {
				setBusy(false);
				if (!browserOpen) addRef.current?.focus({ preventScroll: true });
			}
		}
	};

	const entries = listing?.entries ?? [];
	return (
		<div
			className={`directory-field${selected.length === 0 ? " empty" : ""}`}
			data-directory-field={id}
		>
			<div className="directory-selections">
				{selected.map((directory, index) => (
					<div key={directory} className="directory-selection">
						<button
							type="button"
							className="directory-primary"
							title={directory}
							aria-label={`${translate(locale, "project.defaultFolder")}: ${directory}`}
							disabled={disabled}
							onClick={() => {
								const next = [
									directory,
									...selected.filter((item) => item !== directory),
								];
								selectedRef.current = next;
								onValueChange(JSON.stringify(next));
								window.requestAnimationFrame(() => {
									document
										.querySelector<HTMLButtonElement>(
											`[data-directory-field="${CSS.escape(id)}"] .directory-primary`,
										)
										?.focus({ preventScroll: true });
								});
							}}
						>
							<Icon name="folder" />
							<span className="directory-text">
								<span>{directoryName(directory)}</span>
								<small>{directory}</small>
							</span>
							{index === 0 && (
								<span className="directory-default">
									{translate(locale, "project.default")}
								</span>
							)}
						</button>
						<button
							type="button"
							className="directory-remove"
							aria-label={`${translate(locale, "project.removeFolder")}: ${directory}`}
							disabled={disabled}
							onClick={() => {
								const next = selected.filter((item) => item !== directory);
								selectedRef.current = next;
								onValueChange(JSON.stringify(next));
								window.requestAnimationFrame(() =>
									addRef.current?.focus({ preventScroll: true }),
								);
							}}
						>
							×
						</button>
					</div>
				))}
			</div>
			<p className="directory-help">
				{translate(locale, "project.folderHint")}
			</p>
			<button
				ref={addRef}
				type="button"
				className="directory-add"
				disabled={disabled || busy}
				onClick={() => void pick()}
			>
				<Icon name="folder" />
				{translate(locale, "project.addFolder")}
			</button>
			<div className="directory-browser" hidden={!browserOpen}>
				<form
					className="directory-navigation"
					onSubmit={(event) => {
						event.preventDefault();
						void browse(path);
					}}
				>
					<input
						ref={pathRef}
						className="directory-path"
						aria-label={translate(locale, "project.directory")}
						value={path}
						disabled={disabled || busy}
						onChange={(event) => setPath(event.currentTarget.value)}
						onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
							if (
								event.key !== "Enter" ||
								event.nativeEvent.isComposing ||
								event.keyCode === 229
							)
								return;
							event.preventDefault();
							event.stopPropagation();
							void browse(path);
						}}
					/>
					<button type="submit" disabled={disabled || busy}>
						{translate(locale, "project.go")}
					</button>
				</form>
				<div className="directory-contents">
					{entries.map((entry) => (
						<button
							key={entry.path}
							type="button"
							className="directory-entry"
							disabled={disabled || busy}
							onClick={() => void browse(entry.path)}
						>
							<Icon name="folder" />
							{entry.name}
						</button>
					))}
				</div>
				<div className="directory-browser-foot">
					<button
						type="button"
						disabled={disabled || busy || listing?.parent == null}
						onClick={() => {
							if (listing?.parent) void browse(listing.parent);
						}}
					>
						{translate(locale, "project.parentFolder")}
					</button>
					<button
						type="button"
						className="directory-choose"
						disabled={disabled || busy || listing === undefined}
						onClick={() => {
							if (listing === undefined) return;
							append([listing.path]);
							setBrowserOpen(false);
							window.requestAnimationFrame(() =>
								addRef.current?.focus({ preventScroll: true }),
							);
						}}
					>
						{translate(locale, "project.chooseFolder")}
					</button>
				</div>
			</div>
			<output
				className="directory-error"
				aria-live="polite"
				style={{ display: "block" }}
			>
				{error}
			</output>
		</div>
	);
}

type ParsedSelection =
	| { readonly kind: "all" }
	| { readonly kind: "selected"; readonly values: ReadonlySet<string> }
	| { readonly kind: "invalid" };

function parseSelection(value: string): ParsedSelection {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null) return { kind: "all" };
		return isStringArray(parsed)
			? { kind: "selected", values: new Set(parsed) }
			: { kind: "invalid" };
	} catch {
		return { kind: "invalid" };
	}
}

export interface MultiselectFieldProps {
	readonly fieldId: string;
	readonly locale: Locale;
	readonly value: string;
	readonly options: readonly {
		readonly value: string;
		readonly label: string;
	}[];
	readonly onValueChange: (value: string) => void;
}

export function MultiselectField({
	fieldId,
	locale,
	value,
	options,
	onValueChange,
}: MultiselectFieldProps) {
	const parsed = parseSelection(value);
	const allValues = options.map((option) => option.value);
	const selected =
		parsed.kind === "all"
			? new Set(allValues)
			: parsed.kind === "selected"
				? new Set(parsed.values)
				: new Set<string>();
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const visible = options.filter(
		(option) =>
			normalizedQuery.length === 0 ||
			`${option.label} ${option.value}`
				.toLocaleLowerCase()
				.includes(normalizedQuery),
	);
	const selectCount = parsed.kind === "all" ? options.length : selected.size;

	const commitSelection = (next: ReadonlySet<string>): void => {
		const all =
			options.length > 0 &&
			options.every((option) => next.has(option.value)) &&
			next.size === options.length;
		onValueChange(JSON.stringify(all ? null : [...next]));
	};

	const setVisible = (enabled: boolean): void => {
		const next = new Set(selected);
		for (const option of visible) {
			if (enabled) next.add(option.value);
			else next.delete(option.value);
		}
		commitSelection(next);
	};

	return (
		<div className="modal-multiselect" data-multiselect={fieldId}>
			<input
				type="search"
				className="modal-input"
				placeholder={translate(locale, "model.search")}
				aria-label={translate(locale, "model.search")}
				value={query}
				onChange={(event) => setQuery(event.currentTarget.value)}
			/>
			<div className="multiselect-controls">
				<button
					type="button"
					className="panel-button weight-line"
					onClick={() => setVisible(true)}
				>
					{translate(
						locale,
						normalizedQuery.length > 0
							? "model.selectMatches"
							: "model.selectAll",
					)}
				</button>
				<button
					type="button"
					className="panel-button weight-line"
					onClick={() => setVisible(false)}
				>
					{translate(
						locale,
						normalizedQuery.length > 0
							? "model.clearMatches"
							: "model.clearAll",
					)}
				</button>
				<span className="multiselect-count">
					{translate(locale, "model.selectedCount", {
						selected: String(selectCount),
						total: String(options.length),
					})}
				</span>
			</div>
			<div className="multiselect-options">
				{options.map((option) => {
					const matches =
						normalizedQuery.length === 0 ||
						`${option.label} ${option.value}`
							.toLocaleLowerCase()
							.includes(normalizedQuery);
					return (
						<label
							key={option.value}
							className="multiselect-option"
							hidden={!matches}
						>
							<input
								type="checkbox"
								value={option.value}
								checked={selected.has(option.value)}
								onChange={(event) => {
									const next = new Set(selected);
									if (event.currentTarget.checked) next.add(option.value);
									else next.delete(option.value);
									commitSelection(next);
								}}
							/>
							<span>{option.label}</span>
						</label>
					);
				})}
			</div>
			<p className="menu-empty" hidden={visible.length > 0}>
				{translate(locale, "model.noMatches")}
			</p>
		</div>
	);
}

export interface PasswordFieldProps {
	readonly id?: string;
	readonly locale: Locale;
	readonly value: string;
	readonly placeholder?: string;
	readonly readOnly?: boolean;
	readonly disabled?: boolean;
	readonly describedBy?: string;
	readonly onChange?: (value: string) => void;
	readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

export function PasswordField({
	id,
	locale,
	value,
	placeholder,
	readOnly,
	disabled,
	describedBy,
	onChange,
	onKeyDown,
}: PasswordFieldProps) {
	const [shown, setShown] = useState(false);
	return (
		<>
			<input
				id={id}
				type={shown ? "text" : "password"}
				className="modal-input"
				value={value}
				placeholder={placeholder}
				readOnly={readOnly}
				disabled={disabled}
				aria-describedby={describedBy}
				autoComplete="off"
				spellCheck={false}
				onChange={
					onChange === undefined
						? undefined
						: (event) => onChange(event.currentTarget.value)
				}
				onKeyDown={onKeyDown}
			/>
			{!readOnly && (
				<button
					type="button"
					className="credential-toggle"
					aria-label={translate(
						locale,
						shown ? "secret.hideAria" : "secret.showAria",
					)}
					aria-pressed={shown}
					onClick={() => setShown((current) => !current)}
				>
					{translate(locale, shown ? "secret.hide" : "secret.show")}
				</button>
			)}
		</>
	);
}

export interface SearchFieldProps {
	readonly id?: string;
	readonly locale: Locale;
	readonly value: string;
	readonly inputRef?: RefObject<HTMLInputElement | null>;
	readonly onChange: (value: string) => void;
	readonly onClear: () => void;
}

export function SearchField({
	id,
	locale,
	value,
	inputRef,
	onChange,
	onClear,
}: SearchFieldProps) {
	return (
		<div className="roster-filter section-search">
			<Icon name="search" className="icon" />
			<input
				id={id}
				ref={inputRef}
				className="roster-filter-input"
				type="search"
				autoComplete="off"
				spellCheck={false}
				placeholder={translate(locale, "panel.settings.search")}
				aria-label={translate(locale, "panel.settings.searchLabel")}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
			<button
				type="button"
				className="section-search-clear"
				aria-label={translate(locale, "panel.settings.searchClear")}
				hidden={value.length === 0}
				onClick={onClear}
			>
				<Icon name="x" />
			</button>
		</div>
	);
}

export function pointerPressedBackdrop(
	event: ReactPointerEvent<HTMLDialogElement>,
	backdropPressed: RefObject<boolean>,
): void {
	backdropPressed.current = event.target === event.currentTarget;
}
