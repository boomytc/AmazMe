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

let mutation: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = mutation.then(work, work);
  mutation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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

export function createWriteTool(root: string): AgentTool {
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

export function createEditTool(root: string): AgentTool {
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
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          context.onUpdate?.(stdout);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
        context.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        child.on("close", (code) => {
          clearTimeout(timer);
          const text = [stdout, stderr].filter((part) => part.length > 0).join("\n");
          resolveRun({
            content: [{ type: "text", text: text || `exit ${code ?? 0}` }],
            isError: code !== 0,
          });
        });
      });
    },
  };
}

export function createCodingTools(root: string): AgentTool[] {
  statSync(root);
  return [createReadTool(root), createWriteTool(root), createEditTool(root), createBashTool(root)];
}
