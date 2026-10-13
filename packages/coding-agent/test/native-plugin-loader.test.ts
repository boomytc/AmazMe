import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { remoteService } from "@amazme/protocol/services";
import { createSourcePluginLoader } from "../src/core/plugins/loader.ts";
import { openPluginRuntime } from "../src/core/plugins/runtime.ts";

test("loads external TypeScript sources, refreshes relative imports and preserves the previous generation on failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "amazme-source-plugin-"));
	const entry = join(directory, "entry.ts");
	const imported = join(directory, "value.ts");
	const Probe = remoteService<{ read(context: Context): Promise<string> }>("source.probe", { read: 0 });
	try {
		await writeFile(imported, 'export const value = "first";');
		await writeFile(
			entry,
			'import { remoteService, serviceFacet } from "@amazme/protocol/services"; import { value } from "./value.ts"; const Probe = remoteService("source.probe", { read: 0 }); export default serviceFacet("probe", Probe, [], () => ({value: {async read() {return value;}}}));',
		);
		const runtime = await openPluginRuntime([], createSourcePluginLoader([entry]));
		try {
			const probe = runtime.services.get(Probe);
			await runtime.services.scope.ready();
			expect(await probe.read(BACKGROUND_CONTEXT)).toBe("first");
			await writeFile(imported, 'export const value = "second";');
			await runtime.reload();
			expect(await probe.read(BACKGROUND_CONTEXT)).toBe("second");
			await writeFile(entry, 'throw new Error("candidate failed"); export default {};');
			await expect(runtime.reload()).rejects.toThrow("candidate failed");
			expect(await probe.read(BACKGROUND_CONTEXT)).toBe("second");
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
