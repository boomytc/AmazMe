import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@amazme/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ExecutionEnvs } from "../src/durable/harness-setup.ts";
import { type OpenDurableResult, openDurable } from "../src/durable/runtime.ts";
import { selectSession } from "../src/durable/sessions.ts";
import {
	createSession,
	deleteSession,
	readSession,
} from "../src/host/session-catalog.ts";

const sessions = new Set<OpenDurableResult>();
const directories = new Set<string>();

async function temp(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	directories.add(path);
	return path;
}

afterEach(async () => {
	for (const session of sessions) await session.close().catch(() => {});
	sessions.clear();
	for (const path of directories)
		await rm(path, { recursive: true, force: true });
	directories.clear();
});

const done = () => fauxAssistantMessage([fauxText("done")]);

async function runtimeFor(cwd: string) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Fixture",
				check: async () => ({
					type: "api_key" as const,
					source: "env" as const,
				}),
				resolve: async () => ({ auth: {} }),
			},
		},
	});
	await runtime.refresh({ allowNetwork: false });
	const settings = SettingsManager.inMemory({
		defaultProvider: "faux",
		defaultModel: "faux-1",
		retry: { enabled: false },
		sessionDir: join(cwd, "sessions"),
	});
	return { runtime, faux, settings };
}

describe("session-scoped code-mode artifacts", () => {
	it("keeps a persistent session's code-mode fullOutputPath readable while the session exists", async () => {
		const cwd = await temp("amazme-artifacts-persist-");
		const { runtime, faux, settings } = await runtimeFor(cwd);
		const session = await openDurable({
			cwd,
			settingsManager: settings,
			modelRuntime: runtime,
			tools: ["codemode"],
			sessionDir: join(cwd, "sessions"),
		});
		sessions.add(session);
		const directory = session.view.current().session.directory;
		expect(directory).toBeDefined();
		const artifacts = join(directory!, "artifacts");

		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{
							code: '// @options: {"max_output_tokens": 20}\nreturn "BEGIN" + "x".repeat(1000) + "END";',
						},
						{ id: "script" },
					),
				],
				{ stopReason: "toolUse" },
			),
			done(),
		]);
		await session.controller.submit("go", "followUp");
		await viWaitForSettled(session);

		const entries = session.view.current().conversation.entries;
		const toolResult = entries.find(
			(entry) =>
				entry.model?.[0]?.role === "toolResult" &&
				entry.model[0].toolCallId === "script",
		);
		const details = (
			toolResult?.model?.[0] as
				| { details?: { fullOutputPath?: string } }
				| undefined
		)?.details;
		expect(details?.fullOutputPath).toBeDefined();
		expect(details!.fullOutputPath!.startsWith(artifacts + "/")).toBe(true);
		expect(await readFile(details!.fullOutputPath!, "utf8")).toContain("BEGIN");
		expect(await readFile(details!.fullOutputPath!, "utf8")).toContain("END");
	});

	it("removes the artifact directory when the host deletes the session directory", async () => {
		const catalog = await temp("amazme-artifacts-delete-");
		const metadata = await createSession(catalog, {
			id: "sess-1",
			cwd: catalog,
			name: "one",
		});
		const artifacts = join(metadata.path, "artifacts");
		await mkdir(join(artifacts, "codemode-task"), { recursive: true });
		await writeFile(join(artifacts, "codemode-task", "output.txt"), "spill");
		expect(
			await readFile(join(artifacts, "codemode-task", "output.txt"), "utf8"),
		).toBe("spill");

		await deleteSession(metadata);
		await expect(access(metadata.path)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(access(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readSession(catalog, "sess-1")).toBeUndefined();
	});

	it("removes the ephemeral amazme-session-artifacts temp directory on release", async () => {
		const cwd = await temp("amazme-artifacts-ephemeral-cwd-");
		const before = await listPrefixedTemps("amazme-session-artifacts-");
		const location = await selectSession(cwd, false, { noSession: true });
		expect(location.directory).toBeUndefined();
		expect(
			location.artifactDirectory.includes("amazme-session-artifacts-"),
		).toBe(true);
		await access(location.artifactDirectory);
		await writeFile(join(location.artifactDirectory, "marker.txt"), "x");

		await location.release();
		await expect(access(location.artifactDirectory)).rejects.toMatchObject({
			code: "ENOENT",
		});
		const after = await listPrefixedTemps("amazme-session-artifacts-");
		const leaked = after.filter((name) => !before.includes(name));
		expect(leaked).toEqual([]);
	});

	it("gives two sessions in the same cwd distinct artifact directories", async () => {
		const cwd = await temp("amazme-artifacts-shared-cwd-");
		const sessionDir = join(cwd, "sessions");
		const first = await selectSession(cwd, false, { sessionDir });
		await writeFile(first.database!, "");
		await first.release();
		const second = await selectSession(cwd, false, { sessionDir });
		await writeFile(second.database!, "");
		try {
			expect(first.artifactDirectory).not.toBe(second.artifactDirectory);
			expect(first.artifactDirectory).toBe(join(first.directory!, "artifacts"));
			expect(second.artifactDirectory).toBe(
				join(second.directory!, "artifacts"),
			);
			const left = new ExecutionEnvs(cwd, first.artifactDirectory);
			const right = new ExecutionEnvs(cwd, second.artifactDirectory);
			expect(left.artifactDirectory).toBe(first.artifactDirectory);
			expect(right.artifactDirectory).toBe(second.artifactDirectory);
			expect(left.artifactDirectory).not.toBe(right.artifactDirectory);
		} finally {
			await second.release();
		}
	});
});

async function listPrefixedTemps(prefix: string): Promise<string[]> {
	try {
		return (await readdir(tmpdir()))
			.filter((name) => name.startsWith(prefix))
			.sort();
	} catch {
		return [];
	}
}

async function viWaitForSettled(session: OpenDurableResult): Promise<void> {
	await vi.waitFor(() => {
		expect(
			session.view.current().conversation.docs["amazme.live"]?.run,
		).toBeUndefined();
	});
}
