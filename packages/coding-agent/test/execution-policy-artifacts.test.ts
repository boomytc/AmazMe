import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createPolicyEnv } from "../src/durable/insights/execution-policy.ts";
import { createTempDir } from "./temp-dir.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temp(prefix: string): Promise<string> {
	const path = createTempDir(prefix);
	directories.push(path);
	return path;
}

describe("createPolicyEnv artifact directory", () => {
	it("allows writes under the session artifact directory when it lies outside the workspace", async () => {
		const cwd = await temp("amazme-policy-cwd-");
		const sessionsRoot = await temp("amazme-policy-sessions-");
		const artifactDirectory = join(sessionsRoot, "session-a", "artifacts");
		await mkdir(artifactDirectory, { recursive: true });
		const outside = join(await temp("amazme-policy-outside-"), "denied.txt");

		const settings = SettingsManager.inMemory({
			executionMode: "workspace-write",
		});
		const env = createPolicyEnv(cwd, artifactDirectory, settings, async () => [
			cwd,
		]);

		const allowedWorkspace = await env.writeFile(
			join(cwd, "workspace-write.txt"),
			"workspace",
			context,
		);
		expect(allowedWorkspace.ok).toBe(true);

		const denied = await env.writeFile(outside, "nope", context);
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.error.code).toBe("permission_denied");

		const artifactPath = join(artifactDirectory, "codemode-task", "output.txt");
		const created = await env.createDir(
			join(artifactDirectory, "codemode-task"),
			{ recursive: true },
			context,
		);
		expect(created.ok).toBe(true);
		const allowedArtifact = await env.writeFile(artifactPath, "spill", context);
		expect(allowedArtifact.ok).toBe(true);
		expect(await readFile(artifactPath, "utf8")).toBe("spill");
	});

	it("denies writes to another session's artifacts directory and to the parent sessions directory", async () => {
		const cwd = await temp("amazme-policy-iso-cwd-");
		const sessionsRoot = await temp("amazme-policy-iso-sessions-");
		const ownArtifacts = join(sessionsRoot, "session-a", "artifacts");
		const otherArtifacts = join(sessionsRoot, "session-b", "artifacts");
		await mkdir(ownArtifacts, { recursive: true });
		await mkdir(otherArtifacts, { recursive: true });

		const settings = SettingsManager.inMemory({
			executionMode: "workspace-write",
		});
		const env = createPolicyEnv(cwd, ownArtifacts, settings, async () => [cwd]);

		const own = await env.writeFile(
			join(ownArtifacts, "mine.txt"),
			"ok",
			context,
		);
		expect(own.ok).toBe(true);

		const sibling = await env.writeFile(
			join(otherArtifacts, "theirs.txt"),
			"nope",
			context,
		);
		expect(sibling.ok).toBe(false);
		if (!sibling.ok) expect(sibling.error.code).toBe("permission_denied");

		const parent = await env.writeFile(
			join(sessionsRoot, "parent.txt"),
			"nope",
			context,
		);
		expect(parent.ok).toBe(false);
		if (!parent.ok) expect(parent.error.code).toBe("permission_denied");

		const otherSessionDir = await env.writeFile(
			join(sessionsRoot, "session-b", "meta.json"),
			"nope",
			context,
		);
		expect(otherSessionDir.ok).toBe(false);
		if (!otherSessionDir.ok)
			expect(otherSessionDir.error.code).toBe("permission_denied");
	});

	it("still refuses createTemp outside the workspace in workspace-write mode", async () => {
		const cwd = await temp("amazme-policy-temp-cwd-");
		const artifactDirectory = await temp("amazme-policy-temp-art-");
		const settings = SettingsManager.inMemory({
			executionMode: "workspace-write",
		});
		const env = createPolicyEnv(cwd, artifactDirectory, settings, async () => [
			cwd,
		]);
		const result = await env.createTempDir("amazme-policy-", context);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("permission_denied");
	});
});
