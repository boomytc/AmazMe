import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MODEL_DEFAULTS_ACTION, REFRESH_MODELS_ACTION } from "../actions.ts";
import type { DirectoryListing } from "../directories.ts";
import { errorMessageCopy } from "../errors.ts";
import type { Locale } from "../locale.ts";
import {
	type ConnectionModelLike,
	MODEL_ENABLED_ACTION,
	type ModelConnectionsLike,
	PROVIDER_EDIT_ACTION,
	PROVIDER_SELECT_ACTION,
	PROVIDER_TEST_ACTION,
	verificationStatusText,
} from "../model-connections.ts";
import {
	type PanelAction,
	type PanelButton,
	type PanelField,
	type PanelGroup,
	type PanelInput as PanelInputModel,
	type PanelModal,
	type PanelNotice,
	type PanelPending,
	type PanelRow,
	type PanelSpec,
	type PanelText,
	type PanelView,
	SETTINGS_FIELD_ACTION,
	SETTINGS_VIEW,
	type SettingsSearchHit,
	searchSettings,
} from "../panels.ts";
import { type MessageKey, translate } from "../strings.ts";
import {
	DEFAULT_TYPOGRAPHY,
	FONT_FAMILY_FIELDS,
	FONT_SIZE_FIELDS,
	resolveTypography,
	type Typography,
} from "../typography.ts";
import { PanelTextReader, type ReadingState } from "./dock.tsx";
import {
	type ControlEdits,
	controlKey,
	DirectoryField,
	Icon,
	MultiselectField,
	PanelBadge,
	PanelButtonView,
	PanelControlView,
	PanelRowMenu,
	PasswordField,
	pointerPressedBackdrop,
	SearchField,
	SensitiveText,
	sameActionTarget,
	type UpdateControlEdit,
} from "./management-fields.tsx";

const TYPOGRAPHY_FIELDS: ReadonlySet<string> = new Set([
	...FONT_FAMILY_FIELDS,
	...FONT_SIZE_FIELDS,
]);

export interface ManagementProps {
	readonly view: PanelView;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
	/** The existing model-connections projection; it owns the settings:models workspace. */
	readonly modelConnections?: ModelConnectionsLike;
	/** Supplied only for the live typography preview. */
	readonly typography?: Typography;
	readonly browseDirectories?: (path?: string) => Promise<DirectoryListing>;
	readonly pickDirectories?: () => Promise<readonly string[] | undefined>;
}

export interface ManagementModalProps {
	readonly modal: PanelModal | undefined;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
	readonly browseDirectories?: (path?: string) => Promise<DirectoryListing>;
	readonly pickDirectories?: () => Promise<readonly string[] | undefined>;
}

function orderedGroups(panel: PanelSpec): readonly PanelGroup[] {
	if (panel.id !== SETTINGS_VIEW) return panel.groups;
	return [
		...panel.groups.filter((group) => group.id === "settings:interface"),
		...panel.groups.filter((group) => group.id !== "settings:interface"),
	];
}

function searchHitKey(hit: SettingsSearchHit, index: number): string {
	return `${index}\u0000${hit.groupId}\u0000${hit.rowId ?? ""}`;
}

export interface ManagementNavigationProps {
	readonly panel: PanelSpec;
	readonly locale: Locale;
	readonly groups: readonly PanelGroup[];
	readonly selectedGroupId: string;
	readonly query: string;
	readonly searchHits: readonly SettingsSearchHit[];
	readonly activeSearchIndex: number;
	readonly searchInputRef: RefObject<HTMLInputElement | null>;
	readonly onQueryChange: (value: string) => void;
	readonly onClearSearch: () => void;
	readonly onSelectGroup: (groupId: string) => void;
	readonly onSelectHit: (hit: SettingsSearchHit, index: number) => void;
}

/**
 * The category/search column. It is controlled so Management can keep the reader's query and
 * selection while a connection token or session update republishes the view.
 */
export function ManagementNavigation({
	locale,
	groups,
	selectedGroupId,
	query,
	searchHits,
	activeSearchIndex,
	searchInputRef,
	onQueryChange,
	onClearSearch,
	onSelectGroup,
	onSelectHit,
}: ManagementNavigationProps) {
	const searching = query.trim().length > 0;
	return (
		<aside className="library-nav">
			<SearchField
				id="management-section-search"
				locale={locale}
				value={query}
				inputRef={searchInputRef}
				onChange={onQueryChange}
				onClear={onClearSearch}
			/>
			<nav
				className="section-nav"
				aria-label={translate(locale, "nav.settings")}
				onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
					if (
						event.key !== "Escape" ||
						query.length === 0 ||
						event.nativeEvent.isComposing
					)
						return;
					event.preventDefault();
					onClearSearch();
					searchInputRef.current?.focus({ preventScroll: true });
				}}
			>
				{searching && searchHits.length === 0 && (
					<p className="empty-state">
						{translate(locale, "panel.settings.searchEmpty")}
					</p>
				)}
				{searching &&
					searchHits.map((hit, index) => {
						const stacked =
							hit.rowId !== undefined && hit.label !== hit.panelLabel;
						return (
							<button
								key={searchHitKey(hit, index)}
								type="button"
								className={stacked ? "nav-row nav-row-stack" : "nav-row"}
								aria-label={
									stacked
										? translate(locale, "panel.settings.searchResult", {
												destination: hit.label,
												panel: hit.panelLabel,
											})
										: hit.label
								}
								aria-current={index === activeSearchIndex ? "true" : undefined}
								onClick={() => onSelectHit(hit, index)}
							>
								<span className="nav-label">{hit.label}</span>
								{stacked && (
									<span className="nav-detail">{hit.panelLabel}</span>
								)}
							</button>
						);
					})}
				{!searching &&
					groups.map((group) => {
						const selected = group.id === selectedGroupId;
						return (
							<button
								key={group.id}
								type="button"
								className={selected ? "nav-row active" : "nav-row"}
								aria-current={selected ? "true" : undefined}
								onClick={() => onSelectGroup(group.id)}
							>
								<span className="nav-label">{group.title}</span>
							</button>
						);
					})}
			</nav>
		</aside>
	);
}

interface PanelNoticesProps {
	readonly scope: string;
	readonly locale: Locale;
	readonly notices: readonly PanelNotice[];
}

function noticeKey(scope: string, notice: PanelNotice): string {
	return `${scope}\u0000${notice.tone}\u0000${notice.text}`;
}

