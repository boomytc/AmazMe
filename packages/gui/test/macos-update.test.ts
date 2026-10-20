import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { downloadRelease, verifyApp, type MacTool } from "../src/macos-update.ts";
import { createTempDir } from "./temp-dir.ts";

const TEAM = "ABCDE12345";
function fakeTool(detail = "TeamIdentifier=" + TEAM + "\nCDHash=" + "a".repeat(40)): MacTool {
	return vi.fn(async (command, args) => {
		if (command.endsWith("codesign") && args.includes("--display")) return detail;
		if (command.endsWith("plutil")) return args[1] === "CFBundleIdentifier" ? "com.amazme.desktop\n" : "8.6.0\n";
		if (command.endsWith("lipo")) return "arm64\n";
		return "";
	});
}
test("publisher comes from a verified installed app; candidate must match it and Apple trust", async () => {
	const tool = fakeTool();
	expect(await verifyApp("/isolated/AmazMe.app", "8.6.0", "arm64", TEAM, tool)).toEqual({ team: TEAM, hash: "a".repeat(40) });
	expect(tool).toHaveBeenCalledWith("/usr/sbin/spctl", ["--assess", "--type", "execute", "/isolated/AmazMe.app"]);
	expect(tool).toHaveBeenCalledWith("/usr/bin/codesign", expect.arrayContaining(["--strict", "-R", expect.stringContaining('identifier "com.amazme.desktop"')]));
	await expect(verifyApp("/isolated/app", "8.6.0", "arm64", "OTHER12345", fakeTool())).rejects.toThrow("signature");
	await expect(verifyApp("/isolated/app", "8.6.0", "arm64", undefined, fakeTool("Signature=adhoc\nTeamIdentifier=not set"))).rejects.toThrow("signature");
});
test.each(["version", "bundle", "arch", "gatekeeper"])("rejects incompatible %s", async fault => {
	const normal = fakeTool();
	const tool: MacTool = async (command, args) => {
		if (fault === "gatekeeper" && command.endsWith("spctl")) throw new Error("signature");
		if (fault === "version" && command.endsWith("plutil") && args[1] === "CFBundleVersion") return "8.5.0";
		if (fault === "bundle" && command.endsWith("plutil") && args[1] === "CFBundleIdentifier") return "com.other.app";
		if (fault === "arch" && command.endsWith("lipo")) return "x86_64";
		return normal(command, args);
	};
	await expect(verifyApp("/isolated/app", "8.6.0", "arm64", TEAM, tool)).rejects.toThrow(fault === "arch" ? "unsupported" : "signature");
});
test("download hashes streamed bytes and the actual file, and rejects truncation/extra bytes/hash mismatch", async () => {
	const directory = createTempDir("amazme-download-test-");
	const bytes = "DMG fixture";
	const asset = { name: "fixture.dmg", url: "https://github.com/boomytc/AmazMe/releases/download/v8.6.0/fixture.dmg", size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
	try {
		const get = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
		const file = join(directory, "ok.dmg");
		await downloadRelease(asset, file, new AbortController().signal, () => {}, get);
		expect(await readFile(file, "utf8")).toBe(bytes);
		for (const [index, content] of ["short", bytes + "extra", "X".repeat(bytes.length)].entries()) {
			await expect(downloadRelease(asset, join(directory, index + ".dmg"), new AbortController().signal, () => {}, vi.fn(async () => new Response(content)) as unknown as typeof fetch)).rejects.toThrow("integrity");
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});
