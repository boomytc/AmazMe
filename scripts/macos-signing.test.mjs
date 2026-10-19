import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
	codesignArguments,
	collectSignableCode,
	isMachOHeader,
	parseTeamIdentifier,
	resolveSigning,
	selectDeveloperIdIdentity,
	signingOrder,
} from "./macos-signing.mjs";

const header = (magic, second = 0) => {
	const buffer = Buffer.alloc(8);
	buffer.writeUInt32BE(magic, 0);
	buffer.writeUInt32BE(second, 4);
	return buffer;
};

test("Mach-O detection covers thin and fat binaries but not Java classes or text", () => {
	assert.equal(isMachOHeader(header(0xcffaedfe)), true);
	assert.equal(isMachOHeader(header(0xfeedfacf)), true);
	assert.equal(isMachOHeader(header(0xcafebabe, 2)), true);
	assert.equal(isMachOHeader(header(0xcafebabe, 52)), false);
	assert.equal(isMachOHeader(Buffer.from("#!/bin/sh\n")), false);
	assert.equal(isMachOHeader(Buffer.alloc(3)), false);
});

test("nested code is found inside-out and symlinks are skipped", (t) => {
	const app = mkdtempSync(join(tmpdir(), "amazme-signing-test-"));
	t.after(() => rmSync(app, { recursive: true, force: true }));
	const framework = join(app, "Contents", "Frameworks", "Lib.framework", "Versions", "A");
	const helper = join(app, "Contents", "Frameworks", "Helper.app", "Contents", "MacOS");
	const addon = join(app, "Contents", "Resources", "app", "node_modules", "pkg");
	for (const directory of [framework, helper, addon, join(app, "Contents", "MacOS")]) mkdirSync(directory, { recursive: true });
	writeFileSync(join(framework, "Lib"), header(0xcffaedfe));
	writeFileSync(join(helper, "Helper"), header(0xcffaedfe));
	writeFileSync(join(addon, "binding.node"), header(0xcafebabe, 2));
	writeFileSync(join(addon, "index.js"), "module.exports = 1;\n");
	writeFileSync(join(app, "Contents", "MacOS", "AmazMe"), header(0xcffaedfe));
	symlinkSync("A", join(app, "Contents", "Frameworks", "Lib.framework", "Versions", "Current"));

	return collectSignableCode(app).then((found) => {
		const order = signingOrder(found);
		assert.deepEqual(new Set(order), new Set([
			["Contents", "Frameworks", "Lib.framework", "Versions", "A", "Lib"].join(sep),
			["Contents", "Frameworks", "Lib.framework"].join(sep),
			["Contents", "Frameworks", "Helper.app", "Contents", "MacOS", "Helper"].join(sep),
			["Contents", "Frameworks", "Helper.app"].join(sep),
			["Contents", "Resources", "app", "node_modules", "pkg", "binding.node"].join(sep),
			["Contents", "MacOS", "AmazMe"].join(sep),
		]));
		const before = (inner, outer) => assert.ok(order.indexOf(inner) < order.indexOf(outer), `${inner} must be signed before ${outer}`);
		before(["Contents", "Frameworks", "Lib.framework", "Versions", "A", "Lib"].join(sep), ["Contents", "Frameworks", "Lib.framework"].join(sep));
		before(["Contents", "Frameworks", "Helper.app", "Contents", "MacOS", "Helper"].join(sep), ["Contents", "Frameworks", "Helper.app"].join(sep));
	});
});

test("only releases use the hardened runtime, entitlements, a timestamp, and the keychain identity", () => {
	const adHoc = codesignArguments({ kind: "ad-hoc" }, "/x");
	assert.deepEqual(adHoc, ["--force", "--timestamp=none", "--sign", "-", "/x"]);
	const release = codesignArguments({ kind: "developer-id", entitlements: "e.plist", keychain: "/k", identity: "ABC", teamId: "T" }, "/x");
	assert.deepEqual(release, ["--force", "--options", "runtime", "--entitlements", "e.plist", "--timestamp", "--keychain", "/k", "--sign", "ABC", "/x"]);
});

test("the Developer ID identity must be the single one of the expected team", () => {
	const listing = [
		'  1) E97702D6ECFFD42CA05053EFF8ACA3C540BE32DF "Apple Development: Someone (W7D63S43JG)"',
		'  2) CF77ED22367A9C3A154A7E6E37AF926D86F6E843 "Developer ID Application: Someone (KUWD2VFQXC)"',
		"     2 valid identities found",
	].join("\n");
	assert.equal(selectDeveloperIdIdentity(listing, "KUWD2VFQXC"), "CF77ED22367A9C3A154A7E6E37AF926D86F6E843");
	assert.throws(() => selectDeveloperIdIdentity(listing, "W7D63S43JG"), /found 0/);
	const twice = `${listing}\n  3) 0000000000000000000000000000000000000000 "Developer ID Application: Other (KUWD2VFQXC)"`;
	assert.throws(() => selectDeveloperIdIdentity(twice, "KUWD2VFQXC"), /found 2/);
});

test("TeamIdentifier is read from codesign output and ad-hoc reports none", () => {
	assert.equal(parseTeamIdentifier("Identifier=com.amazme.desktop\nTeamIdentifier=KUWD2VFQXC\n"), "KUWD2VFQXC");
	assert.equal(parseTeamIdentifier("Signature=adhoc\nTeamIdentifier=not set\n"), undefined);
	assert.equal(parseTeamIdentifier("Signature=adhoc\n"), undefined);
});

test("Developer ID signing needs both the keychain and the team", () => {
	assert.deepEqual(resolveSigning({ entitlements: "e.plist" }), { kind: "ad-hoc" });
	assert.throws(() => resolveSigning({ keychain: "/k", entitlements: "e.plist" }), /both --keychain and --team-id/);
	assert.throws(() => resolveSigning({ teamId: "T", entitlements: "e.plist" }), /both --keychain and --team-id/);
	assert.throws(() => resolveSigning({ keychain: "/k", teamId: "", entitlements: "e.plist" }), /both --keychain and --team-id/);
});
