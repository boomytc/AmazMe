import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const LIMIT = 200;
const LIST_TTL_MS = 3_000;

/**
 * One directory listing is shared for three seconds.
 * Each `@` key used to run `git ls-files` synchronously, and a second key started another listing.
 * The full list is cached by directory. A query only filters that list.
 * A request that arrives while a listing is running waits for the same result.
 */
const listedCache = new Map<string, { at: number; names: readonly string[] }>();
const listedJobs = new Map<string, Promise<readonly string[]>>();

/**
 * Files the @ menu can offer.
 * A git work tree uses `git ls-files -co --exclude-standard`, so ignored files stay out.
 * Paths starting with `node_modules/` or `.git/` are dropped from that list too.
 * Otherwise the directory is walked and `.git` and `node_modules` are skipped.
 * Only workspace-relative paths are returned, at most 200, matched by prefix or substring.
 */
export async function listWorkspaceFiles(cwd: string, query: string): Promise<string[]> {
  const names = await fullList(resolve(cwd));
  const matched: string[] = [];
  for (const name of names) {
    if (query.length > 0 && !name.includes(query)) continue;
    matched.push(name);
    if (matched.length >= LIMIT) break;
  }
  return matched;
}

function fullList(root: string): Promise<readonly string[]> {
  const hit = listedCache.get(root);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return Promise.resolve(hit.names);
  const pending = listedJobs.get(root);
  if (pending) return pending;
  const job = scan(root).then((names) => {
    listedCache.set(root, { at: Date.now(), names });
    return names;
  });
  listedJobs.set(root, job);
  void job.finally(() => {
    if (listedJobs.get(root) === job) listedJobs.delete(root);
  });
  return job;
}

async function scan(root: string): Promise<string[]> {
  const names = (await isGitWorkTree(root)) ? await gitFiles(root) : await walkFiles(root);
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith("node_modules/") || name.startsWith(".git/")) continue;
    if (!contained(root, name)) continue;
    out.push(name);
  }
  return out;
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  const stdout = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"], 2_000);
  return stdout?.trim() === "true";
}

async function gitFiles(cwd: string): Promise<string[]> {
  const stdout = await gitOutput(cwd, ["ls-files", "-co", "--exclude-standard", "-z"], 5_000);
  if (stdout === undefined) return [];
  return stdout.split("\0").filter((name) => name.length > 0);
}

function gitOutput(cwd: string, args: readonly string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    childProcess.execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolvePromise(error || typeof stdout !== "string" ? undefined : stdout);
      },
    );
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) continue;
    const abs = resolve(dir, entry.name);
    if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
    if (entry.isDirectory()) {
      await walk(abs, root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, abs).split(sep).join("/");
    if (rel.length > 0) out.push(rel);
  }
}

function contained(root: string, rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return false;
  const parts = rel.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  const abs = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix);
}
