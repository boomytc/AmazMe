# Durable host and client services

Facet setup generates each host's RPC service catalogue from its provided non-local tokens. Remote service sources obtain those catalogues and bind only services required by consuming facets; there is no handwritten built-in service inventory. With no selected Session, its deferred source admits unresolved requirements as unavailable and keeps their handles disconnected. Attachment validates them against the worker's generated catalogue, which is cached for later detached generations. Keyed services hydrate as an empty directory until their owning feature spawns an instance.

The installed product exposes one CLI for the host and both clients:

```bash
amazme server
amazme client
amazme web --port 0
```

Development uses the same `src/cli.ts` through `src/source-resolver.ts`; no separate experimental entry or flag is required. Published hosts read the prebuilt browser asset and compiled service modules.

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
(`host/web/page.ts`) that binds the host's services and drives the composer, plus the HTTP/WebSocket
host. The page bundle is built with the product and read from its installed assets, so the browser runs the same protocol and client code the TUI does. Source development can build it in memory. Changes to the
page take effect after the host restarts.

| Scope | Service | Current slice | Continuation point |
|---|---|---|---|
| server | `SessionDirectory` | replicated state implemented | add authenticated per-client projection when identity lands |
| server | `SessionManagement` | create, remove, attach, detach implemented | add authenticated workspace authorization |
| server | `Settings` | the editable field catalogue over the host's `SettingsManager` — field ids, heading tokens, kinds, and stored enum values, plus the interface `locale` and `appearance` preferences — with a write per field and a reload of the files | add project-scoped writes and a typed editor for list fields |
| server | `Skills` | the agent's loaded skills, with read, write, remove, and import for the agent directory's own | add skill-path settings and prompt-template management |
| server | `Plugins` | the server's default plugin package selection and the `mcp.json` entries the CLI and TUI read | connect MCP servers from this host and report their status |
| server | `Feedback` | the reader's rating of one committed answer, stored in `<agentDir>/feedback.json` so the CLI can read it too, with rate, replace, and retract | attach a note or a diff-scoped rating, and aggregate them into review reports |
| selected server plugin | `Schedules` | `plugins/automation` owns the plan file, timer and cleanup; the host runs its prompts through the existing Session workers. The service and Web entry are absent when the package is not selected | implement calendar rules, bounded delivery records and restart recovery in the plugin |
| server | `PresentationPlugins` | prepares the selected Session branch's matching TUI artifacts and reloads that branch | add authenticated plugin policy |
| session | `SessionPlugins` | reloads the configured Session facet generation | add coordinated multi-worker reload reporting |
| session | `SessionSettings` | publishes this session's effective settings and paths; re-reads files so changes made elsewhere reach the running Session | invalidate the per-directory prompt cache so newly written skills apply to a running Session |
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

An interactive `amazme client` creates and attaches a Session before opening the service-only chat TUI. `amazme client -c` and `amazme client -r` attach the newest existing Session instead, preserving its durable model and thinking configuration. Model selection is available on demand through `/model`; it is never a startup screen. The presentation always uses the stable coding agent's alternate-screen renderer and shared transcript/dock viewport. It loads configured theme resources and uses the stable terminal light/dark detection and appearance-change notifications. Its replicated state feeds the stable editor, message, tool, status, theme, and tool-renderer components. The presentation drives the worker-owned root conversation through `AgentController` and renders the `Transcript` service's complete replicated value while controller calls are pending. `Transcript` serves `Conversation.viewState()` directly: the durable Harness publishes exact operations per commit, so the worker keeps no reducer of its own. Chord flushes compact operations once per publication, while each client/state pairing encodes them with an independent path dictionary. Chord reconstructs presentation replicas and owns hydration, sequencing, and gap detection.

The server keeps each Session in its own directory under the session directory: `meta.json` holds the ID, creation time, and working directory, and `session.sqlite` is the `@amazme/durable` storage. The server lists and creates Sessions from `meta.json` only. The Session worker locks the directory, opens the storage, and owns it until it retires; the worker stays alive while the Harness task graph has live tasks.

A foreground server uses repeatable `-e` options to establish its default Session, server and TUI facets. A local client may select packages for one Session. The selected package paths stay with the Session across worker restarts.

AmazMe builds the selected roles as ESM artifacts in `plugin-builds/`, writes each `plugin.json` atomically, and sends the matching TUI code to the presentation. Chord's `nodeLoader` loads each generation. A Chord `Host` owns service records, resources and reload; the product retains its Durable Harness, approvals, project management, session mirrors and native plugins.

Product contracts live in `@amazme/protocol/services`. Remote domain methods carry positional arguments and receive cancellation through their final Context. Local contributions use opaque members. `serviceFacet` owns one implementation; `serviceSetFacet` lets several public surfaces borrow one resource; `activationFacet` owns registration leases. Declared dependencies are Chord holds and resources. The example plugin demonstrates a remote service and a TUI command consuming it.

Protocol version 9 multiplexes native Chord frames through authenticated, attachment-fenced channels. Every endpoint has a distinct principal identity; closing an attachment cancels and releases its channels. Clients wait for initial state hydration, reject obsolete attachment generations, and serialize cleanup before publishing a replacement. Server and Session capabilities are discovered from the live catalogue. The Web and desktop clients use the same path.

Reload waits for idle session work, prepares fresh modules and calls `Host.reload`. Preparation failure preserves the previous generation; resource cleanup failures are reported. The TUI projects its declared remote dependencies into its local Chord host. A local contribution such as `SlashCommands` is never published over the network.
