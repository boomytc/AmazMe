import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodePortable: fileURLToPath(new URL("./packages/codemode/src/portable.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	webIndex: fileURLToPath(new URL("./packages/web/src/index.ts", import.meta.url)),
	webTypography: fileURLToPath(new URL("./packages/web/src/typography.ts", import.meta.url)),
	webAssets: fileURLToPath(new URL("./packages/web/src/assets.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{find:/^@amazme\/web\/typography$/,replacement:workspaceSourcePaths.webTypography},
			{find:/^@amazme\/web$/,replacement:workspaceSourcePaths.webIndex},
			{find:/^@amazme\/web\/assets$/,replacement:workspaceSourcePaths.webAssets},
			{find:/^@amazme\/tui$/,replacement:workspaceSourcePaths.tuiIndex},
			{find:/^@amazme\/codemode$/,replacement:workspaceSourcePaths.codemodeIndex},
			{find:/^@amazme\/codemode\/portable$/,replacement:workspaceSourcePaths.codemodePortable},
			{find:/^@amazme\/codemode\/declarations$/,replacement:workspaceSourcePaths.codemodeDeclarations},
			{find:/^@amazme\/codemode\/source$/,replacement:workspaceSourcePaths.codemodeSource},
		],
	},
});
