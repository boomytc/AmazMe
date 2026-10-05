import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ProjectState {
  trusted: boolean;
  settings: Record<string, string>;
  names: Record<string, string>;
  scopedModels: string[];
}

export interface ExtensionApi {
  registerCommand(name: string, run: (args: string) => string | Promise<string>): void;
}

interface Surface {
  commands: Map<string, (args: string) => string | Promise<string>>;
  templates: Map<string, string>;
  skills: string;
  theme: { name: string; accent?: string } | null;
  error: string;
}

const surfaces = new Map<string, Surface>();
let activeCwd: string | null = null;

const empty = (): Surface => ({ commands: new Map(), templates: new Map(), skills: "", theme: null, error: "" });

export function projectFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "project.json");
}

export function readProject(cwd: string): ProjectState {
  const file = projectFile(cwd);
  if (!existsSync(file)) return { trusted: false, settings: {}, names: {}, scopedModels: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectState>;
    return {
      trusted: parsed.trusted === true,
      settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      names: parsed.names && typeof parsed.names === "object" ? parsed.names : {},
      scopedModels: Array.isArray(parsed.scopedModels) ? parsed.scopedModels.filter((item) => typeof item === "string") : [],
    };
  } catch {
    return { trusted: false, settings: {}, names: {}, scopedModels: [] };
  }
}

function writeProject(cwd: string, state: ProjectState): void {
  const file = projectFile(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function grantTrust(cwd: string): string {
  const state = readProject(cwd);
  state.trusted = true;
  writeProject(cwd, state);
  return "已信任此项目";
}

export function isTrusted(cwd: string): boolean {
  return readProject(cwd).trusted;
}

export function saveSetting(cwd: string, key: string, value: string): string {
  const state = readProject(cwd);
  state.settings[key] = value;
  writeProject(cwd, state);
  return `${key}=${value}`;
}

export function readSetting(cwd: string, key: string): string | undefined {
  return readProject(cwd).settings[key];
}

export function setDisplayName(cwd: string, lane: string, name: string): string {
  const state = readProject(cwd);
  state.names[lane] = name;
  writeProject(cwd, state);
  return name;
}

export function displayName(cwd: string, lane: string): string {
  return readProject(cwd).names[lane] ?? "";
}

export function saveScopedModel(cwd: string, spec: string): string {
  const state = readProject(cwd);
  if (!state.scopedModels.includes(spec)) state.scopedModels.push(spec);
  writeProject(cwd, state);
  return state.scopedModels.join(" ");
}

export function scopedModels(cwd: string): string[] {
  return readProject(cwd).scopedModels;
}

/**
 * Append `provider/id` specs. Existing order and hand-filled entries stay.
 * The file is written once, and only when the list grows.
 * An empty list inserts `current` first so that lane's model remains in `/model`.
 */
export function addScopedModels(cwd: string, specs: readonly string[], current?: string): { added: number; models: string[] } {
  const state = readProject(cwd);
  const models = [...state.scopedModels];
  const fresh = specs.filter(acceptScopedSpec);
  const queue = models.length === 0 && fresh.length > 0 && current !== undefined && acceptScopedSpec(current)
    ? [current, ...fresh]
    : fresh;
  let added = 0;
  for (const spec of queue) {
    if (!acceptScopedSpec(spec) || models.includes(spec)) continue;
    models.push(spec);
    added += 1;
  }
  if (added === 0) return { added, models };
  state.scopedModels = models;
  writeProject(cwd, state);
  return { added, models };
}

function acceptScopedSpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  return slash > 0 && slash < spec.length - 1 && !/\s/.test(spec);
}

/** Next id in the enabled set. An empty set does not limit cycling. */
export function cycleModels(enabled: readonly string[], current: string): string {
  if (enabled.length === 0) return current;
  const index = enabled.indexOf(current);
  return enabled[(index + 1) % enabled.length] ?? enabled[0] ?? current;
}

export function externalCommand(cwd: string, name: "share" | "bug" | "llama"): string {
  const key = name === "share" ? "shareService" : name === "bug" ? "bugService" : "llamaRouter";
  if (!readProject(cwd).settings[key]) return `${name} 未配置外部服务`;
  return `${name} 已配置，当前构建不上传`;
}

export function extraKind(name: string): "command" | "template" | null {
  const surface = activeCwd ? surfaces.get(activeCwd) : undefined;
  if (!surface) return null;
  if (surface.commands.has(name)) return "command";
  if (surface.templates.has(name)) return "template";
  return null;
}

export function templateText(name: string, rest: string): string | null {
  const surface = activeCwd ? surfaces.get(activeCwd) : undefined;
  const body = surface?.templates.get(name);
  if (body === undefined) return null;
  return rest.length > 0 ? `${body}\n${rest}` : body;
}

export async function runExtension(name: string, rest: string): Promise<string | null> {
  const run = activeCwd ? surfaces.get(activeCwd)?.commands.get(name) : undefined;
  if (!run) return null;
  return String(await run(rest));
}

export function packageSkillText(cwd: string): string {
  return surfaces.get(resolve(cwd))?.skills ?? "";
}

export function loadedTheme(cwd: string): { name: string; accent?: string } | null {
  return surfaces.get(resolve(cwd))?.theme ?? null;
}

/** Read a trusted local package. An untrusted project contributes nothing. */
export async function activateProject(cwd: string): Promise<string> {
  const root = resolve(cwd);
  activeCwd = root;
  const surface = empty();
  surfaces.set(root, surface);
  if (!readProject(root).trusted) return "项目未信任";
  try {
    await loadPackage(root, surface);
  } catch (error) {
    surface.error = error instanceof Error ? error.message : String(error);
    return surface.error;
  }
  return surface.error || "已重新加载";
}

async function loadPackage(root: string, surface: Surface): Promise<void> {
  const manifest = join(root, ".amazme", "package.json");
  const dirs = existsSync(manifest) ? manifestDirs(root, manifest) : conventionalDirs(root);
  surface.skills = skillParagraph(dirs.skills);
  surface.templates = readTemplates(dirs.prompts);
  surface.theme = readTheme(dirs.themes);
  for (const file of extensionFiles(dirs.extensions)) {
    const href = `${pathToFileURL(file).href}?reload=${Date.now()}`;
    const loaded = await import(href) as { register?: (api: ExtensionApi) => void };
    loaded.register?.({
      registerCommand(name, run) {
        if (/^[a-z0-9][a-z0-9-]*$/i.test(name)) surface.commands.set(name, run);
      },
    });
  }
}

function conventionalDirs(root: string): Record<"extensions" | "skills" | "prompts" | "themes", string[]> {
  const base = join(root, ".amazme");
  return {
    extensions: [join(base, "extensions")],
    skills: [join(base, "skills")],
    prompts: [join(base, "prompts")],
    themes: [join(base, "themes")],
  };
}

function manifestDirs(root: string, file: string): Record<"extensions" | "skills" | "prompts" | "themes", string[]> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const base = dirname(file);
  const take = (key: "extensions" | "skills" | "prompts" | "themes"): string[] => {
    const value = parsed[key];
    const listed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return listed.map((item) => resolve(base, item));
  };
  const dirs = conventionalDirs(root);
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const extra = take(key);
    if (extra.length > 0) dirs[key] = extra;
  }
  return dirs;
}

