# SDK

`@amazme/coding-agent` embeds AmazMe in a Node.js or Bun process. It provides direct TypeScript access to the agent, sessions, tools, models, and resources used by the command-line application.

Use the SDK for in-process TypeScript integration. For a language-independent or isolated subprocess, see [CLI Integration](cli-integration.md).

`main(args)` embeds the CLI. Plugins are native facets passed with `-e`. There is no inline extension-factory option.

```typescript
import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession();

try {
  const answer = await session.prompt("What files are in the current directory?");
  console.log(answer?.content);
} finally {
  await session.dispose();
}
```

This uses the working directory, discovered resources, stored settings, and configured credentials. `prompt()` resolves with the committed assistant message.

The [complete minimal example](../examples/sdk/01-minimal.ts) also streams text events. All [SDK examples](../examples/sdk/) are typechecked with the repository.

<a id="session-management"></a>

## Session lifecycle

`createDurableSession()` opens one Durable session. The same export is available from `@amazme/coding-agent/durable`.

Read current state through `session.messages()`, `session.model`, and `session.thinkingLevel`.

<a id="sessionmanager-api"></a>

### Session storage

Sessions are persistent by default, under the Durable session root. Pass `noSession: true` for memory storage. Pass `continueSession: true` to resume the newest Durable session for `cwd`. Pass `sessionDir` to override the storage root.

`cwd` selects the workspace used for project resource discovery, context files, session grouping, and built-in tool paths. Pass it explicitly when the target differs from `process.cwd()`.

`session.dispose()` closes the Durable session. Call it when the session is no longer needed.

Continue, import, and a fresh session are shown in the [sessions example](../examples/sdk/11-sessions.ts) and the [runtime example](../examples/sdk/13-session-runtime.ts). JSONL remains an import source and an export projection; see [Session File Format](session-format.md).

## Prompting

`prompt()` submits text and resolves with that input's committed assistant message, or throws when the input is unanswered. `steer()` steers the active run, or starts one when idle. `followUp()` queues input for the next run, or starts one when idle. `abort()` stops the active run. `compact()` starts a manual compaction task.

## Subscribing to events

Subscribe before prompting when the host needs streamed output:

```typescript
const unsubscribe = session.subscribe((events) => {
  for (const event of events) {
    if (event.type !== "message_update") continue;
    for (const change of event.changes) {
      if (change.type === "text_delta") process.stdout.write(change.delta);
    }
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
}
```

The subscription receives batches of Durable agent events, one batch per commit. `message_end` contains the completed message.

## Configuring a session

Without overrides, the factory uses stored settings, discovered resources, and persistent Durable storage.

Each boundary can be supplied explicitly:

- `model` and `thinkingLevel` select the conversation model.
- `settingsManager` supplies merged settings or an in-memory configuration.
- `noSession` uses memory storage. `continueSession` resumes the newest Durable session. `sessionDir` overrides the storage root.
- `resourceLoader` supplies skills, prompt templates, themes, and context files.
- `tools`, `noTools`, and `excludeTools` control the active tool set.
  `tools: ["+grep", "-write"]` edits inherited defaults; plain names form an allowlist. Modifier entries require exact names and cannot mix with plain names. `excludeTools` applies last.
- `extensions` lists native facet sources. Inline extension factories are not accepted.

Use `DefaultResourceLoader` when you want standard discovery with selected overrides. Supply a custom `ResourceLoader` when the host owns resource storage and discovery completely.

<a id="inlineextension"></a>

`extensions` on `createDurableSession` takes native facet paths: a source file, a plugin package, or the same sources `-e` accepts. Inline extension factories are not accepted, and supplying them through `DefaultResourceLoader` does not install them on a Durable session. Print, JSON, and RPC use that same native path. See [native plugins](plugin-runtime.md) and the [extensions example](../examples/sdk/06-extensions.ts).

<a id="codemode-mcp"></a>

The CLI loads `codemode`, `tool_search`, and MCP through the resource loader. A Durable session enables them with tool names and native facet sources. See [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts) and [extensions](../examples/sdk/06-extensions.ts).

