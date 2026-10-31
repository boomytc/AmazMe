import type { WorkspaceStateLike } from "../dock.ts";
import { readFilePreview } from "../file-preview.ts";
import type {
	ProjectView,
	Session,
	TerminalView,
	WorkspaceGrantView,
} from "../generated/contracts.ts";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";
import { ApiError } from "../transport/api.ts";
import type { ClientConnection, PythonClient } from "../transport/client.ts";
import { TerminalInputQueue } from "./pending/terminal.ts";
import type { PendingWrites } from "./pending/writes.ts";

type WorkspaceOpen =
	| {
			readonly kind: "directory";
			readonly path?: string;
			readonly offset?: number;
	  }
	| {
			readonly kind: "file";
			readonly path: string;
			readonly line?: number;
			readonly preserve?: boolean;
	  };
interface ActiveTerminal {
	readonly connection: ClientConnection;
	readonly id: string;
	readonly queue: TerminalInputQueue;
	view: TerminalView;
	desiredSize?: { cols: number; rows: number };
	resizing: boolean;
}
interface WorkspaceServices {
	readonly client: PythonClient;
	readonly connection: () => ClientConnection;
	readonly ledger: (connection: ClientConnection) => PendingWrites;
	readonly changed: () => void;
	readonly error: (error: unknown) => void;
	readonly context: () => {
		readonly sessions: readonly Session[];
		readonly projects: readonly ProjectView[];
		readonly workspaces: readonly WorkspaceGrantView[];
		readonly locale: Locale;
	};
}

