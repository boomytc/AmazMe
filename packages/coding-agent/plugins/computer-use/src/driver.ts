import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	access,
	chmod,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { VERSION } from "@amazme/coding-agent/config";
import type { CallToolResult, Tool } from "@amazme/mcp";
import { McpClient, StdioTransport } from "@amazme/mcp";
import { isRecord } from "./config.ts";
import type { NativeObservation } from "./native-candidates.ts";
import { rect } from "./native-candidates.ts";

const execute = promisify(execFile);

async function hostBundle(
	binary: string,
	signal: AbortSignal,
): Promise<{ executable: string; bundleId: string; path: string } | undefined> {
	if (process.platform !== "darwin" || !binary.includes(".app/Contents/MacOS/"))
		return;
	const contents = dirname(dirname(binary)),
		path = join(contents, "Info.plist");
	const plist = await readFile(path, "utf8");
	const property = async (key: string): Promise<string> => {
		const text = new RegExp(
			`<key>${key}</key>\\s*<string>([^<]+)</string>`,
			"u",
		).exec(plist)?.[1];
		if (text) return text;
		return (
			await execute(
				"/usr/bin/plutil",
				["-extract", key, "raw", "-o", "-", path],
				{ signal, timeout: 2000, env: driverEnvironment() },
			)
		).stdout.trim();
	};
	const name = await property("CFBundleExecutable"),
		bundleId = await property("CFBundleIdentifier");
	if (name === "cua-driver") return;
	if (
		!name ||
		name.includes("/") ||
		!bundleId ||
		!(await executable(join(dirname(binary), name)))
	)
		throw new Error("Invalid computer-use host bundle");
	return {
		executable: await realpath(join(dirname(binary), name)),
		bundleId,
		path: dirname(contents),
	};
}

function applicationArguments(
	path: string,
	env: Record<string, string>,
): string[] {
	return [
		"-n",
		"-g",
		"-W",
		"-a",
		path,
		...Object.entries(env).flatMap(([key, value]) => [
			"--env",
			`${key}=${value}`,
		]),
	];
}

async function terminateMatchingProcesses(
	executable: string,
	args: string,
	pids?: number[],
	allowArguments = false,
): Promise<void> {
	if (pids?.length === 0) return;
	const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="], {
		timeout: 2000,
		env: driverEnvironment(),
	});
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
		if (!match?.[2]) continue;
		const pid = Number(match[1]);
		if (pids && !pids.includes(pid)) continue;
		const offset = match[2].lastIndexOf(` ${args}`);
		if (offset < 0) continue;
		const actualArgs = match[2].slice(offset + 1);
		if (
			actualArgs !== args &&
			!(allowArguments && actualArgs.startsWith(`${args} `))
		)
			continue;
		const actualExecutable = match[2].slice(0, offset);
		// LaunchServices and NSTask can spell the same executable using /private/var and /var.
		if (
			actualExecutable !== executable &&
			(await realpath(actualExecutable)) !== executable
		)
			continue;
		const alive = (): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				if (isRecord(error) && error.code === "ESRCH") return false;
				throw error;
			}
		};
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if (!isRecord(error) || error.code !== "ESRCH") throw error;
		}
		const deadline = Date.now() + 2000;
		while (alive()) {
			if (Date.now() >= deadline)
				throw new Error("Computer-use host did not exit after termination");
			await delay(25);
		}
	}
}

async function stopPermissionProbe(
	executable: string,
	output: string,
): Promise<void> {
	let stdout: string;
	try {
		({ stdout } = await execute(
			"/usr/sbin/lsof",
			["-t", "-a", "-d", "1", output],
			{
				timeout: 2000,
				env: driverEnvironment(),
			},
		));
	} catch (error) {
		if (isRecord(error) && error.code === 1) return;
		throw error;
	}
	// The private stdout file identifies this probe, even when another conversation probes the same app.
	const pids = stdout
		.trim()
		.split(/\s+/u)
		.map(Number)
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
	await terminateMatchingProcesses(executable, "check-permissions", pids);
}

export type WindowTarget = { pid: number; window_id: number };
export type Snapshot = NativeObservation & {
	pid?: number;
	windowId?: number;
	snapshotId?: string;
	captureId: string;
	imageBytes: Uint8Array;
	width: number;
	height: number;
	observedAt: number;
};

