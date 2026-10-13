import { spawnSync } from "node:child_process";
import { chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkspace } from "./workspace.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.env.AMAZME_EVAL_VARIANT;

function parseId(name: string): number {
	const value = Number(process.env[name]);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
	return value;
}

const sandboxUid = parseId("AMAZME_EVAL_SANDBOX_UID");
const sandboxGid = parseId("AMAZME_EVAL_SANDBOX_GID");

function chownTree(path: string, uid: number, gid: number): void {
	const stats = lstatSync(path);
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		for (const entry of readdirSync(path)) chownTree(join(path, entry), uid, gid);
	}
	chownSync(path, uid, gid);
}

function assertRootOnly(path: string): void {
	const stats = statSync(path);
	if (stats.uid !== 0 || (stats.mode & 0o077) !== 0) {
		throw new Error(`Evaluator source must be readable only by root: ${path}`);
	}
}

function assertSandboxCannotRead(path: string): void {
	const method = statSync(path).isDirectory() ? "readdirSync" : "readFileSync";
	const probe = spawnSync(process.execPath, ["--eval", `require("node:fs").${method}(${JSON.stringify(path)})`], {
		uid: sandboxUid,
		gid: sandboxGid,
		stdio: "ignore",
	});
	if (probe.status === 0) throw new Error(`The model-facing user can read evaluator source: ${path}`);
}

assertWorkspace("/repo", variant);
const evalRoot = "/repo/packages/evals/evals";
for (const path of [
	evalRoot,
	"/repo/packages/evals/src",
	"/repo/packages/evals/docker",
	"/repo/packages/evals/vitest.evals.config.ts",
	"/repo/vitest.base.ts",
]) {
	assertRootOnly(path);
	assertSandboxCannotRead(path);
}
const codingAgentEntry = fileURLToPath(import.meta.resolve("@amazme/coding-agent"));
if (codingAgentEntry !== "/repo/node_modules/@amazme/coding-agent/dist/index.js") {
	throw new Error(`Eval does not resolve @amazme/coding-agent from dist: ${codingAgentEntry}`);
}

const agentDir = "/tmp/amazme-eval-host-agent";
mkdirSync(agentDir, { recursive: true });
const authSource = "/run/amazme-eval-secrets/auth.json";
if (existsSync(authSource)) copyFileSync(authSource, join(agentDir, "auth.json"));
chownTree(agentDir, sandboxUid, sandboxGid);
chownTree("/artifacts", sandboxUid, sandboxGid);
process.env.HOME = "/tmp/amazme-eval-bootstrap";
process.env.USERPROFILE = process.env.HOME;
process.env.AMAZME_CODING_AGENT_DIR = agentDir;
process.env.AMAZME_EVAL_CONTAINER = "1";
process.umask(0o022);

const require = createRequire(import.meta.url);
const vitestCli = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const inputArgs = process.argv.slice(2);
const discover = inputArgs.includes("--discover");
const vitestArgs = inputArgs.filter((argument) => argument !== "--discover");
const evalFiles = vitestArgs.filter((argument) => argument.endsWith(".eval.ts"));
if (evalFiles.length === 0) throw new Error("The container runner requires an explicit eval file.");

for (const evalFile of evalFiles) {
	assertRootOnly(evalFile);
	assertSandboxCannotRead(evalFile);
}

const commandArgs = discover
	? [vitestCli, "list", "--config", "vitest.evals.config.ts", ...vitestArgs, "--json=/artifacts/discovered-tests.json"]
	: [
			vitestCli,
			"run",
			"--config",
			"vitest.evals.config.ts",
			...vitestArgs,
			"--reporter=vitest-evals/reporter",
			"--reporter=json",
			"--outputFile=/artifacts/vitest.json",
		];
const result = spawnSync(process.execPath, commandArgs, { cwd: packageRoot, stdio: "inherit", env: process.env });
if (result.error) throw result.error;

const artifactUid = process.env.AMAZME_EVAL_ARTIFACT_UID;
const artifactGid = process.env.AMAZME_EVAL_ARTIFACT_GID;
if (artifactUid !== undefined && artifactGid !== undefined) {
	chownTree("/artifacts", parseId("AMAZME_EVAL_ARTIFACT_UID"), parseId("AMAZME_EVAL_ARTIFACT_GID"));
}
process.exit(result.status ?? 1);