export class WorkspaceController {
	private open = false;
	private tab = "files";
	workspace?: WorkspaceStateLike;
	terminal?: ActiveTerminal;
	private terminalTimer?: ReturnType<typeof setTimeout>;
	private readonly terminalQueues = new Map<string, TerminalInputQueue>();
	private terminalLoadGeneration = 0;
	private workspaceGeneration = 0;
	private readonly services: WorkspaceServices;
	constructor(services: WorkspaceServices) {
		this.services = services;
	}
	get dockOpen(): boolean {
		return this.open;
	}
	set dockOpen(value: boolean) {
		this.open = value;
		if (!value) clearTimeout(this.terminalTimer);
	}
	get dockTab(): string {
		return this.tab;
	}
	set dockTab(value: string) {
		this.tab = value;
		if (value !== "terminal") clearTimeout(this.terminalTimer);
	}
	reset(): void {
		this.terminal = undefined;
		this.terminalLoadGeneration++;
		this.workspaceGeneration++;
		this.workspace = undefined;
		clearTimeout(this.terminalTimer);
	}
	dispose(): void {
		this.reset();
	}
	observeTerminal(terminal: ActiveTerminal, view: TerminalView): void {
		if (
			view.terminal_id !== terminal.id ||
			(view.session_id && view.session_id !== terminal.connection.sessionId)
		)
			throw new Error("终端归属不匹配");
		if (
			(view.output_seq ?? 0) < (terminal.view.output_seq ?? 0) ||
			(terminal.view.phase === "exited" && view.phase === "running")
		)
			return;
		terminal.view = view;
	}
	async loadTerminal(
		connection: ClientConnection,
		open = false,
	): Promise<void> {
		if (!connection.active()) return;
		const generation = ++this.terminalLoadGeneration;
		const list = await this.services.client.call(
			"GET /api/v1/sessions/{session_id}/terminals",
			{ path: { session_id: connection.sessionId } },
		);
		if (
			!connection.active() ||
			generation !== this.terminalLoadGeneration ||
			this.dockTab !== "terminal"
		)
			return;
		let view =
			list.terminals.findLast((item) => item.phase === "running") ??
			list.terminals.at(-1);
		if ((!view || view.phase === "exited") && open) {
			const ledger = this.services.ledger(connection),
				key = "terminal:open";
			const record = ledger.prepare(
				key,
				"POST /api/v1/sessions/{session_id}/terminals",
				(id) => ({
					path: { session_id: connection.sessionId },
					body: {
						terminal_id: id,
						command: "/bin/zsh -il",
						cols: 80,
						rows: 24,
					},
				}),
			);
			view = await ledger.send(key, record, this.services.client, connection);
		}
		if (
			!view ||
			!connection.active() ||
			generation !== this.terminalLoadGeneration ||
			this.dockTab !== "terminal"
		)
			return;
		const key = `amazme:terminal:${connection.identity.profile_id}:${connection.sessionId}:${view.terminal_id}`;
		let queue = this.terminalQueues.get(key);
		if (!queue) {
			queue = new TerminalInputQueue(sessionStorage, key);
			this.terminalQueues.set(key, queue);
		}
		const terminal: ActiveTerminal = {
			connection,
			id: view.terminal_id,
			view,
			queue,
			resizing: false,
		};
		this.terminal = terminal;
		queue.bind({
			active: () => connection.active() && this.terminal === terminal,
			send: async (input) => {
				const result = await this.services.client.call(
					"POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/input",
					{
						path: {
							session_id: connection.sessionId,
							terminal_id: terminal.id,
						},
						body: input,
						connection,
					},
				);
				if (connection.active() && this.terminal === terminal) {
					this.observeTerminal(terminal, result);
					this.services.changed();
				}
				return result;
			},
			error: (error) => {
				if (this.terminalVisible(terminal)) this.services.error(error);
			},
			changed: () => {
				if (connection.active() && this.terminal === terminal)
					this.services.changed();
			},
		});
		this.services.changed();
		clearTimeout(this.terminalTimer);
		void this.pollTerminal(terminal);
	}
	private async pollTerminal(terminal: ActiveTerminal): Promise<void> {
		if (!this.terminalVisible(terminal)) return;
		try {
			const view = await this.services.client.call(
				"POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/read",
				{
					path: {
						session_id: terminal.connection.sessionId,
						terminal_id: terminal.id,
					},
					connection: terminal.connection,
				},
			);
			if (!this.terminalVisible(terminal)) return;
			this.observeTerminal(terminal, view);
			this.services.changed();
		} catch (error) {
			if (this.terminalVisible(terminal)) this.services.error(error);
		} finally {
			if (this.terminalVisible(terminal) && terminal.view.phase === "running")
				this.terminalTimer = setTimeout(() => {
					void this.pollTerminal(terminal);
				}, 250);
		}
	}
	private terminalVisible(terminal: ActiveTerminal): boolean {
		return (
			terminal.connection.active() &&
			this.terminal === terminal &&
			this.dockOpen &&
			this.dockTab === "terminal"
		);
	}
	async resizeTerminal(terminal: ActiveTerminal): Promise<void> {
		if (terminal.resizing) return;
		terminal.resizing = true;
		try {
			while (
				terminal.desiredSize &&
				terminal.connection.active() &&
				this.terminal === terminal
			) {
				const size = terminal.desiredSize;
				terminal.desiredSize = undefined;
				const view = await this.services.client.call(
					"POST /api/v1/sessions/{session_id}/terminals/{terminal_id}/resize",
					{
						path: {
							session_id: terminal.connection.sessionId,
							terminal_id: terminal.id,
						},
						body: size,
						connection: terminal.connection,
					},
				);
				if (terminal.connection.active() && this.terminal === terminal) {
					this.observeTerminal(terminal, view);
					this.services.changed();
				}
			}
		} catch (error) {
			if (this.terminalVisible(terminal)) this.services.error(error);
		} finally {
			terminal.resizing = false;
		}
	}
	async openWorkspace(
		request: WorkspaceOpen = { kind: "directory" },
	): Promise<void> {
		const connection = this.services.connection(),
			generation = ++this.workspaceGeneration;
		const { sessions, projects, workspaces, locale } = this.services.context();
		let path = request.path;
		const session = sessions.find(
			(item) => item.session_id === connection.sessionId,
		);
		const project = projects.find(
			(item) => item.project_id === session?.project_id,
		);
		const names = project?.workspaces ?? [session?.workspace ?? "primary"];
		const roots = workspaces.filter((item) => names.includes(item.name));
		let root =
			(request.kind === "directory"
				? roots.find((item) => item.host_path === this.workspace?.cwd)
				: undefined) ??
			roots.find((item) => item.name === session?.workspace) ??
			roots[0];
		if (!root) throw new Error("工作区目录不可用");
		this.dockOpen = true;
		this.dockTab = "files";
		this.services.changed();
		if (path?.startsWith("grant/")) {
			const parts = path.split("/"),
				matched = roots.find((item) => item.name === parts[1]);
			if (!matched) {
				this.workspace = {
					cwd: root.host_path,
					workspaces: roots.map((item) => item.host_path),
					view: { kind: "denied", path, reason: "目录不属于当前项目" },
				};
				this.services.changed();
				return;
			}
			root = matched;
			path = parts.slice(2).join("/");
		}
		if (path?.startsWith("/")) {
			const matched = [...roots]
				.sort((a, b) => b.host_path.length - a.host_path.length)
				.find(
					(item) =>
						path === item.host_path || path.startsWith(item.host_path + "/"),
				);
			if (!matched) {
				this.workspace = {
					cwd: root.host_path,
					workspaces: roots.map((item) => item.host_path),
					view: { kind: "denied", path, reason: "目录不属于当前项目" },
				};
				this.services.changed();
				return;
			}
			root = matched;
		}
		const relative = path?.startsWith("/")
			? path.slice(root.host_path.length).replace(/^\/+/, "") || "."
			: path || ".";
		const previous =
			this.workspace?.cwd === root.host_path &&
			this.workspace.view.kind === "listing" &&
			this.workspace.view.path === relative
				? this.workspace.view.page
				: undefined;
		const pageOffset =
			request.kind === "directory"
				? (request.offset ?? previous?.offset ?? 0)
				: 0;
		const prefix = root.name === "primary" ? "" : `grant/${root.name}`;
		const target =
			relative === "." ? prefix : prefix ? `${prefix}/${relative}` : relative;
		const previousText =
			this.workspace?.cwd === root.host_path &&
			this.workspace.view.kind === "text" &&
			this.workspace.view.path === relative
				? this.workspace.view
				: undefined;
		const retained =
			request.kind === "file" && request.preserve ? previousText : undefined;
		const line =
			request.kind === "file"
				? (request.line ??
					retained?.selection?.line ??
					(retained && retained.startLine > 1
						? retained.startLine + 40
						: undefined))
				: undefined;
		let view: WorkspaceStateLike["view"];
		try {
			if (request.kind === "file") {
				const result = await readFilePreview({
					line,
					active: () =>
						connection.active() &&
						generation === this.workspaceGeneration &&
						this.dockOpen &&
						this.dockTab === "files",
					read: (page) =>
						this.services.client.call("GET /api/v1/files/content", {
							query: { path: target, ...page },
							connection,
						}),
				});
				if (result === undefined) return;
				view =
					result.kind === "changed"
						? {
								kind: "denied",
								path: relative,
								reason: translate(locale, "dock.fileChanged"),
							}
						: {
								...result,
								path: relative,
								...(retained?.selection
									? { selection: retained.selection }
									: line === undefined
										? {}
										: { selection: { line, revision: generation } }),
							};
			} else {
				const result = await this.services.client.call("GET /api/v1/files", {
					query: { path: target, offset: pageOffset },
				});
				view = {
					kind: "listing",
					path: relative,
					parent:
						relative === "."
							? null
							: relative.includes("/")
								? relative.split("/").slice(0, -1).join("/")
								: ".",
					entries: result.entries.map((item) => ({
						...item,
						kind: item.kind === "dir" ? "dir" : "file",
					})),
					page: {
						offset: result.offset ?? pageOffset,
						limit: result.limit ?? 200,
						total: result.total ?? result.entries.length,
					},
				};
			}
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			if (error.code === "file_not_text")
				view = { kind: "binary", path: relative };
			else if (error.code === "workspace_missing")
				view = { kind: "missing", path: relative };
			else if (
				[
					"workspace_permission",
					"workspace_path_escape",
					"workspace_not_file",
					"workspace_not_directory",
					"workspace_not_found",
					"invalid_workspace_path",
				].includes(error.code)
			)
				view = { kind: "denied", path: relative, reason: error.message };
			else throw error;
		}
		if (!connection.active() || generation !== this.workspaceGeneration) return;
		this.workspace = {
			cwd: root.host_path,
			workspaces: roots.map((item) => item.host_path),
			view,
		};
		this.services.changed();
	}
}
