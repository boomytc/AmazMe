# Sessions and Context

AmazMe keeps conversation history and supplies the active conversation to the model. The default terminal uses Durable SQLite storage. Web and hosted clients share their server's session roster. Print/JSON/RPC and the SDK expose a JSONL session API; select storage through the entry point you are using.

## Default terminal

Start a named session or continue the newest session for the same working folder:

```bash
amazme --name "Refactor authentication"
amazme --continue
```

`--resume` also continues the newest native session. The footer shows the stored name. Supplying `--name` while continuing updates that session; omitting it preserves the name. Names are trimmed and must be non-empty.

The default storage root is `<agent-dir>/experimental/durable-sessions`. The historical directory name is retained so existing sessions remain discoverable. Each canonical working directory has a hash group, and each session owns a directory containing `session.sqlite`. A process holds the session's lock until it closes; another process cannot write that same session concurrently.

Choose another root with `--session-dir`, `AMAZME_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting, in that precedence order. Relative roots resolve against the working folder; `~` expands to the home directory. Custom roots still group sessions by canonical working directory, so continuation uses the selected root and folder.

```bash
amazme --session-dir ./agent-history --name "Review"
amazme --session-dir ./agent-history --continue
amazme --no-session
```

`--no-session` uses the same Harness, tools and plugins with in-memory storage. Its footer says `in memory`; no conversation database or session lock is created. Exiting discards the conversation. Configuration, credentials and files changed by tools retain their usual behavior. Combining it with `--continue` or `--resume` is rejected.

### Branches and context

| Command | Result |
|---|---|
| `/tree` or `/agents` | Choose a stored conversation or a return point in the current conversation |
| `/fork` | Fork at the current tip and focus the new conversation within the same session |
| `/older` | Load an earlier page of stored history above the transcript |
| `/tasks` | Show the current task graph |
| `/compact [instructions]` | Summarize older context while retaining the original history |

Leaving at a return point can summarize the branch being left. The menu offers no summary, a summary, or custom summarization instructions. The `branchSummary.skipPrompt` setting skips that menu and leaves without a summary. Selecting an existing conversation only changes focus. The stored focus survives exit and continuation; all branches keep the same session display name.

The model receives the focused conversation's context rather than every branch. The footer shows context usage. Automatic compaction uses the [compaction settings](settings.md#compaction); manual compaction also works when automatic compaction is disabled. If a provider error prevents compaction, correct the provider issue and retry `/compact`.

## Web and hosted terminal

`amazme web`, `amazme server` and `amazme client` use the shared host. Its session controls create, select and name sessions. Conversation selection, forks, tools and task state belong to the selected hosted session; clients observe the same server state.

The host's `--session-dir` selects its server storage root. Default terminal flags do not select a hosted session. See [CLI Integration](cli-integration.md) for host commands.

## JSONL API and print/RPC

Print, JSON and RPC sessions use the SDK's [JSONL format](session-format.md), normally under `<agent-dir>/sessions`, grouped by working directory. Their `--session`, `--session-id` and `--fork` options select or create JSONL sessions. `--session-dir`, the environment root, the `sessionDir` setting and `--no-session` also apply to this entry point.

```bash
amazme --print --name "Review" "Explain this project"
amazme --print --continue "Continue that review"
amazme --mode rpc --session /path/to/session.jsonl
amazme --export /path/to/session.jsonl
```

An application embedding the SDK can use its `SessionManager` and interactive UI APIs for session selection, naming, cloning and export. See [SDK](sdk.md) and [RPC](rpc.md). The default terminal's SQLite session is selected through its native continuation and conversation commands.

Review exported transcripts before sharing them: they can contain prompts, responses, tool arguments, command output and file contents.
