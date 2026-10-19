import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { permissionPanelSource } from "./permission-panel-source.ts";

const execute = promisify(execFile);
const hash = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Also called by the optional runtime installer, so no compiler is needed when the panel is shown. */
export async function preparePermissionPanel(
	signingIdentity = process.env.AMAZME_CUA_SIGNING_IDENTITY ?? "-",
	signal?: AbortSignal,
): Promise<string> {
	if (process.platform !== "darwin")
		throw new Error("The native permission panel requires macOS");
	const key = hash(`${permissionPanelSource}\n${signingIdentity}`);
	const output = join(
		homedir(),
		"Library/Caches/AmazMe/ComputerUse/permissions",
		key,
	);
	const app = "AmazMe Permissions.app";
	const relative = `${app}/Contents/MacOS/amazme-permissions`;
	const binary = join(output, relative);
	const existing = await readFile(join(output, "manifest.json"), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return;
			throw error;
		},
	);
	if (existing) {
		const manifest: unknown = JSON.parse(existing);
		if (
			typeof manifest !== "object" ||
			manifest === null ||
			!("source" in manifest) ||
			manifest.source !== key ||
			!("binary" in manifest) ||
			manifest.binary !== hash(await readFile(binary))
		)
			throw new Error("Permission panel differs from its manifest");
		await execute(
			"/usr/bin/codesign",
			["--verify", "--deep", "--strict", join(output, app)],
			{ signal },
		);
		return binary;
	}
	await mkdir(dirname(output), { recursive: true });
	const staging = await mkdtemp(join(dirname(output), ".prepare-"));
	try {
		const ready = join(staging, "ready"),
			contents = join(ready, app, "Contents");
		await mkdir(join(contents, "MacOS"), { recursive: true });
		const source = join(staging, "permissions.m");
		await writeFile(source, permissionPanelSource);
		await writeFile(
			join(contents, "Info.plist"),
			`<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>amazme-permissions</string>
<key>CFBundleIdentifier</key><string>com.amazme.computer-use.permissions</string>
<key>CFBundleName</key><string>AmazMe Permissions</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>`,
		);
		await execute(
			"/usr/bin/xcrun",
			[
				"clang",
				"-fobjc-arc",
				"-mmacosx-version-min=13.0",
				"-arch",
				"arm64",
				"-arch",
				"x86_64",
				source,
				"-framework",
				"Cocoa",
				"-o",
				join(ready, relative),
			],
			{ signal, timeout: 120_000 },
		);
		await execute(
			"/usr/bin/codesign",
			[
				"--force",
				"--sign",
				signingIdentity,
				"--options",
				"runtime",
				join(ready, app),
			],
			{ signal },
		);
		await writeFile(
			join(ready, "manifest.json"),
			JSON.stringify({
				source: key,
				binary: hash(await readFile(join(ready, relative))),
			}),
		);
		await rename(ready, output);
		return binary;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export interface PanelStatus {
	status: "ready" | "permission_required" | "unknown";
	missing: string[];
	host_path?: string;
}

/** UI-only process. Its only inbound request is a read-only permission refresh. */
export async function runPermissionPanel(
	initial: PanelStatus,
	read: (signal: AbortSignal) => Promise<PanelStatus>,
	signal: AbortSignal,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const binary = await preparePermissionPanel(undefined, signal);
	signal.throwIfAborted();
	const child = spawn(binary, [JSON.stringify(initial)], {
		env,
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lifetime = new AbortController();
	let refresh: Promise<void> | undefined;
	const lines = createInterface({ input: child.stdout });
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
	let force: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		lifetime.abort();
		child.stdin.destroy();
		child.kill("SIGTERM");
		force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
	};
	signal.addEventListener("abort", stop, { once: true });
	child.stdin.on("error", () => {}); // Closing a window can race a status response.
	lines.on("line", (line) => {
		if (line !== '{"event":"recheck"}' || refresh || lifetime.signal.aborted)
			return;
		refresh = (async () => {
			const report = await read(AbortSignal.any([signal, lifetime.signal]));
			if (!lifetime.signal.aborted && !signal.aborted)
				child.stdin.write(`${JSON.stringify(report)}\n`);
		})()
			.catch(() => {
				if (!lifetime.signal.aborted && !signal.aborted)
					child.stdin.write(
						`${JSON.stringify({ ...initial, status: "unknown" })}\n`,
					);
			})
			.finally(() => {
				refresh = undefined;
			});
	});
	try {
		if (signal.aborted) stop();
		await exited;
	} finally {
		lifetime.abort();
		lines.close();
		child.stdin.destroy();
		await refresh;
		signal.removeEventListener("abort", stop);
		if (force) clearTimeout(force);
	}
}
