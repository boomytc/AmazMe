# Experimental client/server service slices

Facet setup generates each host's RPC service catalogue from its provided non-local tokens. Remote service sources obtain those catalogues and bind only services required by consuming facets; there is no handwritten built-in service inventory. With no selected Session, its deferred source admits unresolved requirements as unavailable and keeps their handles disconnected. Attachment validates them against the worker's generated catalogue, which is cached for later detached generations. Keyed services hydrate as an empty directory until their owning feature spawns an instance.

Run the source-only server, client, and web entry from the repository root. The slice is source-only because
it is excluded from npm packages and standalone binaries, so every command starts from the repository's
TypeScript through the source resolver:

```bash
AMAZME_EXPERIMENTAL=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/experimental/cli.ts server
AMAZME_EXPERIMENTAL=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/experimental/cli.ts client
AMAZME_EXPERIMENTAL=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/experimental/cli.ts web
```

`AMAZME_SERVER_DIR` overrides the server profile and socket directory, which defaults to `~/.amazme/server`. `AMAZME_SERVER_ID` selects the logical server ID when `--server-id` is omitted.

`web` serves the same host to a browser: loopback HTTP for the page, the same port's `/amazme` path for the
byte protocol over WebSocket, and the same Unix socket for the TUI client. It prints `Web: <url>`,
`Mode: <mode>`, `WebSocket: <url>`, and `Server: <id> (started|already running)` once the host accepts
connections, binds loopback only,
and injects a boot manifest into the document so a page without one reports an error instead of rendering an
empty shell. A server already listening in the server directory under the resolved server ID is reused: the
page's WebSocket endpoint stays this launch's, and every connection is forwarded to that server, so a second
`web` launch — or a `client` one — shares one session list and one live state. The document, its stylesheets,
and the browser-side view come from the `@amazme/web` package; this slice holds the entry
(`experimental/web/page.ts`) that binds the host's services and drives the composer, plus the HTTP/WebSocket
host. The page bundle is built in memory with the repository's esbuild and the root tsconfig paths, so the
browser runs the same protocol and client code the TUI does. Changes to the
page take effect after the host restarts.

| Scope | Service | Current slice | Continuation point |
|---|---|---|---|
| server | `SessionDirectory` | replicated state implemented | add authenticated per-client projection when identity lands |
| server | `SessionManagement` | create, remove, attach, detach implemented | add authenticated workspace authorization |
| server | `Settings` | the editable field catalogue over the host's `SettingsManager` — field ids, heading tokens, kinds, and stored enum values, plus the interface `locale` and `appearance` preferences — with a write per field and a reload of the files | add project-scoped writes and a typed editor for list fields |
| server | `Skills` | the agent's loaded skills, with read, write, remove, and import for the agent directory's own | add skill-path settings and prompt-template management |
| server | `Plugins` | the server's default plugin package selection and the `mcp.json` entries the CLI and TUI read | connect MCP servers from this host and report their status |
| server | `Feedback` | the reader's rating of one committed answer, stored in `<agentDir>/feedback.json` so the CLI can read it too, with rate, replace, and retract | attach a note or a diff-scoped rating, and aggregate them into review reports |
| server | `Schedules` | planned prompts the host runs on their own: one JSON file (`<agentDir>/schedules.json`), a periodic due check, and an on-demand run that reports the answer's outcome | add per-schedule models, retries, and a run history rather than only the last outcome |
| server | `PresentationPlugins` | prepares the selected Session branch's matching TUI artifacts and reloads that branch | add authenticated plugin policy |
| session | `SessionPlugins` | reloads the configured Session facet generation | add coordinated multi-worker reload reporting |
| session | `SessionSettings` | asks the worker to re-read the settings files, so a change made elsewhere reaches the running Session | invalidate the per-directory prompt cache so newly written skills apply to a running Session |
| session | `Commands` | the session's own command catalogue (model, thinking, compact, reload) with textual arguments, argument completions, and a value-shaped result | add skill and prompt-template commands to this catalogue |
| session | `Workspace` | the Session's working directory as a listing and a text reader, with paths confined to that directory | add file writing, git status, and a diff view |
| session | `Terminal` | one shell per Session over the same execution path as the bash tool, with streamed output in replicated state and a stop control | add a persistent shell session and per-command timeouts |
| session | `Approvals` | the tool calls paused at the boundary by the `toolApproval` policy, with a decision that releases each one (approve runs it, deny blocks it) | add per-tool rules and remembered decisions |
| session | `Conversations` | the Session's conversation list with fork and subagent edges, the focused conversation (restored from `amazme.session.focus`), its lane, stored-history paging, per-conversation prompt/steer/follow-up/abort/compact, and leaving a branch via `Conversation.branchSummary` | focus-only stays `select`; a summary is written on the continuation `branchSummary` returns |
| session | `Models` | state, default-persisting selection, thinking, refresh implemented | move provider/auth composition behind plugin facets |
| session | `AgentController` | presentation-safe facade over the root durable conversation for prompting, steering, follow-ups, queue cancellation, abort, compaction, and waiting for a prompt's answer | add new conversation operations only when a presentation requires them |
| session | `Transcript` | the root conversation's durable `ConversationView` as replicated state | add projections only when another presentation needs them |
| presentation | `SlashCommands` | process-local contribution registry with model, thinking, compact, reload, and example hello commands | add more presentation hookpoints only as concrete plugin slices require them |
| presentation | `PresentationUI` | process-local selection and status capabilities | add narrowly scoped UI capabilities only when commands require them |

