import { execFile } from "node:child_process";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@amazme/ai";
import {
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { serviceFacet } from "@amazme/protocol/services";
import * as photon from "@silvia-odwyer/photon-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComputerUsePolicy,
	DEFAULT_COMPUTER_USE_SETTINGS as defaults,
	editComputerUseSettings,
	readComputerUseSettings,
} from "../plugins/computer-use/src/config.ts";
import {
	DriverClient,
	driverEnvironment,
	resolveDriverBinary,
} from "../plugins/computer-use/src/driver.ts";
import type { Classify } from "../plugins/computer-use/src/jev.ts";
import {
	chooseCandidateWithJev,
	locateWithJevCrop,
	locateWithJevTiles,
} from "../plugins/computer-use/src/jev.ts";
import {
	extractCandidates,
	visualFallbackReason,
} from "../plugins/computer-use/src/native-candidates.ts";
import {
	act,
	ComputerUseController,
	groundAndAct,
} from "../plugins/computer-use/src/runtime.ts";
import {
	configureComputerUse,
	createComputerUseExtension,
} from "../plugins/computer-use/src/session.ts";
import { createAgentExtensionsFacet } from "../src/core/plugins/agent-extensions.ts";
import {
	AgentRuntime,
	createAgentRuntime,
} from "../src/core/plugins/agent-runtime.ts";
import { createSlashCommandsRuntimeFacet } from "../src/core/plugins/command-registry.ts";
import { createSourcePluginLoader } from "../src/core/plugins/loader.ts";
import { openPluginRuntime } from "../src/core/plugins/runtime.ts";
import { SlashCommands } from "../src/core/plugins/slash-commands.ts";
import {
	ForkManagementDoc,
	withConversationAdmission,
} from "../src/durable/fork-management.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
const signal = new AbortController().signal;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const target = { pid: 7, window_id: 9 };
const policy = readComputerUseSettings({ ...defaults, enabled: true });
const coarse = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.5 };

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("Missing expected test fixture value");
	return value;
}

function picture(width = 1200, height = 1600) {
	const image = new photon.PhotonImage(
		new Uint8Array(width * height * 4).fill(255),
		width,
		height,
	);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}
function answer(answers: ClassifierResult["answers"]): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.14.0",
		stopReason: "stop",
		timestamp: 0,
		answers,
	};
}
function boxAnswer(presence = 0.99, confidence = 0.95, box = coarse) {
	return answer({
		present: { type: "bool", probability: presence },
		target: { type: "box", confidence, box },
	});
}
function deterministic(input: ClassifierContext): ClassifierResult {
	return answer(
		Object.fromEntries(
			Object.entries(input.questions).map(([id, question]) => {
				if (question.type === "box")
					return [id, { type: "box", box: coarse, confidence: 0.95 }];
				if (question.type === "bool")
					return [
						id,
						{
							type: "bool",
							probability:
								id.startsWith("risk_") || id === "goal_satisfied"
									? 0.001
									: 0.99,
						},
					];
				if (question.type === "choice") {
					const keys = Object.keys(question.criteria);
					const selected =
						keys.find((key) => key.startsWith("ax_")) ??
						keys.find((key) => key.startsWith("tile_")) ??
						"abstain";
					return [
						id,
						{
							type: "choice",
							choice: selected,
							confidence: 0.95,
							probabilities: Object.fromEntries(
								keys.map((key) => [key, key === selected ? 1 : 0]),
							),
						},
					];
				}
				throw new Error("Unexpected question");
			}),
		),
	);
}

