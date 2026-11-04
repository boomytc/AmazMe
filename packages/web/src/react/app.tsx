import type { ErrorInfo, ReactNode } from "react";
import {
	Component,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import * as A from "../actions.ts";
import type { DockPresentation } from "../app/dock-preferences.ts";
import {
	readDockPresentation,
	storeDockPresentation,
} from "../app/dock-preferences.ts";
import { desktopBridge } from "../desktop.ts";
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
import { ToastLayer } from "./toast.tsx";

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
				className="session-more icon-button icon-button--compact"
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
				run={(id) => actions.onPanelAction({ kind: "command", id, data: item.id })}
			/>
		</div>
	);
}

function Navigation({
	view,
	actions,
}: {
	readonly view: ShellView;
	readonly actions: PageRenderer;
}) {
	const [filterOpen, setFilterOpen] = useState(view.rosterFilter.length > 0);
	const copy = (key: Parameters<typeof translate>[1]) =>
		translate(view.locale, key);
	const report = (id: string, data?: string) =>
		actions.onPanelAction({ kind: "command", id, data });
	const standalone = view.roster.filter((item) => !item.projectId);
	const filterField = useRef<HTMLInputElement>(null);
	const filterToggle = useRef<HTMLButtonElement>(null);
	const closeFilter = (focusToggle = false) => {
		actions.onFilterRoster("");
		setFilterOpen(false);
		if (focusToggle) filterToggle.current?.focus({ preventScroll: true });
	};
	useEffect(() => {
		if (filterOpen) filterField.current?.focus({ preventScroll: true });
	}, [filterOpen]);
	return (
		<aside className="sidebar" id="sidebar">
			<div className="session-sidebar" id="session-sidebar">
				<div className="sidebar-head">
					<button
						type="button"
						className="sidebar-new-chat"
						id="new-chat"
						title={copy("sidebar.newSession")}
						disabled={!view.newSession.enabled || view.newSession.pending}
						onClick={() => actions.onCreateSession()}
					>
						<Icon name="square-pen" />
						<span className="sidebar-new-chat-label">
							{copy("sidebar.newSession")}
						</span>
					</button>
					<button
						ref={filterToggle}
						id="roster-filter-toggle"
						className="icon-button"
						type="button"
						aria-label={copy("sidebar.filter")}
						title={copy("sidebar.filter")}
						aria-expanded={filterOpen}
						aria-controls="roster-filter"
						onClick={() => {
							if (filterOpen) closeFilter(true);
							else setFilterOpen(true);
						}}
					>
						<Icon name="search" />
					</button>
				</div>
				<div
					className="roster-filter sidebar-filter"
					id="roster-filter-field"
					hidden={!filterOpen}
				>
					<Icon name="search" />
					<input
						ref={filterField}
						className="roster-filter-input"
						id="roster-filter"
						type="search"
						autoComplete="off"
						spellCheck={false}
						aria-label={copy("sidebar.filter")}
						placeholder={copy("sidebar.filter")}
						value={view.rosterFilter}
						onChange={(event) =>
							actions.onFilterRoster(event.currentTarget.value)
						}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							closeFilter(true);
						}}
					/>
					<button
						type="button"
						className="section-search-clear icon-button icon-button--mini"
						aria-label={copy("sidebar.clearFilter")}
						title={copy("sidebar.clearFilter")}
						hidden={view.rosterFilter.length === 0}
						onClick={() => {
							actions.onFilterRoster("");
							filterField.current?.focus({ preventScroll: true });
						}}
					>
						<Icon name="x" />
					</button>
				</div>
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
											aria-label={`${copy("sidebar.newSession")}: ${project.name}`}
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
								<p className="session-group-label">
									{copy("sidebar.sessions")}
								</p>
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

/**
 * The window's one toolbar row. It replaces the native title bar inside the desktop shell (the
 * traffic lights sit in the leading inset), so it carries the current view's title, the sidebar
 * toggle or the management back control, and the conversation's own controls. A plain browser
 * renders the same row without the window treatment.
 */
