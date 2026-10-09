import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run the same installed modules as plugins and subprocesses, using the compiled Bun runtime.
await import(pathToFileURL(join(dirname(process.execPath), "dist", "bun", "cli.js")).href);
