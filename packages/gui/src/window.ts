import { spawn } from "node:child_process";

/**
 * Ask the desktop to show a short AmazMe window.
 * A missing window system resolves to the launcher error instead of hanging.
 */
export function tryOpenWindow(html: string): Promise<string | null> {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  const source = `display dialog ${JSON.stringify(text || "AmazMe")} with title "AmazMe" giving up after 1`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };
    const child = spawn("/usr/bin/osascript", ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      finish(stderr.trim() || "the window system did not open");
    }, 2_000);
    child.on("error", (error) => finish(error.message));
    child.on("exit", (code) => finish(code === 0 ? null : stderr.trim() || `osascript exited ${code ?? "null"}`));
  });
}