See the focused examples for [models](../examples/sdk/02-custom-model.ts), [tools](../examples/sdk/05-tools.ts), and [full control](../examples/sdk/12-full-control.ts). `setModel()` and `setThinkingLevel()` write the conversation's agent document. See [Durable single-kernel migration](../../../docs/durable-migration.md).

## Examples

| Example | Purpose |
|---|---|
| [Minimal](../examples/sdk/01-minimal.ts) | Create, prompt, observe, and dispose a session |
| [Custom model](../examples/sdk/02-custom-model.ts) | Select a model and thinking level |
| [System prompt](../examples/sdk/03-custom-prompt.ts) | Replace or append to the system prompt |
| [Skills](../examples/sdk/04-skills.ts) | Discover, filter, and add skills |
| [Tools](../examples/sdk/05-tools.ts) | Select built-in tools and their working directory |
| [Extensions](../examples/sdk/06-extensions.ts) | Load a native facet |
| [Context files](../examples/sdk/07-context-files.ts) | Add or replace project instructions |
| [Prompt templates](../examples/sdk/08-prompt-templates.ts) | Add file-style prompt templates |
| [Credentials](../examples/sdk/09-api-keys-and-oauth.ts) | Configure credential and model storage |
| [Settings](../examples/sdk/10-settings.ts) | Supply file-backed or in-memory settings |
| [Sessions](../examples/sdk/11-sessions.ts) | Control session persistence and restoration |
| [Full control](../examples/sdk/12-full-control.ts) | Replace default discovery and state services |
| [Session runtime](../examples/sdk/13-session-runtime.ts) | Replace the active session safely |
| [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts) | Add the `codemode`, `tool_search`, and MCP extensions |

<a id="exports"></a>

## Resources

- [Choose a Model](models.md) covers model selection and compatible endpoints; [Providers](providers.md) covers credentials and provider-specific setup.
- [Configuration](configuration.md) explains normal discovery and settings; [Settings](settings.md) lists every setting.
- [Sessions and Context](sessions.md) explains session behavior; [Session Format](session-format.md) defines persisted entries; [Message Types](message-types.md) defines shared transcript values.
- [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) document resources supplied through a `ResourceLoader`.
- [CLI Integration](cli-integration.md) covers print, JSON, and RPC alternatives to an in-process SDK integration.

## Observed file tools

Built-in `edit` and replacement `write` require a successful `read` of the existing file. Files changed outside the tool chain must be read again. New-file writes never overwrite another writer's creation. Completed changes refresh the observation, so subsequent edits can use them without another read. The session JSONL journal owns observations; reopening the same session restores them, while a fork or historical branch requires fresh reads. A bounded projection keeps at most 1024 targets per owner.

Standalone groups created by `createCodingTools()`, `createAllTools()` or their definition factories share one in-memory owner. Independent tools share only an explicitly supplied owner:

```typescript
import { createMemoryFileObservations, createReadTool, createEditTool } from "@amazme/coding-agent";

const observations = createMemoryFileObservations();
const read = createReadTool(process.cwd(), { observations });
const edit = createEditTool(process.cwd(), { observations });
await read.execute("read-1", { path: "app.ts" });
await edit.execute("edit-1", { path: "app.ts", edits: [{ oldText: "old", newText: "new" }] });
```

For another filesystem, supply `fileSystem` in the tool options (or group options). It implements the shared `FileSystem` contract from `@amazme/durable/env`, including opened-reader revisions and checked publication. SSH and Gondolin examples use the actual daemon protocol. Gondolin needs a Linux musl daemon for the guest architecture; `AMAZME_ENV_LINUX_BINARY` can point to that build when the package has no bundled binary. There is no unconditional read/write operations fallback. File namespaces must remain stable across connection recreation to restore observations and differ across isolated machines.

Cancellation waits for in-flight IO and required cleanup before releasing a mutation barrier. If publication already completed, the result reports success; unavailable observation persistence adds a reread warning. Checked publication rechecks cooperating writers but does not claim an operating-system lock against arbitrary external processes.