async function executable(path: string): Promise<boolean> {
	try {
		await access(
			path,
			process.platform === "win32" ? constants.F_OK : constants.X_OK,
		);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export async function resolveDriverBinary(
	options: {
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
		home?: string;
	} = {},
): Promise<string> {
	const env = options.env ?? process.env,
		platform = options.platform ?? process.platform,
		home = options.home ?? homedir();
	const explicit = env.AMAZME_CUA_DRIVER_PATH || env.CUA_DRIVER_PATH;
	if (explicit) {
		if (!isAbsolute(explicit) || !(await executable(explicit)))
			throw new Error(
				"Configured cua-driver path must be an executable absolute file",
			);
		return explicit;
	}
	const name = platform === "win32" ? "cua-driver.exe" : "cua-driver";
	const paths: string[] = [];
	if (platform === "darwin") {
		for (const product of ["AmazMe", "PilotDeck"]) {
			const root = join(
				home,
				"Library/Application Support",
				product,
				"ComputerUse",
			);
			paths.push(
				join(root, `${product} Computer Use.app/Contents/MacOS/cua-driver`),
			);
			const versions = await readdir(root).catch((): string[] => []);
			for (const version of versions.sort().reverse().slice(0, 20))
				paths.push(
					join(
						root,
						version,
						`${product} Computer Use.app/Contents/MacOS/cua-driver`,
					),
				);
		}
		paths.push(
			"/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
			"/Applications/PilotDeck.app/Contents/Resources/cua-driver/PilotDeck Computer Use.app/Contents/MacOS/cua-driver",
		);
	}
	paths.push(join(home, ".local/bin", name));
	for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute))
		paths.push(join(directory, name));
	for (const path of paths) if (await executable(path)) return path;
	throw new Error(
		"cua-driver is unavailable; prepare the optional runtime or set AMAZME_CUA_DRIVER_PATH",
	);
}

export function driverEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const allowed = new Set([
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TMPDIR",
		"TEMP",
		"TMP",
		"LANG",
		"SystemRoot",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XAUTHORITY",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"AT_SPI_BUS_ADDRESS",
		"XDG_SESSION_TYPE",
		"XDG_CURRENT_DESKTOP",
	]);
	return {
		...Object.fromEntries(
			Object.entries(env).filter(
				([key, value]) =>
					value !== undefined && (allowed.has(key) || key.startsWith("LC_")),
			),
		),
		CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
		CUA_TELEMETRY_ENABLED: "false",
	} as Record<string, string>;
}

function payload(result: CallToolResult): Record<string, unknown> {
	if (isRecord(result.structuredContent)) return result.structuredContent;
	for (const part of result.content) {
		if (part.type !== "text") continue;
		try {
			const parsed: unknown = JSON.parse(part.text);
			if (isRecord(parsed)) return parsed;
		} catch {}
	}
	return {};
}

export function parseSnapshot(
	result: CallToolResult,
	target?: WindowTarget,
): Snapshot {
	const data = payload(result);
	if (
		result.isError ||
		data.success === false ||
		data.error ||
		data.screenshot_frame_valid === false
	)
		throw new Error("Driver observation failed");
	if (
		target &&
		(data.pid !== target.pid || data.window_id !== target.window_id)
	)
		throw new Error("Observation belongs to another window");
	const image = result.content.find((part) => part.type === "image");
	if (
		!image ||
		image.type !== "image" ||
		image.mimeType !== "image/png" ||
		image.data.length > 48 * 1024 * 1024
	)
		throw new Error("Driver did not return a bounded PNG screenshot");
	const bytes = Buffer.from(image.data, "base64");
	if (
		bytes.length < 24 ||
		bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
	)
		throw new Error("Invalid PNG screenshot");
	const width = bytes.readUInt32BE(16),
		height = bytes.readUInt32BE(20);
	if (
		!width ||
		!height ||
		width * height > 40_000_000 ||
		data.screenshot_width !== width ||
		data.screenshot_height !== height
	)
		throw new Error(
			"Screenshot dimensions disagree with the atomic observation",
		);
	if (typeof data.capture_id !== "string" || !data.capture_id)
		throw new Error("Observation has no capture_id");
	const raw = data.elements ?? [];
	if (!Array.isArray(raw) || !raw.every(isRecord))
		throw new Error("Invalid accessibility elements");
	return {
		pid: target?.pid,
		windowId: target?.window_id,
		snapshotId:
			typeof data.snapshot_id === "string" ? data.snapshot_id : undefined,
		captureId: data.capture_id,
		imageBytes: bytes,
		width,
		height,
		observedAt: Date.now(),
		elements: raw,
		windowBounds: rect(data.window_bounds),
		treeMarkdown:
			typeof data.tree_markdown === "string" ? data.tree_markdown : "",
		degradedReason:
			typeof data.degraded_reason === "string"
				? data.degraded_reason
				: undefined,
	};
}

export interface DriverOptions {
	/** Trusted host/test injection, never accepted from model tools. */
	command?: string;
	args?: readonly string[];
}

