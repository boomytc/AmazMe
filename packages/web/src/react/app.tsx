import type { ErrorInfo, ReactNode } from "react";
import {
	Component,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import * as A from "../actions.ts";
import type { Locale } from "../locale.ts";
import { CHAT_VIEW, SETTINGS_VIEW } from "../panels.ts";
import * as P from "../projects.ts";
import type { PageRenderer } from "../render.ts";
import {
	fontSizeShortcut,
	isApplePlatform,
	isStopChord,
	matchShortcut,
} from "../shortcuts.ts";
import { translate } from "../strings.ts";
import { applyTypography } from "../typography.ts";
import type { RosterItem } from "../view.ts";
import { rosterGroups, windowTitle } from "../view.ts";
import { Composer, Transcript } from "./chat.tsx";
import { Dock } from "./dock.tsx";
import { Management, ManagementModal } from "./management.tsx";
import type { Presentation, ShellView } from "./state.ts";

export function Icon({ name }: { readonly name: string }) {
	return (
		<svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
			<use href={`#i-${name}`} />
		</svg>
	);
}

interface MenuItem {
	readonly id: string;
	readonly label: string;
	readonly danger?: boolean;
	readonly disabled?: boolean;
}
function RosterMenu({
	label,
	items,
	run,
}: {
	readonly label: string;
	readonly items: readonly MenuItem[];
	readonly run: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: 8, top: 8 });
	const trigger = useRef<HTMLButtonElement>(null),
		menu = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!open || !trigger.current) return;
		const box = trigger.current.getBoundingClientRect();
		setPosition({
			left: Math.max(8, Math.min(box.left, window.innerWidth - 220)),
			top: Math.max(
				8,
				Math.min(
					box.bottom + 4,
					window.innerHeight - (menu.current?.offsetHeight ?? 0) - 8,
				),
			),
		});
	}, [open]);
	useEffect(() => {
		if (!open) return;
		menu.current
			?.querySelector<HTMLButtonElement>("button:not(:disabled)")
			?.focus();
		const close = (event: MouseEvent) => {
			if (
				event.target instanceof Node &&
				!menu.current?.contains(event.target) &&
				!trigger.current?.contains(event.target)
			)
				setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);
	const close = () => {
		setOpen(false);
		trigger.current?.focus();
	};
	return (
		<span className="roster-menu-anchor">
			<button
				ref={trigger}
				onContextMenu={(event) => {
					event.preventDefault();
					setOpen(true);
				}}
				className="session-more"
				type="button"
				aria-label={label}
				title={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				<Icon name="more" />
			</button>
			{open &&
				createPortal(
					<div
						style={position}
						className="session-menu"
						role="menu"
						aria-label={label}
						ref={menu}
						onKeyDown={(event) => {
							if (event.key === "Escape" || event.key === "Tab") {
								close();
								if (event.key === "Escape") {
									event.preventDefault();
									event.stopPropagation();
								}
								return;
							}
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
								return;
							event.preventDefault();
							const rows = [
									...event.currentTarget.querySelectorAll<HTMLButtonElement>(
										"button:not(:disabled)",
									),
								],
								index = rows.indexOf(
									document.activeElement instanceof HTMLButtonElement
										? document.activeElement
										: rows[0],
								);
							rows[
								event.key === "Home"
									? 0
									: event.key === "End"
										? rows.length - 1
										: (index +
												(event.key === "ArrowUp" ? -1 : 1) +
												rows.length) %
											rows.length
							]?.focus();
						}}
					>
						{items.map((item) => (
							<button
								key={item.id}
								className={`session-menu-item${item.danger ? " danger" : ""}`}
								role="menuitem"
								type="button"
								disabled={item.disabled}
								onClick={() => {
									close();
									run(item.id);
								}}
							>
								{item.label}
							</button>
						))}
					</div>,
					document.body,
				)}
		</span>
	);
}
function SessionRow({
	item,
	locale,
	actions,
}: {
	readonly item: RosterItem;
	readonly locale: Locale;
	readonly actions: PageRenderer;
}) {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	const [copyError, setCopyError] = useState("");
	return (
		<div
			className={`session-row${item.attached ? " attached" : ""}`}
			data-session-id={item.id}
		>
			<button
				type="button"
				className="session-select"
				aria-current={item.attached ? "true" : undefined}
				title={[item.label, item.cwd].filter(Boolean).join(" · ")}
				onClick={() => actions.onSelect(item.id)}
			>
				<span className="session-name">{item.label}</span>
				<time className="session-age" dateTime={item.ageIso}>
					{item.age}
				</time>
			</button>
			<RosterMenu
				label={`${copy("sidebar.more")}: ${item.label}`}
				items={[
					{ id: A.SESSION_RENAME_ACTION, label: copy("sidebar.rename") },
					{
						id: item.archived
							? P.SESSION_RESTORE_ACTION
							: P.SESSION_ARCHIVE_ACTION,
						label: copy(item.archived ? "project.restore" : "project.archive"),
					},
					{ id: A.SESSION_COPY_ID_ACTION, label: copy("sidebar.copyId") },
					{ id: item.remove.id, label: item.remove.label, danger: true },
				]}
				run={(id) => {
					if (id === A.SESSION_COPY_ID_ACTION) {
						void navigator.clipboard
							.writeText(item.id)
							.catch(() => setCopyError(copy("copy.failed")));
					} else actions.onPanelAction({ kind: "command", id, data: item.id });
				}}
			/>
			{copyError && <span role="alert">{copyError}</span>}
		</div>
	);
}

function Navigation({
	view,
	actions,
	collapsed,
	toggle,
}: {
	readonly view: ShellView;
	readonly actions: PageRenderer;
	readonly collapsed: boolean;
	readonly toggle: () => void;
}) {
	const [filterOpen, setFilterOpen] = useState(view.rosterFilter.length > 0);
	const copy = (key: Parameters<typeof translate>[1]) =>
		translate(view.locale, key);
	const report = (id: string, data?: string) =>
		actions.onPanelAction({ kind: "command", id, data });
	const standalone = view.roster.filter((item) => !item.projectId);
	return (
		<aside className="sidebar" id="sidebar">
			<div className="session-sidebar" id="session-sidebar">
				<div className="brand">
					<div
						className="brand-filter"
						id="roster-filter-field"
						data-open={filterOpen}
					>
						<button
							id="roster-filter-toggle"
							className="icon-button"
							type="button"
							aria-label={copy("sidebar.filter")}
							aria-expanded={filterOpen}
							onClick={() => {
								if (filterOpen) actions.onFilterRoster("");
								setFilterOpen(!filterOpen);
							}}
						>
							<Icon name="search" />
						</button>
						<input
							className="roster-filter-input"
							id="roster-filter"
							type="search"
							aria-label={copy("sidebar.filter")}
							placeholder={copy("sidebar.filter")}
							hidden={!filterOpen}
							value={view.rosterFilter}
							onChange={(event) =>
								actions.onFilterRoster(event.currentTarget.value)
							}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									actions.onFilterRoster("");
									setFilterOpen(false);
								}
							}}
						/>
					</div>
					<button
						className="icon-button"
						type="button"
						id="sidebar-toggle"
						aria-label={copy("sidebar.toggle")}
						aria-expanded={!collapsed}
						onClick={toggle}
					>
						<Icon name="panel-left" />
					</button>
				</div>
				<button
					type="button"
					className="sidebar-new-chat"
					id="new-chat"
					disabled={!view.newSession.enabled || view.newSession.pending}
					onClick={() => actions.onCreateSession()}
				>
					<Icon name="square-pen" />
					{copy("sidebar.newChat")}
				</button>
				<p className="sidebar-label">
					{copy(view.projects ? "project.projects" : "sidebar.sessions")}
					{view.projects && (
						<button
							type="button"
							className="project-add"
							id="project-add"
							aria-label={copy("project.add")}
							onClick={() => report(P.PROJECT_ADD_ACTION)}
						>
							<Icon name="plus" />
						</button>
					)}
				</p>
				<div className="session-list" id="roster">
					{view.projects && (
						<>
							{view.projects.map((project) => (
								<section
									className={`project-group${project.selected ? " selected" : ""}`}
									key={project.id}
								>
									<div className="project-heading">
										<button
											className="project-select"
											type="button"
											aria-expanded={project.expanded}
											title={project.cwd}
											onClick={() =>
												report(P.PROJECT_SELECT_ACTION, project.id)
											}
										>
											<Icon name="folder" />
											<span className="project-name">{project.name}</span>
										</button>
										<button
											className="project-action project-new-session"
											type="button"
											disabled={
												!view.newSession.enabled || view.newSession.pending
											}
											aria-label={`${copy("sidebar.newChat")}: ${project.name}`}
											onClick={() =>
												report(P.PROJECT_NEW_SESSION_ACTION, project.id)
											}
										>
											<Icon name="plus" />
										</button>
										<RosterMenu
											label={project.name}
											items={[
												{
													id: P.PROJECT_EDIT_ACTION,
													label: copy("project.edit"),
												},
												{
													id: P.PROJECT_REMOVE_ACTION,
													label: copy("project.remove"),
													danger: true,
												},
											]}
											run={(id) => report(id, project.id)}
										/>
									</div>
									{project.expanded &&
										project.items.map((item) => (
											<SessionRow
												key={item.id}
												item={item}
												locale={view.locale}
												actions={actions}
											/>
										))}
								</section>
							))}
						</>
					)}
					{view.projects ? (
						<>
							{standalone.length > 0 && (
								<p className="session-group-label">{copy("sidebar.chats")}</p>
							)}
							{standalone.map((item) => (
								<SessionRow
									key={item.id}
									item={item}
									locale={view.locale}
									actions={actions}
								/>
							))}
						</>
					) : (
						rosterGroups(view.locale, standalone).map((group) => (
							<section className="roster-group" key={group.id}>
								<p className="roster-group-title">{group.label}</p>
								{group.items.map((item) => (
									<SessionRow
										key={item.id}
										item={item}
										locale={view.locale}
										actions={actions}
									/>
								))}
							</section>
						))
					)}
					{view.archivedAttached && (
						<SessionRow
							item={view.archivedAttached}
							locale={view.locale}
							actions={actions}
						/>
					)}
				</div>
			</div>
		</aside>
	);
}

