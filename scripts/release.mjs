#!/usr/bin/env node
/**
 * Publish a signed, notarized macOS release from this machine.
 *
 * The build runs in a temporary worktree of the pushed main commit, so local edits and stale
 * build outputs never reach the DMG. Nothing is tagged or published until the DMG is notarized,
 * stapled, and verified. Local configuration (IDs and file paths, never key contents) comes from
 * the environment or ~/.config/amazme/release.env.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "boomytc/AmazMe";
const NODE_VERSION = "22.23.3";

/** Tags and GitHub Releases start together at 1.0.0. Earlier versions are not tagged or published. */

/** Only application versions belong to this cleanup; component namespaces stay. */
export function staleReleaseNames(names, currentTag) {
	return names.filter((name) => name !== currentTag && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name));
}
export function publishesToGitHub(version) {
	const match = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(version);
	return match !== null && Number(match[1]) >= 1;
}

/** Decide what to publish from repository state; throw before anything has side effects. */
export function releasePlan({ branch, dirty, head, remoteHead, version, rootVersion, localTag, remoteTag, releaseExists }) {
	if (branch !== "main") throw new Error(`Release from main, not ${branch || "a detached HEAD"}`);
	if (dirty) throw new Error("Working tree has uncommitted changes");
	if (head !== remoteHead) throw new Error("HEAD is not origin/main; push or pull first");
	if (version !== rootVersion) throw new Error(`packages/gui version ${version} differs from root version ${rootVersion}`);
	const tag = `v${version}`;
	if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Not a release version: ${version}`);
	if (!publishesToGitHub(version)) throw new Error(`GitHub Release starts at 1.0.0; ${version} is not tagged or published`);
	if (releaseExists) throw new Error(`GitHub Release ${tag} already exists`);
	for (const [where, commit] of [["local", localTag], ["remote", remoteTag]]) {
		if (commit !== undefined && commit !== head) throw new Error(`${where} tag ${tag} points at ${commit.slice(0, 8)}, not HEAD`);
	}
	return { tag, version, prerelease: version.includes("-"), createTag: localTag === undefined, pushTag: remoteTag === undefined };
}

export function releaseArguments({ tag, version, prerelease, files, notes }) {
	const channel = prerelease ? ["--prerelease", "--latest=false"] : ["--latest"];
	return ["release", "create", tag, ...files, "--repo", REPOSITORY, "--title", `AmazMe ${version}`, "--notes-file", notes, "--verify-tag", ...channel];
}

export function releaseNotes(dmg) {
	return `## 安装

1. 打开 DMG，把 AmazMe 拖到“应用程序”。
2. 应用已用 Developer ID 签名并通过 Apple 公证，双击即可打开。
3. 不需要安装 Node 或任何开发环境；运行时已包含在应用内。

## 校验

\`\`\`bash
shasum -a 256 -c ${dmg}.sha256
\`\`\`

## 已知限制

- 仅 macOS arm64。
- 签名安装支持每天检查更新；下载与安装重启分别确认，可取消或稍后安装。
- 更新前请完成运行中的工作。安装器保留旧应用；二进制回滚不等于数据迁移回滚。

## 部署方式

- Web 界面在本机或内网自托管，不提供公网托管。
`;
}

/** `git ls-remote` lists an annotated tag twice; the peeled `^{}` line names the commit. */
export function remoteTagCommit(output, tag) {
	const lines = output.trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
	const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
	return (peeled ?? lines.find(([, ref]) => ref === `refs/tags/${tag}`))?.[0];
}

function run(command, args, { cwd = repoRoot, env, capture = false, allowFailure = false } = {}) {
	const result = spawnSync(command, args, { cwd, env: env ?? process.env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
	if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
	if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status}`);
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const git = (...args) => run("git", args, { capture: true }).stdout.trim();

function step(title) {
	console.log(`\n==> ${title}`);
}

function loadConfig() {
	const file = process.env.AMAZME_RELEASE_ENV ?? join(homedir(), ".config", "amazme", "release.env");
	if (existsSync(file)) process.loadEnvFile(file);
	const missing = ["APPLE_TEAM_ID", "ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"].filter((name) => !process.env[name]);
	if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the environment or ${file}`);
	const key = resolve(process.env.ASC_KEY_PATH.replace(/^~(?=\/)/, homedir()));
	if (!existsSync(key)) throw new Error("ASC_KEY_PATH does not point at a file");
	return {
		teamId: process.env.APPLE_TEAM_ID,
		key,
		keychain: process.env.SIGNING_KEYCHAIN ?? join(homedir(), "Library", "Keychains", "login.keychain-db"),
	};
}

function readVersion(path) {
	return JSON.parse(readFileSync(path, "utf8")).version;
}

