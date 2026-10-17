import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { getShareViewerUrl } from "../src/config.ts";
import { shareSessionToUrl, type GhResult } from "../src/core/session-share.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-core-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function session(stub: { provider?: boolean; credential?: string } = {}): AgentSession {
	return {
		modelRuntime: {
			getProvider: () => (stub.provider === false ? undefined : ({ id: "radius" } as unknown)),
			getAuth: async () => (stub.credential === undefined ? undefined : { auth: { apiKey: stub.credential } }),
		},
	} as unknown as AgentSession;
}

function gh(steps: ReadonlyArray<Partial<GhResult>>): (args: readonly string[]) => Promise<GhResult> {
	let index = 0;
	return async () => {
		const step = steps[Math.min(index, steps.length - 1)] ?? {};
		index += 1;
		return { code: 0, stdout: "", stderr: "", ...step };
	};
}

const base = {
	themeName: "dark",
	exportJsonl: (file: string) => fs.writeFileSync(file, "{}\n"),
	exportHtml: async (file: string) => fs.writeFileSync(file, "html"),
	checkGhAuth: () => "ok" as const,
};

describe("shareSessionToUrl", () => {
	test("creates a private gist and returns the viewer URL", async () => {
		const root = tempRoot();
		const outcome = await shareSessionToUrl({
			...base,
			session: session(),
			destination: "gist",
			tempRoot: root,
			runGh: gh([{ code: 0, stdout: "https://gist.github.com/reader/abc123\n" }]),
		});

		expect(outcome).toEqual({
			ok: true,
			url: getShareViewerUrl("abc123"),
			gistUrl: "https://gist.github.com/reader/abc123",
		});
		expect(fs.readdirSync(root)).toEqual([]);
	});

	test("uploads to Radius when the provider is available", async () => {
		const calls: string[] = [];
		const outcome = await shareSessionToUrl({
			...base,
			session: session({ credential: "token-1" }),
			destination: "radius",
			tempRoot: tempRoot(),
			fetchImpl: (async (url: URL | string) => {
				calls.push(String(url));
				return new Response(JSON.stringify({ artifact: { canonical_url: "https://radius.example/a/1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});

		expect(outcome).toEqual({ ok: true, url: "https://radius.example/a/1" });
		expect(calls[0]).toContain("/v1/artifacts");
	});

	test("falls back to a gist when Radius is not configured", async () => {
		const outcome = await shareSessionToUrl({
			...base,
			session: session({ provider: false }),
			destination: "auto",
			tempRoot: tempRoot(),
			runGh: gh([{ code: 0, stdout: "https://gist.github.com/reader/def456\n" }]),
		});

		expect(outcome).toMatchObject({ ok: true, gistUrl: "https://gist.github.com/reader/def456" });
	});

	test("reports a fixed Radius destination without credentials", async () => {
		const outcome = await shareSessionToUrl({
			...base,
			session: session({ provider: false }),
			destination: "radius",
			tempRoot: tempRoot(),
		});

		expect(outcome).toEqual({
			ok: false,
			problem: "Radius authentication is not configured. Run '/login radius' first.",
		});
	});

	test("distinguishes a logged-out CLI from a missing one", async () => {
		const loggedOut = await shareSessionToUrl({
			...base,
			session: session(),
			destination: "gist",
			tempRoot: tempRoot(),
			checkGhAuth: () => "logged-out" as const,
		});
		expect(loggedOut).toEqual({
			ok: false,
			problem: "GitHub CLI is not logged in. Run 'gh auth login' first.",
		});

		const missing = await shareSessionToUrl({
			...base,
			session: session(),
			destination: "gist",
			tempRoot: tempRoot(),
			checkGhAuth: () => "missing" as const,
		});
		expect(missing).toEqual({
			ok: false,
			problem: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		});
	});

	test("reports export and gist failures as values", async () => {
		const exportFailure = await shareSessionToUrl({
			...base,
			exportJsonl: () => {
				throw new Error("disk full");
			},
			session: session(),
			destination: "gist",
			tempRoot: tempRoot(),
		});
		expect(exportFailure).toEqual({ ok: false, problem: "Failed to export session: disk full" });

		const gistFailure = await shareSessionToUrl({
			...base,
			session: session(),
			destination: "gist",
			tempRoot: tempRoot(),
			runGh: gh([{ code: 1, stderr: "quota exceeded" }]),
		});
		expect(gistFailure).toEqual({ ok: false, problem: "Failed to create gist: quota exceeded" });
	});

	test("stops before uploading when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await shareSessionToUrl({
			...base,
			session: session(),
			destination: "radius",
			tempRoot: tempRoot(),
			signal: controller.signal,
		});

		expect(outcome).toEqual({ ok: false, problem: "Share cancelled", cancelled: true });
	});
});
