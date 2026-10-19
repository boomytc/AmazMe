import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { remoteService } from "@amazme/protocol/services";
import { expect, test } from "vitest";
import { createSourcePluginLoader } from "../src/core/plugins/loader.ts";
import { openPluginRuntime } from "../src/core/plugins/runtime.ts";

test("native plugin artifacts resolve host MCP ESM and Photon WASM dependencies outside the temporary bundle", async () => {
	const directory = await mkdtemp(join(tmpdir(), "am-plugin-external-"));
	const Probe = remoteService<{ read(context: Context): Promise<string> }>(
		"test.host-externals",
		{ read: 0 },
	);
	try {
		const entry = join(directory, "entry.ts");
		await writeFile(
			entry,
			`
import { McpClient } from "@amazme/mcp";
import * as photon from "@silvia-odwyer/photon-node";
import { remoteService, serviceFacet } from "@amazme/protocol/services";
const Probe = remoteService("test.host-externals", { read: 0 });
export default serviceFacet("externals", Probe, [], () => ({ value: { async read() {
  const client = new McpClient({ name: "probe", version: "1" });
  const image = new photon.PhotonImage(new Uint8Array(4), 1, 1);
  try { return typeof client.callTool + ":" + image.get_width(); } finally { image.free(); await client.close(); }
} } }));`,
		);
		const runtime = await openPluginRuntime(
			[],
			createSourcePluginLoader([entry]),
		);
		try {
			await runtime.services.scope.ready();
			expect(await runtime.services.get(Probe).read(BACKGROUND_CONTEXT)).toBe(
				"function:1",
			);
			await runtime.reload();
			expect(await runtime.services.get(Probe).read(BACKGROUND_CONTEXT)).toBe(
				"function:1",
			);
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
