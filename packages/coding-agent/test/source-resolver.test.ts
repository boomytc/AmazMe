import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { childProcessEnv } from "./child-process-env.ts";

const execFileAsync = promisify(execFile);

// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const webEntryUrl = pathToFileURL(resolve(__dirname, "../../web/src/index.ts")).href;
const webAssetsUrl = pathToFileURL(resolve(__dirname, "../../web/src/assets.ts")).href;

// Static imports: host/web/boot.ts loads @amazme/web the same way. A resolver that
// stops on dist/index.d.ts lets Node follow that file's ./actions.ts specifier into
// dist, where only the declaration and the compiled JavaScript exist.
const sourceResolverProbe = [
	'import { BOOT_GLOBAL } from "@amazme/web";',
	'import { PAGE_SCRIPT } from "@amazme/web/assets";',
	'if (BOOT_GLOBAL !== "__AMAZME_BOOT__") throw new Error("web entry did not evaluate");',
	'if (PAGE_SCRIPT !== "/page.js") throw new Error("web assets did not evaluate");',
	'const entry = import.meta.resolve("@amazme/web");',
	'const assets = import.meta.resolve("@amazme/web/assets");',
	'process.stdout.write(entry + "\\n" + assets + "\\n");',
].join("\n");

describe("source resolver", () => {
	test("loads @amazme/web from TypeScript when its path points at the declaration", async () => {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			["--import", sourceResolverUrl, "--input-type=module", "--eval", sourceResolverProbe],
			{ encoding: "utf8", timeout: 20_000, env: childProcessEnv() },
		);
		expect(stderr).not.toMatch(/error/i);
		expect(stdout).toBe(`${webEntryUrl}\n${webAssetsUrl}\n`);
	});
});
