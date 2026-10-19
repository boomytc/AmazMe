# Changelog

## [Unreleased]

## [1.4.0] - 2026-10-19

### Breaking Changes

- `run_end` agent events carry `willRetry`, true when the same commit starts a successor run. Code that builds an `AgentEvent` by hand, such as a test fake, must add it.

### Added

- An `agent_settled` agent event follows `run_end` when no successor run starts in the same commit: the session-level run is over and nothing queued continues it. `aborted` is true when one of the run's inputs was settled `unanswered` with reason `aborted`. It is not part of the snapshot, so an idle attachment sees no past settlement.
- The task graph shows each task's restart count (`TaskGraphNode.restarts`, absent while zero) and the configured bound (`TaskGraph.restartLimit`, `Infinity` when nothing parks). A change of `settings.restartLimit` alone refreshes the graph. JSON has no `Infinity`, so a host that sends the graph or a summary of it must map an unbounded limit itself.

## [1.3.0] - 2026-10-19

### Breaking Changes

- `TaskRuntime.sleep()` is removed: it waited inside a phase, which holds an invocation and, after a restart, reruns the phase and restarts the wait. A task now ends its phase asleep with `runtime.sleepUntil(until, checkpoint, context)` or by returning `{ status: "sleeping", until, checkpoint }` from `runtime.commit()`; move the work after the wait into the next phase and carry what it needs in the checkpoint. `TaskRuntime.setTimer()` paces work inside a phase without waiting for it.
- Tasks have a `sleeping` status, so code that handles every `TaskState`, `TaskGraphState`, or `TaskInspection` state needs a case for it.
- Opening a SQLite storage migrates it to schema version 2 automatically, rebuilding its task table. A migrated database cannot be opened by AmazMe 1.2.2 or earlier, so a deployment cannot roll back past this release. JSONL storage needs no migration, but AmazMe 1.2.2 or earlier never resumes a sleeping task it finds (a run's conversation stays busy).
- `TaskRuntime` has `sleepUntil()` and `setTimer()`, and `ToolExecutionApi` has `now()`: code that builds either object by hand, such as a test fake or a tool wrapper that does not spread the original, must add them.
- A task cut off by a crash 5 times in a row without committing a new state is parked instead of run again (see the crash-loop guard under Added); set `settings.restartLimit` to `Infinity` to keep the old behavior. `TaskInspection`'s blocked reasons include `restart_limit`.

### Added

- `HarnessOptions.telemetry` accepts a host-owned telemetry context with optional propagation and metrics capabilities. This change adds the configuration type only; Durable instrumentation and persisted carriers are not yet implemented.
- Durable sleeps: a sleeping task holds no invocation, survives restarts, and resumes at its checkpoint once the Harness clock reaches `until`.
- `HarnessOptions.setTimer` arms the timers of the Session, the scheduler, and its tasks (progress throttles, idle-memory eviction, sleeps), also for `createSession()`; with `now`, they run on a host or fake clock. A foreground timer the host throws on or declines falls back to `setTimeout`. `ToolExecutionApi.now()` reads the Harness clock.
- `Harness.wake()` and `HarnessOptions.onWake` tell a host when the Session next needs a process: `active` while work can run, `at` for the earliest sleep. With `onWake`, the Harness keeps no timer for sleeps, so a Cloudflare Durable Object can hibernate and wake on its alarm, calling `resume()`.
- Crash-loop guard: open counts the restarts of each task that a crash, eviction, or reset cut off (`TaskRecord.restarts`); a close writes the tasks it stopped back as `pending` uncounted, and a new state the task commits starts the count over. At `settings.restartLimit` the task is parked: blocked with reason `restart_limit` in `inspect()` and the task graph, not active in `wake()`, and reported once. `Harness.retryTask(id)` runs it again. An abort handler cut off that many times ends its task `faulted`.
- `onReport(error, info)`: `info` (`ReportInfo`) says what happened in `type`: `session_failed`; `task_faulted`, `task_parked`, `migration_failed`, `task_outdated`, or `task_error` with the task and the extension that installed it; `extension_error` with the extension's name; `host_error` with the failing `HostCallback`; or `listener_error`.
- `settings.afterFailedRun`: a run that fails with `model_error` or `no_model` keeps the inputs queued behind it (`keep`, the default), starts the next run with them (`continue`), or settles them `unanswered` with reason `run_failed` (`withdraw`).
- The task graph shows why a task cannot run (`TaskGraphNode.blocked`: `missing_task`, `task_too_old`, `migration_failed`, or `restart_limit`) and follows registry changes and failed migrations.

### Changed

- A task phase that faults is reported through `onReport` (as `task_faulted`), not only recorded in its outcome.
- `onReport` gets a second argument, `info`, and `TaskRuntime.report()` takes an optional `from` (see Added); an `onReport` written for one argument still works.
- Generation retry backoffs, deferred-response polls, and compaction retry backoffs sleep instead of waiting in a running phase, so a process can stop or hibernate during them. A record an earlier version stored mid-backoff sleeps again when it resumes before its time. A deferred poll whose model is gone after a reopen now fails `no_model` once the poll is due, not at once.
- Code mode measures script deadlines and wall time on the Harness clock (`HarnessOptions.now`) instead of `Date.now()`.
- SQLite drivers, portable interfaces, and the generic migration runner now come from `@amazme/chord/sqlite`. Existing Durable SQLite entry points keep re-exporting their public names; storage helpers and Durable schema migrations stay here.

### Fixed

- `Harness.retryTask()` leaves scheduling paused when its target is not parked, instead of starting unrelated pending work.
- In Cloudflare Workers with `nodejs_compat`, the timers that evict idle documents and contexts were armed, since timers there have an `unref()`; a pending one kept a Durable Object from hibernating and blocked its eviction. They are now declined in Workers, and memory is freed at later commits.

- AmazMe preserves read-only reopen and schema-corruption checks in Chord's shared SQLite migration runner. `wake()` also excludes work blocked by an unavailable plugin owner, and loadout preparation reports name the responsible extension.

## [1.2.0] - 2026-10-18

### Added

- `settings.compaction.modelOverrides` sets compaction thresholds per model, keyed by exact `"provider/modelId"`, so one harness can serve small- and large-window models; the threshold check, overflow recovery, and the compaction task use the entry of the model they act for ([#10942](https://github.com/earendil-works/pi/issues/10942)).
- `HarnessOptions.models` and `HarnessOptions.settings` also accept a function returning the current value, like `env`. Generation, compaction, hooks and tools call it at each use (`api.models` reads the current value at each access), so a host can replace its model configuration or settings without reopening the Harness. A plain object still works.

### Changed

- `ToolControl.terminate` is now typed `boolean` instead of `true`, matching `@amazme/agent` and coding-agent; `false` does not end the run ([#10858](https://github.com/earendil-works/pi/issues/10858)).

### Fixed

- The README's Errors section now limits the `StorageRequestError` exemption to reads: a `StorageRequestError` thrown by `commit()` or `mintId()` fails the Harness like any other storage error ([#11014](https://github.com/earendil-works/pi/issues/11014)).

## [1.1.1] - 2026-10-18

### Breaking Changes

- `ToolTaskInput` and `ToolTaskResult` are tagged unions: a model-issued call is `{ kind: "model", ... }` with its previous fields, a nested call `{ kind: "nested", ... }`. `amazme.tool` is version 2 and migrates live version 1 tasks. Previously executing AmazMe tasks are marked unsafe to replay because the old nested call keys cannot be reattached.
- `NestedResultDoc` is replaced by `NestedCallDoc`, keyed by call key rather than child task ID, holding `{ taskId, result? }`. On open, live callers' previous index and result documents migrate before scheduling so completed tools are not executed again.
- `ToolExecutionResult.content` is now `output`, next to the new `structuredOutput`.
- `bash` and `powershell` answer a nonzero exit with an error result carrying an `exit_code` diagnostic, instead of throwing (`tool_error`).
- Any error a `Storage` method throws, a read included, now fails the Session, which closes itself: every later call and every pending wait rejects with `SessionFailed`, whose `cause` is that error, and nothing is retried. `StorageRejected` is removed; a storage retries its own transient failures and throws the new `StorageRequestError` for an invalid request, which fails only that call. A throw in the scheduler's own commits, or in the commit listeners of the Harness's components, fails the Session too.
- `subscribeCommits()` and `subscribeClose()` listeners that throw, or return a rejected promise, are reported through `onReport` instead of failing the operation that ran them.
- A display-only write submission, one of only `kind` and `data` (no `model`, `head`, or `edits`), is appended and settled `done` at once, even while the conversation is busy or has queued items, instead of waiting in `amazme.inbox` for the next boundary; only a queued reset still holds it back, so the reset does not hide it. It changes nothing the model sees, so a chat message shows as soon as it is sent, ahead of earlier submissions still queued, and it no longer places items left queued after a failed run ([#10407](https://github.com/earendil-works/pi/issues/10407)).

### Added

- `SqliteStorage.open(database, { prefix })` namespaces every table and index; `openNodeSqliteStorage()` and `openDurableObjectSqliteStorage()` forward the prefix for databases shared with host tables.

- `@amazme/durable/tool-search` and `tool-search/search` provide bounded tool discovery and shared ranking. AmazMe retains its existing exposure and persistent activation contract instead of adding a second deferred flag.
- Optional `ExecutionEnv.listFiles()` enumerates file trees with explicit bounds and cancellation; environments without this capability reject the operation.

- Input submissions take `entry: { kind, data }` (`InputEntry`): the input is placed as an entry of that kind carrying that data, with its content as the user message, instead of `amazme.user`, and behaves as any other input; the kind must not start with `amazme.`. Queued inputs carry it in their `amazme.inbox` item ([#10407](https://github.com/earendil-works/pi/issues/10407)).
- Exposed the asking task's resolved agent and tool metadata to hooks through `api.agent(context)`

- Added invocation-bound commits and owned-task waits to completion hooks; final responses are persisted before `onYield`, so recovery resumes verification without re-requesting or changing the candidate answer

- Added inactive tool registration, persistent name/pattern selection, and allow/exclude boundaries that dynamic loading cannot bypass
- Added portable `grep`, `find`, and `ls` tools and the separate `FileSearchTools` extension, with bounded output, literal argv, invocation cancellation and paged alphabetical directory listing

- `Session.closed` settles once the Session has closed, Storage included: `{ reason: "closed" }` after `close()`, or `{ reason: "failed", error }` after a storage error. `WatchEnd` gains `{ reason: "session_failed", error }`, and the README has an Errors section.
- `ToolExecutionApi.executeTool(name, args, context, { key?, progress? })`: a tool calls another tool as a nested call. The nested call is its own `amazme.tool` task owned by the caller, runs validation, the `ToolTask` hooks (whose `ToolHookCall` carries `parent`), output limits, and its replay policy, and returns a `NestedToolExecutionResult` (its `taskId`, `structuredOutput`, `details`, `diagnostics`, `usage`, `isError`, `durationMs`, but not the model's `output`) to the caller instead of the transcript. Each nested call is a member of `NestedCallDoc`, a task-scoped document family of the caller keyed by the call's key, holding its `taskId` and, once it ends, its `result` as returned, so it is gone from storage once the caller settles; its task's receipt stays small. Keys, by default the call's position, let a replay-safe caller's rerun reattach to its nested calls; a caller that is not replay-safe has its unfinished nested calls abandoned after a restart. Nested calls show in `amazme.live.nestedTools`, with the arguments they run with and a `summary` (error, duration, usage) once done (`progress: false` keeps their running output out), and as tool events with `parentToolCallId` and `parentTaskId`; every tool event also carries its call's `taskId`. A caller aborts the nested calls it left running before it settles.
- Structured tool output: a tool declares `structuredOutputSchema` and returns `structuredOutput`, which the Harness validates and gives to programs that call the tool; a tool without a schema gives them its bounded output, one text item as a string, one image as itself, and otherwise the content list, for errors too. `structuredOutput` is always the tool's own value: a schema tool's error result keeps the value it returned, and the text of one without becomes a `tool_error` diagnostic of the nested result, as a thrown error's message does. A nested call with invalid structured output gets an error result; a model-issued one only loses it, and the host gets a report. `api.retainedOutput()` reads the bounded output the model will see. `bash` and `powershell` return `{ output, truncated, fullOutputPath?, exitCode }`.
- `ToolRegistration.callers` (`model`, `tools`, or both, the default) and `amazme.agent` `modelTools`: who may call a tool, and which of its tools a conversation offers the model; `Agent.callable` lists the tools nested calls resolve among. `addTools` also extends `modelTools`.
- `TaskOptions.abandonOnRestart`: a task its creator awaits only in memory is aborted, with its owned work, when a later Harness starts scheduling, before any of it runs again. Its mark carries `abortReason: "restart"`, which cascades; such a task waits for a missing definition instead of becoming `orphaned`. Nested calls and `api.createTask()` children of tools that are not replay-safe get it by default. No task below an owner with cancellation intent starts a run phase any more, even before the cascade marks it.
- `TaskRuntime.abortOwned(id, context)`: abort a task this task owns and wait until it is terminal.
- `TaskRuntime.ownedTasks(context)`: the live tasks a task owns directly, whichever invocation created them, as copies. A tool call settling finds the nested calls it left running with it.
- `@amazme/durable/codemode`: a `codemode` tool (`createCodemodeExtension({ sandbox })`) whose scripts call the conversation's tools as nested calls and survive a restart: the script is replayed deterministically from a journal of the results it got, written before each delivery, reattaching to its nested calls, and then continues. Divergence, a changed sandbox fingerprint or module version, and a passed deadline end the call with an error. As in the coding agent, a `codemode` prompt section lists the tools scripts can call (`namespaces`, an inline token budget), scripts find tools with `searchTools()`, `describeTool()`, and `describeNamespace()`, and the result is laid out with a header, text item markers, a console block, truncation to `max_output_tokens` with a spill file, and saved images. Scripts get `models.*` (the catalog, `models.classify()`, `models.generateImages()`; the last two as nested calls of internal tools, at most four at once), and the tool declares the Lark grammar of its source for models that support grammar-constrained sampling. A failed call rejects in the script with its text, except an error result of a schema tool with its own value, which resolves: `tools.bash` gives `{ output, exitCode, ... }` for a nonzero exit. Scripts keep `store()`/`load()` values per conversation, forked as of the fork's entry. The result's `details.calls` list the script's tool calls with their status; live progress is in `amazme.live.nestedTools` (`npm run bench:codemode`).
- `read` returns images as one image block instead of an `unsupported_image` error: PNG, JPEG, GIF, and WebP within the model's image limits (by default 2000x2000 pixels and 4.5 MB of base64) as they are, or, with `createCodingTools({ images })`, oriented, converted, and shrunk to fit. `@amazme/durable/images` provides a Photon (WebAssembly) image processor, with `/images/node` and `/images/cloudflare` loaders; `/images/node` prepares images in a worker thread, so a large photo never blocks the event loop, and the thread exits after 30 s without images; nothing loads it unless imported. A model without image input gets a diagnostic saying it sees a placeholder.
- `amazme.live.compactionFailure` keeps the newest compaction failure (task, reason, error) until a compaction produces a summary; the agent events' snapshot carries it as `compactionFailure`, and `compaction_end` carries `error` for a compaction that failed. A failed background or manual compaction was invisible once its status was removed.

### Changed

- Cloudflare Durable Object SQLite adapters created for the same storage object share one operation queue, so several storages can use one Durable Object database.

### Fixed

- Reopening a current SQLite schema no longer takes a writer lock. Newer or missing schema metadata is rejected before mutation; required migrations still recheck their version under the transaction lock and roll back atomically.
- Overflow recovery checks the final request after projection and request hooks, and retries only when it shrank and restored the configured output reserve. Generation version 4 retains the rejected request size across deferred polling and restart; an older pending recovery without that evidence ends with its original error.
- After compaction retains assistant messages, the generated system baseline leads the projected context without reordering stored entries or later system updates; incremental and whole reads agree.
- Image base64 encoding uses bounded byte chunks and btoa instead of retaining concatenation trees; the 3 MiB/128 MB heap regression is covered.

- Reject waits that close a task wait cycle, including cycles through ordinary owned work.
- Codemode declarations derive results from each tool's schema and `reachesTools`, without shared MCP types or output-shape detection; output joining is linear.

- Appending to an array in a document no longer costs a walk over the whole array per commit: Chord's delta tracker plans inserts and removals that keep the remaining elements in order from the changed ranges alone, and builds an appended array in one copy instead of two. 32,000 one-item appends, one commit each, take 1.4 s instead of 11.3 s; what remains is the copy each immutable value needs (`npm run bench:document-append`).
- A generation whose blocking threshold compaction failed, faulted, was orphaned, or was aborted directly now fails with `model_error` (`Compaction failed: <error>`) instead of sending its request anyway. The context was still above the blocking threshold, so the request at best left no room for the answer: a session at 996K of a 1M window got an empty `length` answer on every turn, with no visible error.
- Compaction no longer includes thinking in the summarization request. Replayed thinking is often not in the live context, so a request that included it could be larger than the context it summarized and fail with "prompt is too long" on every attempt.
- The Session's document cache is bounded by use: a loaded document that no watch or document state observes leaves memory once it was not read or written for `documentRetentionMs` (new in `HarnessSettings` and `createSession()` options; default ten minutes, `0` drops it right after use) and loads from Storage again on its next access. It held every conversation and session document ever touched, built-in and third-party, for the life of the process: 5,000 conversations kept 26,000 documents and about 3.8 KB each; with retention 0 they keep none (`npm run bench:document-cache`).
- Final responses update committed progress leaf by leaf before completion hooks, instead of replacing the entire generation and retransmitting its accumulated text.

- Preserved nested call count/depth bounds and automatically drop an unchanged structured payload when an `afterTool` hook rewrites its model output.

- A throwing `onReport` no longer replaces the error being reported or becomes an unhandled rejection, a throwing `now()` is reported once and `Date.now` used, and a watch listener's error is reported as well as ending the watch with `listener_error`.
- A task whose fault write failed no longer runs again in the same process.
- The scheduler no longer visits every live task on each pass: abort cascades start only from tasks with cancellation intent, owned live work and idle scopes are walks down an in-memory ownership index, and reservation, finalization, and failFast checks keep their own candidate sets. Each nested call has its own document instead of rewriting one growing index. `npm run bench:scheduler-fanout` measures up to AmazMe's limit of 256 nested calls per invocation.
- The scheduler's ownership indexes are bounded by live work: it keeps a conversation's owner and an ended task's ownership only while live work is below them, instead of every conversation and subagent chain it ever saw. Work that later appears in an old conversation loads its chain from storage again (`npm run bench:scheduler-memory`). A queued input no longer makes the scheduler scan every queued submission when nothing is being cancelled.

Versions below are @amazme/durable's own numbering before unified versioning.

## [1.1.0] - 2026-10-07

### Breaking Changes

- `Storage` implementations must honor the new `order` field of `ConversationQuery`, `EntryQuery`, `TaskQuery`, and `SubmissionQuery`, and continue a cursor in the order it was returned with. A storage that ignores it returns pages in the wrong direction; the conformance suite covers both orders ([#10546](https://github.com/earendil-works/pi/issues/10546)).
- `TaskRuntime.context()` takes the cutoff as an options object, matching `Conversation.context()`: `runtime.context(conversationId, context, { at })` replaces `runtime.context(conversationId, context, at)`.

### Added

- `ToolExecutionApi.models` and `HookApi.models`: the Harness's `models`, so tools and hooks can resolve models and make requests with the same catalog, credentials, and request transforms as generation ([#10395](https://github.com/earendil-works/pi/issues/10395)).
- `Conversation.context(context, { at })` returns the model context as of a visible earlier entry, the same view `fork(at)` would start with, without creating a conversation ([#10512](https://github.com/earendil-works/pi/issues/10512)).
- `ScanOrder` (`ascending` or `descending`) as `order` on conversation, entry, task, and submission scans, including `Tx.scanTasks()` and `Conversation.entries()`, so hosts can page the newest tasks first. Defaults are unchanged: entries newest first, everything else oldest first. A cursor continues in its scan's order, so the query may omit `order`; asking for the other order with it throws ([#10546](https://github.com/earendil-works/pi/issues/10546)).
- Task records carry `startedAt` and `endedAt`, wall-clock times the Session stamps at the first change to `running` and at the change to `terminal`, with `HarnessOptions.now` or the new `createSession(storage, { now })` option. `startedAt` survives waits and reopen. `inspect()` shows them on each live task's record. Records written by earlier versions have neither ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- `amazme.tool-result` messages carry `durationMs`: how long `execute()` took in that attempt, measured with a monotonic clock. Calls that did not execute, and interrupted or aborted calls, have none ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- Assistant messages carry the `durationMs` pi-ai measures for each response ([#10549](https://github.com/earendil-works/pi/issues/10549)).
- `openDurableObjectSqliteStorage(ctx.storage)` in `@amazme/durable/storage/sqlite/cloudflare`: SQLite storage on a SQLite-backed Cloudflare Durable Object.
- `settings.contextRetentionMs` (default ten minutes): how long an idle conversation keeps its last context read in memory; `0` drops it once idle.

### Changed

- `runtime.context()` keeps each conversation's last read range and derived view in memory: a later read by any of its tasks with the same head marker scans and derives only the entries committed since. A generation no longer rereads and re-derives the whole transcript for each model request. Busy conversations keep it; idle ones for `settings.contextRetentionMs`.

### Fixed

- A conversation's first system message, and the baseline after a compaction or reset, now leads the model context instead of following the input that started the run. Providers with native mid-conversation tool changes, such as Anthropic, keep the prompt cache across later tool changes instead of rewriting it in full ([#10542](https://github.com/earendil-works/pi/issues/10542)).

## [1.0.4] - 2026-10-05

### Breaking Changes

- `NodeExecutionEnv.watch()` fails with `permission_denied` when a target, or a watched directory itself, cannot be read for lack of permission; before, it was watched as if missing. Later rescans that hit this report `{ error }` with `permission_denied` instead of `invalid`.
- The env conformance suite checks three more `watch()` behaviors: changes to the file a watched symbolic link points to, recursive coverage below a target that a non-recursive target overlaps, and a directory replaced at the same path. Custom environments that passed the 1.0.3 suite may need changes.

### Added

- `createPowerShellTool()` in `@amazme/durable/tools`: a `powershell` tool that runs `pwsh`, else Windows PowerShell, directly through argv `exec` (no other shell parses the command), with UTF-8 output and the `bash` tool's output window, spill and errors.

### Fixed

- The `read` tool reads a file that grows while it is read (an active log) instead of failing with "changed while it was read"; it reads again only when the file shrank or was rewritten in place.
- `NodeExecutionEnv.watch()`: a directory replaced at the same path gets a new native watcher; a target that is a symbolic link to a file reports changes to that file; a non-recursive target no longer stops an overlapping recursive target from covering subdirectories; closing during a rescan no longer leaks watchers.
- Bounded tool output keeps a U+FEFF at the start of the retained tail, and drops a byte-order mark only at the very start of byte output.
- `settings.progress` fields given as `undefined` keep their defaults.

## [1.0.3] - 2026-10-05

### Breaking Changes

- `FileSystem` requires `openBinaryReader()` and `openDirReader()`; custom environments must implement them.
- `BinaryReader` requires `scanLines()`.
- `FileSystem` requires `watch()`.
- `Shell.exec()` accepts an argv array besides a shell string, and `ShellExecOptions.onOutput` receives a third `info` argument naming the stream (`stdout` or `stderr`); custom environments must accept both forms and pass the stream.

### Added

- `openBinaryReader()` for bounded positional reads of one opened regular file, with `noFollow` to refuse a final-component symlink.
- `openDirReader()` for paged directory listings that read metadata only for returned entries.
- Argv form of `exec()`, which runs a program without a shell.
- `createEnvConformance()` and `registerEnvConformance()` in `@amazme/durable/testing` for checking custom `ExecutionEnv` implementations.
- `settings.progress` with `partialIntervalMs` and `outputIntervalMs` configures how often generation partials and running tool output are committed; defaults stay 100 ms ([#10357](https://github.com/earendil-works/pi/issues/10357))
- `ShellExecOptions.window` and `ShellOutputInfo.skipped`: an environment may omit shell output outside the caller's retained tail and report the omission, so remote environments need not transfer output the caller drops. `ToolExecutionApi.outputWindow` provides the window and `output(chunk, skipped)` counts omissions; the `bash` tool passes them through.
- `BinaryReader.scanLines()` locates and measures a span of lines in one pass inside the environment; `LineScanner`, `StreamDecoder`, `rangeDecoder()` and `startsWithBom()` in `@amazme/durable/env` let other environments decode and scan exactly like `NodeExecutionEnv`.
- `FileSystem.watch()` reports changes to files and directories, recursive with excludes, including missing targets, with explicit `overflow` and `error` and a `native` or `polling` mode. `NodeExecutionEnv` polls on Windows (native watchers there keep directories open, which blocks renaming their parents) and on network and FUSE file systems, and on macOS rescans shortly after installing native watchers because FSEvents misses changes made right after `fs.watch` returns; its `watch` option sets the mode, poll interval, and directory limit.

### Changed

- The `read` tool reads only the file's header, one scan, and the lines it shows, instead of loading the whole file; its results are unchanged.

### Fixed

- `NodeExecutionEnv.flushFile()` on a directory fails with `is_directory` on Windows, as on POSIX.
- Tail-retained tool output no longer depends on when progress commits happened: a progress snapshot compacted the stored output to the kept window, which could move where a later window's first line started.
- `NodeExecutionEnv` shell output and text line readers no longer drop a U+FEFF that follows a chunk boundary; Node's streaming `TextDecoder` with BOM handling dropped it, unlike decoding all of the bytes at once.

## [1.0.2] - 2026-10-04

### Fixed

- Persisted a distinct provider session UUID per conversation and forwarded it for prompt-cache and session affinity ([#10424](https://github.com/earendil-works/pi/issues/10424))

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@amazme/durable`, a durable agent harness. See the [README](README.md) and the [design document](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
