import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The git checkout this command is running from. */
export function installationRoot(from = fileURLToPath(new URL(".", import.meta.url))): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("amazme update 只适用于这份检出的安装");
    dir = parent;
  }
}

/** Fast-forward the checkout and install its dependencies. A dirty tree is left untouched. */
export async function updateInstallation(root: string, options: { inherit?: boolean } = {}): Promise<string> {
  const inherit = options.inherit !== false;
  const dirty = (await run(root, "git", ["status", "--porcelain"], false)).trim();
  if (dirty) throw new Error("工作区有未提交的改动，先处理后再 amazme update");
  const before = (await run(root, "git", ["rev-parse", "HEAD"], false)).trim();
  await run(root, "git", ["pull", "--ff-only"], inherit);
  await run(root, "npm", ["install"], inherit);
  const after = (await run(root, "git", ["rev-parse", "HEAD"], false)).trim();
  return before === after ? "已经是最新" : `已更新 ${before.slice(0, 7)} → ${after.slice(0, 7)}`;
}

function run(cwd: string, command: string, args: string[], inherit: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout).trim() || `${command} ${args.join(" ")} 退出 ${code ?? "null"}`));
    });
  });
}
