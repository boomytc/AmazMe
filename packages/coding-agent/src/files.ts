import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const LIMIT = 200;

/**
 * Files the @ menu can offer.
 * A git work tree uses `git ls-files -co --exclude-standard`, so ignored files stay out.
 * Otherwise the directory is walked and `.git` and `node_modules` are skipped.
 * Only workspace-relative paths are returned, at most 200, matched by prefix or substring.
 */
export async function listWorkspaceFiles(cwd: string, query: string): Promise<string[]> {
  const root = resolve(cwd);
  const names = isGitWorkTree(root) ? gitFiles(root) : await walkFiles(root);
  const matched: string[] = [];
  for (const name of names) {
    if (!contained(root, name)) continue;
    if (query.length > 0 && !name.includes(query)) continue;
    matched.push(name);
    if (matched.length >= LIMIT) break;
  }
  return matched;
}

function isGitWorkTree(cwd: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    timeout: 2_000,
  });
  return probe.status === 0 && probe.stdout.trim() === "true";
}

function gitFiles(cwd: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\0").filter((name) => name.length > 0);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
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
