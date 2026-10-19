import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials } from "../src/auth/types.ts";
import { resolveApiKey } from "./oauth.ts";
import { createTempDir } from "./temp-dir.ts";

const oauth = vi.hoisted(() => ({ refresh: vi.fn(), toAuth: vi.fn() }));
vi.mock("../src/providers/all.ts", () => ({
	builtinProviders: () => [{ id: "openai-codex", auth: { oauth } }],
}));

const temporaryRoots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createAuthFile(content: string) {
	const root = createTempDir("amazme-test-auth-");
	temporaryRoots.push(root);
	const path = join(root, "auth.json");
	writeFileSync(path, content);
	return path;
}

function credentials(expires: number): OAuthCredentials {
	return { type: "oauth", access: "test-access", refresh: "test-refresh", expires };
}

describe("live-test OAuth resolution", () => {
	it("returns missing credentials without creating a file", async () => {
		const path = createAuthFile("{}");
		expect(await resolveApiKey("openai-codex", path)).toBeUndefined();
		expect(await resolveApiKey("openai-codex", `${path}.missing`)).toBeUndefined();
	});

	it("reads valid tokens concurrently without rewriting shared credentials", async () => {
		const entry = credentials(Date.now() + 60_000);
		const original = JSON.stringify({ "openai-codex": entry });
		const path = createAuthFile(original);
		oauth.toAuth.mockImplementation((credential: OAuthCredentials) => ({ apiKey: credential.access }));
		const tokens = await Promise.all(Array.from({ length: 32 }, () => resolveApiKey("openai-codex", path)));
		expect(tokens).toEqual(Array(32).fill("test-access"));
		expect(oauth.refresh).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("saves only refreshed tokens atomically and preserves intervening provider changes", async () => {
		const path = createAuthFile(JSON.stringify({ "openai-codex": credentials(0) }));
		const refreshed = { ...credentials(Date.now() + 60_000), access: "refreshed-access" };
		oauth.refresh.mockImplementation(async () => {
			writeFileSync(path, JSON.stringify({ other: { type: "api_key", key: "other-key" } }));
			return refreshed;
		});
		oauth.toAuth.mockImplementation((credential: OAuthCredentials) => ({ apiKey: credential.access }));
		expect(await resolveApiKey("openai-codex", path)).toBe("refreshed-access");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			other: { type: "api_key", key: "other-key" },
			"openai-codex": refreshed,
		});
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(temporaryRoots[0])).toEqual(["auth.json"]);
	});

	it("fails on refresh errors instead of silently skipping configured tests", async () => {
		const path = createAuthFile(JSON.stringify({ "openai-codex": credentials(0) }));
		oauth.refresh.mockRejectedValue(new Error("test refresh failed"));
		await expect(resolveApiKey("openai-codex", path)).rejects.toThrow("test refresh failed");
	});

	it("fails on malformed storage instead of treating it as absent credentials", async () => {
		const path = createAuthFile("{");
		await expect(resolveApiKey("openai-codex", path)).rejects.toThrow();
	});

	it("fails when a configured OAuth provider has no implementation", async () => {
		const path = createAuthFile(JSON.stringify({ missing: credentials(Date.now() + 60_000) }));
		await expect(resolveApiKey("missing", path)).rejects.toThrow("No OAuth implementation");
	});
});
