import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const hostRoot = fileURLToPath(new URL("../src/host", import.meta.url));
const forbidden = ["durable/sessions", "durable/harness-setup", "durable/fork-management"] as const;

function typescriptFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return typescriptFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

describe("host service durable boundary", () => {
	test("administration services do not import the old session modules", () => {
		const paths = [...typescriptFiles(join(hostRoot, "services")), join(hostRoot, "server.ts")];
		const hits: string[] = [];
		for (const path of paths) {
			const source = readFileSync(path, "utf8");
			for (const token of forbidden) {
				if (source.includes(token)) hits.push(`${path} imports ${token}`);
			}
		}
		expect(hits).toEqual([]);
	});
});