export class StartupBoundary extends Component<
	{ readonly children: ReactNode },
	{ readonly error?: string }
> {
	state: { readonly error?: string } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	componentDidCatch(_error: Error, _info: ErrorInfo): void {
		document.body.classList.add("startup-failed");
	}
	render() {
		return this.state.error ? (
			<section className="startup-error" role="alert">
				<h1>
					{translate(
						document.documentElement.lang === "en" ? "en" : "zh",
						"page.entryFailed",
					)}
				</h1>
				<p>{this.state.error}</p>
				<button type="button" onClick={() => location.reload()}>
					{translate(
						document.documentElement.lang === "en" ? "en" : "zh",
						"page.entryRetry",
					)}
				</button>
			</section>
		) : (
			this.props.children
		);
	}
}

export function App({ presentation }: { readonly presentation: Presentation }) {
	const view = useSyncExternalStore(
		presentation.shell.subscribe,
		presentation.shell.getSnapshot,
	);
	const connection = useSyncExternalStore(
		presentation.connection.subscribe,
		presentation.connection.getSnapshot,
	);

	const [collapsed, setCollapsed] = useState(false);
	const typography = view?.typography,
		pageTitle = view?.pageTitle,
		pendingCount = view?.approvalIndicator?.count ?? 0,
		dockOpen = view?.dock.open ?? false,
		currentPanel = view?.panel.current,
		composerActive = currentPanel === CHAT_VIEW,
		modelManagement =
			currentPanel === SETTINGS_VIEW &&
			view?.panel.settingsSection?.id === "settings:models";
	useEffect(() => {
		if (!typography) return;
		applyTypography(document.documentElement.style, typography);
		document.title = windowTitle({
			appName: presentation.app.name,
			version: presentation.app.version,
			sessionName: pageTitle,
			pendingCount,
		});
		document.body.classList.toggle("dock-open", dockOpen);
		document.body.classList.toggle("library-open", currentPanel !== CHAT_VIEW);
		document.body.classList.toggle("sidebar-collapsed", collapsed);
		return () => {
			document.body.classList.remove(
				"dock-open",
				"library-open",
				"sidebar-collapsed",
			);
		};
	}, [
		typography,
		pageTitle,
		pendingCount,
		dockOpen,
		currentPanel,
		collapsed,
		presentation,
	]);
	useEffect(() => {
		const removeMenu = window.amazmeDesktop?.onMenuAction?.((action) => {
			if (action === "new-session") presentation.onShortcut("session.new");
			else if (action === "settings")
				presentation.onPanelAction({ kind: "open", panel: SETTINGS_VIEW });
		});
		const key = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.keyCode === 229 ||
				document.querySelector("dialog[open]") ||
				(event.target instanceof Element &&
					event.target.closest(".pty-surface"))
			)
				return;
			const font = fontSizeShortcut(
				event,
				navigator.platform,
				window.amazmeDesktop !== undefined,
			);
			if (font) {
				event.preventDefault();
				presentation.onShortcut(`font.${font}`);
				return;
			}
			const control = isStopChord(event),
				selected = document.getSelection()?.toString();
			if (
				control &&
				(selected ||
					((event.target instanceof HTMLTextAreaElement ||
						event.target instanceof HTMLInputElement) &&
						event.target.selectionStart !== event.target.selectionEnd))
			)
				return;
			const id = matchShortcut({
				code: event.code,
				primary: control
					? false
					: isApplePlatform(navigator.platform)
						? event.metaKey
						: event.ctrlKey,
				alt: event.altKey,
				shift: event.shiftKey,
				control,
			});
			if (
				id &&
				["session.new", "view.cycle", "run.stop"].includes(id) &&
				(id !== "run.stop" || presentation.view?.busy === true)
			) {
				event.preventDefault();
				presentation.onShortcut(id);
			}
		};
		document.addEventListener("keydown", key);
		return () => {
			removeMenu?.();
			document.removeEventListener("keydown", key);
		};
	}, [presentation]);
	if (!view) return <p className="empty-state">AmazMe</p>;
	const copy = (key: Parameters<typeof translate>[1]) =>
		translate(view.locale, key);
	const report = presentation.dispatchPanelAction;
	const glyphs: Readonly<Record<string, string>> = {
		chat: "message",
		plugins: "package",
		skills: "sparkles",
		automation: "clock",
		settings: "sliders",
	};
	const text =
		typeof connection.text === "function"
			? connection.text(view.locale)
			: connection.text;
	return (
		<>
			<nav className="app-rail" aria-label={copy("sidebar.management")}>
				<button
					type="button"
					className="rail-brand"
					id="connection-status"
					data-state={connection.state}
					aria-label="AmazMe"
				>
					<span className="brand-mark" aria-hidden="true">
						<svg
							className="pixel-logo"
							viewBox="0 0 10 4"
							aria-hidden="true"
							focusable="false"
						>
							<use href="#i-logo-a" className="pixel-a" />
							<use href="#i-logo-m" className="pixel-m" />
						</svg>
						<span className="connection-dot" />
					</span>
					<output className="connection-tooltip">
						<span className="connection-tooltip-name">AmazMe</span>
						<span id="connection-status-text">{text}</span>
					</output>
				</button>
				<div className="rail-nav" id="nav">
					{[
						{
							id: CHAT_VIEW,
							label: copy("nav.chat"),
							active: view.panel.current === CHAT_VIEW,
						},
						...view.panel.nav.filter((item) => item.id !== SETTINGS_VIEW),
					].map((item) => (
						<button
							key={item.id}
							className={`rail-button${item.active ? " active" : ""}`}
							type="button"
							aria-label={item.label}
							title={item.label}
							aria-current={item.active ? "page" : undefined}
							data-view={item.id}
							onClick={() => report({ kind: "open", panel: item.id })}
						>
							<Icon name={glyphs[item.id] ?? "file"} />
						</button>
					))}
				</div>
				<div className="rail-footer">
					<button
						className={`rail-button${view.panel.current === SETTINGS_VIEW ? " active" : ""}`}
						type="button"
						id="settings-button"
						aria-label={copy("nav.settings")}
						title={copy("nav.settings")}
						onClick={() => report({ kind: "open", panel: SETTINGS_VIEW })}
					>
						<Icon name="settings" />
					</button>
				</div>
			</nav>
			{view.panel.current === CHAT_VIEW && (
				<Navigation
					view={view}
					actions={presentation}
					collapsed={collapsed}
					toggle={() => setCollapsed(!collapsed)}
				/>
			)}
			<main
				className="center"
				id="center"
				data-state={view.emptyTranscript ? "empty" : "conversation"}
				data-attached={Boolean(view.attachedId)}
				data-read-only={view.readOnly === true}
				data-draft={view.sessionDraft !== undefined}
			>
				<header className="header">
					<div className="header-start">
						{collapsed && (
							<button
								className="icon-button"
								type="button"
								aria-label={copy("sidebar.toggle")}
								onClick={() => setCollapsed(false)}
							>
								<Icon name="panel-left" />
							</button>
						)}
						<button
							className="crumb-back"
							id="view-back"
							type="button"
							hidden={view.panel.current === CHAT_VIEW}
							onClick={() => report({ kind: "open", panel: CHAT_VIEW })}
						>
							<Icon name="arrow-left" />
						</button>
						<div className="header-titles">
							<span className="crumb" id="session-title">
								{view.sessionLabel ?? copy("header.noSession")}
							</span>
							<span
								className="lane-status"
								id="lane-status"
								hidden={!view.lane}
							>
								{view.lane}
							</span>
						</div>
					</div>
					<div className="header-end">
						<span
							className="approval-status"
							id="approval-status"
							hidden={!view.approvalIndicator}
						>
							{view.approvalIndicator?.label}
						</span>
						<div className="header-actions" id="run-actions">
							<button
								className="header-action"
								type="button"
								aria-label={view.run.fork.label}
								title={view.run.fork.label}
								disabled={view.run.fork.disabled}
								onClick={() =>
									report({
										kind: "command",
										id: view.run.fork.id,
										data: view.run.fork.data,
									})
								}
							>
								<Icon name="git-fork" />
								<span className="sr-only header-action-label">
									{view.run.fork.label}
								</span>
							</button>
							<button
								className={`header-action${view.dock.open ? " pressed" : ""}`}
								type="button"
								aria-label={view.dock.toggle.label}
								title={view.dock.toggle.label}
								aria-expanded={view.dock.open}
								onClick={() =>
									report({
										kind: "command",
										id: A.DOCK_TOGGLE_ACTION,
										data: undefined,
									})
								}
							>
								<Icon name="panel-right" />
								<span className="sr-only header-action-label">
									{view.dock.toggle.label}
								</span>
							</button>
						</div>
					</div>
					<span
						className="connection"
						id="connection"
						role={connection.kind === "error" ? "alert" : "status"}
						hidden={connection.kind !== "error"}
					>
						{text}
					</span>
				</header>
				{view.mirrorWarning && (
					<div className="session-warning" id="session-warning" role="alert">
						{view.mirrorWarning.path} {view.mirrorWarning.detail}
					</div>
				)}
				<section
					className="view"
					id="view"
					hidden={view.panel.current === CHAT_VIEW}
				>
					<ManagementSurface presentation={presentation} />
				</section>
				<div hidden={view.panel.current !== CHAT_VIEW} className="react-chat">
					<Conversation
						presentation={presentation}
						active={composerActive}
						modelManagement={modelManagement}
					/>
				</div>
			</main>
			<DockSurface
				presentation={presentation}
				locale={view.locale}
				scope={view.transcriptScope ?? view.attachedId ?? ""}
			/>
			<ModalSurface presentation={presentation} />
		</>
	);
}