function PanelNotices({ scope, locale, notices }: PanelNoticesProps) {
	const [expired, setExpired] = useState<ReadonlySet<string>>(new Set());
	const timers = useRef(new Map<string, number>());

	useEffect(() => {
		const live = new Set(notices.map((notice) => noticeKey(scope, notice)));
		setExpired((current) => {
			const next = new Set([...current].filter((key) => live.has(key)));
			return next.size === current.size &&
				[...next].every((key) => current.has(key))
				? current
				: next;
		});
		for (const notice of notices) {
			const key = noticeKey(scope, notice);
			const persistence =
				notice.persistence ?? (notice.tone === "info" ? "transient" : "pinned");
			if (persistence !== "transient" || timers.current.has(key)) continue;
			const timer = window.setTimeout(() => {
				timers.current.delete(key);
				setExpired((current) => new Set([...current, key]));
			}, 2400);
			timers.current.set(key, timer);
		}
		for (const [key, timer] of timers.current) {
			if (!key.startsWith(`${scope}\u0000`) || live.has(key)) continue;
			window.clearTimeout(timer);
			timers.current.delete(key);
		}
	}, [notices, scope]);

	useEffect(
		() => () => {
			for (const timer of timers.current.values()) window.clearTimeout(timer);
			timers.current.clear();
		},
		[],
	);

	return (
		<>
			{notices
				.filter((notice) => !expired.has(noticeKey(scope, notice)))
				.map((notice) => {
					const text =
						notice.tone === "error"
							? errorMessageCopy(locale, notice.text)
							: notice.text;
					const classes = [
						"panel-notice",
						notice.tone,
						...(notice.verification === undefined
							? []
							: ["connection-verification", notice.verification]),
					].join(" ");
					return (
						<p
							key={noticeKey(scope, notice)}
							className={classes}
							role={notice.tone === "error" ? "alert" : "status"}
						>
							<SensitiveText text={text} locale={locale} />
						</p>
					);
				})}
		</>
	);
}

function PanelHead({
	panel,
	locale,
	onAction,
}: {
	readonly panel: PanelSpec;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
}) {
	return (
		<header className="panel-head">
			<div className="panel-titles">
				<h1 className="panel-title">
					<SensitiveText text={panel.title} locale={locale} />
				</h1>
				{panel.description !== undefined && (
					<p className="panel-desc">
						<SensitiveText text={panel.description} locale={locale} />
					</p>
				)}
			</div>
			{panel.actions !== undefined && panel.actions.length > 0 && (
				<div className="panel-actions">
					{panel.actions.map((action) => (
						<PanelButtonView
							key={`${action.id}\u0000${action.data ?? ""}`}
							action={action}
							pending={panel.pending}
							onAction={onAction}
						/>
					))}
				</div>
			)}
		</header>
	);
}

interface PanelRowViewProps {
	readonly panelId: string;
	readonly locale: Locale;
	readonly row: PanelRow;
	readonly skeleton: PanelGroup["skeleton"];
	readonly pending: PanelPending | undefined;
	readonly hasError: boolean;
	readonly edits: ControlEdits;
	readonly updateEdit: UpdateControlEdit;
	readonly located: boolean;
	readonly onAction: (action: PanelAction) => void;
}

function isRecordPath(value: string | undefined): value is string {
	return (
		value !== undefined &&
		!value.includes(" · ") &&
		(value.startsWith("/") ||
			value.startsWith("\\") ||
			value.startsWith("~") ||
			/^[A-Za-z]:[\\/]/u.test(value))
	);
}

