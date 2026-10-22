import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as photon from "@silvia-odwyer/photon-node";
import { DEFAULT_COMPUTER_USE_SETTINGS } from "../packages/coding-agent/plugins/computer-use/src/config.ts";
import {
	DriverClient,
	resolveDriverBinary,
} from "../packages/coding-agent/plugins/computer-use/src/driver.ts";
import {
	installationRoot,
	readInstallation,
} from "../packages/coding-agent/plugins/computer-use/src/installation.ts";
import {
	createBuildWorkspace,
	directoryInUse,
} from "../packages/coding-agent/plugins/computer-use/src/maintenance.ts";
import { extractCandidates } from "../packages/coding-agent/plugins/computer-use/src/native-candidates.ts";
import { act } from "../packages/coding-agent/plugins/computer-use/src/runtime.ts";
import {
	PATCH_PIN,
	patchBuild,
} from "../packages/coding-agent/plugins/computer-use/src/runtime-pin.ts";
import { prepareComputerUseBuildRoot } from "./computer-use-paths.mjs";

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "packages/coding-agent/test/fixtures");
const policy = {
	...DEFAULT_COMPUTER_USE_SETTINGS,
	enabled: true,
	jevEnabled: false,
};
const lifetime = new AbortController();
let validationLease;
const cancel = () => lifetime.abort(new Error("Live validation interrupted"));
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, cancel);
const signal = () =>
	AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);

async function waitFor(read, accept = Boolean, timeout = 12_000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		lifetime.signal.throwIfAborted();
		const value = await read();
		if (accept(value)) return value;
		await delay(100);
	}
	throw new Error("Live fixture condition timed out");
}

function blueCenter(bytes) {
	const image = photon.PhotonImage.new_from_byteslice(bytes);
	try {
		const w = image.get_width(),
			h = image.get_height(),
			pixels = image.get_raw_pixels();
		let x1 = w,
			y1 = h,
			x2 = 0,
			y2 = 0,
			count = 0;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4,
					r = pixels[i],
					g = pixels[i + 1],
					b = pixels[i + 2];
				if (b >= 130 && b <= 180 && g >= 45 && g <= 90 && r <= 45) {
					x1 = Math.min(x1, x);
					x2 = Math.max(x2, x);
					y1 = Math.min(y1, y);
					y2 = Math.max(y2, y);
					count++;
				}
			}
		assert.ok(
			count > 10_000 && x2 - x1 > 150 && y2 - y1 > 100,
			"Fixture blue canvas was not found",
		);
		return {
			x: (x1 + x2) / 2,
			y: (y1 + y2) / 2,
			width: x2 - x1,
			height: y2 - y1,
		};
	} finally {
		image.free();
	}
}

async function stopFixture(owned) {
	owned.launcher.kill("SIGTERM");
	const matching = async () => {
		const { stdout } = await execute("/bin/ps", ["-axo", "pid=,command="]);
		return stdout
			.split("\n")
			.filter((row) =>
				owned.identities.some((identity) => row.includes(identity)),
			)
			.map((row) => Number(row.trim().split(/\s+/)[0]))
			.filter(Number.isSafeInteger);
	};
	for (const pid of await matching()) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (e) {
			if (e.code !== "ESRCH") throw e;
		}
	}
	for (let i = 0; i < 50 && (await matching()).length; i++) await delay(100);
	for (const pid of await matching()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (e) {
			if (e.code !== "ESRCH") throw e;
		}
	}
	for (let i = 0; i < 20 && (await matching()).length; i++) await delay(100);
	const remaining = await matching();
	return remaining;
}

