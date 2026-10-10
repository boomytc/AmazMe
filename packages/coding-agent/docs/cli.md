<a id="cli-and-modes-reference"></a>

# Command Line

This page documents AmazMe's built-in command-line commands and options. Run `amazme --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
amazme [options] [--] [@files...] [messages...]
amazme install <source> [options]
amazme remove <source> [options]
amazme uninstall <source> [options]
amazme update [target] [options]
amazme list
amazme config [options]
amazme auth <login|logout|check|print-api-key|print-bearer-token> [options]
amazme mcp <list|login|logout> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
amazme
amazme --print "Summarize this repository"
git diff | amazme --print "Review this change"
amazme --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, AmazMe opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, AmazMe uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

AmazMe resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether AmazMe runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

<a id="model-options"></a>

## Models

```sh
amazme --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

The default Durable TUI applies `--provider`, `--model`, `--thinking`, and `--api-key` to its actual runtime. A new conversation uses per-model thinking settings before the global default. Continuing restores the focused conversation before applying explicit overrides; other branches keep their settings. Without overrides, saved model and thinking values remain in effect. A previously prepared request retains its saved parameters when recovered; subsequent generations use the current selection.

In this interactive path, `--api-key` requires `--model` and is never persisted. `--use-theme <name>` applies for the current run without changing saved settings. Invalid model selection is rejected before opening session storage.

<a id="session-options"></a>

## Sessions

```sh
amazme --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current project.
- `-r`, `--resume`<br>
  Continues the newest session in the default terminal, like `--continue`. JSONL applications use a session selector.
- `--session <path|id>`<br>
  Selects a JSONL session for print/RPC by file path, exact ID, or partial ID. AmazMe searches the current project first and offers to fork a cross-project match.
- `--session-id <id>`<br>
  Opens the exact JSONL project session ID or creates it if absent. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks an existing JSONL session into a new session for the current project. In the default terminal, use `/fork` or `/tree`.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `AMAZME_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses the existing runtime with in-memory storage. No conversation database or session lock is created, and the conversation cannot be resumed after exit. Configuration and authentication still use their normal files.
- `-n`, `--name <name>`<br>
  Sets a non-empty session display name after trimming surrounding whitespace. The default terminal displays it in the footer and restores it on continuation; an explicit name updates the continued session.

The default terminal stores SQLite sessions under `<agent-dir>/experimental/durable-sessions/<cwd-hash>/<session-id>/session.sqlite`. The directory name is retained for existing histories. A custom session root replaces `experimental/durable-sessions`; it still groups sessions by canonical working directory. Relative roots resolve against the working directory and `~` expands to the home directory. CLI root selection takes precedence over the environment, then settings, then the default. Web/server session roots belong to their shared host; these native terminal options do not select a hosted session.

Constraints:

- In the default terminal, `--no-session` cannot be combined with `--continue` or `--resume`. `--session`, `--session-id`, and `--fork` select JSONL storage and are rejected by that terminal.
- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
amazme --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools. Entries are tool names or patterns where `*` matches any characters. MCP tools are kept unless an entry starts with `mcp__` (see [MCP tools](#mcp-tools)).
  A list containing only exact `+name` and `-name` entries edits the inherited default selection in order, for example `--tools +codemode,-write`. Other extension tools retain their default activation. Plain names and modifiers cannot be mixed; modifiers do not accept patterns.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names or patterns after all other selection options, MCP tools included.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and custom tools.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, custom, and MCP tools disabled.

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. A plain `--tools` list replaces the selection; a modifier list applies after `defaultTools` or tool suppression. `--no-tools --tools +grep` therefore enables only `grep`. Exclusions apply last and cannot be undone by dynamic tool loading. Selection calculation is shared by the SDK, print/RPC CLI and default Durable TUI. The TUI keeps its selected names and patterns in the focused conversation and restores them on `--continue`; explicit startup options replace that conversation's saved selection. Its built-in registry includes `grep`, `find`, `ls`, optional PowerShell, `codemode`, and `tool_search` alongside the default tools; `subagent` is an additional default tool. Codemode and tool discovery use the same execution and metadata rules as the SDK, while nested calls and script state are persisted in the Durable conversation. The TUI and host share MCP connections and resource operations with the SDK; MCP calls use persistent tool tasks. Initial discovery completes before the Harness starts, and project configuration requires project trust.

<a id="mcp-tools"></a>

`--tools` selects the tools declared to the model. It does not remove MCP tools, whose reach is set by their [exposure](mcp.md#control-tool-exposure): `amazme --tools read,codemode` keeps every MCP tool callable from codemode scripts. An MCP tool that no entry names or matches is never declared directly, whatever its exposure; only `tool_search`, if listed, can load it. Once an entry starts with `mcp__`, `--tools` filters MCP tools too, so this keeps only the tools of the `radius` server:

```sh
amazme --tools read,bash,codemode,'mcp__radius__*'
```

The MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) count as MCP tools. To remove MCP tools, use `--exclude-tools 'mcp__*'` or [`--no-mcp`](#resource-options).

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

Built-in extensions add two more tools. They are off by default; the MCP extension turns them on when an MCP server needs them (see [MCP](mcp.md#exposure)). To enable them yourself, name them in `--tools` or `defaultTools`.

| Built-in extension | Purpose |
|---|---|
| `codemode` | Run JavaScript that calls the other tools, for example in parallel with `Promise.allSettled`; only the script's output reaches the model |
| `tool_search` | Search tools that are not declared to the model (`codemode` and `deferred` exposure, such as MCP tools) and declare the matches for the next call |

### Enable codemode

To turn on `codemode` for every session, add it to the default tools in `~/.amazme/agent/settings.json` or a project's `.amazme/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

