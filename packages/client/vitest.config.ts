import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{
				find: /^@amazme\/protocol$/,
				replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			},
			{
				find: /^@amazme\/server$/,
				replacement: fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
			},
			{
				find: /^@amazme\/server\/testing$/,
				replacement: fileURLToPath(new URL("../server/src/testing/index.ts", import.meta.url)),
			},
			{
				find: /^@amazme\/server\/websocket$/,
				replacement: fileURLToPath(new URL("../server/src/transports/websocket/index.ts", import.meta.url)),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
