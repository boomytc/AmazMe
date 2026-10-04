import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@amazme/agent";

const objectSchema = {
  type: "object",
  additionalProperties: false,
} as const;

function inside(root: string, target: string): string {
  const full = resolve(root, target);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${target}`);
  return full;
}

type Enqueue = <T>(work: () => Promise<T>) => Promise<T>;

function createQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function createReadTool(root: string): AgentTool {
  return {
    name: "read",
    description: "Read a UTF-8 text file",
    replay: "safe",
    parameters: {
      ...objectSchema,
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based line" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
    async execute(args) {
      const { path: file, offset, limit } = args as { path: string; offset?: number; limit?: number };
      const full = inside(root, file);
      const text = readFileSync(full, "utf8");
      const lines = text.split("\n");
      const start = Math.max(0, (offset ?? 1) - 1);
      const slice = lines.slice(start, limit === undefined ? undefined : start + limit);
      return { content: [{ type: "text", text: slice.join("\n") }] };
    },
  };
}

export function createWriteTool(root: string, enqueue: Enqueue = createQueue()): AgentTool {
  return {
    name: "write",
    description: "Create or replace a UTF-8 text file",
    replay: "never",
    parameters: { ...objectSchema, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    execute(args) {
      const { path: file, content } = args as { path: string; content: string };
      return enqueue(async () => {
        const full = inside(root, file);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        return { content: [{ type: "text", text: `wrote ${file}` }] };
      });
    },
  };
}

export function createEditTool(root: string, enqueue: Enqueue = createQueue()): AgentTool {
  return {
    name: "edit",
    description: "Replace one exact occurrence in a file",
    replay: "never",
    parameters: {
      ...objectSchema,
      properties: { path: { type: "string" }, old: { type: "string" }, replacement: { type: "string" } },
      required: ["path", "old", "replacement"],
    },
    execute(args) {
      const { path: file, old, replacement } = args as { path: string; old: string; replacement: string };
      return enqueue(async () => {
        const full = inside(root, file);
        const text = readFileSync(full, "utf8");
        const count = text.split(old).length - 1;
        if (count !== 1) return { content: [{ type: "text", text: `expected 1 match, found ${count}` }], isError: true };
        writeFileSync(full, text.replace(old, replacement));
        return { content: [{ type: "text", text: `edited ${file}` }] };
      });
    },
  };
}

const OUTPUT_TAIL_BYTES = 32 * 1024;

function rememberTail(current: string, chunk: Buffer): { text: string; truncated: boolean } {
  const next = Buffer.concat([Buffer.from(current), chunk]);
  if (next.length <= OUTPUT_TAIL_BYTES) return { text: next.toString("utf8"), truncated: false };
  return { text: next.subarray(next.length - OUTPUT_TAIL_BYTES).toString("utf8"), truncated: true };
}

export function createBashTool(root: string): AgentTool {
  return {
    name: "bash",
    description: "Run a shell command in the workspace",
    replay: "never",
    parameters: { ...objectSchema, properties: { command: { type: "string" } }, required: ["command"] },
    execute(args, context) {
      const { command } = args as { command: string };
      return new Promise((resolveRun) => {
        const child = spawn(command, { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;
        const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
        const onAbort = () => child.kill("SIGTERM");
        const finish = (text: string, isError: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          resolveRun({ content: [{ type: "text", text }], isError });
        };
        child.on("error", (error) => {
          finish(error.message, true);
        });
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener("abort", onAbort);
        child.stdout?.on("data", (chunk: Buffer) => {
          const kept = rememberTail(stdout, chunk);
          stdout = kept.text;
          stdoutTruncated = stdoutTruncated || kept.truncated;
          context.onUpdate?.(stdout);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const kept = rememberTail(stderr, chunk);
          stderr = kept.text;
          stderrTruncated = stderrTruncated || kept.truncated;
        });
        child.on("close", (code) => {
          const notice = [
            stdoutTruncated ? "stdout truncated to the last 32 KiB" : "",
            stderrTruncated ? "stderr truncated to the last 32 KiB" : "",
          ].filter((part) => part.length > 0);
          const text = [stdout, stderr, ...notice].filter((part) => part.length > 0).join("\n");
          finish(text || `exit ${code ?? 0}`, code !== 0);
        });
      });
    },
  };
}

export function createCodingTools(root: string): AgentTool[] {
  statSync(root);
  const enqueue = createQueue();
  return [createReadTool(root), createWriteTool(root, enqueue), createEditTool(root, enqueue), createBashTool(root)];
}