This keeps `read`, `bash`, `edit`, and `write` and adds `codemode`. For one invocation, list every tool, since `--tools` replaces the selection:

```sh
amazme --tools read,bash,edit,write,codemode
```

Codemode is useful without MCP: scripts can run several tool calls in parallel, filter large output before it reaches the model, call classifier models such as TypeSafe's Jev through `models.classify()` (see [Classifier models](models.md#use-classifier-models)), and generate images through `models.generateImages()` (see [Image models](models.md#use-image-models)).

### How codemode works

Scripts run in a QuickJS sandbox and reach the other tools through `tools.<name>(args)`. [Codemode](codemode.md) describes the script API, how tools are listed and found, the `store()` and `models` globals, and the limits.

### Tool search

`tool_search` is off by default; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It uses the same ranking as `searchTools()` over tools that are not declared yet and declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

<a id="resource-options"></a>

## Resources

```sh
amazme --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [AmazMe Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads a native facet file/package in the default terminal and is repeatable. Print/RPC and SDK applications use SDK extension factories, including their `builtin:mcp` source.
- `-ne`, `--no-extensions`<br>
  Disables extension discovery and default built-in MCP support. Explicit `-e` sources still load, using the current entry point's format. Native plugins use [Chord facets](plugin-runtime.md).
- `--no-mcp`<br>
  Disables built-in MCP connections and MCP tools for this run. The default terminal's `/mcp` reports that support is disabled. SDK applications may supply their own replacement extension.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

The default terminal consumes `--skill`, `--no-skills` and `--no-context-files` through the same resource loader as the SDK. Explicit skill paths still load when discovery is disabled. Project skill discovery requires project trust; context-file discovery follows its separate directory inheritance rules. While idle, `/reload` refreshes these prompt resources even when no plugin is selected.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
amazme --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.

These prompt options apply to the default terminal's actual model requests. Without CLI sources, it discovers `SYSTEM.md` and `APPEND_SYSTEM.md` in the trusted project configuration or agent directory; a project file replaces the corresponding user file. An explicit prefix replaces the default prefix, while context files, skills and the working-directory section remain. Appended sources keep their CLI order before context and skills. File paths resolve against the runtime working directory and support `~`.

- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `AMAZME_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the AmazMe version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
amazme install npm:@scope/package
```

See [AmazMe Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `amazme install <source>` |
| List configured packages | `amazme list` |
| Remove a package and its settings entry | `amazme remove <source>` |
| Configure which package resources load | `amazme config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update AmazMe or packages

Running `amazme update` without a target updates AmazMe itself.

| Task | Command |
|---|---|
| Update AmazMe | `amazme update` |
| Update all installed packages | `amazme update --extensions` |
| Update one installed package | `amazme update <source>` |
| Refresh model catalogs | `amazme update --models` |
| Update AmazMe and all installed packages | `amazme update --all` |

Add `--force` to reinstall AmazMe when the selected update includes AmazMe.

Self-update reads the current package's public npm metadata and accepts only a matching package name and valid version. The package must have a published release and this installation must belong to a writable global package-manager prefix. Update source checkouts through their checkout; replace compiled runtimes with a complete AmazMe release from their original source. Package and model catalog updates use their existing separate commands.

### Aliases and command options

- `amazme uninstall <source>` is an alias for `amazme remove <source>`.
- `amazme update --self`, `amazme update self`, and `amazme update amazme` are aliases for `amazme update`.
- `amazme update --extension <source>` is an alias for `amazme update <source>`.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Authentication commands

```sh
amazme auth login --provider openai-codex
amazme auth login --provider deepseek --method api-key
amazme auth logout --provider deepseek
amazme auth check --provider openai --json
```

Login and logout require `--provider <provider>`. Login runs in a terminal, prompts for a method when needed, hides secret input and supports Ctrl+C cancellation. Credential checks and printing require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `amazme auth login` | Run the existing provider login flow and save its credential |
| `amazme auth logout` | Delete saved credentials; environment and models.json configuration remain available |
| `amazme auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `amazme auth print-api-key` | Print the resolved API key |
| `amazme auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--method oauth\|api-key` | `auth login` | Select a supported method instead of prompting |
| `--model <model>` | Checks and printing | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.

## MCP commands

These commands work outside a session, so agents can run them through `bash`. See [MCP Servers](mcp.md).

| Command | Description |
|---|---|
| `amazme mcp add <server> [options] -- <command> [args...]` | Add or replace a stdio server in `mcp.json`; `--env KEY=VALUE` (repeatable) and `--cwd <dir>` set its environment and working directory. Arguments after the command are passed to it |
| `amazme mcp add <server> [options] --url <url>` | Add or replace a streamable HTTP server; `--header KEY=VALUE` (repeatable), `--bearer-token-env-var <NAME>` (sends `Authorization: Bearer ${NAME}`), `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, and `--oauth-client-name` configure authentication |
| `amazme mcp remove <server>` | Remove a server from `mcp.json`; stored OAuth credentials are kept |
| `amazme mcp list [--json]` | Connect to every enabled server and print its state, tools, and errors; exit with `1` when a config entry is invalid or an enabled server is not connected |
| `amazme mcp login <server> [--timeout <seconds>]` | Sign in to an OAuth server: open the authorization page and wait for the browser (default 300 seconds); a terminal also accepts the pasted redirect URL |
| `amazme mcp logout <server>` | Delete the stored OAuth credentials of a server |

`add` and `remove` change `~/.amazme/agent/mcp.json`, or `.amazme/mcp.json` in the current directory with `--local` (`-l`). `add` also takes `--exposure <mode>` (see [Exposure](mcp.md#exposure)) and `--description <text>` and does not connect; run `amazme mcp list` to check the server.

Project `.amazme/mcp.json` files are only read for projects that are already trusted.
