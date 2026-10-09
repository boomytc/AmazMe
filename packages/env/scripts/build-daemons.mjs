import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const daemon = join(root, "daemon");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const targets = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"linux-arm64": "aarch64-unknown-linux-musl",
	"linux-x64": "x86_64-unknown-linux-musl",
	"android-arm64": "aarch64-linux-android",
	"android-x64": "x86_64-linux-android",
	"windows-arm64": "aarch64-pc-windows-msvc",
	"windows-x64": "x86_64-pc-windows-msvc",
};
const unixTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function rustSources(directory, relative = "") {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) result.push(...await rustSources(join(directory, entry.name), path));
		else if (entry.name.endsWith(".rs")) result.push(path);
	}
	return result;
}

const sources = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "build.rs",
	...await rustSources(join(daemon, "src"), "src")].map((path) => path.replaceAll("\\", "/")).sort();
const fingerprint = createHash("sha256").update(version);
for (const path of sources) {
	fingerprint.update(path).update("\0").update(await readFile(join(daemon, path))).update("\0");
}
const sourceDigest = fingerprint.digest("hex");

function assertBinary(target, bytes) {
	const arm = target.endsWith("arm64");
	let valid = false;
	if (target.startsWith("darwin-")) {
		valid = bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf &&
			bytes.readUInt32LE(4) === (arm ? 0x0100000c : 0x01000007);
	} else if (target.startsWith("windows-")) {
		if (bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
			const offset = bytes.readUInt32LE(60);
			valid = bytes.length >= offset + 6 && bytes.readUInt32LE(offset) === 0x00004550 &&
				bytes.readUInt16LE(offset + 4) === (arm ? 0xaa64 : 0x8664);
		}
	} else {
		valid = bytes.length >= 20 && bytes.toString("hex", 0, 6) === "7f454c460201" &&
			bytes.readUInt16LE(18) === (arm ? 183 : 62);
	}
	if (!valid) throw new Error(`Daemon binary does not match ${target}`);
}

function artifact(target) {
	const directory = join(root, "bin", `amazme-env-${target}`);
	return { directory, binary: join(directory, target.startsWith("windows-") ? "amazme-env.exe" : "amazme-env") };
}

async function check(target) {
	const { directory, binary } = artifact(target);
	const bytes = await readFile(binary);
	assertBinary(target, bytes);
	const metadata = JSON.parse(await readFile(join(directory, "build.json"), "utf8"));
	if (metadata.version !== version || metadata.sourceDigest !== sourceDigest ||
		metadata.target !== targets[target] || metadata.sha256 !== digest(bytes)) {
		throw new Error(`Stale daemon for ${target}; rebuild it with npm run build:daemons -- ${target}`);
	}
	console.log(`Verified ${target} ${version}`);
}

async function build(target) {
	const triple = targets[target];
	const result = spawnSync("cargo", ["build", "--release", "--locked", "--target", triple], {
		cwd: daemon,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Cargo failed for ${target} (${result.signal ?? result.status})`);
	const name = target.startsWith("windows-") ? "amazme-env.exe" : "amazme-env";
	const targetDirectory = resolve(daemon, process.env.CARGO_TARGET_DIR ?? "target");
	const bytes = await readFile(join(targetDirectory, triple, "release", name));
	assertBinary(target, bytes);
	const { directory, binary } = artifact(target);
	await mkdir(directory, { recursive: true });
	await writeFile(`${binary}.tmp`, bytes);
	await chmod(`${binary}.tmp`, 0o755);
	await rename(`${binary}.tmp`, binary);
	await writeFile(join(directory, "build.json"), `${JSON.stringify({ version, target: triple, sourceDigest, sha256: digest(bytes) }, null, 2)}\n`);
	await check(target);
}

try {
	const args = process.argv.slice(2);
	const verify = args[0] === "--check";
	const selected = verify ? (args.length > 1 ? args.slice(1) : unixTargets) :
		(args.length > 0 ? args : [`${process.platform}-${process.arch}`]);
	for (const target of selected) {
		if (!Object.hasOwn(targets, target)) throw new Error(`Unknown daemon target: ${target}`);
	}
	for (const target of selected) await (verify ? check(target) : build(target));
} catch (error) {
	console.error(`Daemon release: ${error.message}`);
	process.exitCode = 1;
}
