#!/usr/bin/env node
/**
 * Notarize, staple, and verify a Developer ID signed DMG, then rewrite its checksum.
 *
 * Credentials come from the environment (ASC_KEY_ID, ASC_ISSUER_ID) and a private key file.
 * notarytool output is never echoed: a failed submission reports only its id and status.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTeam, tool, writeChecksum } from "./macos-signing.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function required(value, name) {
	if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
	return value;
}

/** Reads `notarytool submit --output-format json`; anything but Accepted fails with id and status only. */
export function parseSubmission(output) {
	let parsed;
	try {
		parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
	} catch {
		throw new Error("notarytool returned no readable result");
	}
	const id = typeof parsed.id === "string" ? parsed.id : "(unknown)";
	const status = typeof parsed.status === "string" ? parsed.status : "(unknown)";
	if (status !== "Accepted") throw new Error(`Notarization ${status} for submission ${id}`);
	return { id, status };
}

function step(name, command, args) {
	try {
		return tool(command, args);
	} catch (error) {
		throw new Error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function verifyMountedApp(image, teamId) {
	const mounted = await mkdtemp(join(tmpdir(), "amazme-notarized-"));
	try {
		step("Mount", "hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mounted, image]);
		const app = join(mounted, "AmazMe.app");
		step("App signature check", "codesign", ["--verify", "--deep", "--strict", app]);
		step("App Gatekeeper check", "spctl", ["--assess", "--type", "execute", app]);
		assertTeam(app, teamId);
	} finally {
		try {
			tool("hdiutil", ["detach", mounted, "-force"]);
		} finally {
			await rm(mounted, { recursive: true, force: true });
		}
	}
}

async function main() {
	if (process.platform !== "darwin") throw new Error("Notarization runs on macOS only");
	const image = resolve(required(argument("--dmg"), "--dmg"));
	const key = resolve(required(argument("--key"), "--key"));
	const teamId = required(argument("--team-id"), "--team-id");
	const keyId = required(process.env.ASC_KEY_ID, "ASC_KEY_ID");
	const issuer = required(process.env.ASC_ISSUER_ID, "ASC_ISSUER_ID");
	if (!existsSync(image)) throw new Error(`No DMG at ${image}`);
	if (!existsSync(key)) throw new Error("App Store Connect key file is missing");

	assertTeam(image, teamId);
	let output;
	try {
		output = tool("xcrun", ["notarytool", "submit", image, "--key", key, "--key-id", keyId, "--issuer", issuer, "--wait", "--output-format", "json"]);
	} catch (error) {
		output = typeof error?.output === "string" ? error.output : "";
		if (!output.includes("{")) throw new Error("Notarization submit failed");
	}
	const submission = parseSubmission(output);
	console.log(`Notarization ${submission.status} for submission ${submission.id}`);

	step("Staple", "xcrun", ["stapler", "staple", image]);
	step("Staple validation", "xcrun", ["stapler", "validate", image]);
	step("DMG signature check", "codesign", ["--verify", "--deep", "--strict", image]);
	step("DMG Gatekeeper check", "spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", image]);
	assertTeam(image, teamId);
	await verifyMountedApp(image, teamId);
	console.log(`Stapled and verified, team ${teamId}`);
	console.log(`SHA256 ${await writeChecksum(image)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
