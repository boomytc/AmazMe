#!/usr/bin/env node
// First: silences warnings before anything below can load node:sqlite (cli.ts loads SQLite code only dynamically).
import "../quiet-warnings.ts";
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";
import "../cli.ts";