The settings catalogue publishes identities, not copy: a field's `id`, its heading `group` token, and an enum's stored
values. Each presentation names them in its own language, the way the TUI's settings selector keeps its own English
labels, so the host never ships a sentence and a second language costs it nothing. `locale` and `appearance` are part of
the same catalogue: the web host reads them per document to serve the page in the stored language and palette, and the
TUI ignores them.

`ServerServiceSource.connection` and `SessionServiceSource.attachment` are implemented local control states. Session directory, creation, and address DTOs are owned by these coding-agent service contracts rather than `pi-protocol`; the transport treats their payloads as opaque service data.

With `AMAZME_EXPERIMENTAL=1`, an interactive `pi client` creates and attaches a Session before opening the service-only chat TUI. `pi client -c` and `pi client -r` attach the newest existing Session instead, preserving its durable model and thinking configuration. Model selection is available on demand through `/model`; it is never a startup screen. The presentation always uses the stable coding agent's alternate-screen renderer and shared transcript/dock viewport. It loads configured theme resources and uses the stable terminal light/dark detection and appearance-change notifications. Its replicated state feeds the stable editor, message, tool, status, theme, and tool-renderer components. The presentation drives the worker-owned root conversation through `AgentController` and renders the `Transcript` service's complete replicated value while controller calls are pending. `Transcript` serves `Conversation.viewState()` directly: the durable Harness publishes exact operations per commit, so the worker keeps no reducer of its own. Chord flushes compact operations once per publication, while each client/state pairing encodes them with an independent path dictionary. Chord reconstructs presentation replicas and owns hydration, sequencing, and gap detection.

The server keeps each Session in its own directory under the session directory: `meta.json` holds the ID, creation time, and working directory, and `session.sqlite` is the `@amazme/durable` storage. The server lists and creates Sessions from `meta.json` only. The Session worker locks the directory, opens the storage, and owns it until it retires; the worker stays alive while the Harness task graph has live tasks.

A foreground server uses repeatable `-e` options to establish its default Session and TUI facets. A local client may instead select packages for the Session it creates or resumes; that branch selection is persisted with the Session and does not alter other workers or the server default. Before attaching, the server asks Chord to build conventional `src/session.ts` and `src/tui.ts` entries into separate `plugin-builds/` directories, passes the generated manifest paths to that Session worker, and returns the matching TUI artifacts. The Session worker loads built-in facets and separately owned plugin generations, then creates one active `FacetHost`. `/reload` atomically rebuilds the packages, loads fresh plugin candidates, cuts them over through `FacetHost.reload()`, and disposes the retired generations. Host-created implementation dependencies such as the durable `Harness`, its root `Conversation`, `ModelRuntime`, and `SettingsManager` are passed directly to built-in facet factories; they are not exposed as services. The TUI loads configured presentation facets and adds one private bridge facet that consumes the connected server and selected-Session services for `ExperimentalClientTui`. Its local presentation services are `SlashCommands`, which owns command contributions, and `PresentationUI`, which exposes selection and status rendering without exposing the raw TUI. Command callbacks receive Chord `Context` directly. Facets consume `AgentController` explicitly for prompting, steering, or queueing and return structured controller results to the command dispatcher.

A host may reload selected facets when their declared service shape is unchanged; retained consumers keep the same service facades while replacement implementations and singleton snapshots are installed behind them. Synchronous setup-time `env.provide()`, `env.provideMany()`, `env.use()`, and `env.observe()` calls produce the internal dependency graph; setup does not repeat a declarative dependency list, and service handles remain disconnected until the complete graph validates. Providers activate before consumers, observations connect with their consuming facet, and facet replacement or host shutdown disposes affected lifecycles in reverse dependency order. Server and Session service tokens are non-local and automatically published by their providing host. Presentation-only hookpoints such as `SlashCommands` are explicitly local and never enter an RPC catalogue.

A facet always calls unqualified `env.use()` or `env.observe()`. The host resolves each token across facet-provided and connected services. The example plugin package contributes `/hello` through its TUI facet. `examples/plugins/amazme-example-plugin/` is an actual `@amazme/example-plugin` package: repeatable `-e` options select plugin packages as server defaults or for one Session branch, Chord discovers and builds their conventional facets, and the attached presentation receives matching TUI artifacts through `PresentationPlugins`. Other host facets from the same plugin remain separate bundle entries rather than one aggregate plugin object. Transport bindings remain internal machinery rather than part of the facet environment. `ExperimentalClientTui` currently owns terminal rendering, state subscriptions, navigation, and action dispatch directly. The server provider remains directly assembled until its complete host environment exists. The canvas, diff-review, and task-observation examples in `packages/durable/docs/pico-v5-chord-usage.md` are extension patterns, not built-in coding-agent services. Private references, trace carriers, and flow control remain protocol/host infrastructure slices rather than presentation service tokens.

## TODO

Deferred while the worker moves from the removed `AgentHarness` to `@amazme/durable`:

- Next-run queue: `AgentController.nextRun()` is dropped. Durable queues only steering and follow-up input. `resume()` is dropped as well: the worker resumes interrupted work when it opens the Session.
