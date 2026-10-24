#!/usr/bin/env node
import { APP_NAME } from "./config.ts";

process.title = `${APP_NAME}-rpc`;
process.env.AMAZME_CODING_AGENT = "true";
process.env.AI_AGENT = "AmazMe";

void import("./main.ts").then(({ main }) => main(["--mode", "rpc", ...process.argv.slice(2)]));
