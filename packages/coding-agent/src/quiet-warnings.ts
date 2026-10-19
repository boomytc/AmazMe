/**
 * Silence Node's runtime warnings (notably node:sqlite's ExperimentalWarning, emitted when `node:sqlite` is first
 * imported) so they never reach a user's terminal or a host's stderr.
 *
 * Every process entry (cli.ts, rpc-entry.ts, bun/cli.ts) imports this module first and has no static path to
 * `node:sqlite`; code that can reach SQLite is imported dynamically after this runs. That ordering matters: Node emits
 * the warning while linking the graph that imports `node:sqlite`, before any module in it evaluates, so a module
 * evaluated inside that same graph would be too late. This runs before the session database preflight and every
 * other SQLite open.
 */
process.emitWarning = (() => {}) as typeof process.emitWarning;
