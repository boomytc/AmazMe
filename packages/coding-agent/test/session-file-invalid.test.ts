import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createTempDir } from "./temp-dir.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function openTempWorkspace(): string {
	const dir = realpathSync(createTempDir("pi-session-file-invalid-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				AMAZME_OFFLINE: "1",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, stderr };
}

describe("explicit --session", () => {
	it("rejects a file that is not a session before reading it and leaves its bytes unchanged", async () => {
		const tempRoot = openTempWorkspace();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const sessionFile = join(tempRoot, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(sessionFile, originalContent);

		const result = await runCli(["--session", sessionFile, "-p", "hi"], projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Error: No durable session matches');
		expect(result.stderr).not.toContain("SessionManager.open");
		expect(result.stderr).not.toContain("at ");
		expect(result.stderr).not.toContain("ExperimentalWarning");
		expect(readFileSync(sessionFile, "utf8")).toBe(originalContent);
	});
});
