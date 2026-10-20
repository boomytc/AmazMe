/** Real Apple trust and isolated helper installation. Never touches a live app or user profile. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macTool, verifyApp, fileDigest } from "../packages/gui/dist/macos-update.js";
import { desktopUpdateAsset, parseUpdateManifest } from "../packages/coding-agent/dist/update-manifest.js";

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) throw new Error("Missing " + name);
	return resolve(process.argv[index + 1]);
}
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function until(test, timeout = 150_000) {
	const end = Date.now() + timeout;
	while (!await test()) { if (Date.now() >= end) throw new Error("Acceptance timed out"); await sleep(250); }
}
async function inspectDmg(image, directory) {
	await macTool("/usr/bin/xcrun", ["stapler", "validate", image]);
	await macTool("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", image]);
	await macTool("/usr/bin/codesign", ["--verify", "--strict", image]);
	const mounted = await mkdtemp(join(directory, "mount-"));
	try {
		await macTool("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, image]);
		const app = join(mounted, "AmazMe.app");
		const version = (await macTool("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents", "Info.plist")])).trim();
		const identity = await verifyApp(app, version, process.arch);
		const copy = join(directory, "verified-" + version + ".app");
		await macTool("/usr/bin/ditto", [app, copy]);
		await verifyApp(copy, version, process.arch, identity.team);
		return { path: copy, version, identity };
	} finally { await macTool("/usr/bin/hdiutil", ["detach", mounted]); await rm(mounted, { recursive: true, force: true }); }
}

async function main() {
	if (process.platform !== "darwin") throw new Error("macOS required");
	const targetImage = argument("--target"), baselineImage = argument("--baseline"), out = argument("--out");
	const scratch = await mkdtemp(join(tmpdir(), "amazme-trusted-acceptance-"));
	const data = join(scratch, "isolated-user-data"); await mkdir(data);
	const sentinel = join(data, "preserve.txt"); await writeFile(sentinel, "isolated user data must survive\n");
	const baseline = await inspectDmg(baselineImage, scratch);
	const candidate = await inspectDmg(targetImage, scratch);
	if (baseline.identity.team !== candidate.identity.team) throw new Error("Publisher changed");
	const manifest = parseUpdateManifest(JSON.parse(await readFile(join(dirname(targetImage), "latest.json"), "utf8")));
	const asset = desktopUpdateAsset(manifest, baseline.version, "stable", "darwin", process.arch);
	if (!asset || await fileDigest(targetImage) !== asset.sha256) throw new Error("Manifest bytes mismatch");
	const target = join(scratch, "AmazMe.app"); await rename(baseline.path, target);
	const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME,
		AMAZME_GUI_CWD: data, AMAZME_GUI_SMOKE_DATA_DIR: data, AMAZME_GUI_USER_DATA_DIR: data,
		AMAZME_CODING_AGENT_DIR: join(data, "agent"), AMAZME_SERVER_DIR: join(data, "server") };
	// The copied notarized app launches without Chromium or Gatekeeper bypass switches.
	const old = spawn(join(target, "Contents/MacOS/AmazMe"), [], { env: { ...env, AMAZME_GUI_SMOKE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; old.stdout.on("data", chunk => { output += String(chunk); });
	old.stderr.resume();
	await new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => { old.kill("SIGTERM"); reject(new Error("Baseline app launch timed out")); }, 150_000);
		old.once("error", reject);
		old.once("exit", code => { clearTimeout(timer); code === 0 && output.includes("desktop smoke:") ? resolvePromise() : reject(new Error("Baseline launch failed; output withheld")); });
	});
	const directory = await mkdtemp(join(scratch, ".AmazMe-update-"));
	await rename(candidate.path, join(directory, "AmazMe.app"));
	// This disposable process exercises the live-parent wait without stopping any user's app.
	const parent = spawn("/bin/cat", [], { stdio: ["pipe", "ignore", "ignore"] });
	await new Promise((resolvePromise, reject) => { parent.once("spawn", resolvePromise); parent.once("error", reject); });
	const job = { target, current: baseline.version, version: candidate.version, team: baseline.identity.team, arch: process.arch, originalHash: baseline.identity.hash, parentPid: parent.pid, nonce: randomUUID() };
	await writeFile(join(directory, "job.json"), JSON.stringify(job), { mode: 0o600 });
	const helper = spawn(join(target, "Contents/Resources/node/bin/node"), [fileURLToPath(new URL("../packages/gui/dist/update-helper.bundle.mjs", import.meta.url)), directory], { env, stdio: ["pipe", "pipe", "ignore"] });
	helper.stdin.on("error", () => {});
	let ready = ""; let exited = false;
	helper.stdout.on("data", chunk => { ready += String(chunk); }); helper.once("exit", () => { exited = true; });
	await until(() => { if (exited) throw new Error("Helper preflight failed"); return ready.includes("ready\n"); });
	helper.stdin.end("install\n");
	await sleep(1000);
	await verifyApp(target, baseline.version, process.arch, baseline.identity.team);
	parent.stdin.end();
	await until(async () => {
		const phase = JSON.parse(await readFile(join(directory, "status.json"), "utf8").catch(() => "{}")).phase;
		if (["failed", "rolled-back", "recovery-required"].includes(phase)) throw new Error("Install " + phase);
		return phase === "complete";
	});
	const healthy = JSON.parse(await readFile(join(directory, "healthy.json"), "utf8"));
	const updated = await verifyApp(target, candidate.version, process.arch, baseline.identity.team);
	await verifyApp(join(directory, "Previous.app"), baseline.version, process.arch, baseline.identity.team);
	if (await readFile(sentinel, "utf8") !== "isolated user data must survive\n") throw new Error("User data changed");
	if (Number.isInteger(healthy.pid)) { try { process.kill(healthy.pid, "SIGTERM"); } catch {} }
	await writeFile(out, JSON.stringify({ verifiedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, from: baseline.version, to: candidate.version,
		publisher: updated.team, installedCdHash: updated.hash, sha256: asset.sha256, manifest: "passed", dmgStaple: "passed", dmgGatekeeper: "passed", appSignature: "passed", appGatekeeper: "passed", isolatedStartup: "passed", liveParentWait: "passed", isolatedReplacement: "passed", previousBundleRetained: true, dataSentinelPreserved: true,
		scope: "Real signed/notarized CI artifacts and isolated native helper installation; GitHub Release HTTP transport covered separately by mocks", binaryRollbackIsDataRollback: false }, null, 2) + "\n");
	console.log("Trusted DMG, isolated startup, live-parent wait, replacement, publisher pin and data preservation passed.");
	// The runner disposes of this directory later; never remove a running app bundle.
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Acceptance failed"); process.exitCode = 1; });
