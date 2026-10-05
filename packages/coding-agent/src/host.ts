import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { AssistantEventStream, Context, Model, StreamOptions } from "@amazme/ai";
import { Server } from "@amazme/server";
import { listenUnix, type UnixListener } from "@amazme/server/unix";
import { openJsonlRuntime } from "@amazme/runtime-service/jsonl";
import { createManagementService, openOwnedRuntimes } from "@amazme/runtime-service/server";
import { connectWorkspaceMcp } from "./mcp-config.ts";
import { appendMcpTools } from "./mcp.ts";
import { packageSkillText } from "@amazme/tui";
import { appendSkillText } from "./skills.ts";
import { codingSystemPrompt, createCodingTools } from "./tools.ts";

interface HostModels {
  getModel(providerId: string, modelId: string): Model | undefined;
  streamSimple(model: Model, context: Context, options?: StreamOptions): AssistantEventStream;
  listModels?(): readonly { provider: string; id: string }[];
}

export const HOST_SERVER_ID = "amazme";
export const HOST_RUNTIME_ID = "workspace";
export const HOST_LANE = "main";

const SYSTEM_PROMPT = codingSystemPrompt;

export function runtimeFile(cwd: string): string {
  return join(resolve(cwd), ".amazme", "runtime", "workspace.jsonl");
}

export interface CodingHostOptions {
  cwd: string;
  socket: string;
  provider: string;
  model: string;
  models: HostModels;
  onError?: (error: Error) => void;
}

export interface CodingHost {
  readonly socket: string;
  readonly serverId: string;
  readonly runtimeId: string;
  readonly lane: string;
  close(mode?: "drain" | "abort"): Promise<void>;
}

/**
 * Listen for one workspace runtime. Opening reads JSONL and constructs the harness;
 * it does not drive or call a model. The caller owns process signals.
 */
export async function startCodingHost(options: CodingHostOptions): Promise<CodingHost> {
  const cwd = resolve(options.cwd);
  const provider = options.provider;
  const modelId = options.model;
  if (!options.models.getModel(provider, modelId)) throw new Error(`unknown model ${provider}/${modelId}`);
  const report = (error: Error) => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot change host state.
    }
  };
  let server!: Server;
  server = new Server({
    serverId: HOST_SERVER_ID,
    service: createManagementService({ removeRuntime: (runtimeId) => server.removeRuntime(runtimeId) }),
    onError: report,
    openRuntime: openOwnedRuntimes({
      // Every conversation in the session log is servable. `main` is only the default.
      onError: report,
      async open(runtimeId) {
        if (runtimeId !== HOST_RUNTIME_ID) return null;
        const file = runtimeFile(cwd);
        mkdirSync(join(cwd, ".amazme", "runtime"), { recursive: true });
        const coding = createCodingTools(cwd);
        const mcp = await connectWorkspaceMcp(cwd);
        try {
          const tools = await appendMcpTools(coding, mcp.servers);
          const resources = await openJsonlRuntime(file, {
            models: withPackageSkills(cwd, options.models),
            model: { provider, modelId },
            systemPrompt: appendSkillText(SYSTEM_PROMPT, join(cwd, "skills")),
            workspace: shortWorkspace(cwd),
            tools,
          });
          return {
            harness: resources.harness,
            closeStorage: () => resources.closeStorage(),
            release: () => resources.release(),
            remove: () => resources.remove(),
            closeResources: () => mcp.close(),
          };
        } catch (error) {
          await mcp.close();
          throw error;
        }
      },
    }),
  });
  const listener: UnixListener = await listenUnix(server, { path: options.socket, onError: report });
  let closing: Promise<void> | undefined;
  return {
    socket: listener.path,
    serverId: HOST_SERVER_ID,
    runtimeId: HOST_RUNTIME_ID,
    lane: HOST_LANE,
    close(mode: "drain" | "abort" = "drain") {
      const shutdown = server.close(mode);
      if (!closing) {
        let run!: Promise<void>;
        run = shutdown.then(() => listener.close()).then(() => undefined, (error: unknown) => {
          if (closing === run) closing = undefined;
          throw error;
        });
        closing = run;
      }
      return closing;
    },
  };
}

function withPackageSkills(cwd: string, models: HostModels): HostModels {
  return {
    getModel: (provider, modelId) => models.getModel(provider, modelId),
    ...(models.listModels ? { listModels: () => models.listModels?.() ?? [] } : {}),
    streamSimple(model, context, options) {
      const extra = packageSkillText(cwd);
      if (extra.length === 0) return models.streamSimple(model, context, options);
      const systemPrompt = context.systemPrompt ? `${context.systemPrompt}\n\n${extra}` : extra;
      return models.streamSimple(model, { ...context, systemPrompt }, options);
    },
  };
}

function shortWorkspace(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + sep)) return `~${cwd.slice(home.length)}`;
  return basename(cwd);
}