/** One persistent MCP transport owns one named conversation session. */
export class DriverClient {
	readonly session: string;
	snapshot?: Snapshot;
	private client?: McpClient;
	private transport?: StdioTransport;
	private host?: ChildProcess;
	private hostLifetime?: FileHandle;
	private hostIdentity?: {
		executable: string;
		socket: string;
		serviceExecutable: string;
	};
	private socketDirectory?: string;
	private tools = new Map<string, Tool>();
	private opening?: Promise<void>;
	private closing?: Promise<void>;
	private closed = false;
	private readonly options: DriverOptions;

	constructor(conversationId: string, options: DriverOptions = {}) {
		this.options = options;
		// Preserve a short readable prefix, with a suffix to avoid cross-conversation prefix collisions.
		this.session = `amazme-${conversationId.slice(0, 8)}-${conversationId.slice(-8)}`;
	}

	private async embedded(
		binary: string,
		env: Record<string, string>,
		signal: AbortSignal,
	): Promise<string[]> {
		const bundle = await hostBundle(binary, signal);
		if (!bundle) return ["mcp"];
		this.socketDirectory = await mkdtemp(
			join(tmpdir().length < 70 ? tmpdir() : "/tmp", "amcu-"),
		);
		await chmod(this.socketDirectory, 0o700);
		const socket = join(this.socketDirectory, "driver.sock");
		const lifetime = join(this.socketDirectory, "lifetime");
		await execute("/usr/bin/mkfifo", ["-m", "600", lifetime], { env, signal });
		// O_RDWR lets LaunchServices open its read end without blocking startup. Only this caller holds a writer.
		this.hostLifetime = await open(
			lifetime,
			constants.O_RDWR | constants.O_NOFOLLOW,
		);
		signal.throwIfAborted();
		this.hostIdentity = {
			executable: bundle.executable,
			socket,
			serviceExecutable: await realpath(binary),
		};
		const host = spawn(
			"/usr/bin/open",
			[
				...applicationArguments(bundle.path, env),
				"--stdin",
				lifetime,
				"--stdout",
				"/dev/null",
				"--stderr",
				"/dev/null",
				"--args",
				"serve",
				"--socket",
				socket,
			],
			{
				env,
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		this.host = host;
		let failure: Error | undefined;
		host.on("error", (error) => {
			failure = error;
		});
		host.stderr?.resume();
		const deadline = Date.now() + 10_000;
		while (
			!(await stat(socket).then(
				(item) => item.isSocket(),
				() => false,
			))
		) {
			if (failure || host.exitCode !== null || host.signalCode !== null)
				throw (
					failure ??
					new Error("Computer-use host exited before opening its socket")
				);
			if (Date.now() > deadline)
				throw new Error("Computer-use host startup timed out");
			await delay(25, undefined, { signal });
		}
		return [
			"mcp",
			"--embedded",
			"--socket",
			socket,
			"--host-bundle-id",
			bundle.bundleId,
		];
	}

	async permissions(
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<CallToolResult> {
		if (this.closed) throw new Error("Driver session is closed");
		signal.throwIfAborted();
		const binary = this.options.command ?? (await resolveDriverBinary());
		const bundle = await hostBundle(binary, signal);
		if (bundle?.bundleId === "com.amazme.computer-use") {
			const directory = await mkdtemp(join(tmpdir(), "amcu-permissions-"));
			const output = join(directory, "result.json");
			let report: unknown;
			try {
				const env = driverEnvironment();
				await writeFile(output, "", { mode: 0o600 });
				await execute(
					"/usr/bin/open",
					[
						...applicationArguments(bundle.path, env),
						"--stdout",
						output,
						"--stderr",
						"/dev/null",
						"--args",
						"check-permissions",
					],
					{ signal, timeout: timeoutMs, env },
				);
				report = JSON.parse(await readFile(output, "utf8"));
			} finally {
				try {
					await stopPermissionProbe(bundle.executable, output);
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			}
			if (
				!isRecord(report) ||
				typeof report.accessibility !== "boolean" ||
				typeof report.screen_recording !== "boolean"
			)
				throw new Error("Invalid host permission report");
			report = { ...report, host_path: bundle.path, driver_path: binary };
			return {
				content: [{ type: "text", text: JSON.stringify(report) }],
				structuredContent: report,
			};
		}
		return this.call("check_permissions", {}, timeoutMs, signal);
	}

	async connect(timeoutMs: number, signal: AbortSignal): Promise<void> {
		if (this.closed) throw new Error("Driver session is closed");
		if (this.opening) return this.opening;
		this.opening = (async () => {
			signal.throwIfAborted();
			const binary = this.options.command ?? (await resolveDriverBinary());
			const env = driverEnvironment();
			const args =
				this.options.args ?? (await this.embedded(binary, env, signal));
			signal.throwIfAborted();
			const transport = new StdioTransport({
				command: binary,
				args,
				env,
				inheritEnv: false,
				maxMessageBytes: 64 * 1024 * 1024,
			});
			this.transport = transport;
			const client = new McpClient({
				name: "AmazMe computer-use",
				version: VERSION,
				requestTimeoutMs: timeoutMs,
			});
			this.client = client;
			const abort = () => {
				void client.close().catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				await client.connect(transport);
				const advertised = await client.listTools({ signal, timeoutMs });
				this.tools = new Map(advertised.map((tool) => [tool.name, tool]));
				signal.throwIfAborted();
			} finally {
				signal.removeEventListener("abort", abort);
			}
		})();
		try {
			await this.opening;
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	supports(tool: string, field?: string): boolean {
		const schema = this.tools.get(tool)?.inputSchema;
		return (
			schema !== undefined &&
			(field === undefined ||
				(isRecord(schema.properties) &&
					Object.hasOwn(schema.properties, field)))
		);
	}

	async call(
		tool: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<CallToolResult> {
		await this.connect(timeoutMs, signal);
		signal.throwIfAborted();
		if (this.closed || !this.client)
			throw new Error("Driver session is closed");
		if (!this.supports(tool))
			throw new Error(`Driver does not advertise ${tool}`);
		const result = await this.client.callTool(
			tool,
			{
				...args,
				...(this.supports(tool, "session") ? { session: this.session } : {}),
			},
			{ signal, timeoutMs },
		);
		signal.throwIfAborted();
		const data = payload(result);
		if (result.isError || data.success === false || data.error) {
			this.snapshot = undefined;
			throw new Error(
				`Driver ${tool} refused: ${JSON.stringify(data).slice(0, 2000)}`,
			);
		}
		return result;
	}

	async observe(
		target: WindowTarget | undefined,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<Snapshot> {
		this.snapshot = undefined;
		await this.connect(timeoutMs, signal);
		const result = await this.call(
			target ? "get_window_state" : "get_desktop_state",
			target
				? {
						...target,
						include_accessibility_tree: true,
						include_screenshot: true,
						...(this.supports("get_window_state", "tree_format")
							? { tree_format: "both" }
							: {}),
						max_elements: 500,
						max_image_dimension: 0,
					}
				: { max_image_dimension: 0 },
			timeoutMs,
			signal,
		);
		const snapshot = parseSnapshot(result, target);
		this.snapshot = snapshot;
		return snapshot;
	}

	current(captureId: string, target?: WindowTarget): Snapshot {
		const snapshot = this.snapshot;
		if (
			!snapshot ||
			snapshot.captureId !== captureId ||
			Date.now() - snapshot.observedAt >= 55_000 ||
			snapshot.pid !== target?.pid ||
			snapshot.windowId !== target?.window_id
		)
			throw new Error("Stale capture or window mismatch; observe again");
		return snapshot;
	}

	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.snapshot = undefined;
		this.closing = (async () => {
			if (this.client && this.supports("end_session"))
				await this.client
					.callTool(
						"end_session",
						{ session: this.session },
						{ timeoutMs: 1500 },
					)
					.catch(() => {});
			const failures: unknown[] = [];
			try {
				await this.client?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await this.transport?.close();
			} catch (error) {
				failures.push(error);
			}
			try {
				await this.hostLifetime?.close();
			} catch (error) {
				failures.push(error);
			}
			const host = this.host;
			const exited =
				host &&
				host.exitCode === null &&
				host.signalCode === null &&
				host.pid !== undefined
					? new Promise<void>((resolve) => host.once("close", resolve))
					: undefined;
			if (exited) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 2000);
					void exited.then(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			// LaunchServices owns these processes; neither killing open nor killing its app kills a stuck service.
			// Check both even when the launcher already exited, using only this session's private endpoint.
			if (this.hostIdentity) {
				const identity = this.hostIdentity;
				for (const [executable, args, allowArguments] of [
					[
						identity.serviceExecutable,
						`serve --embedded --socket ${identity.socket}`,
						true,
					],
					[identity.executable, `serve --socket ${identity.socket}`, false],
				] as const) {
					try {
						await terminateMatchingProcesses(
							executable,
							args,
							undefined,
							allowArguments,
						);
					} catch (error) {
						failures.push(error);
					}
				}
			}
			if (exited) {
				host?.kill("SIGKILL");
				await exited;
			}
			try {
				if (this.socketDirectory)
					await rm(this.socketDirectory, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			}
			if (failures.length)
				throw new AggregateError(failures, "Driver transport cleanup failed");
		})();
		return this.closing;
	}
}
