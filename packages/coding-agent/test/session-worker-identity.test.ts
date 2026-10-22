import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, formatUserAgent, getIdentityHeaders } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { lockSessionDatabase } from "../src/durable/session-database.ts";
import { createSession, sessionStoragePath } from "../src/host/session-catalog.ts";
import { createCodingAgentHarness } from "../src/host/session-worker.ts";
import { createTempDir } from "./temp-dir.ts";

afterEach(() => vi.unstubAllEnvs());

it("hosted requests honor live telemetry settings and the environment opt-out", async () => {
	const directory = createTempDir("amazme-worker-identity-");
	const profile = join(directory, "profile");
	const cwd = join(directory, "project");
	await mkdir(profile);
	await mkdir(cwd);
	await writeFile(join(profile, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
	vi.stubEnv("AMAZME_TELEMETRY", undefined);
	const sessionDir = join(directory, "sessions");
	const metadata = await createSession(sessionDir, { cwd });
	const lease = await lockSessionDatabase(metadata.path, sessionStoragePath(metadata), directory => lockfile.lock(directory));
	try {
		const worker = await createCodingAgentHarness(lease, { sessionDir, metadata, pluginManifestPaths: [] });
		try {
			const headers: Record<string, string>[] = [];
			const faux = fauxProvider();
			faux.setResponses(Array.from({ length: 4 }, () => (_request, options) => {
				headers.push(getIdentityHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, options?.identity));
				return fauxAssistantMessage("answer");
			}));
			worker.modelRuntime!.registerNativeProvider({
				...faux.provider,
				auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "env" }), resolve: async () => ({ auth: {} }) } },
			});
			await worker.modelRuntime!.refresh({ allowNetwork: false });
			await worker.conversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
			for (const [index, enabled] of [false, true, false, true].entries()) {
				worker.settingsManager!.setEnableInstallTelemetry(enabled);
				if (index === 3) vi.stubEnv("AMAZME_TELEMETRY", "0");
				await (await worker.conversation.submit({ type: "input", content: "question" }, context)).wait(context);
			}
			expect(headers).toHaveLength(4);
			expect(headers.map(value => value["X-OpenRouter-Title"])).toEqual([undefined, "pi", undefined, undefined]);
			for (const value of headers) expect(value["User-Agent"]).toBe(formatUserAgent({ version: VERSION }));
		} finally {
			await worker.harness.close(context);
			await worker.cleanup?.(context);
			await worker.settingsManager?.flush();
		}
	} finally {
		await lease.release();
	}
});
