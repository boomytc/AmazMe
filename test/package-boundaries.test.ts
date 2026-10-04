import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as agent from "@amazme/agent";
import { AgentHarness, type HarnessMessage, type HarnessTool } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { createModels } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall } from "@amazme/ai/providers/faux";

test("durable depends on the agent walks and agent does not depend on durable", () => {
  const agentPkg = JSON.parse(readFileSync(new URL("../packages/agent/package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
  const durablePkg = JSON.parse(readFileSync(new URL("../packages/durable/package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(durablePkg.dependencies?.["@amazme/agent"], "0.1.0");
  assert.equal(agentPkg.dependencies?.["@amazme/durable"], undefined);
  assert.equal(typeof agent.walkBefore, "function");
  assert.equal(typeof agent.walkAfter, "function");
  assert.equal(typeof agent.walkTransform, "function");
  assert.equal(typeof agent.walkYield, "function");
  assert.equal("foldHooks" in agent, false);
  assert.equal("finishTurn" in agent, false);
});

test("the MCP package depends on none of the other AmazMe packages", () => {
  const mcpPkg = JSON.parse(readFileSync(new URL("../packages/mcp/package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(mcpPkg.dependencies, undefined);
  assert.equal(mcpPkg.devDependencies, undefined);
  const script = `
    let loadingCore = true;
    const { registerHooks } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (/\\/packages\\/(ai|agent|durable|coding-agent)\\//.test(resolved.url)) {
        throw new Error("MCP loaded " + specifier);
      }
      if (loadingCore && resolved.url.includes("/packages/mcp/src/oauth/")) {
        throw new Error("MCP core loaded OAuth: " + specifier);
      }
      return resolved;
    } });
    const { McpClient } = await import("@amazme/mcp");
    const { createInMemoryTransportPair } = await import("@amazme/mcp/testing");
    if (typeof McpClient !== "function" || typeof createInMemoryTransportPair !== "function") throw new Error("MCP entry missing");
    loadingCore = false;
    const { McpOAuthProvider } = await import("@amazme/mcp/oauth");
    if (typeof McpOAuthProvider !== "function") throw new Error("MCP OAuth entry missing");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("the protocol depends only on TypeBox and its root entry runs without Node modules, process, or AmazMe packages", () => {
  const protocolPkg = JSON.parse(readFileSync(new URL("../packages/protocol/package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(protocolPkg.dependencies, { typebox: "1.3.27" });
  assert.equal(protocolPkg.devDependencies, undefined);
  const script = `
    const { registerHooks, builtinModules } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) throw new Error("Node import in protocol: " + specifier);
      const resolved = next(specifier, context);
      if (/\\/packages\\/(?!protocol\\/)[^/]+\\//.test(resolved.url)) throw new Error("protocol loaded " + specifier);
      return resolved;
    } });
    globalThis.process = undefined;
    const protocol = await import("@amazme/protocol");
    const message = { type: "request", id: "r1", route: { serverId: "s" }, call: { opaque: [1, "x"] } };
    const frame = protocol.encodeClientMessage(message);
    const decoder = new protocol.ClientMessageDecoder();
    const decoded = [...decoder.push(frame.subarray(0, 3)), ...decoder.push(frame.subarray(3))];
    if (JSON.stringify(decoded) !== JSON.stringify([message])) throw new Error("round trip failed");
    for (const name of ["LaneSnapshot", "OperationState", "prompt", "value", "list", "AgentHarness"]) {
      if (name in protocol) throw new Error("protocol exports business value " + name);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("the public Agent entry runs without loading Durable", () => {
  const script = `
    const { registerHooks } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.includes("/packages/durable/")) throw new Error("Durable dependency in Agent: " + specifier);
      return resolved;
    } });
    const { Agent } = await import("@amazme/agent");
    const { createModels } = await import("@amazme/ai");
    const { fauxProvider } = await import("@amazme/ai/providers/faux");
    const models = createModels();
    models.setProvider(fauxProvider());
    const model = models.getModel("faux", "faux-1");
    const output = await new Agent({ model, streamFn: models.streamSimple.bind(models) }).prompt("independent");
    const last = output.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error("Agent failed");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("the AI root entry does not load a protocol and runs without process or Node modules", () => {
  const script = `
    const { registerHooks } = await import("node:module");
    registerHooks({ resolve(specifier, context, next) {
      const parent = context.parentURL ?? "";
      const fromCore = parent.includes("/packages/ai/src/") && !parent.includes("/packages/ai/src/api/") && !parent.includes("/packages/ai/src/providers/") && !parent.includes("/packages/ai/src/testing/");
      if (fromCore && (specifier.startsWith("node:") || specifier.includes("/api/") || specifier.includes("/providers/") || specifier.includes("/testing"))) {
        throw new Error("core loaded " + specifier);
      }
      return next(specifier, context);
    } });
    const prior = globalThis.process;
    globalThis.process = undefined;
    try {
      const { createModels, validateArguments } = await import("@amazme/ai");
      const models = createModels();
      models.setProvider({
        id: "local",
        name: "local",
        auth: { env: "LOCAL_KEY", ambient: "local" },
        getModels: () => [{ id: "m", name: "m", provider: "local", api: "local", input: ["text"], contextWindow: 8, maxTokens: 8, cost: { input: 0, output: 0 } }],
        stream() { throw new Error("unused"); },
        streamSimple() { throw new Error("unused"); },
      });
      if (!models.getModel("local", "m")) throw new Error("model lookup failed");
      const invalid = validateArguments({ type: "object", properties: { n: { type: "number" } }, additionalProperties: false }, { n: "1" });
      if (!invalid || !invalid.includes("n")) throw new Error("validator unavailable");
    } finally {
      globalThis.process = prior;
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test("shared tools and custom messages satisfy the independent Agent and Durable contracts", async (t) => {
  assert.equal("AgentHarness" in agent, false);
  assert.equal("MemoryStorage" in agent, false);
  assert.equal("uuidv7" in agent, false);
  assert.equal("validateArguments" in agent, false);
  for (const path of ["@amazme/agent/storage/jsonl/node", "@amazme/agent/testing"]) {
    await assert.rejects(import(path), (error: NodeJS.ErrnoException) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
  }
  let runs = 0;
  const agentTool: agent.AgentTool = {
    name: "shared", description: "shared tool", parameters: { type: "object" }, replay: "safe",
    async execute() { runs++; return { content: [{ type: "text", text: "shared-result" }] }; },
  };
  const durableTool: HarnessTool = agentTool;
  const custom: agent.CustomMessage = { role: "custom", name: "application", content: "custom-input", timestamp: 1 };
  const durableMessage: HarnessMessage = custom;
  const models = createModels();
  models.setProvider(fauxProvider({ respond: (_context, _options, state) => state.callCount === 1
    ? fauxAssistant([fauxToolCall("shared", {})]) : fauxAssistant("done") }));
  const harness = new AgentHarness(new MemoryStorage(), { models, model: { provider: "faux", modelId: "faux-1" }, tools: [durableTool] });
  t.after(() => harness.close());
  assert.ok((await harness.lane().steer(durableMessage)).ok);
  assert.equal((await harness.lane().prompt("go")).status, "completed");
  assert.equal(runs, 1);
  const customEntry = (await harness.lane().entries()).find(entry => entry.payload.type === "message" && entry.payload.message.role === "custom");
  assert.ok(customEntry?.payload.type === "message");
  assert.deepEqual(customEntry.payload.message, custom);
});
