#!/usr/bin/env node
// First: silences warnings. node:sqlite warns while the module graph that imports it is being linked, so main (which
// can reach node:sqlite) is imported dynamically below, after this has run. Keep the static imports free of SQLite.
import "./quiet-warnings.ts";
import { APP_NAME } from "./config.ts";

process.title = `${APP_NAME}-rpc`;
process.env.AMAZME_CODING_AGENT = "true";
process.env.AI_AGENT = "AmazMe";

void import("./main.ts").then(({ main }) => main(["--mode", "rpc", ...process.argv.slice(2)]));
