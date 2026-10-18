# SDK Examples

Programmatic usage of the coding agent via `createDurableSession()`.

The runtime example shows how to build a recreate function that closes over process-global fixed inputs and recreates cwd-bound services and sessions as the active session cwd changes.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with all defaults |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `06-extensions.ts` | Logging, blocking, result modification |
| `07-context-files.ts` | AGENTS.md context files |
| `08-prompt-templates.ts` | File-based prompt templates |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |
| `14-codemode-mcp.ts` | Add the `codemode`, `tool_search`, and MCP extensions |
| `15-typesafe-crop.ts` | Jev 1.14: locate on a small image, crop the original, re-question and restore pixel coordinates |

## Running

```bash
cd packages/coding-agent
node examples/sdk/01-minimal.ts
```

## TypeSafe crop and re-question

The TypeSafe example uses `TYPESAFE_API_KEY` or saved agent credentials:

```bash
node examples/sdk/15-typesafe-crop.ts ./page.png "the complete table" ./crop-output
```

It sends PNGs prepared from upright pixels, first at a smaller resolution and then as a crop of the original. Both rounds require sufficient presence probability and Box confidence; rejected candidates are returned for review. `result.json` records status, original upright pixel coordinates, both responses and combined usage/cost. `target.png` is written only for an accepted final result. Ctrl+C cancels the active request and prevents the second call. The example conservatively uses a 280-pixel minimum side to accommodate observed service behavior; this does not change the official 256-pixel/78,400-total-pixel protocol limits. Tiny or extremely narrow images require caller preparation or tiling. The fixed thresholds are examples to calibrate, and no desktop actions are executed.

## Quick Reference

```typescript
import { createDurableSession, SettingsManager } from "@amazme/coding-agent";

const session = await createDurableSession({
  provider: "anthropic",
  model: "claude-opus-4-5",
  thinkingLevel: "high",
  tools: ["read", "grep", "find", "ls"],
  noSession: true,
  settingsManager: SettingsManager.inMemory(),
  extensions: ["./my-facet.ts"],
});

session.subscribe((events) => {
  for (const event of events) {
    if (event.type !== "message_update") continue;
    for (const change of event.changes) {
      if (change.type === "text_delta") process.stdout.write(change.delta);
    }
  }
});
await session.prompt("Hello");
await session.dispose();
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `cwd` | `process.cwd()` | Working directory |
| `model` | From settings or the first available model | Model reference |
| `thinkingLevel` | From settings | off, low, medium, high, and the levels the model accepts |
| `tools` | Built-in defaults | Allowlist or `+name`/`-name` modifiers |
| `noSession` | false | Memory storage |
| `continueSession` | false | Resume the newest Durable session for `cwd` |
| `sessionDir` | Durable default root | Storage root override |
| `settingsManager` | File-backed settings | Settings overrides |
| `extensions` | none | Native facet sources |
