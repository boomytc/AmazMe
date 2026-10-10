# Environment variables

AmazMe inherits the environment of the process that starts it. Export provider keys in your shell before starting the CLI or host; an already running host keeps the environment it started with. See [Providers](providers.md#use-an-api-key-from-the-environment) for the supported credential variables.

## Process markers

The CLI and RPC entry points set `AI_AGENT=AmazMe` and `AMAZME_CODING_AGENT=true`. Their child processes inherit these markers. Embedding through a library does not automatically set them.

These are application process markers. OAuth client IDs, callbacks and provider request identities remain Pi's; changing product branding does not change them.

## Default terminal and hosted tools

The default terminal and hosted workers run tools through Durable and their execution environment. The built-in local environment inherits process variables when a shell command starts. It does not inject the SDK's `AMAZME_SESSION_*` or selected-model variables below. Its sessions use SQLite rather than the SDK's JSONL session files.

Use the client's model display and its conversation state for the current selection. Trusted native plugins can read their current conversation through `AgentRuntime`; tool implementations can use the invocation's `ToolExecutionApi.agent(context)`. A shell variable inherited from a parent process does not identify a Durable conversation's current model.

Remote environments use the environment configured for that target. They do not inherit your Mac's secrets just because the client runs there.

## SDK shell session metadata

The AgentSession SDK's `bash` and `powershell` tools inject these values when their extension context is available:

| Variable | Value |
|---|---|
| `AMAZME_SESSION_ID` | SDK session ID |
| `AMAZME_SESSION_FILE` | JSONL session file; absent for ephemeral SDK sessions |
| `AMAZME_PROVIDER` | Selected model provider |
| `AMAZME_MODEL` | Selected model ID |
| `AMAZME_REASONING_LEVEL` | Effective reasoning level |

Values are resolved for each command. They describe the selected SDK model, including when a router sends the request to another upstream model. User-entered `!`/`!!` commands in SDK interactive mode do not receive this injection.

SDK `createBashTool(cwd, options)` and `createPowerShellTool(cwd, options)` expose this metadata by default when registered with an extension context. `spawnHook` receives it in `ctx.env`. Set `exposeSessionEnvironment: false` to disable injection; the SDK removes inherited metadata names before building that command's environment.

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({ ...ctx, env: { ...ctx.env, CI: "1" } }),
});
```

Durable's shell factories and execution environments have their own options; this SDK option is not a native tool contract. See [SDK](sdk.md) and [Native plugins](plugin-runtime.md).

## Process configuration

| Variable | Behavior |
|---|---|
| `AMAZME_CODING_AGENT_DIR` | Agent configuration directory; default `~/.amazme/agent` |
| `AMAZME_CODING_AGENT_SESSION_DIR` | Native/SDK terminal session storage override; `--session-dir` takes precedence. Hosted session storage uses the host's `--session-dir` separately |
| `AMAZME_SERVER_DIR` | Hosted server discovery and socket directory; default `~/.amazme/server` |
| `AMAZME_SERVER_ID` | Preferred server identity during local automatic activation |
| `AMAZME_PACKAGE_DIR` | Package resource directory override, including installed or compiled layouts |
| `AMAZME_OFFLINE` | Disable automatic network activity such as catalog and update checks; explicit model/tool requests still require their configured services |
| `AMAZME_SKIP_VERSION_CHECK` | Disable optional automatic update checks. The release checker uses this package's npm metadata |
| `AMAZME_TELEMETRY` | Override the install/update telemetry preference with `1`/`true`/`yes` or `0`/`false`/`no` |
| `AMAZME_CACHE_RETENTION` | `long` requests extended prompt caching from providers that support it |
| `AMAZME_STARTUP_BENCHMARK` | Measure native interactive startup and exit; initial prompts are not submitted |
| `AMAZME_SHARE_VIEWER_URL` | SDK `/share` viewer URL |
| `AMAZME_RADIUS_GATEWAY` | Radius relay and SDK `/bug` gateway origin |
| `AMAZME_HARDWARE_CURSOR` | `1` enables the hardware cursor |
| `AMAZME_HYPERLINKS` | OSC 8 override: `1`, `0`, or `auto` |
| `AMAZME_PROGRAM_STATUS` | OSC 7501 override: `1` always reports, `0` never reports; otherwise terminal support is queried |
| `AMAZME_IMAGE_PROTOCOL` | Inline image protocol: `kitty`, `iterm2`, `none`, or `auto` |
| `AMAZME_TRUE_COLOR` | Truecolor override: `1`, `0`, or `auto` |
| `AMAZME_TUI_ESC_TIMEOUT` | Lone Escape timeout in milliseconds; defaults to `100` over SSH and `10` otherwise |
| `VISUAL`, `EDITOR` | External-editor fallback in clients that expose that action |
| `HTTP_PROXY`, `HTTPS_PROXY` | Outbound HTTP proxy configuration |

See [Terminal setup](terminal-setup.md), [Configuration](configuration.md) and [Sessions](sessions.md) for the respective scopes. Internal worker control addresses and tokens are managed by the host, not user configuration.