async function fixture(mode = "native") {
	const directory = await mkdtemp(join(tmpdir(), "amcu-test-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const binary = join(directory, "driver.mjs");
	await copyFile(
		join(packageRoot, "test/fixtures/computer-use-driver.mjs"),
		binary,
	);
	await chmod(binary, 0o755);
	await writeFile(join(directory, "mode.txt"), mode);
	await writeFile(join(directory, "capture.png"), picture(800, 600));
	const create = (id: string) =>
		new DriverClient(id, { command: process.execPath, args: [binary] });
	const events = async (): Promise<
		Array<{
			event: string;
			name?: string;
			args?: Record<string, unknown>;
			pid?: number;
			secretsPresent?: boolean;
			telemetry?: string;
		}>
	> =>
		(await readFile(join(directory, "events.jsonl"), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return { create, events, directory, binary };
}

async function setup(install = true, mode = "native") {
	const native = await fixture(mode);
	const models = createModels(),
		faux = fauxProvider();
	models.setProvider(faux.provider);
	const classify = vi.fn<Classify>(async (input) => deterministic(input));
	const model: ClassifierModel<"typesafe-system-one"> = {
		type: "classifier",
		id: "jev-1.14.0",
		name: "Jev",
		provider: "typesafe",
		api: "typesafe-system-one",
		baseUrl: "https://never-network.test",
		input: ["text", "image"],
		contextWindow: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	models.setProvider(
		createProvider({
			id: "typesafe",
			models: [model],
			auth: {
				apiKey: {
					name: "Fixture",
					resolve: async () => ({ auth: { apiKey: "fixture" } }),
				},
			},
			classifiers: {
				"typesafe-system-one": {
					classify: (_model, input, options) =>
						classify(input, options?.signal),
				},
			},
		}),
	);
	const registry = createRegistry();
	const controller = new ComputerUseController(native.create);
	if (install) registry.install(createComputerUseExtension(controller));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ registry, models },
		context,
	);
	cleanups.push(async () => {
		await harness.close(context);
		await controller.dispose();
	});
	controller.bind(harness);
	const root = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	let selected = root.id;
	const runtime = createAgentRuntime(
		harness,
		() => selected,
		() => false,
	);
	const ask = async (
		name: string,
		args: Parameters<typeof fauxToolCall>[1],
	) => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const input = await root.submit(
			{
				type: "input",
				content: "fixture action",
				entry: { kind: "client.input" },
			},
			context,
		);
		expect((await input.wait(context)).status).toBe("done");
	};
	return {
		native,
		models,
		faux,
		classify,
		registry,
		controller,
		harness,
		root,
		runtime,
		ask,
		select: (id: typeof selected) => {
			selected = id;
		},
	};
}

describe("computer-use policy and plugin lifecycle", () => {
	it.skipIf(process.platform !== "darwin")(
		"blocks a missing grant before captures or Jev and requires a new request after granting",
		async () => {
			const s = await setup(true, "missing-permissions");
			await configureComputerUse(s.runtime, "on", context, s.controller);
			await s.ask("cu_ground_and_act", {
				target,
				goal: "Increment",
				verification: "Counter 1",
			});
			expect(s.classify).not.toHaveBeenCalled();
			expect(s.faux.getPendingResponseCount()).toBe(1);
			expect(
				(await s.native.events())
					.filter((event) => event.event === "call")
					.map((event) => event.name),
			).toEqual(["check_permissions", "end_session"]);
			await writeFile(join(s.native.directory, "mode.txt"), "native");
			await new Promise((resolve) => setImmediate(resolve));
			expect(
				(await s.native.events()).filter((event) => event.name === "click"),
			).toHaveLength(0);
			await s.ask("cu_observe", { action: "window", target });
			expect(
				(await s.native.events()).filter(
					(event) => event.name === "get_window_state",
				),
			).toHaveLength(1);
		},
	);
	it("pins the command conversation before a queued operation and a selection change", async () => {
		const s = await setup();
		await s.root.submit(
			{ type: "write", entry: { kind: "marker", data: {} } },
			context,
		);
		const entry = required(
			(await s.root.entries({}, 1, undefined, context)).items[0],
		).id;
		const fork = await s.root.fork(
			entry,
			{ ownership: { kind: "ownerless" } },
			context,
		);
		let release!: () => void;
		const blocker = s.controller.serial(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const update = configureComputerUse(s.runtime, "on", context, s.controller);
		await new Promise((resolve) => setImmediate(resolve));
		s.select(fork.id);
		release();
		await blocker;
		await update;
		expect(
			(await s.harness.snapshot(ComputerUsePolicy, s.root.id, context))
				?.enabled,
		).toBe(true);
		expect(
			await s.harness.snapshot(ComputerUsePolicy, fork.id, context),
		).toBeUndefined();
	});

	it("restores policy from disk without restoring native snapshots or starting a process", async () => {
		const native = await fixture();
		const file = join(native.directory, "session.sqlite");
		const models = createModels(),
			harness = await Harness.open(
				await openNodeSqliteStorage(file),
				{ models, registry: createRegistry() },
				context,
			);
		const root = await harness.root(context);
		const runtime = createAgentRuntime(
			harness,
			() => root.id,
			() => false,
		);
		try {
			await configureComputerUse(
				runtime,
				'{"enabled":true,"minPresence":0.95}',
				context,
			);
		} finally {
			await harness.close(context);
		}
		const reopened = await Harness.open(
			await openNodeSqliteStorage(file),
			{ models, registry: createRegistry() },
			context,
		);
		try {
			expect(
				await reopened.snapshot(
					ComputerUsePolicy,
					(await reopened.root(context)).id,
					context,
				),
			).toMatchObject({ enabled: true, minPresence: 0.95 });
			expect(await native.events()).toEqual([]);
		} finally {
			await reopened.close(context);
		}
	});
	it("rejects invalid and unknown settings, persists only command changes and serializes with archive admission", async () => {
		expect(defaults.enabled).toBe(false);
		for (const patch of [
			'{"minPresence":-0.1}',
			'{"minBoxConfidence":2}',
			'{"unknown":true}',
			'{"enabled":"yes"}',
			'{"allowRiskCategories":["other"]}',
			'{"timeoutMs":0}',
		])
			expect(() => editComputerUseSettings(policy, patch)).toThrow();
		const setupResult = await setup();
		await configureComputerUse(
			setupResult.runtime,
			"on",
			context,
			setupResult.controller,
		);
		expect(
			(
				await setupResult.harness.snapshot(
					ComputerUsePolicy,
					setupResult.root.id,
					context,
				)
			)?.enabled,
		).toBe(true);
		let release!: () => void, entered!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const archive = withConversationAdmission(
			setupResult.harness,
			context,
			async () => {
				entered();
				await held;
				await setupResult.harness.commit(async (tx) => {
					(await tx.doc(ForkManagementDoc)).forks[String(setupResult.root.id)] =
						{ archivedAt: 1 };
				}, context);
			},
		);
		await ready;
		const configure = configureComputerUse(
			setupResult.runtime,
			"off",
			context,
			setupResult.controller,
		);
		release();
		await archive;
		await expect(configure).rejects.toThrow(/archiv|归档/iu);
		expect(
			(
				await setupResult.harness.snapshot(
					ComputerUsePolicy,
					setupResult.root.id,
					context,
				)
			)?.enabled,
		).toBe(true);
	});

	it("rejects every tool while disabled without starting a driver or resolving Jev", async () => {
		const s = await setup();
		await s.ask("cu_observe", { action: "window", target });
		await s.ask("cu_locate", {
			target,
			capture_id: "missing",
			description: "Increment",
		});
		await s.ask("cu_act", {
			target,
			capture_id: "missing",
			intent: "Increment",
			actions: [{ action: "click", x: 10, y: 10 }],
		});
		await s.ask("cu_ground_and_act", {
			target,
			goal: "Increment",
			verification: "Counter is 1",
		});
		expect(await s.native.events()).toEqual([]);
		expect(s.classify).not.toHaveBeenCalled();
		for (const tool of required(
			required(s.registry.snapshot().extension("computer-use")).tools,
		)) {
			expect(tool.executionMode).toBe("sequential");
			expect(tool.replay).toBe("unsafe");
		}
	});

	it("loads the real package through host externals, reloads registrations and cleans up native children", async () => {
		const s = await setup(false);
		vi.stubEnv("AMAZME_CUA_DRIVER_PATH", s.native.binary);
		const plugin = await openPluginRuntime(
			[
				createAgentExtensionsFacet(s.registry),
				createSlashCommandsRuntimeFacet(),
				serviceFacet("cu-test-runtime", AgentRuntime, [], () => ({
					value: s.runtime,
				})),
			],
			createSourcePluginLoader([join(packageRoot, "plugins/computer-use")]),
		);
		try {
			await plugin.services.scope.ready();
			const commands = plugin.services.get(SlashCommands);
			expect(commands.list().map((command) => command.name)).toEqual([
				"computer-use",
			]);
			await required(commands.list()[0]).run("on", context);
			await s.ask("cu_observe", { action: "window", target });
			await plugin.reload();
			expect(commands.list()).toHaveLength(1);
			expect(
				(await s.native.events()).filter(
					(event) => event.name === "end_session",
				),
			).toHaveLength(2);
			expect(
				(await s.native.events()).filter((event) => event.event === "exited"),
			).toHaveLength(2);
			await s.ask("cu_observe", { action: "window", target });
		} finally {
			await plugin.close();
		}
		expect(s.registry.snapshot().extension("computer-use")).toBeUndefined();
		expect(
			(await s.native.events()).filter((event) => event.name === "end_session"),
		).toHaveLength(3);
	});
	it("offers setup while disabled without enabling control and reports missing grants on enable", async () => {
		const s = await setup(false, "missing-permissions");
		vi.stubEnv("AMAZME_CUA_DRIVER_PATH", s.native.binary);
		const plugin = await openPluginRuntime(
			[
				createAgentExtensionsFacet(s.registry),
				createSlashCommandsRuntimeFacet(),
				serviceFacet("cu-test-runtime", AgentRuntime, [], () => ({
					value: s.runtime,
				})),
			],
			createSourcePluginLoader([join(packageRoot, "plugins/computer-use")]),
		);
		try {
			await plugin.services.scope.ready();
			const command = required(plugin.services.get(SlashCommands).list()[0]);
			expect(await command.run("setup", context)).toMatchObject({
				note: expect.stringContaining("Computer-use 未开启"),
			});
			expect(
				await s.harness.snapshot(ComputerUsePolicy, s.root.id, context),
			).toBeUndefined();
			const enabled = await command.run("on", context);
			expect(enabled).toMatchObject({
				note: expect.stringContaining("等待系统授权"),
			});
			expect(s.classify).not.toHaveBeenCalled();
			expect(
				(await s.native.events())
					.filter((event) => event.event === "call")
					.map((event) => event.name),
			).toEqual([
				"check_permissions",
				"end_session",
				"check_permissions",
				"end_session",
			]);
		} finally {
			await plugin.close();
		}
	});

	it("off and harness close retire the session; tool calls retain one deterministic session", async () => {
		const s = await setup();
		await configureComputerUse(s.runtime, "on", context, s.controller);
		await Promise.all([s.ask("cu_observe", { action: "window", target })]);
		await configureComputerUse(s.runtime, "off", context, s.controller);
		await configureComputerUse(s.runtime, "on", context, s.controller);
		await s.ask("cu_observe", { action: "window", target });
		await s.harness.close(context);
		await s.controller.dispose();
		const events = await s.native.events();
		expect(events.filter((event) => event.name === "end_session")).toHaveLength(
			2,
		);
		expect(events.filter((event) => event.event === "exited")).toHaveLength(2);
		expect(
			new Set(
				events
					.filter((event) => event.event === "call")
					.map((event) => event.args?.session),
			).size,
		).toBe(1);
	});
});

describe("driver observations and policy-bound actions", () => {
	it
		.skipIf(process.platform !== "darwin")
		.each([
			"native",
			"hung-host",
			"hung-service",
			"hung-probe-cancel",
			"hung-probe-timeout",
		])(
		"owns an embedded host and joins its shutdown in %s mode without starting a service for diagnostics",
		async (mode) => {
			const native = await fixture();
			const contents = join(
					native.directory,
					"AmazMe Computer Use.app/Contents",
				),
				bin = join(contents, "MacOS");
			await mkdir(bin, { recursive: true });
			await writeFile(join(bin, "package.json"), '{"type":"module"}');
			await writeFile(
				join(contents, "Info.plist"),
				"<plist><dict><key>CFBundleExecutable</key><string>amazme-computer-use</string><key>CFBundleIdentifier</key><string>com.amazme.computer-use</string></dict></plist>",
			);
			for (const [from, to] of [
				["test/fixtures/computer-use-driver.mjs", "cua-driver"],
			]) {
				await copyFile(join(packageRoot, from), join(bin, to));
				await chmod(join(bin, to), 0o755);
			}
			await promisify(execFile)("/usr/bin/clang", [
				"-fobjc-arc",
				"-fblocks",
				"-framework",
				"Cocoa",
				join(packageRoot, "test/fixtures/computer-use-host.m"),
				"-o",
				join(bin, "amazme-computer-use"),
			]);
			if (mode === "hung-service") {
				await copyFile(
					join(bin, "cua-driver"),
					join(bin, "driver-fixture.mjs"),
				);
				await copyFile(
					join(bin, "amazme-computer-use"),
					join(bin, "cua-driver"),
				);
				await writeFile(join(bin, "node-path.txt"), process.execPath);
			}
			await copyFile(
				join(native.directory, "capture.png"),
				join(bin, "capture.png"),
			);
			await writeFile(join(bin, "mode.txt"), mode);
			const driver = new DriverClient("embedded", {
				command: join(bin, "cua-driver"),
			});
			cleanups.push(() => driver.dispose());
			const events = async (): Promise<
				Array<{
					event: string;
					socket?: string;
					argv?: string[];
					directoryMode?: number;
					pid?: number;
				}>
			> =>
				(await readFile(join(bin, "events.jsonl"), "utf8").catch(() => ""))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			if (mode.startsWith("hung-probe")) {
				const controller = new AbortController();
				const probe = driver.permissions(
					mode.endsWith("timeout") ? 1500 : 5000,
					controller.signal,
				);
				const rejected = expect(probe).rejects.toThrow();
				await vi.waitFor(async () =>
					expect(
						(await events()).find((event) => event.event === "probe"),
					).toBeDefined(),
				);
				if (mode.endsWith("cancel")) controller.abort();
				await rejected;
				const diagnostic = required(
					(await events()).find((event) => event.event === "probe"),
				);
				expect(() => process.kill(required(diagnostic.pid), 0)).toThrow();
				expect((await events()).map((event) => event.event)).toEqual(["probe"]);
				return;
			}
			expect(
				(await driver.permissions(3000, signal)).structuredContent,
			).toMatchObject({ accessibility: false });
			expect((await events()).map((event) => event.event)).toEqual(["probe"]);
			await driver.observe(target, 3000, signal);
			const host = required(
				(await events()).find((event) => event.event === "host-started"),
			);
			const service = (await events()).find(
				(event) => event.event === "service-started",
			);
			if (mode === "hung-service") expect(service).toBeDefined();
			expect(host.directoryMode).toBe(0o700);
			expect(
				(await events()).find((event) => event.event === "started")?.argv,
			).toEqual([
				"mcp",
				"--embedded",
				"--socket",
				host.socket,
				"--host-bundle-id",
				"com.amazme.computer-use",
			]);
			await driver.dispose();
			if (mode === "native")
				expect((await events()).map((event) => event.event)).toContain(
					"host-exited",
				);
			expect(() => process.kill(required(host.pid), 0)).toThrow();
			if (service)
				expect(() => process.kill(required(service.pid), 0)).toThrow();
			await expect(stat(required(host.socket))).rejects.toThrow();
		},
		15_000,
	);

	it("cancels a pending native action without retry and joins child shutdown", async () => {
		const native = await fixture("slow"),
			driver = native.create("cancelled");
		cleanups.push(() => driver.dispose());
		const snapshot = await driver.observe(target, 3000, signal);
		await expect(
			act(
				driver,
				snapshot.captureId,
				snapshot.snapshotId,
				target,
				"Increment",
				[{ action: "click", element_token: "s1:1" }],
				undefined,
				policy,
				AbortSignal.timeout(50),
			),
		).rejects.toThrow();
		await driver.dispose();
		expect(driver.snapshot).toBeUndefined();
		expect(
			(await native.events()).filter((event) => event.name === "click"),
		).toHaveLength(1);
		expect(
			(await native.events()).filter((event) => event.event === "exited"),
		).toHaveLength(1);
	});

	it("rejects malformed observations without caching their image or tokens", async () => {
		const native = await fixture("mismatch"),
			driver = native.create("mismatch");
		cleanups.push(() => driver.dispose());
		await expect(driver.observe(target, 3000, signal)).rejects.toThrow(
			/another window/u,
		);
		expect(driver.snapshot).toBeUndefined();
	});
	it("sanitizes the child environment and rejects invalid explicit binaries", async () => {
		expect(
			driverEnvironment({
				PATH: "/bin",
				TYPESAFE_API_KEY: "secret",
				OPENAI_API_KEY: "secret",
				DISPLAY: ":0",
			}),
		).toEqual({
			PATH: "/bin",
			DISPLAY: ":0",
			CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
			CUA_TELEMETRY_ENABLED: "false",
		});
		await expect(
			resolveDriverBinary({
				env: { AMAZME_CUA_DRIVER_PATH: "/missing-native-fixture" },
			}),
		).rejects.toThrow(/executable/u);
		const native = await fixture();
		const driver = native.create("conversation");
		cleanups.push(() => driver.dispose());
		vi.stubEnv("TYPESAFE_API_KEY", "private-value");
		await driver.observe(target, 3000, signal);
		expect((await native.events())[0]).toMatchObject({
			secretsPresent: false,
			telemetry: "false",
		});
	});

	it("filters risk and chrome controls, keeps IDs stable across index changes and omits ambiguous controls", async () => {
		const native = await fixture();
		const driver = native.create("candidates");
		cleanups.push(() => driver.dispose());
		const snapshot = await driver.observe(target, 3000, signal);
		const candidates = extractCandidates(snapshot, policy);
		expect(candidates.map((entry) => entry.label)).toEqual([
			"Increment",
			"Title",
		]);
		expect(
			extractCandidates(snapshot, {
				...policy,
				allowRiskCategories: ["destructive", "send"],
			}).map((entry) => entry.label),
		).toContain("Delete");
		const remapped = {
			...snapshot,
			elements: snapshot.elements.map((element) => ({
				...element,
				element_index: Number(element.element_index) + 20,
				parent_index:
					element.parent_index === undefined
						? undefined
						: Number(element.parent_index) + 20,
			})),
		};
		expect(
			extractCandidates(remapped, policy).map((entry) => entry.id),
		).toEqual(candidates.map((entry) => entry.id));
		const chrome = {
			...snapshot,
			elements: [
				...snapshot.elements,
				{ role: "TitleBar", element_index: 90, parent_index: 0 },
				{
					...snapshot.elements[1],
					parent_index: 90,
					label: "Maximize",
					element_index: 91,
				},
				{
					...snapshot.elements[1],
					label: "Hidden",
					enabled: false,
					element_index: 92,
				},
				{
					...snapshot.elements[1],
					label: "Offscreen",
					frame: { x: -1000, y: -1000, w: 1, h: 1 },
					element_index: 93,
				},
			],
		};
		expect(
			extractCandidates(chrome, policy).map((entry) => entry.label),
		).toEqual(["Increment", "Title"]);
		expect(
			extractCandidates(
				{
					...snapshot,
					elements: [...snapshot.elements, required(snapshot.elements[1])],
				},
				policy,
			).map((entry) => entry.label),
		).not.toContain("Increment");
		expect(visualFallbackReason({ elements: [], treeMarkdown: "" }, [])).toBe(
			"ax_tree_empty",
		);
	});

	it.each(["window", "desktop"])(
		"preserves screenshot pixels for %s scroll and drag",
		async (scope) => {
			const native = await fixture();
			const driver = native.create(`pixels-${scope}`);
			cleanups.push(() => driver.dispose());
			const window = scope === "window" ? target : undefined;
			const settings = { ...policy, allowForeground: scope === "desktop" };
			const delivery_mode =
				scope === "desktop" ? ("foreground" as const) : ("background" as const);
			const classify: Classify = async (input) => deterministic(input);
			for (const action of [
				{
					action: "scroll" as const,
					x: 600,
					y: 450,
					direction: "down" as const,
					amount: 2,
					delivery_mode,
				},
				{
					action: "drag" as const,
					x: 600,
					y: 450,
					to_x: 700,
					to_y: 500,
					delivery_mode,
				},
			]) {
				const snapshot = await driver.observe(window, 3000, signal);
				if (window)
					expect(snapshot.windowBounds?.width).toBe(snapshot.width / 2);
				else expect(snapshot.windowBounds).toBeUndefined();
				expect(
					await act(
						driver,
						snapshot.captureId,
						snapshot.snapshotId,
						window,
						"Move within the test surface",
						[action],
						classify,
						settings,
						signal,
					),
				).toMatchObject({ status: "acted", applied: 1 });
			}
			const events = (await native.events()).filter((event) =>
				["scroll", "drag"].includes(event.name ?? ""),
			);
			expect(events[0].args).toMatchObject({
				x: 600,
				y: 450,
				direction: "down",
				amount: 2,
				delivery_mode,
			});
			expect(events[1].args).toMatchObject({
				from_x: 600,
				from_y: 450,
				to_x: 700,
				to_y: 500,
				delivery_mode,
			});
		},
	);

	it("scrolls using a fresh AX token without requiring pixel coordinates", async () => {
		const native = await fixture();
		const driver = native.create("token-scroll");
		cleanups.push(() => driver.dispose());
		const snapshot = await driver.observe(target, 3000, signal);
		expect(
			await act(
				driver,
				snapshot.captureId,
				snapshot.snapshotId,
				target,
				"Scroll the text field",
				[
					{
						action: "scroll",
						element_token: "s1:4",
						direction: "down",
						amount: 2,
					},
				],
				async (input) => deterministic(input),
				policy,
				signal,
			),
		).toMatchObject({ status: "acted", applied: 1 });
		const args = required(
			(await native.events()).find((event) => event.name === "scroll")?.args,
		);
		expect(args).toMatchObject({
			element_token: "s1:4",
			direction: "down",
			delivery_mode: "background",
		});
		expect(args).not.toHaveProperty("x");
		expect(args).not.toHaveProperty("y");
	});

	it("rejects cross-window, expired, disallowed-token and foreground actions before dispatch", async () => {
		const native = await fixture();
		const driver = native.create("actions");
		cleanups.push(() => driver.dispose());
		const snapshot = await driver.observe(target, 3000, signal);
		const go = (
			actions: Parameters<typeof act>[5],
			capture = snapshot.captureId,
			window = target,
		) =>
			act(
				driver,
				capture,
				snapshot.snapshotId,
				window,
				"Increment",
				actions,
				undefined,
				policy,
				signal,
			);
		await expect(
			go([{ action: "click", element_token: "s1:1" }], "old"),
		).rejects.toThrow(/Stale/u);
		await expect(
			go([{ action: "click", element_token: "s1:1" }], snapshot.captureId, {
				pid: 8,
				window_id: 9,
			}),
		).rejects.toThrow(/mismatch/u);
		await expect(
			go([{ action: "click", element_token: "s1:2" }]),
		).rejects.toThrow(/excluded/u);
		await expect(
			go([
				{ action: "click", element_token: "s1:1", delivery_mode: "foreground" },
			]),
		).rejects.toThrow(/Foreground/u);
		await expect(go([{ action: "click", x: 800, y: 0 }])).rejects.toThrow(
			/outside/u,
		);
		snapshot.observedAt -= 60_000;
		await expect(
			go([{ action: "click", element_token: "s1:1" }]),
		).rejects.toThrow(/Stale/u);
		expect(
			(await native.events()).filter((event) => event.name === "click"),
		).toHaveLength(0);
	});

	it("prefers tokens, binds atomic pixels, refreshes batch tokens and never escalates a refusal", async () => {
		const native = await fixture();
		const driver = native.create("batch");
		cleanups.push(() => driver.dispose());
		let snapshot = await driver.observe(target, 3000, signal);
		expect(
			await act(
				driver,
				snapshot.captureId,
				snapshot.snapshotId,
				target,
				"edit title",
				[
					{ action: "set_value", element_token: "s1:4", value: "hello" },
					{ action: "type_text", element_token: "s1:4", text: " world" },
				],
				undefined,
				policy,
				signal,
			),
		).toMatchObject({ status: "acted", applied: 2 });
		const written = (await native.events()).filter((event) =>
			["set_value", "type_text"].includes(event.name ?? ""),
		);
		expect(written.map((event) => event.args?.element_token)).toEqual([
			"s1:4",
			"s2:4",
		]);
		expect(written[0].args).not.toHaveProperty("delivery_mode");
		expect(written[1].args).toHaveProperty("delivery_mode", "background");
		snapshot = await driver.observe(target, 3000, signal);
		await act(
			driver,
			snapshot.captureId,
			snapshot.snapshotId,
			target,
			"Increment",
			[{ action: "click", element_token: "s3:1", x: 30, y: 40 }],
			undefined,
			policy,
			signal,
		);
		expect(
			(await native.events()).find((event) => event.name === "click")?.args,
		).toMatchObject({
			element_token: "s3:1",
			target: { kind: "window", ...target },
			delivery_mode: "background",
		});
		expect(driver.snapshot).toBeUndefined();
		snapshot = await driver.observe(target, 3000, signal);
		await act(
			driver,
			snapshot.captureId,
			snapshot.snapshotId,
			target,
			"Increment",
			[{ action: "click", x: 10, y: 20 }],
			async (input) => deterministic(input),
			policy,
			signal,
		);
		expect(
			(await native.events()).filter((event) => event.name === "click").at(-1)
				?.args,
		).toMatchObject({ x: 10, y: 20, capture_id: snapshot.captureId });
		const refusal = await fixture("refuse");
		const refused = refusal.create("refusal");
		cleanups.push(() => refused.dispose());
		const before = await refused.observe(target, 3000, signal);
		expect(
			await act(
				refused,
				before.captureId,
				before.snapshotId,
				target,
				"Increment",
				[{ action: "click", element_token: "s1:1" }],
				undefined,
				policy,
				signal,
			),
		).toMatchObject({ status: "review", applied: 0 });
		expect(
			(await refusal.events()).filter((event) => event.name === "click"),
		).toHaveLength(1);
	});

	it("takes the AX and empty-tree visual paths and independently verifies the resulting observation", async () => {
		for (const mode of ["native", "noax", "pinned"]) {
			const native = await fixture(mode);
			const driver = native.create(mode);
			cleanups.push(() => driver.dispose());
			const classify = vi.fn<Classify>(async (input) => deterministic(input));
			const completed = await groundAndAct(
				driver,
				target,
				"Increment",
				"Counter is 1",
				"click",
				undefined,
				classify,
				policy,
				signal,
			);
			expect(completed).toMatchObject({
				status: "verified",
				acted: true,
				capture_id: "capture-2",
			});
			expect(completed.calls).toHaveLength(classify.mock.calls.length);
			const events = (await native.events()).filter(
				(event) => event.event === "call",
			);
			expect(events.map((event) => event.name)).toEqual([
				"get_window_state",
				"click",
				"get_window_state",
			]);
			expect(events[1].args).toMatchObject(
				mode !== "noax"
					? { element_token: "s1:1" }
					: { capture_id: "capture-1" },
			);
			expect(classify.mock.calls.at(-1)?.[0].questions).toHaveProperty(
				"verified",
			);
			const riskContext = required(
				classify.mock.calls.find(
					([input]) =>
						Object.hasOwn(input.questions, "risk_destructive") &&
						!Object.hasOwn(input.questions, "candidate"),
				),
			)[0];
			const { session: _session, ...parameters } = required(events[1].args);
			expect(riskContext.state).toMatchObject({
				action: { tool: "click", parameters },
			});
		}
	});

	it("does not act or visually bypass an unsafe or uncertain AX choice, and does not claim dispatch as verification", async () => {
		for (const kind of ["risk", "choice", "verification"]) {
			const native = await fixture(),
				driver = native.create(kind);
			cleanups.push(() => driver.dispose());
			const classify: Classify = async (input) => {
				const response = deterministic(input);
				if (kind === "risk" && response.answers.risk_send)
					response.answers.risk_send = { type: "bool", probability: 0.99 };
				if (kind === "choice" && response.answers.candidate?.type === "choice")
					response.answers.candidate.confidence = 0.1;
				if (kind === "verification" && response.answers.verified)
					response.answers.verified = { type: "bool", probability: 0.1 };
				return response;
			};
			const completed = await groundAndAct(
				driver,
				target,
				"Increment",
				"Counter is 1",
				"click",
				undefined,
				classify,
				policy,
				signal,
			);
			expect(completed.status).toBe("review");
			expect(
				(await native.events()).filter((event) => event.name === "click"),
			).toHaveLength(kind === "verification" ? 1 : 0);
		}
	});

	it("preserves successful dispatch when a later observation or verification request fails", async () => {
		for (const mode of ["verify-refuse", "verification-error"]) {
			const native = await fixture(mode),
				driver = native.create(mode);
			cleanups.push(() => driver.dispose());
			const classify: Classify = async (input) => {
				if (mode === "verification-error" && input.questions.verified)
					throw new Error("classifier unavailable");
				return deterministic(input);
			};
			const completed = await groundAndAct(
				driver,
				target,
				"Increment",
				"Counter is 1",
				"click",
				undefined,
				classify,
				policy,
				signal,
			);
			expect(completed).toMatchObject({
				status: "review",
				acted: true,
				verified: false,
			});
			expect(completed).toHaveProperty(
				"reason",
				expect.stringContaining("verification failed"),
			);
			expect(driver.snapshot).toBeUndefined();
			expect(
				(await native.events()).filter((event) => event.name === "click"),
			).toHaveLength(1);
		}
	});
});

describe("Jev crop, tiles and closed candidate decisions", () => {
	it("corrects EXIF rotation before coarse encoding and maps fine coordinates in the upright original", async () => {
		const image = photon.PhotonImage.new_from_byteslice(picture());
		let jpeg: Uint8Array;
		try {
			jpeg = image.get_bytes_jpeg(90);
		} finally {
			image.free();
		}
		const exif = Buffer.concat([
			Buffer.from("Exif\0\0"),
			Buffer.from(
				"49492a0008000000010012010300010000000600000000000000",
				"hex",
			),
		]);
		const segment = Buffer.alloc(exif.length + 4);
		segment[0] = 0xff;
		segment[1] = 0xe1;
		segment.writeUInt16BE(exif.length + 2, 2);
		segment.set(exif, 4);
		const bytes = Buffer.concat([
			jpeg.subarray(0, 2),
			segment,
			jpeg.subarray(2),
		]);
		const classify = vi
			.fn<Classify>()
			.mockResolvedValueOnce(boxAnswer())
			.mockResolvedValueOnce(
				boxAnswer(0.99, 0.95, { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }),
			);
		expect(
			(await locateWithJevCrop(bytes, "control", classify, policy, signal)).box,
		).toEqual([336, 228, 1104, 612]);
		const uploaded = photon.PhotonImage.new_from_byteslice(
			Buffer.from(
				Object.values(required(classify.mock.calls[0][0].assets))[0].data,
				"base64",
			),
		);
		try {
			expect([uploaded.get_width(), uploaded.get_height()]).toEqual([640, 480]);
		} finally {
			uploaded.free();
		}
	});
	it("maps two-stage crops exactly and keeps every uploaded image within the strict size limits", async () => {
		const classify = vi
			.fn<Classify>()
			.mockResolvedValueOnce(boxAnswer())
			.mockResolvedValueOnce(
				boxAnswer(0.99, 0.95, { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }),
			);
		const found = await locateWithJevCrop(
			picture(),
			"control",
			classify,
			policy,
			signal,
		);
		expect(found.status).toBe("located");
		expect(found.box).toEqual([252, 304, 828, 816]);
		for (const [input] of classify.mock.calls) {
			expect(input.questions.present.type).toBe("bool");
			expect(input.questions.target.type).toBe("box");
			for (const asset of Object.values(input.assets ?? {})) {
				const image = photon.PhotonImage.new_from_byteslice(
					Buffer.from(asset.data, "base64"),
				);
				try {
					const w = image.get_width(),
						h = image.get_height();
					expect(Math.min(w, h)).toBeGreaterThanOrEqual(280);
					expect(Math.max(w, h)).toBeLessThanOrEqual(1568);
					expect(w * h).toBeGreaterThanOrEqual(78_400);
				} finally {
					image.free();
				}
			}
		}
	});

	it("pads small crops to 280px, handles 279px inputs and refuses low probabilities without a fine request", async () => {
		const classify = vi.fn<Classify>(async () =>
			boxAnswer(0.99, 0.95, { left: 0.48, top: 0.48, right: 0.5, bottom: 0.5 }),
		);
		expect(
			(
				await locateWithJevCrop(
					picture(279, 500),
					"control",
					classify,
					policy,
					signal,
				)
			).status,
		).toBe("located");
		for (const [input] of classify.mock.calls)
			for (const asset of Object.values(input.assets ?? {})) {
				const image = photon.PhotonImage.new_from_byteslice(
					Buffer.from(asset.data, "base64"),
				);
				try {
					expect(
						Math.min(image.get_width(), image.get_height()),
					).toBeGreaterThanOrEqual(280);
				} finally {
					image.free();
				}
			}
		for (const response of [
			boxAnswer(0.79),
			boxAnswer(0.99, 0.69),
			boxAnswer(Number.NaN),
		]) {
			const rejected = vi.fn<Classify>().mockResolvedValue(response);
			expect(
				(
					await locateWithJevCrop(
						picture(400, 400),
						"control",
						rejected,
						policy,
						signal,
					)
				).status,
			).toBe("review");
			expect(rejected).toHaveBeenCalledOnce();
		}
	});

	it("maps overlapping 2x2 tiles back to the original and includes all required fallback choices", async () => {
		const classify = vi.fn<Classify>(async (input) => {
			if (input.questions.tile?.type === "choice") {
				const keys = Object.keys(input.questions.tile.criteria);
				expect(keys).toEqual(
					expect.arrayContaining([
						"tile_0_0",
						"tile_0_1",
						"tile_1_0",
						"tile_1_1",
						"none",
						"reobserve",
						"abstain",
					]),
				);
				return answer({
					tile: {
						type: "choice",
						choice: "tile_1_1",
						confidence: 0.95,
						probabilities: Object.fromEntries(
							keys.map((key) => [key, key === "tile_1_1" ? 1 : 0]),
						),
					},
				});
			}
			return boxAnswer(0.99, 0.95, { left: 0, top: 0, right: 1, bottom: 1 });
		});
		const found = await locateWithJevTiles(
			picture(1200, 1600),
			"control",
			classify,
			policy,
			signal,
		);
		expect(found).toMatchObject({
			status: "located",
			box: [568, 768, 1200, 1600],
			x: 884,
			y: 1184,
		});
	});

	it("abstains for out-of-set choices, malformed distributions, low confidence and cancellation", async () => {
		const candidates = [
			{
				id: "ax_fixture",
				role: "button" as const,
				label: "Increment",
				elementToken: "s1:1",
			},
		];
		for (const choice of ["untrusted", "ax_fixture"]) {
			const classify: Classify = async (input) => {
				const result = deterministic(input);
				result.answers.candidate = {
					type: "choice",
					choice,
					confidence: choice === "untrusted" ? 1 : 0.69,
					probabilities: { [choice]: 1 },
				};
				return result;
			};
			expect(
				(
					await chooseCandidateWithJev(
						"Increment",
						"tree",
						candidates,
						classify,
						policy,
						signal,
					)
				).choice,
			).toBe("abstain");
		}
		const aborted = new AbortController();
		aborted.abort();
		const classify = vi.fn<Classify>();
		await expect(
			locateWithJevCrop(
				picture(400, 400),
				"control",
				classify,
				policy,
				aborted.signal,
			),
		).rejects.toThrow();
		expect(classify).not.toHaveBeenCalled();
	});
});