function Titlebar({
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
	const copy = (key: Parameters<typeof translate>[1]) =>
		translate(view.locale, key);
	const management = view.panel.current !== CHAT_VIEW;
	const attached = Boolean(view.attachedId) || view.connecting === true;
	const title = management
		? view.pageTitle
		: (view.sessionLabel ?? copy("header.noSession"));
	return (
		<header className="titlebar">
			<div className="titlebar-leading">
				{management ? (
					<button
						className="icon-button"
						type="button"
						aria-label={copy("header.back")}
						title={copy("header.back")}
						onClick={() =>
							actions.onPanelAction({ kind: "open", panel: CHAT_VIEW })
						}
					>
						<Icon name="arrow-left" />
					</button>
				) : (
					<button
						className="icon-button"
						type="button"
						aria-label={copy("sidebar.toggle")}
						title={copy("sidebar.toggle")}
						aria-expanded={!collapsed}
						aria-controls="sidebar"
						onClick={toggle}
					>
						<Icon name="panel-left" />
					</button>
				)}
				<div className="titlebar-titles">
					<span className="crumb" id="session-title">
						{title ?? copy("header.noSession")}
					</span>
					{management ? null : (
						<span className="lane-status" id="lane-status" hidden={!view.lane}>
							{view.lane}
						</span>
					)}
				</div>
			</div>
			<div className="titlebar-trailing">
				{management || !attached ? null : (
					<>
						{/* The in-conversation search follows this column's context, not the window. */}
						<div className="titlebar-search" id="titlebar-search-slot" />
						<span
							className="approval-status"
							id="approval-status"
							hidden={!view.approvalIndicator}
						>
							{view.approvalIndicator?.label}
						</span>
						<div className="titlebar-actions" id="run-actions">
							<button
								className="titlebar-action"
								type="button"
								aria-label={view.run.fork.label}
								title={view.run.fork.label}
								disabled={view.run.fork.disabled}
								onClick={() =>
									actions.onPanelAction({
										kind: "command",
										id: view.run.fork.id,
										data: view.run.fork.data,
									})
								}
							>
								<Icon name="git-fork" />
							</button>
							{/* The way back into a hidden dock is the conversation header's corner, past the
							    utilities' right edge — the same corner the right panel's strip collapses to. */}
							{view.dock.open ? null : (
								<button
									className="titlebar-action"
									type="button"
									data-dock-expand
									aria-label={copy("dock.expand")}
									title={copy("dock.expand")}
									aria-controls="dock"
									onClick={() =>
										actions.onPanelAction({
											kind: "command",
											id: A.DOCK_TOGGLE_ACTION,
											data: undefined,
										})
									}
								>
									<Icon name="panel-right" />
								</button>
							)}
						</div>
					</>
				)}
			</div>
		</header>
	);
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
	const [dockPresentation, setDockPresentation] = useState<DockPresentation>(
		readDockPresentation,
	);
	const dockMotionTimer = useRef<number | undefined>(undefined);
	const stopDockMotion = useCallback(() => {
		window.clearTimeout(dockMotionTimer.current);
		dockMotionTimer.current = undefined;
		delete document.body.dataset.dockMotion;
	}, []);
	const animateDock = useCallback((motion: "width" | "presentation", apply: () => void) => {
		stopDockMotion();
		document.body.dataset.dockMotion = motion;
		void document.body.offsetWidth;
		apply();
		dockMotionTimer.current = window.setTimeout(stopDockMotion, 340);
	}, [stopDockMotion]);
	const animateDockWidth = useCallback((apply: () => void) => {
		animateDock("width", apply);
	}, [animateDock]);
	const toggleDockFullscreen = useCallback(() => {
		animateDock("presentation", () => {
			setDockPresentation((current) => current === "fullscreen" ? "push" : "fullscreen");
		});
	}, [animateDock]);
	const typography = view?.typography,
		pageTitle = view?.pageTitle,
		pendingCount = view?.approvalIndicator?.count ?? 0,
		dockOpen = view?.dock.open ?? false,
		currentPanel = view?.panel.current,
		composerActive = currentPanel === CHAT_VIEW,
		modelManagement =
			currentPanel === SETTINGS_VIEW &&
			view?.panel.settingsSection?.id === "settings:models";
	/* Layout effect: typography and the window title land before the frame paints. */
	useLayoutEffect(() => {
		if (!typography) return;
		applyTypography(document.documentElement.style, typography);
		document.title = windowTitle({
			appName: presentation.app.name,
			version: presentation.app.version,
			sessionName: pageTitle,
			pendingCount,
		});
	}, [typography, pageTitle, pendingCount, presentation]);
	/* CSS derives the track and panel position from the same reveal fraction. */
	useLayoutEffect(() => {
		const body = document.body;
		const narrowOpening = dockOpen && !body.classList.contains("dock-open") && window.innerWidth < 1280;
		if (narrowOpening) setCollapsed(true);
		if (currentPanel !== CHAT_VIEW) stopDockMotion();
		body.classList.toggle("library-open", currentPanel !== CHAT_VIEW);
		body.classList.toggle("sidebar-collapsed", collapsed || narrowOpening);
		body.classList.toggle("dock-open", dockOpen);
	}, [dockOpen, currentPanel, collapsed, stopDockMotion]);
	useLayoutEffect(
		() => () => {
			stopDockMotion();
			document.body.classList.remove(
				"dock-open",
				"library-open",
				"sidebar-collapsed",
			);
		},
		[stopDockMotion],
	);
	useEffect(() => {
		storeDockPresentation(dockPresentation);
	}, [dockPresentation]);
	useEffect(() => {
		window.addEventListener("resize", stopDockMotion);
		return () => window.removeEventListener("resize", stopDockMotion);
	}, [stopDockMotion]);
	useEffect(() => {
		const desktop = desktopBridge() !== undefined;
		const removeMenu = desktopBridge()?.onMenuAction?.((action) => {
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
				desktop,
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
			if (id === "dock.fullscreen") {
				// Fullscreen is a presentation of a panel that is on screen; a hidden dock has none.
				const current = presentation.view;
				if (current?.dock.open !== true || current.panel.current !== CHAT_VIEW)
					return;
				event.preventDefault();
				toggleDockFullscreen();
				return;
			}
			if (
				id &&
				["session.new", "dock.toggle", "run.stop"].includes(id) &&
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
	}, [presentation, toggleDockFullscreen]);
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
			<Titlebar
				view={view}
				actions={presentation}
				collapsed={collapsed}
				toggle={() => setCollapsed(!collapsed)}
			/>
			<nav className="app-rail" aria-label={copy("nav.primary")}>
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
						aria-current={
							view.panel.current === SETTINGS_VIEW ? "page" : undefined
						}
						onClick={() => report({ kind: "open", panel: SETTINGS_VIEW })}
					>
						<Icon name="settings" />
					</button>
				</div>
			</nav>
			{view.panel.current === CHAT_VIEW && (
				<Navigation view={view} actions={presentation} />
			)}
			<main
				className="center"
				id="center"
				data-state={view.emptyTranscript ? "empty" : "conversation"}
				data-attached={Boolean(view.attachedId) || view.connecting === true}
				data-read-only={view.readOnly === true}
				data-draft={view.sessionDraft !== undefined}
			>
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
				fullscreen={dockPresentation === "fullscreen"}
				visible={composerActive && dockOpen}
				onAnimateWidth={animateDockWidth}
				onResizeStart={stopDockMotion}
				onToggleFullscreen={toggleDockFullscreen}
			/>
			<ModalSurface presentation={presentation} />
			<ToastLayer presentation={presentation} />
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
	fullscreen,
	visible,
	onAnimateWidth,
	onResizeStart,
	onToggleFullscreen,
}: {
	readonly presentation: Presentation;
	readonly locale: Locale;
	readonly scope: string;
	readonly fullscreen: boolean;
	readonly visible: boolean;
	readonly onAnimateWidth: (apply: () => void) => void;
	readonly onResizeStart: () => void;
	readonly onToggleFullscreen: () => void;
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
				fullscreen={fullscreen}
				visible={visible}
				onAnimateWidth={onAnimateWidth}
				onResizeStart={onResizeStart}
				onToggleFullscreen={onToggleFullscreen}
				onAction={presentation.dispatchPanelAction}
				onTerminalInput={presentation.dispatchTerminalInput}
				onTerminalResize={presentation.dispatchTerminalResize}
			/>
		)
	);
}