function Conversation({
	presentation,
	active,
	modelManagement,
}: {
	readonly presentation: Presentation;
	readonly active: boolean;
	readonly modelManagement: boolean;
}) {
	return (
		<>
			<TranscriptSurface presentation={presentation} />
			<ComposerSurface
				presentation={presentation}
				active={active}
				modelManagement={modelManagement}
			/>
		</>
	);
}
function TranscriptSurface({
	presentation,
}: {
	readonly presentation: Presentation;
}) {
	const view = useSyncExternalStore(
		presentation.transcript.subscribe,
		presentation.transcript.getSnapshot,
	);
	return (
		view && (
			<Transcript
				key={view.transcriptScope ?? view.attachedId ?? "detached"}
				view={view}
				actions={presentation}
			/>
		)
	);
}
function ComposerSurface({
	presentation,
	active,
	modelManagement,
}: {
	readonly presentation: Presentation;
	readonly active: boolean;
	readonly modelManagement: boolean;
}) {
	const view = useSyncExternalStore(
		presentation.composer.subscribe,
		presentation.composer.getSnapshot,
	);
	const draft = useSyncExternalStore(
		presentation.draft.subscribe,
		presentation.draft.getSnapshot,
	);
	const scope = view?.transcriptScope ?? view?.attachedId ?? "";
	const previousActive = useRef(active);
	const modelScope = useRef<string | undefined>(undefined);
	const [restoreFocusRequest, setRestoreFocusRequest] = useState(0);
	useEffect(() => {
		const wasActive = previousActive.current;
		if (wasActive && !active) {
			modelScope.current = modelManagement ? scope : undefined;
		} else if (!active && !modelManagement) {
			modelScope.current = undefined;
		} else if (!wasActive && active) {
			const targetScope = modelScope.current;
			modelScope.current = undefined;
			if (targetScope !== undefined && targetScope === scope)
				setRestoreFocusRequest((request) => request + 1);
		}
		previousActive.current = active;
	}, [active, modelManagement, scope]);
	return (
		view && (
			<Composer
				key={view.transcriptScope ?? view.attachedId ?? "detached"}
				view={view}
				actions={presentation}
				draft={draft}
				active={active}
				restoreFocusRequest={restoreFocusRequest}
			/>
		)
	);
}