function skillParagraph(directories: readonly string[]): string {
  const skills: string[] = [];
  for (const directory of directories) {
    if (!isDirectory(directory)) continue;
    for (const file of skillFiles(directory)) {
      const text = readFileSync(file, "utf8");
      const data = frontmatter(text);
      if (data.disableModelInvocation === "true") continue;
      const name = data.name?.trim() || basename(dirname(file));
      skills.push(`- ${name}: ${data.description?.trim() ?? ""} (path: ${file})`);
    }
  }
  if (skills.length === 0) return "";
  return ["Skills available in this workspace. Open a path with the read or bash tool when it applies.", ...skills].join("\n");
}

function skillFiles(directory: string): string[] {
  const paths: string[] = [];
  const own = join(directory, "SKILL.md");
  if (isFile(own)) paths.push(own);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(directory, entry.name, "SKILL.md");
    if (isFile(nested)) paths.push(nested);
  }
  return paths.sort();
}

function readTemplates(directories: readonly string[]): Map<string, string> {
  const templates = new Map<string, string>();
  for (const directory of directories) {
    if (!isDirectory(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".md")) continue;
      const name = basename(entry, ".md");
      templates.set(name, readFileSync(join(directory, entry), "utf8").trim());
    }
  }
  return templates;
}

function readTheme(directories: readonly string[]): Surface["theme"] {
  for (const directory of directories) {
    if (!isDirectory(directory)) continue;
    const files = readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort();
    const file = files[0];
    if (!file) continue;
    const parsed = JSON.parse(readFileSync(join(directory, file), "utf8")) as { accent?: unknown };
    return { name: basename(file, ".json"), ...(typeof parsed.accent === "string" ? { accent: parsed.accent } : {}) };
  }
  return null;
}

function extensionFiles(directories: readonly string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    if (!isDirectory(directory)) continue;
    for (const entry of readdirSync(directory)) {
      const extension = extname(entry);
      if (extension === ".mjs" || extension === ".js") files.push(join(directory, entry));
    }
  }
  return files.sort();
}

function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const data: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "---") return data;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
  }
  return {};
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function parseImportedMessages(raw: string): { role: "user" | "assistant"; text: string }[] {
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as {
      type?: string;
      role?: string;
      text?: string;
      message?: { role?: string; content?: unknown };
    };
    if (parsed.type === "session") continue;
    const message = (parsed.type === "message" ? parsed.message : parsed) as { role?: string; text?: string; content?: unknown } | undefined;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof message?.text === "string"
      ? message.text
      : typeof parsed.text === "string" && parsed.role === role
        ? parsed.text
        : textOf(message?.content);
    if (text.length === 0) continue;
    messages.push({ role, text });
  }
  return messages;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("");
}

export function exportBody(entries: readonly { role: string; text: string }[], format: "html" | "jsonl"): string {
  if (format === "jsonl") {
    return entries.map((entry) => JSON.stringify({ role: entry.role, text: entry.text })).join("\n") + (entries.length > 0 ? "\n" : "");
  }
  const body = entries.map((entry) => `<article><h2>${escapeHtml(entry.role)}</h2><p>${escapeHtml(entry.text)}</p></article>`).join("\n");
  return `<!DOCTYPE html><meta charset="utf-8"><title>session</title>\n${body}\n`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
