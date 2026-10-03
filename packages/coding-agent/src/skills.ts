import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface SkillEntry {
  name: string;
  description: string;
  path: string;
}

/**
 * Append one paragraph of skill name, description, and path after `systemPrompt`.
 * Reads `SKILL.md` in `directory` and in each immediate child directory. This read happens here;
 * the agent loop does not open the files.
 * Frontmatter `name` is the skill name, and the parent directory name is used when `name` is absent.
 * `description` is the frontmatter description. `disableModelInvocation: true` omits that skill.
 * A missing directory, or a directory with nothing left to show, returns `systemPrompt` unchanged.
 */
export function appendSkillText(systemPrompt: string, directory: string): string {
  if (!isDirectory(directory)) return systemPrompt;
  const skills: SkillEntry[] = [];
  for (const file of skillFiles(directory)) {
    const skill = readSkill(file);
    if (skill) skills.push(skill);
  }
  if (skills.length === 0) return systemPrompt;
  const paragraph = [
    "Skills available in this workspace. Open a path with the read or bash tool when it applies.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (path: ${skill.path})`),
  ].join("\n");
  return systemPrompt.length === 0 ? paragraph : `${systemPrompt}\n\n${paragraph}`;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** `directory/SKILL.md` and `directory/<skill>/SKILL.md`. */
function skillFiles(directory: string): string[] {
  const paths: string[] = [];
  const own = join(directory, "SKILL.md");
  if (isFile(own)) paths.push(resolve(own));
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(directory, entry.name, "SKILL.md");
    if (isFile(nested)) paths.push(resolve(nested));
  }
  paths.sort();
  return paths;
}

function readSkill(file: string): SkillEntry | undefined {
  const data = frontmatter(readFileSync(file, "utf8"));
  if (data.disableModelInvocation === "true") return undefined;
  const named = data.name?.trim() ?? "";
  return {
    name: named.length > 0 ? named : basename(dirname(file)),
    description: data.description?.trim() ?? "",
    path: file,
  };
}

function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const data: Record<string, string> = {};
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line === "---") return data;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    data[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1));
  }
  return {};
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value[value.length - 1] === quote) return value.slice(1, -1).trim();
  return value;
}
