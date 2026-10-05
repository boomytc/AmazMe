import {
  baseAssistant,
  createAssistantEventStream,
  createModels,
  type AssistantContent,
  type AssistantEventStream,
  type Model,
  type Provider,
} from "@amazme/ai";
import { Client, type ByteTransportFactory } from "@amazme/client";
import { AgentHarness, type HarnessTool, type Storage } from "@amazme/durable";
import type { ProtocolLimits } from "@amazme/protocol";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { Server, type RuntimeHandle, type RuntimeService } from "@amazme/server";
import { memoryConnector, type MemoryLink } from "@amazme/server/testing";
import type { LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { createManagementService, openOwnedRuntimes, type HostClock, type OwnedRuntimeResources } from "@amazme/runtime-service/server";

export const model: Model = {
  id: "g",
  name: "g",
  provider: "gated",
  api: "faux",
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0 },
};

/** A model whose streams the test drives event by event. No network, no credentials. */
export function gatedModels() {
  const streams: AssistantEventStream[] = [];
  const provider: Provider = {
    id: "gated",
    name: "gated",
    auth: { apiKey: { env: "GATED", ambient: "x" } },
    getModels: () => [model],
    stream(active, context, options) {
      return this.streamSimple(active, context, options);
    },
    streamSimple() {
      const stream = createAssistantEventStream();
      streams.push(stream);
      return stream;
    },
  };
  const models = createModels();
  models.setProvider(provider);
  return { models, streams };
}

export function partial(content: AssistantContent[]) {
  return { ...baseAssistant(model, content, "stop"), stopReason: "pending" as const };
}

export function textDelta(stream: AssistantEventStream, delta: string, soFar: string): void {
  stream.push({ type: "text_delta", contentIndex: 0, delta, partial: partial([{ type: "text", text: soFar }]) });
}

export function finish(stream: AssistantEventStream, text: string): void {
  stream.push({ type: "done", reason: "stop", message: baseAssistant(model, [{ type: "text", text }], "stop") });
}

export async function until(predicate: () => boolean | Promise<boolean>, label = "condition", ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

export function pendingText(snapshot: LaneSnapshotDto): string | undefined {
  const block = snapshot.pendingResponse?.content[0] as { type: string; text?: string } | undefined;
  return block?.type === "text" ? block.text : undefined;
}

export function texts(snapshot: LaneSnapshotDto): string[] {
  return snapshot.entries.map((entry) => {
    if (entry.payload.type === "compaction") return entry.payload.summary;
    const message = entry.payload.message as unknown as { content: unknown };
    if (typeof message.content === "string") return message.content;
    return (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join("");
  });
}

export interface RuntimeFixture {
  storage: Storage;
  harness: AgentHarness;
  streams: AssistantEventStream[];
  /** Present after the server has opened this runtime. */
  handle?: RuntimeHandle;
  service?: RuntimeService;
}

/** One server whose runtimes are opened on demand and owned by the host. */
export function world(options: {
  runtimes?: string[];
  storage?: (id: string) => Storage;
  tools?: HarnessTool[];
  publishWindowMs?: number;
  clock?: HostClock;
  lanes?: readonly string[];
  limits?: Partial<ProtocolLimits>;
} = {}) {
  const errors: Error[] = [];
  const fakes = new Map<string, RuntimeService>();
  const runtimes = new Map<string, RuntimeFixture>();
  const known = new Set(options.runtimes ?? ["main"]);
  let server!: Server;
  const opener = openOwnedRuntimes({
    open(runtimeId): Promise<OwnedRuntimeResources | null> {
      if (!known.has(runtimeId)) return Promise.resolve(null);
      const { models, streams } = gatedModels();
      const storage = options.storage?.(runtimeId) ?? new MemoryStorage();
      const harness = new AgentHarness(storage, {
        models,
        model: { provider: "gated", modelId: "g" },
        ...(options.tools ? { tools: options.tools } : {}),
      });
      runtimes.set(runtimeId, { storage, harness, streams });
      return Promise.resolve(memoryResources(storage, harness));
    },
    publishWindowMs: options.publishWindowMs ?? 5,
    ...(options.clock ? { clock: options.clock } : {}),
    onError: (error) => errors.push(error),
    ...(options.lanes ? { lanes: options.lanes } : {}),
  });
  server = new Server({
    serverId: "srv",
    service: createManagementService({
      removeRuntime: (runtimeId) => server.removeRuntime(runtimeId),
      ...(options.runtimes ? { runtimes: options.runtimes } : {}),
    }),
    onError: (error) => errors.push(error),
    openRuntime: async (runtimeId, signal) => {
      const fake = fakes.get(runtimeId);
      if (fake) return detachedService(fake);
      const handle = await opener(runtimeId, signal);
      const fixture = runtimes.get(runtimeId);
      if (handle && fixture) {
        fixture.handle = handle;
        fixture.service = handle.acquire().service;
      }
      return handle;
    },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const connector = memoryConnector((connection) => server.accept(connection));
  const links: MemoryLink[] = connector.links;
  const transport: ByteTransportFactory = (handlers) => connector.transport(handlers);
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ serverId: "srv", transport, ...(options.limits ? { limits: options.limits } : {}) });
    clients.push(client);
    await client.connect();
    return { client, remote: new RuntimeClient(client) };
  };
  const runtime = (id = "main") => {
    const fixture = runtimes.get(id);
    if (!fixture?.handle || !fixture.service) throw new Error(`runtime ${id} is not open`);
    return fixture as RuntimeFixture & { handle: RuntimeHandle; service: RuntimeService };
  };
  const close = async () => {
    for (const client of clients) await client.dispose();
    const closing = server.close();
    for (const fixture of runtimes.values()) {
      for (const stream of fixture.streams) finish(stream, "teardown");
    }
    await closing;
    const thrown = links.flatMap((link) => [...link.client.handlerErrors, ...link.server.handlerErrors]);
    if (thrown.length > 0) throw new AggregateError(thrown, "transport handlers threw");
    if (errors.length > 0) throw new AggregateError(errors, "unexpected server or runtime errors");
  };
  const allow = (id: string, service: RuntimeService) => { fakes.set(id, service); };
  return { server, runtime, connect, links, errors, close, allow };
}

function memoryResources(storage: Storage, harness: AgentHarness): OwnedRuntimeResources {
  return {
    harness,
    closeStorage: () => storage.whenIdle(),
    release: () => storage.whenIdle(),
    remove: () => storage.whenIdle(),
  };
}

/** A service with no harness. Idle stays false so the server does not reclaim it. */
function detachedService(service: RuntimeService): RuntimeHandle {
  return {
    acquire: () => ({ service, release() {} }),
    close: () => Promise.resolve(),
    idle: () => false,
  };
}
