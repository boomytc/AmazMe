import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STATUSES = new Set(["running", "exited", "killed", "lost"]);

/** coding-agent 把后台任务写在 `.amazme/runtime/jobs.json`。这里只读 id、status、summary。 */
export function formatBackgroundJobs(cwd: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(resolve(cwd), ".amazme", "runtime", "jobs.json"), "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? "没有后台任务" : "无法读取后台任务";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "无法读取后台任务";
  }
  if (!parsed || typeof parsed !== "object" || !("jobs" in parsed) || !Array.isArray(parsed.jobs)) {
    return "无法读取后台任务";
  }
  const lines: string[] = [];
  for (const item of parsed.jobs) {
    if (!item || typeof item !== "object") continue;
    const id = "id" in item && typeof item.id === "string" ? item.id.trim() : "";
    const status = "status" in item && typeof item.status === "string" ? item.status : "";
    const summary = "summary" in item && typeof item.summary === "string" ? item.summary.replace(/\s+/g, " ").trim() : "";
    if (!id || /\s/.test(id) || !STATUSES.has(status)) continue;
    lines.push(summary.length > 0 ? `${id} ${status} ${summary}` : `${id} ${status}`);
  }
  return lines.join("\n") || "没有后台任务";
}