function PanelRowView({
	panelId,
	locale,
	row,
	skeleton,
	pending,
	hasError,
	edits,
	updateEdit,
	located,
	onAction,
}: PanelRowViewProps) {
	if (row.file !== undefined) {
		const action = row.file.action;
		const isPending = sameActionTarget(pending, action);
		return (
			<button
				type="button"
				className={`file-entry file-entry-${row.file.kind}`}
				data-row-id={row.id}
				data-file-name={row.title}
				data-control-key={`file:${action.data ?? row.id}`}
				title={action.data ?? row.title}
				aria-label={`${action.label}: ${row.title}`}
				aria-busy={isPending || undefined}
				disabled={action.disabled === true || isPending}
				onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
					if (
						event.nativeEvent.isComposing ||
						!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
					)
						return;
					const controls = [
						...(event.currentTarget
							.closest(".panel-rows")
							?.querySelectorAll<HTMLButtonElement>(
								".file-entry:not(:disabled):not([hidden])",
							) ?? []),
					];
					const current = controls.indexOf(event.currentTarget);
					if (current < 0) return;
					event.preventDefault();
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? controls.length - 1
								: Math.max(
										0,
										Math.min(
											controls.length - 1,
											current + (event.key === "ArrowUp" ? -1 : 1),
										),
									);
					controls[next]?.focus();
				}}
				onClick={() =>
					onAction({
						kind: "command",
						id: action.id,
						data: action.data,
					})
				}
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
				{row.value !== undefined && (
					<span className="file-entry-size">{row.value}</span>
				)}
				{row.file.kind === "dir" && (
					<Icon name="chevron-down" className="icon file-entry-chevron" />
				)}
			</button>
		);
	}

	const records = skeleton === "records";
	const path = records && isRecordPath(row.value) ? row.value : undefined;
	const hasStatus =
		records &&
		((row.badges?.length ?? 0) > 0 ||
			(row.value !== undefined && path === undefined));
	return (
		<div
			className={`${records ? "panel-row record-row" : "panel-row"}${located ? " panel-row-located" : ""}`}
			data-row-id={row.id}
			data-review-open={row.detail === undefined ? undefined : row.id}
		>
			<div className="panel-row-text">
				<div className="panel-row-head">
					<span className="panel-row-title">
						<SensitiveText text={row.title} locale={locale} />
					</span>
					{!records &&
						row.badges?.map((badge, index) => (
							<PanelBadge
								key={
									typeof badge === "string"
										? `${badge}\u0000${index}`
										: `delta\u0000${badge.added}\u0000${badge.removed}\u0000${index}`
								}
								badge={badge}
								locale={locale}
							/>
						))}
				</div>
				{row.description !== undefined && (
					<p className="panel-row-desc">
						<SensitiveText text={row.description} locale={locale} />
					</p>
				)}
				{path !== undefined ? (
					<code className="record-path">
						<SensitiveText text={path} locale={locale} />
					</code>
				) : !records && row.value !== undefined ? (
					<code className="panel-row-value">
						<SensitiveText text={row.value} locale={locale} />
					</code>
				) : null}
			</div>
			{hasStatus && (
				<div className="record-status">
					{row.badges?.map((badge, index) => (
						<PanelBadge
							key={
								typeof badge === "string"
									? `${badge}\u0000${index}`
									: `delta\u0000${badge.added}\u0000${badge.removed}\u0000${index}`
							}
							badge={badge}
							locale={locale}
						/>
					))}
					{row.value !== undefined && path === undefined && (
						<span className="record-value">
							<SensitiveText text={row.value} locale={locale} />
						</span>
					)}
				</div>
			)}
			{row.controls !== undefined && row.controls.length > 0 && (
				<div className="panel-controls">
					{row.controls.map((control) => (
						<PanelControlView
							key={`${control.id}\u0000${control.data ?? ""}`}
							panelId={panelId}
							row={row}
							control={control}
							locale={locale}
							pending={pending}
							hasError={hasError}
							edits={edits}
							updateEdit={updateEdit}
							onAction={onAction}
						/>
					))}
				</div>
			)}
			{((row.actions?.length ?? 0) > 0 || row.menu !== undefined) && (
				<div className="panel-actions">
					{row.actions?.map((action) => (
						<PanelButtonView
							key={`${action.id}\u0000${action.data ?? ""}`}
							action={action}
							pending={pending}
							onAction={onAction}
						/>
					))}
					{row.menu !== undefined && (
						<PanelRowMenu
							menu={row.menu}
							rowTitle={row.title}
							pending={pending}
							onAction={onAction}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function PanelTextBlock({
	reading,
	text,
	scope,
	locale,
	reviewDetail = false,
}: {
	readonly text: PanelText;
	readonly scope: string;
	readonly locale: Locale;
	readonly reviewDetail?: boolean;
	readonly reading: ReadingState;
}) {
	return (
		<PanelTextReader
			reading={reading}
			text={text}
			scope={scope}
			locale={locale}
			className={reviewDetail ? "review-detail" : undefined}
			renderText={(value) => <SensitiveText text={value} locale={locale} />}
		/>
	);
}

function typographyControlValues(
	group: PanelGroup,
	panelId: string,
	edits: ControlEdits,
	base: Typography,
): Typography {
	const values: Record<string, unknown> = { ...base };
	for (const row of group.rows) {
		for (const control of row.controls ?? []) {
			if (
				control.id !== SETTINGS_FIELD_ACTION ||
				control.data === undefined ||
				!TYPOGRAPHY_FIELDS.has(control.data)
			)
				continue;
			const value =
				edits[controlKey(panelId, row.id, control)]?.value ?? control.value;
			values[control.data] = control.data.endsWith("Size")
				? Number(value)
				: value;
		}
	}
	return resolveTypography(values);
}

function TypographyPreview({
	group,
	panelId,
	locale,
	edits,
	typography,
}: {
	readonly group: PanelGroup;
	readonly panelId: string;
	readonly locale: Locale;
	readonly edits: ControlEdits;
	readonly typography: Typography;
}) {
	const values = typographyControlValues(group, panelId, edits, typography);
	const family = (value: string, fallback: string): string =>
		value.length === 0 ? `var(${fallback})` : `${value}, var(${fallback})`;
	return (
		<section
			className="typography-preview"
			aria-label={translate(locale, "panel.settings.fontPreviewTitle")}
		>
			<p className="typography-preview-title">
				{translate(locale, "panel.settings.fontPreviewTitle")}
			</p>
			<p
				className="typography-preview-item preview-text"
				style={{
					fontFamily: family(values.textFont, "--font-sans"),
					fontSize: values.textSize,
				}}
			>
				{translate(locale, "panel.settings.fontPreviewText")}
			</p>
			<pre
				className="typography-preview-item preview-code"
				style={{
					fontFamily: family(values.codeFont, "--font-mono"),
					fontSize: values.codeSize,
				}}
			>
				<code>{translate(locale, "panel.settings.fontPreviewCode")}</code>
			</pre>
			<pre
				className="typography-preview-item preview-terminal"
				style={{
					fontFamily: family(values.terminalFont, "--font-mono"),
					fontSize: values.terminalSize,
				}}
			>
				<code>{translate(locale, "panel.settings.fontPreviewTerminal")}</code>
			</pre>
		</section>
	);
}

function groupHasTypographyControls(group: PanelGroup): boolean {
	return group.rows.some((row) =>
		(row.controls ?? []).some(
			(control) =>
				control.id === SETTINGS_FIELD_ACTION &&
				control.data !== undefined &&
				TYPOGRAPHY_FIELDS.has(control.data),
		),
	);
}

interface PanelGroupViewProps {
	readonly reading: ReadingState;
	readonly panelId: string;
	readonly locale: Locale;
	readonly group: PanelGroup;
	readonly pending: PanelPending | undefined;
	readonly hasError: boolean;
	readonly edits: ControlEdits;
	readonly updateEdit: UpdateControlEdit;
	readonly typography: Typography;
	readonly hideHeading: boolean;
	readonly locatedRowId?: string;
	readonly onAction: (action: PanelAction) => void;
}

function PanelGroupView({
	reading,
	panelId,
	locale,
	group,
	pending,
	hasError,
	edits,
	updateEdit,
	typography,
	hideHeading,
	locatedRowId,
	onAction,
}: PanelGroupViewProps) {
	const showActions = group.actions !== undefined && group.actions.length > 0;
	return (
		<section
			className="panel-group"
			data-group-id={group.id}
			data-skeleton={group.skeleton}
		>
			{(!hideHeading || showActions) && (
				<header className="panel-group-head">
					{!hideHeading && (
						<div className="panel-group-titles">
							{group.title.length > 0 && (
								<h2 className="panel-group-title">{group.title}</h2>
							)}
							{group.description !== undefined && (
								<p className="panel-group-desc">
									<SensitiveText text={group.description} locale={locale} />
								</p>
							)}
						</div>
					)}
					{showActions && (
						<div className="panel-actions">
							{group.actions?.map((action) => (
								<PanelButtonView
									key={`${action.id}\u0000${action.data ?? ""}`}
									action={action}
									pending={pending}
									onAction={onAction}
								/>
							))}
						</div>
					)}
				</header>
			)}
			{group.lead !== undefined && (
				<div className="panel-lead">
					<div>
						<p className="panel-lead-title">{group.lead.title}</p>
						{group.lead.description !== undefined && (
							<p className="panel-lead-desc">
								<SensitiveText text={group.lead.description} locale={locale} />
							</p>
						)}
					</div>
					<div className="panel-actions">
						{group.lead.actions.map((action) => (
							<PanelButtonView
								key={`${action.id}\u0000${action.data ?? ""}`}
								action={action}
								pending={pending}
								onAction={onAction}
							/>
						))}
					</div>
				</div>
			)}
			<div
				className={
					group.id === "files:entries" ||
					group.rows.some((row) => row.file !== undefined)
						? "panel-rows file-entries"
						: "panel-rows"
				}
			>
				{group.rows.length === 0 && group.empty !== undefined ? (
					<p className="panel-empty" data-cause={group.empty.cause}>
						{group.empty.text}
					</p>
				) : (
					group.rows.map((row) => (
						<Fragment key={row.id}>
							<PanelRowView
								panelId={panelId}
								locale={locale}
								row={row}
								skeleton={group.skeleton}
								pending={pending}
								hasError={hasError}
								edits={edits}
								updateEdit={updateEdit}
								located={row.id === locatedRowId}
								onAction={onAction}
							/>
							{row.detail !== undefined && (
								<PanelTextBlock
									reading={reading}
									text={row.detail}
									scope={panelId}
									locale={locale}
									reviewDetail
								/>
							)}
						</Fragment>
					))
				)}
			</div>
			{groupHasTypographyControls(group) && (
				<TypographyPreview
					group={group}
					panelId={panelId}
					locale={locale}
					edits={edits}
					typography={typography}
				/>
			)}
			{group.footnote !== undefined && (
				<p className="panel-footnote">
					<SensitiveText text={group.footnote} locale={locale} />
				</p>
			)}
		</section>
	);
}

function PanelInputView({
	input,
	locale,
	pending,
	onAction,
}: {
	readonly input: PanelInputModel;
	readonly locale: Locale;
	readonly pending: PanelPending | undefined;
	readonly onAction: (action: PanelAction) => void;
}) {
	const [value, setValue] = useState(input.value);
	const [dirty, setDirty] = useState(false);
	const isPending = sameActionTarget(pending, input.submit);
	useEffect(() => {
		if (!dirty) setValue(input.value);
		else if (value === input.value) setDirty(false);
	}, [dirty, input.value, value]);
	const submit = (): void => {
		if (input.submit.disabled === true || isPending) return;
		onAction({ kind: "command", id: input.submit.id, data: value });
	};
	return (
		<form
			className="panel-input-row"
			data-input-row={input.id}
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<input
				type="text"
				className="panel-input panel-input-wide"
				placeholder={input.placeholder}
				aria-label={input.placeholder}
				value={value}
				autoComplete="off"
				spellCheck={false}
				onChange={(event) => {
					setDirty(true);
					setValue(event.currentTarget.value);
				}}
			/>
			<button
				type="submit"
				className={`panel-button weight-${input.submit.weight}${input.submit.danger === true ? " is-danger" : ""}${isPending ? " pending" : ""}`}
				disabled={input.submit.disabled === true || isPending}
				aria-busy={isPending || undefined}
			>
				{input.submit.label || translate(locale, "modal.add")}
			</button>
		</form>
	);
}

interface PanelSurfaceProps {
	readonly reading: ReadingState;
	readonly panel: PanelSpec;
	readonly groups: readonly PanelGroup[];
	readonly locale: Locale;
	readonly modelConnections?: ModelConnectionsLike;
	readonly typography: Typography;
	readonly edits: ControlEdits;
	readonly updateEdit: UpdateControlEdit;
	readonly hideGroupHeading: boolean;
	readonly locatedRowId?: string;
	readonly onAction: (action: PanelAction) => void;
}

function PanelSurface({
	reading,
	panel,
	groups,
	locale,
	modelConnections,
	typography,
	edits,
	updateEdit,
	hideGroupHeading,
	locatedRowId,
	onAction,
}: PanelSurfaceProps) {
	const hasError = panel.notices.some((notice) => notice.tone === "error");
	const special =
		groups.length === 1 &&
		groups[0]?.id === "settings:models" &&
		modelConnections !== undefined;
	if (special && modelConnections !== undefined) {
		return (
			<ModelConnectionsView
				panel={panel}
				connections={modelConnections}
				locale={locale}
				onAction={onAction}
			/>
		);
	}
	return (
		<div className="panel" data-panel-id={panel.id}>
			<PanelHead panel={panel} locale={locale} onAction={onAction} />
			<PanelNotices scope={panel.id} locale={locale} notices={panel.notices} />
			{panel.inputs?.map((input) => (
				<PanelInputView
					key={input.id}
					input={input}
					locale={locale}
					pending={panel.pending}
					onAction={onAction}
				/>
			))}
			{groups.map((group) => (
				<PanelGroupView
					reading={reading}
					key={group.id}
					panelId={panel.id}
					locale={locale}
					group={group}
					pending={panel.pending}
					hasError={hasError}
					edits={edits}
					updateEdit={updateEdit}
					typography={typography}
					hideHeading={hideGroupHeading}
					locatedRowId={locatedRowId}
					onAction={onAction}
				/>
			))}
			{panel.texts?.map((text) => (
				<PanelTextBlock
					reading={reading}
					key={text.id}
					text={text}
					scope={panel.id}
					locale={locale}
				/>
			))}
		</div>
	);
}

interface ManagementPanelProps {
	readonly reading: ReadingState;
	readonly view: PanelView;
	readonly panel: PanelSpec;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
	readonly modelConnections?: ModelConnectionsLike;
	readonly typography: Typography;
}

function ManagementPanel({
	reading,
	view,
	panel,
	locale,
	onAction,
	modelConnections,
	typography,
}: ManagementPanelProps) {
	const groups = orderedGroups(panel);
	const requestedSettings =
		panel.id === SETTINGS_VIEW ? view.settingsSection : undefined;
	const requestedGroup =
		requestedSettings === undefined
			? undefined
			: groups.find((group) => group.id === requestedSettings.id);
	const [selectedGroupId, setSelectedGroupId] = useState(
		requestedGroup?.id ?? groups[0]?.id ?? "",
	);
	const [query, setQuery] = useState("");
	const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
	const [located, setLocated] = useState<{
		readonly groupId: string;
		readonly rowId: string;
	}>();
	const [controlEdits, setControlEdits] = useState<ControlEdits>({});
	const previousPanel = useRef(panel.id);
	const appliedSettingsGeneration = useRef(
		requestedGroup === undefined ? undefined : requestedSettings?.generation,
	);
	const rootRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const updateControlEdit = useCallback<UpdateControlEdit>((key, update) => {
		setControlEdits((current) => {
			const previous = current[key];
			const next = update(previous);
			if (previous === next) return current;
			return { ...current, [key]: next };
		});
	}, []);

	useEffect(() => {
		if (requestedSettings === undefined || requestedGroup === undefined) return;
		if (appliedSettingsGeneration.current === requestedSettings.generation)
			return;
		appliedSettingsGeneration.current = requestedSettings.generation;
		setSelectedGroupId(requestedGroup.id);
		setQuery("");
		setActiveSearchIndex(-1);
		setLocated(undefined);
		const scroller = rootRef.current?.parentElement;
		if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
	}, [requestedGroup, requestedSettings]);

	useEffect(() => {
		if (previousPanel.current !== panel.id) {
			previousPanel.current = panel.id;
			setSelectedGroupId(requestedGroup?.id ?? groups[0]?.id ?? "");
			setQuery("");
			setActiveSearchIndex(-1);
			setLocated(undefined);
			appliedSettingsGeneration.current =
				requestedGroup === undefined
					? undefined
					: requestedSettings?.generation;
			return;
		}
		if (!groups.some((group) => group.id === selectedGroupId)) {
			setSelectedGroupId(groups[0]?.id ?? "");
		}
	}, [
		groups,
		panel.id,
		requestedGroup,
		requestedSettings?.generation,
		selectedGroupId,
	]);

	useEffect(() => {
		if (panel.id !== SETTINGS_VIEW) return;
		const timer = window.requestAnimationFrame(() => {
			searchInputRef.current?.focus({ preventScroll: true });
		});
		return () => window.cancelAnimationFrame(timer);
	}, [panel.id]);

	useEffect(() => {
		if (panel.id !== SETTINGS_VIEW) return;
		const onFind = (event: KeyboardEvent): void => {
			if (
				event.code !== "KeyF" ||
				(!event.metaKey && !event.ctrlKey) ||
				event.altKey ||
				event.shiftKey ||
				document.querySelector("dialog[open]") !== null
			)
				return;
			event.preventDefault();
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		};
		document.addEventListener("keydown", onFind);
		return () => document.removeEventListener("keydown", onFind);
	}, [panel.id]);

	const searchHits = useMemo(
		() => (panel.id === SETTINGS_VIEW ? searchSettings(groups, query) : []),
		[groups, panel.id, query],
	);
	const selectedGroup =
		groups.find((group) => group.id === selectedGroupId) ?? groups[0];
	const visibleGroups =
		panel.id === SETTINGS_VIEW
			? selectedGroup === undefined
				? []
				: [selectedGroup]
			: groups;

	useEffect(() => {
		if (located === undefined || selectedGroup?.id !== located.groupId) return;
		const frame = window.requestAnimationFrame(() => {
			const row = rootRef.current?.querySelector<HTMLElement>(
				`[data-row-id="${CSS.escape(located.rowId)}"]`,
			);
			row?.scrollIntoView({ block: "nearest" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [located, selectedGroup]);

	const selectGroup = (groupId: string): void => {
		setSelectedGroupId(groupId);
		setActiveSearchIndex(-1);
		setLocated(undefined);
		const scroller = rootRef.current?.parentElement;
		if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
	};

	const selectHit = (hit: SettingsSearchHit, index: number): void => {
		setSelectedGroupId(hit.groupId);
		setActiveSearchIndex(index);
		setLocated(
			hit.rowId === undefined
				? undefined
				: { groupId: hit.groupId, rowId: hit.rowId },
		);
	};

	return (
		<div
			ref={rootRef}
			className="library-frame"
			data-management-current={view.current}
		>
			{panel.id === SETTINGS_VIEW && (
				<ManagementNavigation
					panel={panel}
					locale={locale}
					groups={groups}
					selectedGroupId={selectedGroup?.id ?? ""}
					query={query}
					searchHits={searchHits}
					activeSearchIndex={activeSearchIndex}
					searchInputRef={searchInputRef}
					onQueryChange={(value) => {
						setQuery(value);
						setActiveSearchIndex(-1);
						setLocated(undefined);
					}}
					onClearSearch={() => {
						setQuery("");
						setActiveSearchIndex(-1);
						setLocated(undefined);
					}}
					onSelectGroup={selectGroup}
					onSelectHit={selectHit}
				/>
			)}
			<div className="view-body">
				<PanelSurface
					reading={reading}
					panel={panel}
					groups={visibleGroups}
					locale={locale}
					modelConnections={modelConnections}
					typography={typography}
					edits={controlEdits}
					updateEdit={updateControlEdit}
					hideGroupHeading={panel.id === SETTINGS_VIEW}
					locatedRowId={located?.rowId}
					onAction={onAction}
				/>
			</div>
		</div>
	);
}

export function Management({
	view,
	locale,
	onAction,
	modelConnections,
	typography = DEFAULT_TYPOGRAPHY,
}: ManagementProps) {
	const reading = useRef<ReadingState>({
		wrap: new Map(),
		expanded: new Map(),
		sourcePositions: new Map(),
	}).current;
	const panel = view.panel;
	if (panel === undefined) return null;
	return (
		<ManagementPanel
			reading={reading}
			view={view}
			panel={panel}
			locale={locale}
			onAction={onAction}
			modelConnections={modelConnections}
			typography={typography}
		/>
	);
}

const EDITABLE_MODEL_APIS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

function connectionCopy(
	locale: Locale,
	key: MessageKey,
	values?: Readonly<Record<string, string>>,
): string {
	return translate(
		locale,
		key,
		values === undefined ? undefined : { ...values },
	);
}

function connectionModelReference(
	model: Pick<ConnectionModelLike, "provider" | "modelId">,
): string {
	return JSON.stringify([model.provider, model.modelId]);
}

function ModelConnectionsView({
	panel,
	connections,
	locale,
	onAction,
}: {
	readonly panel: PanelSpec;
	readonly connections: ModelConnectionsLike;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
}) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const configured = connections.state.providers.filter(
		(provider) => provider.configured,
	);
	const visible = configured.filter(
		(provider) =>
			normalizedQuery.length === 0 ||
			`${provider.name} ${provider.id}`
				.toLocaleLowerCase()
				.includes(normalizedQuery),
	);
	const addable = connections.state.providers.some(
		(provider) =>
			!provider.configured &&
			(connections.state.authentication.providers.find(
				(auth) => auth.id === provider.id,
			)?.methods.length ?? 0) > 0,
	);
	const addAction: PanelButton = {
		id: PROVIDER_EDIT_ACTION,
		label: connectionCopy(locale, "connections.add"),
		weight: "line",
		disabled: connections.disabled || !addable,
	};
	const refreshAction: PanelButton = {
		id: REFRESH_MODELS_ACTION,
		label: connectionCopy(locale, "connections.refresh"),
		weight: "line",
		disabled:
			connections.disabled || connections.state.refresh.status === "refreshing",
	};
	const notices: PanelNotice[] = [
		...panel.notices,
		...(connections.state.error === null
			? []
			: [
					{
						tone: "error" as const,
						text: connectionCopy(
							locale,
							connections.state.error === "synchronization"
								? "connections.syncError"
								: "connections.configError",
						),
					},
				]),
		...(connections.state.refresh.status === "warning"
			? [
					{
						tone: "warning" as const,
						text: connectionCopy(locale, "model.refreshWarning", {
							providers: Object.keys(
								connections.state.refresh.errors ?? {},
							).join(", "),
						}),
					},
				]
			: []),
	];

	const defaultModel = connections.state.defaults?.model;
	const defaultReference =
		defaultModel === undefined ? "" : connectionModelReference(defaultModel);
	const options: ConnectionModelLike[] = [...connections.enabledModels];
	if (
		defaultModel !== undefined &&
		!options.some(
			(model) =>
				model.provider === defaultModel.provider &&
				model.modelId === defaultModel.modelId,
		)
	) {
		options.unshift({
			...defaultModel,
			name: `${defaultModel.provider}/${defaultModel.modelId}`,
			available: false,
		});
	}
	const providerNames = new Map(
		connections.state.providers.map((provider) => [provider.id, provider.name]),
	);
	const modelGroups = new Map<string, ConnectionModelLike[]>();
	for (const model of options) {
		const models = modelGroups.get(model.provider) ?? [];
		if (!modelGroups.has(model.provider))
			modelGroups.set(model.provider, models);
		models.push(model);
	}
	const provider = connections.state.providers.find(
		(item) => item.id === connections.selected,
	);
	const authentication =
		provider === undefined
			? undefined
			: connections.state.authentication.providers.find(
					(item) => item.id === provider.id,
				);
	const canConfigure =
		provider !== undefined &&
		(EDITABLE_MODEL_APIS.has(provider.api) ||
			(authentication?.methods.length ?? 0) > 0);
	const enabled = (model: ConnectionModelLike): boolean =>
		connections.state.enabledModelIds === null ||
		connections.state.enabledModelIds.includes(
			`${model.provider}/${model.modelId}`,
		);
	const enabledCount = connections.models.filter(enabled).length;

	return (
		<div
			className="panel model-connections split-workspace"
			data-panel-id={panel.id}
		>
			<PanelHead panel={panel} locale={locale} onAction={onAction} />
			<PanelNotices
				scope={`${panel.id}:connections`}
				locale={locale}
				notices={notices}
			/>
			<div className="connection-overview">
				<span className="connection-default-text">
					{connectionCopy(locale, "connections.defaultLabel")}
				</span>
				<div className="connection-default-controls">
					<select
						className="panel-select connection-default-select"
						aria-label={connectionCopy(locale, "connections.defaultLabel")}
						value={defaultReference}
						disabled={connections.disabled || options.length === 0}
						onChange={(event) => {
							if (event.currentTarget.value.length === 0) return;
							onAction({
								kind: "command",
								id: MODEL_DEFAULTS_ACTION,
								data: event.currentTarget.value,
							});
						}}
					>
						{defaultReference.length === 0 && (
							<option value="" disabled>
								{connectionCopy(
									locale,
									options.length > 0
										? "connections.chooseDefault"
										: configured.length > 0
											? "connections.noEnabledModels"
											: "connections.noDefault",
								)}
							</option>
						)}
						{[...modelGroups].map(([providerId, models]) => (
							<optgroup
								key={providerId}
								label={providerNames.get(providerId) ?? providerId}
							>
								{models.map((model) => (
									<option
										key={connectionModelReference(model)}
										value={connectionModelReference(model)}
										disabled={!model.available}
									>
										{model.available
											? model.name
											: connectionCopy(
													locale,
													"connections.defaultUnavailable",
													{
														model: model.name,
													},
												)}
									</option>
								))}
							</optgroup>
						))}
					</select>
					<PanelButtonView
						action={refreshAction}
						pending={panel.pending}
						onAction={onAction}
					/>
				</div>
			</div>
			<div className="connection-workspace">
				<aside className="connection-rail">
					<div className="connection-rail-head">
						<search className="connection-search">
							<input
								type="search"
								className="connection-search-input"
								autoComplete="off"
								spellCheck={false}
								placeholder={connectionCopy(locale, "connections.search")}
								aria-label={connectionCopy(locale, "connections.search")}
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</search>
						<PanelButtonView
							action={addAction}
							pending={panel.pending}
							onAction={onAction}
						/>
					</div>
					<div className="connection-list">
						{visible.map((item) => {
							const selected = item.id === connections.selected;
							return (
								<button
									key={item.id}
									type="button"
									className={
										selected ? "connection-row selected" : "connection-row"
									}
									aria-pressed={selected}
									disabled={connections.disabled}
									onClick={() =>
										onAction({
											kind: "command",
											id: PROVIDER_SELECT_ACTION,
											data: item.id,
										})
									}
								>
									<span className="connection-row-top">
										<span className="connection-row-name">{item.name}</span>
										<span
											className="connection-status-dot configured"
											aria-hidden="true"
										/>
									</span>
									<small className="connection-row-meta">
										<span className="connection-row-state">
											{connectionCopy(
												locale,
												item.available
													? "connections.configured"
													: "connections.loginRequired",
											)}
										</span>
										<span className="connection-row-sep" aria-hidden="true">
											{" "}
											·{" "}
										</span>
										<span className="connection-row-count">
											{item.modelCount}
										</span>
									</small>
								</button>
							);
						})}
						{visible.length === 0 && (
							<p className="connection-empty">
								{connectionCopy(
									locale,
									configured.length === 0
										? "connections.empty"
										: "connections.noMatch",
								)}
							</p>
						)}
					</div>
				</aside>
				<div className="connection-detail">
					{provider === undefined ? (
						<p className="connection-empty connection-choose">
							{connectionCopy(locale, "connections.choose")}
						</p>
					) : (
						<>
							<section className="connection-provider">
								<header className="connection-provider-head">
									<div className="connection-provider-titles">
										<div className="connection-provider-title-row">
											<h2 className="connection-provider-name">
												{provider.name}
											</h2>
											<span
												className={`panel-badge connection-badge ${provider.available ? "configured" : "unconfigured"}`}
											>
												{connectionCopy(
													locale,
													!provider.configured
														? "connections.unconfigured"
														: provider.available
															? "connections.configured"
															: "connections.loginRequired",
												)}
											</span>
										</div>
										<p className="connection-endpoint">{provider.baseUrl}</p>
									</div>
									<div className="connection-actions">
										<PanelButtonView
											action={{
												id: PROVIDER_EDIT_ACTION,
												data: provider.id,
												label: connectionCopy(locale, "connections.configure"),
												weight:
													!provider.configured && canConfigure
														? "filled"
														: "line",
												disabled: !canConfigure,
											}}
											pending={panel.pending}
											onAction={onAction}
										/>
										<PanelButtonView
											action={{
												id: PROVIDER_TEST_ACTION,
												data: provider.id,
												label: connectionCopy(locale, "connections.testAction"),
												weight: "line",
												disabled:
													!provider.configured ||
													connections.loading ||
													connections.models.length === 0 ||
													provider.verification.status === "checking",
											}}
											pending={panel.pending}
											onAction={onAction}
										/>
									</div>
								</header>
								{!canConfigure && (
									<p className="connection-native">
										{connectionCopy(locale, "connections.native")}
									</p>
								)}
								<output
									className={`connection-verification ${provider.verification.status}`}
									aria-live="polite"
								>
									{verificationStatusText(locale, provider.verification)}
								</output>
							</section>
							<section className="connection-models-section">
								<header className="connection-models-head">
									<h3 className="connection-models-title">
										{connectionCopy(locale, "connections.models")}
									</h3>
									{!connections.loading && connections.models.length > 0 && (
										<span className="connection-models-count">
											{enabledCount} / {connections.models.length}
										</span>
									)}
								</header>
								{connections.loading ? (
									<p className="connection-empty">
										{connectionCopy(locale, "connection.starting")}
									</p>
								) : connections.models.length === 0 ? (
									<p className="connection-empty">
										{connectionCopy(locale, "connections.discover")}
									</p>
								) : (
									<div className="connection-model-list">
										{connections.models.map((model) => {
											const reference = connectionModelReference(model);
											const pending = sameActionTarget(panel.pending, {
												id: MODEL_ENABLED_ACTION,
												data: reference,
											});
											return (
												<div
													key={reference}
													className={
														model.available
															? "connection-model"
															: "connection-model is-unavailable"
													}
												>
													<div className="connection-model-main">
														<label className="connection-model-label">
															<input
																type="checkbox"
																checked={enabled(model)}
																disabled={
																	connections.disabled ||
																	!model.available ||
																	pending
																}
																onChange={(event) =>
																	onAction({
																		kind: "control",
																		id: MODEL_ENABLED_ACTION,
																		data: reference,
																		value: String(event.currentTarget.checked),
																	})
																}
															/>
															<span className="connection-model-name">
																{model.name}
															</span>
														</label>
														<small className="connection-model-id">
															{model.modelId}
														</small>
													</div>
												</div>
											);
										})}
									</div>
								)}
							</section>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function fieldRules(field: PanelField): readonly {
	readonly field: string;
	readonly values: readonly string[];
}[] {
	const visibleWhen = field.visibleWhen;
	if (visibleWhen === undefined) return [];
	return "field" in visibleWhen ? [visibleWhen] : visibleWhen;
}

function fieldIsVisible(
	field: PanelField,
	values: Readonly<Record<string, string>>,
): boolean {
	return fieldRules(field).every((rule) =>
		rule.values.includes(values[rule.field] ?? ""),
	);
}

function initialFieldValues(
	fields: readonly PanelField[],
): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of fields) values[field.id] = field.value;
	return values;
}

interface ModalFieldViewProps {
	readonly field: PanelField;
	readonly locale: Locale;
	readonly value: string;
	readonly visible: boolean;
	readonly disabled: boolean;
	readonly browseDirectories?: (path?: string) => Promise<DirectoryListing>;
	readonly pickDirectories?: () => Promise<readonly string[] | undefined>;
	readonly onChange: (value: string) => void;
	readonly onSubmit: () => void;
}

function ModalFieldView({
	field,
	locale,
	value,
	visible,
	disabled,
	browseDirectories,
	pickDirectories,
	onChange,
	onSubmit,
}: ModalFieldViewProps) {
	const helpId = `modal-help-${useId().replaceAll(":", "")}`;
	const help =
		field.description === undefined ? undefined : (
			<small id={helpId} className="modal-field-help">
				<SensitiveText text={field.description} locale={locale} />
			</small>
		);
	const enter = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
		if (
			event.key !== "Enter" ||
			event.nativeEvent.isComposing ||
			event.keyCode === 229 ||
			event.currentTarget.readOnly
		)
			return;
		event.preventDefault();
		onSubmit();
	};
	if (field.kind === "directories") {
		return (
			<div className="modal-field" hidden={!visible}>
				<span className="modal-field-label">{field.label}</span>
				<DirectoryField
					id={field.id}
					locale={locale}
					value={value}
					disabled={disabled || !visible}
					onValueChange={onChange}
					browseDirectories={browseDirectories}
					pickDirectories={pickDirectories}
				/>
				{help}
			</div>
		);
	}
	if (field.kind === "multiselect") {
		return (
			<div className="modal-field" hidden={!visible}>
				<span className="modal-field-label">{field.label}</span>
				<MultiselectField
					fieldId={field.id}
					locale={locale}
					value={value}
					options={field.options ?? []}
					onValueChange={onChange}
				/>
				{help}
			</div>
		);
	}
	if (field.kind === "checkbox") {
		return (
			<label
				className="modal-field modal-checkbox"
				hidden={!visible}
				aria-describedby={helpId}
			>
				<span className="modal-field-label">{field.label}</span>
				<input
					type="checkbox"
					className="modal-check"
					checked={value === "true"}
					disabled={disabled || field.readOnly === true}
					onChange={(event) => onChange(String(event.currentTarget.checked))}
					onKeyDown={enter}
				/>
				{help}
			</label>
		);
	}
	if (field.kind === "select") {
		return (
			<label className="modal-field" hidden={!visible}>
				<span className="modal-field-label">{field.label}</span>
				<select
					className="modal-input"
					value={value}
					disabled={disabled || field.readOnly === true}
					aria-describedby={helpId}
					onChange={(event) => onChange(event.currentTarget.value)}
				>
					{field.options?.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				{help}
			</label>
		);
	}
	if (field.kind === "textarea") {
		return (
			<label className="modal-field" hidden={!visible}>
				<span className="modal-field-label">{field.label}</span>
				<textarea
					className={`modal-textarea${field.id === "content" || field.id === "entry" ? " code" : ""}`}
					value={value}
					placeholder={field.placeholder}
					readOnly={field.readOnly === true}
					disabled={disabled}
					aria-describedby={helpId}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
				{help}
			</label>
		);
	}
	if (field.inputType === "password") {
		return (
			<div className="modal-field" hidden={!visible}>
				<label className="modal-field-label" htmlFor={field.id}>
					{field.label}
				</label>
				<PasswordField
					id={field.id}
					locale={locale}
					value={value}
					placeholder={field.placeholder}
					readOnly={field.readOnly === true}
					disabled={disabled}
					describedBy={helpId}
					onChange={field.readOnly === true ? undefined : onChange}
					onKeyDown={enter}
				/>
				{help}
			</div>
		);
	}
	return (
		<label className="modal-field" hidden={!visible}>
			<span className="modal-field-label">{field.label}</span>
			<input
				type={field.inputType ?? "text"}
				className="modal-input"
				value={value}
				placeholder={field.placeholder}
				readOnly={field.readOnly === true}
				disabled={disabled}
				step={
					field.inputType === "number" || field.inputType === "datetime-local"
						? 1
						: undefined
				}
				aria-describedby={helpId}
				onChange={(event) => onChange(event.currentTarget.value)}
				onKeyDown={enter}
			/>
			{help}
		</label>
	);
}

interface ModalContentProps {
	readonly modal: PanelModal;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
	readonly onClose: () => void;
	readonly browseDirectories?: (path?: string) => Promise<DirectoryListing>;
	readonly pickDirectories?: () => Promise<readonly string[] | undefined>;
}

function firstModalFocusable(
	body: HTMLFieldSetElement | null,
): HTMLElement | null {
	if (body === null) return null;
	return body.querySelector<HTMLElement>(
		"input:not([type='hidden']):not(:disabled), textarea:not(:disabled), select:not(:disabled), .directory-add:not(:disabled), button:not(:disabled)",
	);
}

function ModalContent({
	modal,
	locale,
	onAction,
	onClose,
	browseDirectories,
	pickDirectories,
}: ModalContentProps) {
	const [values, setValues] = useState<Record<string, string>>(() =>
		initialFieldValues(modal.fields),
	);
	const dirty = useRef(new Set<string>());
	const cardRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLFieldSetElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const initialFocus = useRef(true);
	const previousPending = useRef(modal.pending === true);

	useEffect(() => {
		setValues((current) => {
			let changed = false;
			const next = { ...current };
			for (const field of modal.fields) {
				if (dirty.current.has(field.id) || next[field.id] === field.value)
					continue;
				next[field.id] = field.value;
				changed = true;
			}
			return changed ? next : current;
		});
	}, [modal.fields]);

	useLayoutEffect(() => {
		const pending = modal.pending === true;
		const wasPending = previousPending.current;
		previousPending.current = pending;
		if (pending) {
			if (!initialFocus.current && wasPending) return;
			cardRef.current?.focus({ preventScroll: true });
			initialFocus.current = false;
			return;
		}
		if (!initialFocus.current && !wasPending) return;
		initialFocus.current = false;
		if (wasPending && document.activeElement !== cardRef.current) return;
		const target =
			modal.danger === true
				? cancelRef.current
				: (firstModalFocusable(bodyRef.current) ?? cancelRef.current);
		target?.focus({ preventScroll: true });
		if (target instanceof HTMLTextAreaElement && target.readOnly) {
			target.setSelectionRange(0, 0);
			target.scrollTop = 0;
		}
	}, [modal.danger, modal.pending]);

	const submit = (): void => {
		if (modal.pending === true || modal.submit === undefined) return;
		const fields: Record<string, string> = {};
		for (const field of modal.fields) {
			fields[field.id] = values[field.id] ?? field.value;
		}
		onAction({
			kind: "modal-submit",
			id: modal.id,
			data: modal.data,
			fields,
		});
	};
	const notice = modal.notice;
	const noticeText =
		notice === undefined
			? ""
			: notice.tone === "error"
				? errorMessageCopy(locale, notice.text)
				: notice.text;
	const noticeClass =
		notice === undefined
			? "modal-notice"
			: notice.verification === undefined
				? `modal-notice ${notice.tone}`
				: `modal-notice connection-verification ${notice.verification}`;
	const projectForm = modal.fields.some(
		(field) => field.kind === "directories",
	);

	return (
		<div
			ref={cardRef}
			className={projectForm ? "modal-card modal-project" : "modal-card"}
			tabIndex={-1}
		>
			<header className="modal-head">
				<div className="modal-titles">
					<h2 id="management-modal-title" className="modal-title">
						{modal.title}
					</h2>
					{modal.description !== undefined && (
						<p id="management-modal-description" className="modal-desc">
							<SensitiveText text={modal.description} locale={locale} />
						</p>
					)}
				</div>
				<button
					type="button"
					className="modal-close"
					aria-label={translate(locale, "panel.dismiss")}
					disabled={modal.pending === true}
					onClick={onClose}
				>
					<Icon name="x" />
				</button>
			</header>
			<fieldset
				ref={bodyRef}
				className="modal-body"
				disabled={modal.pending === true}
			>
				{modal.fields.map((field) => {
					const value = values[field.id] ?? field.value;
					const visible = fieldIsVisible(field, values);
					return (
						<ModalFieldView
							key={field.id}
							field={field}
							locale={locale}
							value={value}
							visible={visible}
							disabled={modal.pending === true || !visible}
							browseDirectories={browseDirectories}
							pickDirectories={pickDirectories}
							onChange={(next) => {
								dirty.current.add(field.id);
								setValues((current) =>
									current[field.id] === next
										? current
										: { ...current, [field.id]: next },
								);
							}}
							onSubmit={submit}
						/>
					);
				})}
			</fieldset>
			<p
				className={noticeClass}
				role={notice?.tone === "error" ? "alert" : "status"}
				hidden={notice === undefined}
			>
				<SensitiveText text={noticeText} locale={locale} />
			</p>
			<footer className="modal-foot">
				{modal.actions
					?.filter((action) => action.placement === "start")
					.map((action) => (
						<PanelButtonView
							key={`${action.id}\u0000${action.data ?? ""}`}
							action={action}
							onAction={onAction}
							forceDisabled={modal.pending === true}
						/>
					))}
				<button
					ref={cancelRef}
					type="button"
					className="panel-button weight-line"
					disabled={modal.pending === true}
					onClick={onClose}
				>
					{modal.dismiss ?? translate(locale, "panel.cancel")}
				</button>
				{modal.actions
					?.filter((action) => action.placement !== "start")
					.map((action) => (
						<PanelButtonView
							key={`${action.id}\u0000${action.data ?? ""}`}
							action={action}
							onAction={onAction}
							forceDisabled={modal.pending === true}
						/>
					))}
				{modal.submit !== undefined && (
					<button
						type="button"
						className={`panel-button weight-filled${modal.danger === true ? " is-danger" : ""}${modal.pending === true ? " pending" : ""}`}
						disabled={modal.pending === true}
						aria-busy={modal.pending === true || undefined}
						onClick={submit}
					>
						{modal.submit}
					</button>
				)}
			</footer>
		</div>
	);
}

export function ManagementModal({
	modal,
	locale,
	onAction,
	browseDirectories,
	pickDirectories,
}: ManagementModalProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const returnFocus = useRef<HTMLElement | undefined>(undefined);
	const backdropPressed = useRef(false);
	const identity =
		modal === undefined ? "" : `${modal.id}\u0000${modal.data ?? ""}`;

	const restoreFocus = useCallback(() => {
		const target = returnFocus.current;
		returnFocus.current = undefined;
		if (target === undefined) return;
		window.requestAnimationFrame(() => {
			if (
				target.isConnected &&
				!target.matches(":disabled") &&
				target.closest("[hidden], [inert]") === null
			)
				target.focus({ preventScroll: true });
		});
	}, []);

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (dialog === null) return;
		if (modal === undefined) {
			if (dialog.open) dialog.close();
			restoreFocus();
			return;
		}
		if (returnFocus.current === undefined) {
			const active = document.activeElement;
			if (active instanceof HTMLElement && !dialog.contains(active)) {
				returnFocus.current = active;
			}
		}
		if (!dialog.open) dialog.showModal();
	}, [modal, restoreFocus]);

	useEffect(
		() => () => {
			const dialog = dialogRef.current;
			if (dialog?.open) dialog.close();
			restoreFocus();
		},
		[restoreFocus],
	);

	const close = (): void => {
		if (modal?.pending === true) return;
		onAction({ kind: "modal-close" });
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Backdrop clicks are pointer-only; Escape and focused controls provide keyboard dismissal.
		<dialog
			ref={dialogRef}
			className={
				modal?.presentation === "drawer" ? "modal-root is-drawer" : "modal-root"
			}
			hidden={modal === undefined}
			aria-busy={modal?.pending === true}
			aria-labelledby={
				modal === undefined ? undefined : "management-modal-title"
			}
			aria-describedby={
				modal?.description === undefined
					? undefined
					: "management-modal-description"
			}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onPointerDown={(event) => pointerPressedBackdrop(event, backdropPressed)}
			onClick={(event) => {
				const backdrop =
					backdropPressed.current && event.target === event.currentTarget;
				backdropPressed.current = false;
				if (!backdrop || modal?.danger === true || modal?.pending === true)
					return;
				close();
			}}
		>
			{modal !== undefined && (
				<ModalContent
					key={identity}
					modal={modal}
					locale={locale}
					onAction={onAction}
					onClose={close}
					browseDirectories={browseDirectories}
					pickDirectories={pickDirectories}
				/>
			)}
		</dialog>
	);
}