async function main() {
	if (process.platform !== "darwin")
		throw new Error("This live harness requires macOS");
	const args = process.argv.slice(2),
		options = {};
	for (let i = 0; i < args.length; i += 2) {
		if (
			!["--version", "--surface"].includes(args[i]) ||
			!args[i + 1] ||
			options[args[i]]
		)
			throw new Error(
				"Usage: verify-computer-use-macos.mjs [--version <runtime>] [--surface native|chromium|electron]",
			);
		options[args[i]] = args[i + 1];
	}
	const surface = options["--surface"];
	if (surface && !["native", "chromium", "electron"].includes(surface))
		throw new Error("Unsupported live surface");
	const version = options["--version"] ?? PATCH_PIN.version,
		{ pin } = patchBuild(version);
	const installed = await readInstallation(join(installationRoot(), version), {
		...pin,
		platform: process.platform,
		arch: process.arch,
	});
	if (!installed) throw new Error("Prepare the candidate runtime first");
	const workRoot = await prepareComputerUseBuildRoot(version);
	validationLease = await createBuildWorkspace(workRoot, version);
	const output = join(workRoot, "validation", `live-${Date.now()}`);
	await mkdir(output, { recursive: true });
	const report = {
		version,
		output,
		defaultBefore: await resolveDriverBinary(),
		steps: [],
		cleanup: [],
	};
	const save = () =>
		writeFile(
			join(output, "result.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
	const driver = new DriverClient(`macos-live-${Date.now()}`, {
		command: installed.binary,
	});
	const processes = [];
	const temporaryDirectories = [];
	let server;
	try {
		report.permissions = (
			await driver.permissions(10_000, signal())
		).structuredContent;
		await save();
		assert.equal(
			report.permissions?.accessibility,
			true,
			"Candidate needs Accessibility permission",
		);
		assert.equal(
			report.permissions?.screen_recording,
			true,
			"Candidate needs Screen Recording permission",
		);
		const app = join(output, "AmazMe Smoke.app"),
			binary = join(app, "Contents/MacOS/smoke");
		temporaryDirectories.push(app);
		await mkdir(dirname(binary), { recursive: true });
		await writeFile(
			join(app, "Contents/Info.plist"),
			`<plist><dict><key>CFBundleExecutable</key><string>smoke</string><key>CFBundleIdentifier</key><string>com.amazme.computer-use.smoke</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
		);
		await execute("/usr/bin/clang", [
			"-fobjc-arc",
			"-fblocks",
			join(fixtures, "computer-use-smoke.m"),
			"-framework",
			"Cocoa",
			"-framework",
			"ApplicationServices",
			"-o",
			binary,
		]);
		await execute("/usr/bin/codesign", ["--force", "--sign", "-", app]);
		const probe = async () =>
			JSON.parse((await execute(binary, ["--probe"])).stdout);
		const initial = await probe();
		report.initial = initial;
		const restore = async () => {
			await execute(binary, ["--activate", String(initial.frontmostPid)]);
			await delay(300);
		};
		const launch = (path, argv, identity) => {
			const child = spawn(
				"/usr/bin/open",
				[
					"-n",
					"-g",
					"-W",
					"-a",
					path,
					"--stdout",
					join(output, `fixture-${processes.length}.stdout.log`),
					"--stderr",
					join(output, `fixture-${processes.length}.stderr.log`),
					"--args",
					...argv,
				],
				{ stdio: "ignore" },
			);
			child.on("error", () => {});
			const owned = {
				identity,
				identities: [
					identity,
					...(path.startsWith(`${output}/`) ? [path] : []),
				],
				launcher: child,
			};
			processes.push(owned);
			return owned;
		};
		const stateFile = join(output, "native-state.json"),
			launcher = launch(app, [stateFile], stateFile);
		const nativeState = async () =>
			readFile(stateFile, "utf8")
				.then(JSON.parse)
				.catch(() => undefined);
		const native = await waitFor(nativeState);
		launcher.pid = native.pid;
		await restore();

		const address = (tool, target) =>
			driver.supports(tool, "target")
				? { target: { kind: "window", ...target } }
				: target;
		const snapshot = async (target, name) => {
			const snap = await driver.observe(target, 25_000, signal());
			await writeFile(join(output, `${name}.png`), snap.imageBytes);
			return snap;
		};
		async function step(name, read, action, accept, verify = () => {}) {
			const before = await read(),
				desktopBefore = await probe();
			const record = { name, before, desktopBefore };
			report.steps.push(record);
			try {
				record.result = await action();
				await save();
				record.after = await waitFor(
					read,
					(value) => value && accept(value, before),
				);
				await delay(250);
				record.desktopAfter = await probe();
				assert.equal(
					record.desktopAfter.frontmostPid,
					desktopBefore.frontmostPid,
					`${name}: foreground changed`,
				);
				assert.ok(
					Math.hypot(
						record.desktopAfter.pointerX - desktopBefore.pointerX,
						record.desktopAfter.pointerY - desktopBefore.pointerY,
					) <= 1,
					`${name}: pointer moved`,
				);
				verify(record.after);
				record.passed = true;
				console.log(`PASS ${name}`);
			} catch (error) {
				record.error = String(error);
				record.passed = false;
				console.log(`FAIL ${name}: ${error}`);
			} finally {
				record.after = await read();
				record.desktopAfter = await probe();
				await save();
			}
		}
		const nativeTarget = { pid: native.pid, window_id: native.windowId };
		async function axAction(action, label, text) {
			const snap = await snapshot(nativeTarget, `native-${action}-before`);
			const candidate = extractCandidates(snap, policy).find(
				(c) => c.label === label,
			);
			assert.ok(candidate?.elementToken, `Missing AX candidate ${label}`);
			return act(
				driver,
				snap.captureId,
				snap.snapshotId,
				nativeTarget,
				`Test fixture ${action}`,
				[
					{
						action,
						element_token: candidate.elementToken,
						...(action === "set_value" ? { value: text } : { text }),
					},
				],
				undefined,
				policy,
				signal(),
			);
		}
		async function canvasAction(
			target,
			name,
			tool,
			extra = {},
			location = 0.5,
		) {
			const snap = await snapshot(target, `${name}-before`),
				point = blueCenter(snap.imageBytes);
			point.x += (location - 0.5) * point.width;
			point.y += (location - 0.5) * point.height;
			const args = {
				...address(tool, target),
				delivery_mode: "background",
				...extra,
			};
			if (tool === "drag")
				Object.assign(args, {
					from_x: point.x - 40,
					from_y: point.y,
					to_x: point.x + 40,
					to_y: point.y,
				});
			else Object.assign(args, { x: point.x, y: point.y });
			if (driver.supports(tool, "capture_id")) args.capture_id = snap.captureId;
			return {
				point,
				args,
				response: (await driver.call(tool, args, 25_000, signal()))
					.structuredContent,
			};
		}
		if (!surface || surface === "native") {
			await step(
				"native AX click",
				nativeState,
				() => axAction("click", "Increment Native"),
				(a, b) => a.nativeCount === b.nativeCount + 1,
			);
			await step(
				"native AX value",
				nativeState,
				() => axAction("set_value", "Smoke Input", "AmazMe 0.38 live"),
				(a) => a.text === "AmazMe 0.38 live",
			);
			await step(
				"native text input",
				nativeState,
				() => axAction("type_text", "Smoke Input", " keyboard"),
				(a) => a.text.includes("keyboard"),
			);
			await step(
				"native Canvas click",
				nativeState,
				() => canvasAction(nativeTarget, "native-canvas", "click"),
				(a, b) => a.canvasCount === b.canvasCount + 1,
				(a) =>
					assert.ok(
						Math.abs(a.canvasX - 165) < 2 && Math.abs(a.canvasY - 80) < 2,
						"Native click missed canvas center",
					),
			);
			await step(
				"native Canvas scroll",
				nativeState,
				() =>
					canvasAction(nativeTarget, "native-scroll", "scroll", {
						direction: "down",
						amount: 3,
					}),
				(a, b) => a.scrollTotal === b.scrollTotal - 3,
			);
			await step(
				"native Canvas drag",
				nativeState,
				() => canvasAction(nativeTarget, "native-drag", "drag"),
				(a, b) =>
					a.dragCount > b.dragCount && a.canvasCount === b.canvasCount + 1,
				(a) =>
					assert.ok(
						Math.abs(a.dragX - 185) < 2 && Math.abs(a.dragY - 80) < 2,
						"Native drag missed its endpoint",
					),
			);
			await snapshot(nativeTarget, "native-after");
		}

		const states = new Map(),
			html = await readFile(join(fixtures, "computer-use-smoke.html"));
		server = createServer((req, res) => {
			if (req.method === "POST" && req.url === "/state") {
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
					if (body.length > 16_384) req.destroy();
				});
				req.on("end", () => {
					try {
						const state = JSON.parse(body);
						if (["chromium", "electron"].includes(state.name))
							states.set(state.name, state);
						res.end("ok");
					} catch {
						res.writeHead(400).end();
					}
				});
			} else {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(html);
			}
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		for (const name of ["chromium", "electron"].filter(
			(name) => !surface || surface === name,
		)) {
			const url = `http://127.0.0.1:${port}/?name=${name}`,
				profile = join(output, `${name}-profile`);
			temporaryDirectories.push(profile);
			let pid, browserLauncher;
			if (name === "chromium") {
				browserLauncher = launch(
					"/Applications/Google Chrome.app",
					[
						`--user-data-dir=${profile}`,
						"--no-first-run",
						"--no-default-browser-check",
						url,
					],
					profile,
				);
				pid = await waitFor(async () => {
					const { stdout } = await execute("/bin/ps", [
						"-axo",
						"pid=,command=",
					]);
					const row = stdout
						.split("\n")
						.find((row) =>
							row.includes(
								`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile}`,
							),
						);
					return row ? Number(row.trim().split(/\s+/)[0]) : undefined;
				});
			} else {
				const pidFile = join(output, "electron.pid");
				const brandedApp = join(output, "AmazMe Fixture.app");
				temporaryDirectories.push(brandedApp);
				await execute("/bin/cp", [
					"-cR",
					join(root, "node_modules/electron/dist/Electron.app"),
					brandedApp,
				]);
				const plist = join(brandedApp, "Contents/Info.plist");
				for (const [key, value] of Object.entries({
					CFBundleName: "AmazMe Fixture",
					CFBundleDisplayName: "AmazMe Fixture",
					CFBundleExecutable: "AmazMe Fixture",
					CFBundleIdentifier: "com.amazme.fixture",
				})) {
					await execute("/usr/libexec/PlistBuddy", [
						"-c",
						`Set :${key} ${value}`,
						plist,
					]);
				}
				await rename(
					join(brandedApp, "Contents/MacOS/Electron"),
					join(brandedApp, "Contents/MacOS/AmazMe Fixture"),
				);
				await execute("/usr/bin/codesign", [
					"--force",
					"--deep",
					"--sign",
					"-",
					"--preserve-metadata=entitlements,flags",
					brandedApp,
				]);
				browserLauncher = launch(
					brandedApp,
					[
						join(fixtures, "computer-use-electron.cjs"),
						"--fixture-profile",
						profile,
						"--fixture-url",
						url,
						"--fixture-pid",
						pidFile,
					],
					profile,
				);
				pid = await waitFor(
					async () =>
						Number(await readFile(pidFile, "utf8").catch(() => "")) ||
						undefined,
				);
			}
			browserLauncher.pid = pid;
			const state = async () => states.get(name);
			await waitFor(state);
			await restore();
			const windows = (
				await driver.call("list_windows", { pid }, 20_000, signal())
			).structuredContent?.windows;
			const window = windows?.find(
				(w) => w.pid === pid && w.title?.includes("AmazMe Driver Fixture"),
			);
			assert.ok(window, `${name}: fixture window missing`);
			const target = { pid, window_id: window.window_id };
			await step(
				`${name} Canvas click`,
				state,
				() => canvasAction(target, `${name}-canvas`, "click"),
				(a, b) => a.canvasCount === b.canvasCount + 1,
				(a) =>
					assert.ok(
						Math.abs(a.canvasX - 180) < 2 && Math.abs(a.canvasY - 90) < 2,
						`${name}: click missed canvas center`,
					),
			);
			await step(
				`${name} Canvas off-center click`,
				state,
				() => canvasAction(target, `${name}-quarter`, "click", {}, 0.25),
				(a, b) => a.canvasCount === b.canvasCount + 1,
				(a) =>
					assert.ok(
						Math.abs(a.canvasX - 90) < 2 && Math.abs(a.canvasY - 45) < 2,
						`${name}: click lost its requested position`,
					),
			);
			await step(
				`${name} Canvas scroll`,
				state,
				() =>
					canvasAction(target, `${name}-scroll`, "scroll", {
						direction: "down",
						amount: 3,
					}),
				(a, b) => a.scrollTotal !== b.scrollTotal,
			);
			await snapshot(target, `${name}-after`);
		}
		report.passed =
			report.steps.length > 0 && report.steps.every((step) => step.passed);
		if (!report.passed) process.exitCode = 1;
	} catch (error) {
		report.passed = false;
		report.error = String(error);
		process.exitCode = 1;
	} finally {
		await driver.dispose().catch((error) => {
			report.cleanup.push({ resource: "driver", error: String(error) });
			report.passed = false;
			process.exitCode = 1;
		});
		for (const owned of processes.reverse()) {
			try {
				const remaining = await stopFixture(owned);
				report.cleanup.push({ identity: owned.identity, remaining });
				if (remaining.length) {
					report.passed = false;
					process.exitCode = 1;
				}
			} catch (error) {
				report.cleanup.push({ identity: owned.identity, error: String(error) });
				report.passed = false;
				process.exitCode = 1;
			}
		}
		for (const directory of temporaryDirectories) {
			try {
				if (await directoryInUse(directory)) {
					report.cleanup.push({ directory, status: "busy" });
				} else {
					await rm(directory, { recursive: true });
					report.cleanup.push({ directory, status: "removed" });
				}
			} catch (error) {
				report.cleanup.push({ directory, error: String(error) });
				report.passed = false;
				process.exitCode = 1;
			}
		}
		if (server) await new Promise((resolve) => server.close(resolve));
		report.defaultAfter = await resolveDriverBinary();
		await save();
		console.log(
			JSON.stringify({
				passed: report.passed,
				error: report.error,
				report: join(output, "result.json"),
			}),
		);
	}
}

try {
	await main();
} finally {
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, cancel);
	if (validationLease) await rm(validationLease, { recursive: true });
}
