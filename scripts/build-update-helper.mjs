import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({ entryPoints: [root + "packages/gui/src/update-helper.ts"], outfile: root + "packages/gui/dist/update-helper.bundle.mjs", bundle: true, platform: "node", format: "esm", target: "node22", conditions: ["source"], banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: "warning" });