function ManagementSurface({
	presentation,
}: {
	readonly presentation: Presentation;
}) {
	const view = useSyncExternalStore(
		presentation.management.subscribe,
		presentation.management.getSnapshot,
	);
	return (
		view && (
			<Management
				view={view.panel}
				locale={view.locale}
				modelConnections={view.modelConnections}
				typography={view.typography}
				onAction={presentation.dispatchPanelAction}
				browseDirectories={
					presentation.onBrowseDirectories
						? presentation.browseDirectories
						: undefined
				}
				pickDirectories={
					presentation.onPickDirectories
						? presentation.pickDirectories
						: undefined
				}
			/>
		)
	);
}
function ModalSurface({
	presentation,
}: {
	readonly presentation: Presentation;
}) {
	const view = useSyncExternalStore(
		presentation.management.subscribe,
		presentation.management.getSnapshot,
	);
	return (
		view && (
			<ManagementModal
				modal={view.panel.modal}
				locale={view.locale}
				onAction={presentation.dispatchPanelAction}
				browseDirectories={
					presentation.onBrowseDirectories
						? presentation.browseDirectories
						: undefined
				}
				pickDirectories={
					presentation.onPickDirectories
						? presentation.pickDirectories
						: undefined
				}
			/>
		)
	);
}
function DockSurface({
	presentation,
	locale,
	scope,
}: {
	readonly presentation: Presentation;
	readonly locale: Locale;
	readonly scope: string;
}) {
	const view = useSyncExternalStore(
		presentation.dock.subscribe,
		presentation.dock.getSnapshot,
	);
	return (
		view && (
			<Dock
				view={view}
				locale={locale}
				scope={scope}
				onAction={presentation.dispatchPanelAction}
				onTerminalInput={presentation.dispatchTerminalInput}
				onTerminalResize={presentation.dispatchTerminalResize}
			/>
		)
	);
}
