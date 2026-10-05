import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, type AgentHook, type AgentTool } from "@amazme/agent";
import { createModels, messageText } from "@amazme/ai";
import { fauxAssistant, fauxProvider, fauxToolCall, type FauxResponder } from "@amazme/ai/testing";
import { appendMcpTools, appendSkillText, createCodingTools, type McpClient } from "@amazme/coding-agent";

const today = "You are a coding agent. Use tools to inspect and change files in the workspace.";

function writeSkill(directory: string, name: string, body: string): string {
  const skillDirectory = join(directory, name);
  mkdirSync(skillDirectory, { recursive: true });
  const file = join(skillDirectory, "SKILL.md");
  writeFileSync(file, body);
  return file;
}

async function firstRequest(systemPrompt: string, tools: AgentTool[] = [], hooks?: AgentHook[], respond?: FauxResponder) {
  const provider = fauxProvider(respond ? { respond } : {});
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("faux", "faux-1");
  assert.ok(model);
  const agent = new Agent({
    model,
    streamFn: models.streamSimple.bind(models),
    systemPrompt,
    tools,
    hooks,
  });
  const produced = await agent.prompt("hi");
  return { provider, produced, agent };
}

test("one SKILL.md is appended to the systemPrompt seen before the request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-skill-"));
  const skills = join(dir, "skills");
  const skillPath = writeSkill(
    skills,
    "local",
    `---
name: ship-review
description: Review the current diff
---

FULL_SKILL_BODY
`,
  );
  const systemPrompt = appendSkillText(today, skills);
  const bare = appendSkillText("", skills);
  rmSync(skillPath);
  const { provider } = await firstRequest(systemPrompt, createCodingTools(dir));
  const seen = provider.state.contexts[0]?.systemPrompt ?? "";
  assert.equal(provider.state.contexts.length, 1);
  assert.equal(seen.slice(0, today.length), today);
  assert.equal(seen.slice(today.length, today.length + 2), "\n\n");
  assert.equal(seen.includes("ship-review"), true);
  assert.equal(seen.includes("Review the current diff"), true);
  assert.equal(seen.includes(skillPath), true);
  assert.equal(skillPath.includes("ship-review"), false);
  assert.equal(seen.includes("FULL_SKILL_BODY"), false);
  assert.equal(bare.startsWith("\n"), false);
  assert.equal(bare.includes("ship-review"), true);
  assert.deepEqual(
    provider.state.contexts[0]?.tools?.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "grep", "find", "ls"],
  );
  const agentSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "src");
  assert.equal(walk(agentSrc).includes("loadSkills"), false);
});

test("a skill marked disableModelInvocation is left out of the systemPrompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-skill-off-"));
  const skills = join(dir, "skills");
  const visible = writeSkill(
    skills,
    "local",
    `---
name: ship-review
description: Review the current diff
disableModelInvocation: false
---
`,
  );
  const hidden = writeSkill(
    skills,
    "quiet",
    `---
name: secret-move
description: Leave this skill out
disableModelInvocation: true
---

HIDDEN_SKILL_BODY
`,
  );
  const other = writeSkill(
    skills,
    "other",
    `---
name: cargo-note
description: Note the crate
---
`,
  );
  const { provider } = await firstRequest(appendSkillText(today, skills));
  const seen = provider.state.contexts[0]?.systemPrompt ?? "";
  assert.equal(seen.split("Skills available in this workspace.").length, 2);
  assert.equal(seen.includes("ship-review"), true);
  assert.equal(seen.includes("Review the current diff"), true);
  assert.equal(seen.includes(visible), true);
  assert.equal(seen.includes("cargo-note"), true);
  assert.equal(seen.includes("Note the crate"), true);
  assert.equal(seen.includes(other), true);
  assert.equal(seen.includes("secret-move"), false);
  assert.equal(seen.includes("Leave this skill out"), false);
  assert.equal(seen.includes(hidden), false);
  assert.equal(seen.includes("HIDDEN_SKILL_BODY"), false);
  const onlyHidden = join(dir, "only-hidden");
  writeSkill(
    onlyHidden,
    "quiet",
    `---
name: secret-move
description: Leave this skill out
disableModelInvocation: true
---
`,
  );
  assert.equal(appendSkillText(today, onlyHidden), today);
});

test("a SKILL.md in the caller directory is part of the same paragraph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-skill-direct-"));
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(
    skillPath,
    `---
name: direct-skill
description: Direct skill text
---
`,
  );
  const { provider } = await firstRequest(appendSkillText(today, dir));
  const seen = provider.state.contexts[0]?.systemPrompt ?? "";
  assert.equal(seen.slice(0, today.length), today);
  assert.equal(seen.includes("direct-skill"), true);
  assert.equal(seen.includes("Direct skill text"), true);
  assert.equal(seen.includes(skillPath), true);
  assert.equal(skillPath.includes("direct-skill"), false);
});

