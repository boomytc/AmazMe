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
import { AgentHarness, type Storage } from "@amazme/durable";
import type { ProtocolLimits } from "@amazme/protocol";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { Server, type RuntimeHandle, type RuntimeService } from "@amazme/server";
import { memoryConnector, type MemoryLink } from "@amazme/server/testing";
import type { LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { createManagementService, RuntimeHost } from "@amazme/runtime-service/server";

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
  host: RuntimeHost;
  streams: AssistantEventStream[];
}

/** One server with explicitly registered runtimes, reached through the in-memory byte pipe. */
export function world(options: {
  runtimes?: string[];
  storage?: (id: string) => Storage;
  publishWindowMs?: number;
  lanes?: readonly string[];
  limits?: Partial<ProtocolLimits>;
} = {}) {
  const errors: Error[] = [];
  const services = new Map<string, RuntimeService>();
  const server = new Server({
    serverId: "srv",
    service: createManagementService(),
    onError: (error) => errors.push(error),
    openRuntime: (runtimeId) => Promise.resolve(services.has(runtimeId) ? borrowedRuntime(services.get(runtimeId)!) : null),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const runtimes = new Map<string, RuntimeFixture>();
  for (const id of options.runtimes ?? ["main"]) {
    const { models, streams } = gatedModels();
    const storage = options.storage?.(id) ?? new MemoryStorage();
    const harness = new AgentHarness(storage, { models, model: { provider: "gated", modelId: "g" } });
    const host = new RuntimeHost({
      harness,
      publishWindowMs: options.publishWindowMs ?? 5,
      onError: (error) => errors.push(error),
      ...(options.lanes ? { lanes: options.lanes } : {}),
    });
    services.set(id, host);
    runtimes.set(id, { storage, harness, host, streams });
  }
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
  const runtime = (id = "main") => runtimes.get(id)!;
  const close = async () => {
    for (const client of clients) await client.dispose();
    await server.close();
    for (const fixture of runtimes.values()) {
      await fixture.host.close();
      for (const stream of fixture.streams) finish(stream, "teardown");
      await fixture.host.drivesSettled();
      await fixture.harness.close();
    }
    const thrown = links.flatMap((link) => [...link.client.handlerErrors, ...link.server.handlerErrors]);
    if (thrown.length > 0) throw new AggregateError(thrown, "transport handlers threw");
    if (errors.length > 0) throw new AggregateError(errors, "unexpected server or runtime errors");
  };
  const allow = (id: string, service: RuntimeService) => { services.set(id, service); };
  return { server, runtime, connect, links, errors, close, allow };
}

/** A borrowed service. Closing the server does not close the harness the caller still owns. */
export function borrowedRuntime(service: RuntimeService): RuntimeHandle {
  return {
    acquire: () => ({ service, release: () => undefined }),
    close: () => Promise.resolve(),
    idle: () => false,
  };
}
