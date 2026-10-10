# How AmazMe Works

The default terminal and hosted product use Durable: one Harness coordinates model requests, tools, persistent conversations and owned tasks. ModelRuntime owns provider catalogs and credentials; the resource loader owns prompts, skills, context files and themes.

## Conversation and execution

A submission enters the focused conversation. The Harness prepares a model request from its saved agent configuration, selected tools, prompt sections and history. The provider streams a response; tool calls run as owned tasks through the same registry, with results committed before the next generation.

Steering enters at a turn boundary. A follow-up waits until the current work completes. Cancellation targets the current conversation and waits for its owned work to stop. Closing an interrupted persistent session preserves recoverable work; reopening uses Durable's recovery rules rather than starting an independent agent loop.

Subagents and workflows use conversations and tasks in this same Harness. Their task IDs, conversation ownership and results remain available to the task graph and transcript. Focusing another conversation does not transfer previously admitted work to it.

## Context and resources

The selected conversation supplies model history and settings. Prompt sections reuse Pi's system-prompt builder and include the active tool descriptions, context files, skill descriptions and working directory. Skills carry full instructions on demand. Prompt templates and `/skill:<name>` commands expand before the input is admitted, using the same expansion code in native and hosted clients.

One resource loader applies configured paths, project trust, exclusions and explicit CLI selections. `/reload` reads its resources and settings while idle. It preserves process-local overrides and does not silently replace an existing conversation's saved model or tool selection.

Model scope patterns control startup and cycling through the existing resolver. Authentication changes are resolved through ModelRuntime; clients do not maintain a second credential store. OAuth uses Pi's original provider client IDs, callbacks and request identity.

## Storage and branches

The default terminal stores each session in a SQLite database. Its session document keeps the title and focused conversation. Branches and subagents have independent agent configuration; changing the focused model updates that conversation. `/tree`, `/fork` and older-history paging operate on persisted conversation state.

Hosted sessions use the host's session storage. The terminal client and Web client observe the same worker and focus. Host restarts reopen the same saved sessions and task state.

`--no-session` gives the default terminal in-memory storage and discards conversation state on close. Tools and plugins still use their normal permissions; this option does not hide file edits or configuration writes.

Print/RPC and `createAgentSession()` use the SDK's JSONL entry tree. Their session selectors, extensions and events follow the [SDK](sdk.md), [RPC](rpc.md) and [Sessions](sessions.md) contracts. A JSONL file is not the default terminal's SQLite database.

## Plugins and lifecycle

A native plugin is a Chord facet. It contributes tools, prompt sections, commands, tasks or hooks through the existing services. Registrations and resources are leases owned by the facet. Reload builds a candidate while the session is idle; failure preserves the usable registration, and cleanup releases the resources it owns.

History, memory, checkpoints, completion verification and workflows are optional plugins. Verification uses ordinary tool tasks and independent receipts. Workflows use saved stages and owned tasks for bounded concurrency and pause/resume. Neither creates a second execution loop or enables itself in a default session.

## Interfaces and trust

`amazme` opens the native terminal when stdin and stdout are terminals. `amazme server`, `client` and `web` expose the hosted runtime; `--print`, JSON and RPC select the SDK's scripted interfaces.

The CLI's startup benchmark initializes the same native terminal and follows its normal cleanup. Plain help and model listing do not evaluate SDK extension factories. Native plugins use slash commands, while SDK extensions may register CLI flags for their own invocation.

Project trust controls which project configuration and executable resources load. Context files have their own discovery rules. Tool execution and trusted plugins use the process's operating-system permissions. See [Security](security.md) and [Plugin runtime](plugin-runtime.md) for the actual boundaries.
