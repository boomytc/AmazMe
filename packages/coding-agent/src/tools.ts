import { isAbsolute, relative, resolve } from "node:path";
import type { AgentTool } from "@amazme/agent";
import { prepareWorkspace, runBash, runFileOp } from "./sandbox/run.ts";

export const codingSystemPrompt = "You are a coding agent. Use tools to inspect and change files in the workspace. File and shell tools can only access the workspace, cannot access .amazme, and have no network.";

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
    async execute(args, context) {
      const { path: file, offset, limit } = args as { path: string; offset?: number; limit?: number };
      const full = inside(root, file);
      const outcome = await runFileOp(prepareWorkspace(root), "read", { path: full }, context.signal);
      if (!outcome.ok) return { content: [{ type: "text", text: outcome.text }], isError: true };
      const lines = outcome.text.split("\n");
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
    execute(args, context) {
      const { path: file, content } = args as { path: string; content: string };
      return enqueue(async () => {
        const full = inside(root, file);
        const outcome = await runFileOp(prepareWorkspace(root), "write", { path: full, content }, context.signal);
        if (!outcome.ok) return { content: [{ type: "text", text: outcome.text }], isError: true };
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
    execute(args, context) {
      const { path: file, old, replacement } = args as { path: string; old: string; replacement: string };
      return enqueue(async () => {
        const full = inside(root, file);
        const outcome = await runFileOp(prepareWorkspace(root), "edit", { path: full, old, replacement }, context.signal);
        if (!outcome.ok) return { content: [{ type: "text", text: outcome.text }], isError: true };
        return { content: [{ type: "text", text: `edited ${file}` }] };
      });
    },
  };
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function searchTool(root: string, name: "grep" | "find" | "ls", description: string, required: string[]): AgentTool {
  return {
    name,
    description,
    replay: "safe",
    parameters: {
      ...objectSchema,
      properties: {
        ...(name === "ls" ? {} : { pattern: { type: "string" } }),
        path: { type: "string" },
      },
      required,
    },
    async execute(args, context) {
      const { path: file = ".", pattern } = args as { path?: string; pattern?: string };
      try {
        const full = inside(root, file);
        const outcome = await runFileOp(prepareWorkspace(root), name, { path: full, ...(pattern !== undefined ? { pattern } : {}) }, context.signal);
        if (!outcome.ok) return { content: [{ type: "text", text: outcome.text }], isError: true };
        return { content: [{ type: "text", text: outcome.text }] };
      } catch (error) {
        return { content: [{ type: "text", text: failureText(error) }], isError: true };
      }
    },
  };
}

export function createGrepTool(root: string): AgentTool {
  return searchTool(root, "grep", "Find lines that contain a literal pattern", ["pattern"]);
}

export function createFindTool(root: string): AgentTool {
  return searchTool(root, "find", "Find paths matching a glob pattern", ["pattern"]);
}

export function createLsTool(root: string): AgentTool {
  return searchTool(root, "ls", "List a directory", []);
}

export function createBashTool(root: string): AgentTool {
  return {
    name: "bash",
    description: "Run a shell command in the workspace",
    replay: "never",
    parameters: { ...objectSchema, properties: { command: { type: "string" } }, required: ["command"] },
    async execute(args, context) {
      const { command } = args as { command: string };
      try {
        const result = await runBash(prepareWorkspace(root), command, context.signal, (text) => context.onUpdate?.(text));
        const notice = [
          result.stdoutTruncated ? "stdout truncated to the last 32 KiB" : "",
          result.stderrTruncated ? "stderr truncated to the last 32 KiB" : "",
        ].filter((part) => part.length > 0);
        const text = [result.stdout, result.stderr, ...notice].filter((part) => part.length > 0).join("\n");
        return { content: [{ type: "text", text: text || `exit ${result.code ?? 0}` }], isError: result.code !== 0 };
      } catch (error) {
        return { content: [{ type: "text", text: failureText(error) }], isError: true };
      }
    },
  };
}

export function createCodingTools(root: string): AgentTool[] {
  prepareWorkspace(root);
  const enqueue = createQueue();
  return [
    createReadTool(root),
    createWriteTool(root, enqueue),
    createEditTool(root, enqueue),
    createBashTool(root),
    createGrepTool(root),
    createFindTool(root),
    createLsTool(root),
  ];
}
