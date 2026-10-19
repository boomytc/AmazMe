import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getShareViewerUrl } from "../src/config.ts";
import { shareFilesToUrl, type GhResult } from "../src/core/session-share.ts";
import { createTempDir } from "./temp-dir.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = createTempDir("share-core-");
	tempDirs.push(dir);
	return dir;
}

function files(root = tempRoot()): { jsonlFile: string; htmlFile: string } {
	const jsonlFile = path.join(root, "session.jsonl");
	const htmlFile = path.join(root, "session.html");
	fs.writeFileSync(jsonlFile, "{}\n");
	fs.writeFileSync(htmlFile, "html");
	return { jsonlFile, htmlFile };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function gh(steps: ReadonlyArray<Partial<GhResult>>): (args: readonly string[], signal?: AbortSignal) => Promise<GhResult> {
	let index = 0;
	return async () => {
		const step = steps[Math.min(index, steps.length - 1)] ?? {};
		index += 1;
		return { code: 0, stdout: "", stderr: "", ...step };
	};
}

describe("shareFilesToUrl", () => {
	test("creates a private gist and returns the viewer URL", async () => {
		const outcome = await shareFilesToUrl({
			...files(),
			destination: "gist",
			checkGhAuth: () => "ok",
			runGh: gh([{ code: 0, stdout: "https://gist.github.com/reader/abc123\n" }]),
		});

		expect(outcome).toEqual({
			ok: true,
			url: getShareViewerUrl("abc123"),
			gistUrl: "https://gist.github.com/reader/abc123",
		});
	});

	test("uploads to Radius when a credential is available", async () => {
		const calls: string[] = [];
		const outcome = await shareFilesToUrl({
			...files(),
			destination: "radius",
			radiusToken: async () => "token-1",
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

	test("falls back to a gist when Radius has no credential", async () => {
		const outcome = await shareFilesToUrl({
			...files(),
			destination: "auto",
			radiusToken: async () => undefined,
			checkGhAuth: () => "ok",
			runGh: gh([{ code: 0, stdout: "https://gist.github.com/reader/def456\n" }]),
		});

		expect(outcome).toMatchObject({ ok: true, gistUrl: "https://gist.github.com/reader/def456" });
	});

	test("reports a fixed Radius destination without credentials", async () => {
		const outcome = await shareFilesToUrl({
			...files(),
			destination: "radius",
			radiusToken: async () => undefined,
		});

		expect(outcome).toEqual({
			ok: false,
			problem: "Radius authentication is not configured. Run '/login radius' first.",
		});
	});

	test("distinguishes a logged-out CLI from a missing one", async () => {
		const loggedOut = await shareFilesToUrl({
			...files(),
			destination: "gist",
			checkGhAuth: () => "logged-out",
		});
		expect(loggedOut).toEqual({
			ok: false,
			problem: "GitHub CLI is not logged in. Run 'gh auth login' first.",
		});

		const missing = await shareFilesToUrl({
			...files(),
			destination: "gist",
			checkGhAuth: () => "missing",
		});
		expect(missing).toEqual({
			ok: false,
			problem: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		});
	});

	test("reports export and gist failures as values", async () => {
		const exported = files();
		const exportFailure = await shareFilesToUrl({
			...exported,
			destination: "gist",
			exportHtml: async () => {
				throw new Error("disk full");
			},
			checkGhAuth: () => "ok",
		});
		expect(exportFailure).toEqual({ ok: false, problem: "Failed to export session: disk full" });

		const gistFailure = await shareFilesToUrl({
			...files(),
			destination: "gist",
			checkGhAuth: () => "ok",
			runGh: gh([{ code: 1, stderr: "quota exceeded" }]),
		});
		expect(gistFailure).toEqual({ ok: false, problem: "Failed to create gist: quota exceeded" });
	});

	test("stops before uploading when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await shareFilesToUrl({
			...files(),
			destination: "radius",
			radiusToken: async () => "token-1",
			signal: controller.signal,
		});

		expect(outcome).toEqual({ ok: false, problem: "Share cancelled", cancelled: true });
	});
});