function inspectRepository() {
	run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
	const version = readVersion(join(repoRoot, "packages", "gui", "package.json"));
	const tag = `v${version}`;
	const head = git("rev-parse", "HEAD");
	const localTag = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], { capture: true, allowFailure: true }).stdout.trim() || undefined;
	const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { capture: true });
	const view = run("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "tagName"], { capture: true, allowFailure: true });
	if (view.status !== 0 && !/not found/i.test(view.stderr)) throw new Error("Could not query GitHub Releases; check `gh auth status`");
	return {
		branch: git("branch", "--show-current"),
		dirty: git("status", "--porcelain") !== "",
		head,
		remoteHead: git("rev-parse", "origin/main"),
		version,
		rootVersion: readVersion(join(repoRoot, "package.json")),
		localTag,
		remoteTag: remoteTagCommit(remote.stdout, tag),
		releaseExists: view.status === 0,
	};
}

async function officialNode() {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const name = `node-v${NODE_VERSION}-darwin-${arch}`;
	const cache = join(homedir(), "Library", "Caches", "amazme-release");
	const binary = join(cache, name, "bin", "node");
	if (existsSync(binary)) return binary;
	mkdirSync(cache, { recursive: true });
	const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
	const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
	const expected = sums.split("\n").find((line) => line.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0];
	if (!expected) throw new Error(`No published checksum for ${name}.tar.gz`);
	const response = await fetch(`${base}/${name}.tar.gz`);
	if (!response.ok) throw new Error(`Node download failed with HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(archive).digest("hex") !== expected) throw new Error("Node archive checksum mismatch");
	const tarball = join(cache, `${name}.tar.gz`);
	writeFileSync(tarball, archive);
	run("tar", ["-xzf", tarball, "-C", cache]);
	return binary;
}

function dmgIn(directory) {
	const images = readdirSync(directory).filter((name) => name.endsWith(".dmg"));
	if (images.length !== 1) throw new Error(`Expected one DMG in ${directory}, found ${images.length}`);
	return join(directory, images[0]);
}

async function main() {
	const args = process.argv.slice(2);
	const unsupported = args.find((argument) => argument !== "--dry-run");
	if (unsupported !== undefined) throw new Error(`Unsupported release option: ${unsupported}`);
	if (process.platform !== "darwin") throw new Error("Releases are built on macOS");
	const dryRun = args.includes("--dry-run");
	const config = loadConfig();

	step("Checking repository, tag, and release state");
	const plan = releasePlan(inspectRepository());
	console.log(`${plan.tag} at ${git("rev-parse", "--short", "HEAD")}${plan.prerelease ? " (prerelease)" : ""}${dryRun ? ", dry run" : ""}`);

	step("Checking notarization credentials (read-only)");
	run(process.execPath, ["scripts/notarize-macos.mjs", "--history-only", "--key", config.key]);

	const releaseRoot = join(repoRoot, "dist-release");
	const out = join(releaseRoot, plan.tag);
	if (existsSync(releaseRoot)) {
		for (const name of staleReleaseNames(readdirSync(releaseRoot), plan.tag)) {
			await rm(join(releaseRoot, name), { recursive: true, force: true });
		}
	}
	const work = await mkdtemp(join(tmpdir(), "amazme-release-"));
	const source = join(work, "source");
	try {
		step("Preparing a clean worktree of HEAD");
		run("git", ["worktree", "add", "--detach", source, "HEAD"]);
		run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source });
		run("npm", ["run", "check:workspace"], { cwd: source });
		run("npm", ["run", "build:offline"], { cwd: source });
		const node = await officialNode();
		const signing = ["--keychain", config.keychain, "--team-id", config.teamId];

		step("Building, signing, and verifying the DMG");
		run(process.execPath, ["scripts/package-desktop.mjs", "--node", node, "--out", out, "--dmg", "--verify", ...signing], { cwd: source });
		const dmg = dmgIn(out);

		step("Notarizing and stapling the DMG");
		run(process.execPath, ["scripts/notarize-macos.mjs", "--dmg", dmg, "--key", config.key, "--team-id", config.teamId], { cwd: source });
		step("Writing latest.json and release notes");
		run(process.execPath, ["scripts/release-manifest.mjs", plan.tag, REPOSITORY, out, join(out, "latest.json")], { cwd: source });
		const notes = join(out, "notes.md");
		writeFileSync(notes, releaseNotes(dmg.slice(out.length + 1)));

		if (dryRun) {
			console.log(`\nDry run complete; artifacts in ${out}. Nothing was tagged or published.`);
			return;
		}

		step(`Tagging and publishing ${plan.tag}`);
		if (plan.createTag) run("git", ["tag", "-a", plan.tag, "-m", `AmazMe ${plan.version}`]);
		if (plan.pushTag) run("git", ["push", "origin", `refs/tags/${plan.tag}`]);
		run("gh", releaseArguments({ ...plan, files: [dmg, `${dmg}.sha256`, join(out, "latest.json")], notes }));
		console.log(`\nPublished https://github.com/${REPOSITORY}/releases/tag/${plan.tag}`);
	} finally {
		run("git", ["worktree", "remove", "--force", source], { capture: true, allowFailure: true });
		await rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