test("a missing skills directory leaves the systemPrompt unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-skill-none-"));
  const missing = join(dir, "skills");
  assert.equal(appendSkillText(today, missing), today);
  const empty = join(dir, "empty-skills");
  mkdirSync(empty);
  assert.equal(appendSkillText(today, empty), today);
  const { provider } = await firstRequest(appendSkillText(today, missing));
  assert.equal(provider.state.contexts[0]?.systemPrompt, today);
});

test("an in-memory MCP tool is called through the same before and after hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-mcp-"));
  const trace: string[] = [];
  const client: McpClient = {
    listTools: () => [{ name: "ping", description: "Send a ping", inputSchema: { type: "object" } }],
    callTool: (name, args) => {
      trace.push(`call:${name}:${JSON.stringify(args)}`);
      return Promise.resolve({ content: [{ type: "text", text: "pong" }] });
    },
  };
  const coding = createCodingTools(dir);
  const tools = await appendMcpTools(coding, { serverId: "box", client });
  assert.equal(tools.length, 8);
  assert.equal(tools[0], coding[0]);
  assert.equal(tools[1], coding[1]);
  assert.equal(tools[2], coding[2]);
  assert.equal(tools[3], coding[3]);
  assert.equal(tools[7]?.name, "mcp_box__ping");
  const respond: FauxResponder = (_context, _options, state) =>
    state.callCount === 1 ? fauxAssistant([fauxToolCall("mcp_box__ping", { value: 1 })]) : fauxAssistant("done");
  const hooks: AgentHook[] = [
    {
      beforeToolCall(input) {
        trace.push(`before:${input.toolName}`);
      },
      afterToolCall(input) {
        trace.push(`after:${input.toolName}:${input.result.content[0]?.type === "text" ? input.result.content[0].text : ""}`);
      },
    },
  ];
  const { provider, produced } = await firstRequest(today, tools, hooks, respond);
  assert.deepEqual(
    provider.state.contexts[0]?.tools?.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "grep", "find", "ls", "mcp_box__ping"],
  );
  assert.deepEqual(trace, ["before:mcp_box__ping", "call:ping:{\"value\":1}", "after:mcp_box__ping:pong"]);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result && result.role === "toolResult" ? messageText(result) : "", "pong");
});

test("beforeToolCall block skips the MCP client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-mcp-block-"));
  const trace: string[] = [];
  const client: McpClient = {
    listTools: () => [{ name: "ping", description: "Send a ping", inputSchema: { type: "object" } }],
    callTool: () => {
      trace.push("call");
      return Promise.resolve({ content: [{ type: "text", text: "pong" }] });
    },
  };
  const tools = await appendMcpTools(createCodingTools(dir), { serverId: "box", client });
  const respond: FauxResponder = (_context, _options, state) =>
    state.callCount === 1 ? fauxAssistant([fauxToolCall("mcp_box__ping", {})]) : fauxAssistant("stopped");
  const hooks: AgentHook[] = [
    {
      beforeToolCall() {
        trace.push("before");
        return { action: "block", reason: "no" };
      },
      afterToolCall() {
        trace.push("after");
      },
    },
  ];
  const { produced } = await firstRequest(today, tools, hooks, respond);
  assert.deepEqual(trace, ["before"]);
  const result = produced.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.match(result?.role === "toolResult" ? messageText(result) : "", /no/);
});

test("the CLI attaches cwd/skills and does not accept MCP arguments", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/host.ts", import.meta.url), "utf8");
  assert.equal(host.includes('join(cwd, "skills")'), true);
  assert.equal(host.includes("appendSkillText"), true);
  assert.equal(cli.includes("appendMcpTools"), false);
  assert.equal(cli.includes("McpClient"), false);
  assert.equal(cli.includes("--mcp"), false);
});

test("no MCP client leaves the original coding tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-mcp-none-"));
  const coding = createCodingTools(dir);
  const empty: McpClient = {
    listTools: () => [],
    callTool: () => Promise.resolve({ content: [{ type: "text", text: "" }] }),
  };
  assert.equal(await appendMcpTools(coding), coding);
  assert.equal(await appendMcpTools(coding, { serverId: "box", client: empty }), coding);
  assert.deepEqual(
    coding.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "grep", "find", "ls"],
  );
  const { provider } = await firstRequest(today, await appendMcpTools(coding));
  assert.deepEqual(
    provider.state.contexts[0]?.tools?.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "grep", "find", "ls"],
  );
});

function walk(directory: string): string {
  let text = "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    text += entry.isDirectory() ? walk(full) : entry.name.endsWith(".ts") ? readFileSync(full, "utf8") : "";
  }
  return text;
}
