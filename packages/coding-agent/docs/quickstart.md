# Quickstart

AmazMe works with files and commands in your working directory. Use a supported model provider through OAuth, an API key, or a configured compatible endpoint. The product command is `amazme`; OAuth client identities and provider request headers remain Pi's.

## 1. Install or build AmazMe

Use the complete AmazMe release directory supplied for your Unix platform. Keep its modules, plugins, builder, and page resources together; the compiled runtime does not need a separate Node.js or Bun installation. Run its `amazme` executable directly, or add that directory to your `PATH`.

The public npm registry did not contain `@amazme/coding-agent` when checked on 2026-10-10; these instructions therefore use the supplied complete release or this source checkout.

From the repository, use Node.js 22.19 or newer:

```bash
npm install --ignore-scripts
npm run build
node packages/coding-agent/dist/bundle/cli.js --version
```

The repository build refreshes model data and builds the dependency graph. `npm run build:offline` uses already available model data. For a single changed package with its dependencies built, use its workspace build. The default terminal, Web and host commands are all part of `dist/bundle/cli.js`.

The examples below assume `amazme` is on `PATH`. From a checkout, substitute `node /path/to/AmazMe/packages/coding-agent/dist/bundle/cli.js`.

## 2. Choose a provider

Authenticate before starting, or use `/login [provider]` in the default terminal:

```bash
amazme auth login --provider openai-codex
amazme auth login --provider deepseek --method api-key
```

Choose a supported method and follow its prompts. Secret input is hidden. Environment credentials and `models.json` are also supported; see [Providers](providers.md) and [Models](models.md).

`amazme auth logout --provider <provider>` removes saved credentials. It does not unset environment variables or revoke access at the provider.

## 3. Start in your working folder

```bash
cd /path/to/project
amazme
```

The working folder determines project resources and groups the default terminal's persisted sessions. Project resources load according to the saved trust decision. User configuration is in `~/.amazme/agent`; project configuration is in `.amazme`.

Run `/model` to select an available model. `Shift+Tab` cycles its supported thinking levels. Give AmazMe a task:

```text
Explain this repository and the commands needed to build it.
```

The transcript shows the response, tool calls, actual file changes and errors. Use `/tasks` to inspect work, `/tree` or `/agents` to choose a conversation or return point, `/fork` to explore another branch, and `/older` to load earlier records. `/compact [instructions]` reduces the active model context while keeping the original history.

During a run, `Enter` sends steering input and `Alt+Enter` queues follow-up work. `Escape` cancels the active run when the editor is focused; inside a menu it dismisses that menu. Exit with `Ctrl+D` from an empty editor.

Review changed files and tool output. Project trust controls resource loading; it does not sandbox tools. See [Security](security.md).

## 4. Continue or use the host

Resume the newest default terminal session for the same working folder:

```bash
amazme --continue
```

Use `amazme --name "Refactor authentication"` to name a session. The footer shows that name and continuing restores it. `--session-dir /path/to/sessions` selects a storage root, grouped by working folder; it overrides `AMAZME_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting. For a conversation that disappears on exit, use `amazme --no-session`. Its footer says `in memory`, and it creates no conversation database or session lock. Saved configuration and credentials retain their normal behavior.

For a shared session roster and graphical controls, start the Web client or connect a hosted terminal:

```bash
amazme web
amazme client
```

Open the loopback URL printed by `web`. The page and hosted terminal use the same server's state. Choose **Provider accounts** from the model menu, or use `/login` and `/logout`. Web **Close** keeps the flow available to reopen until its five-minute deadline; **Cancel sign-in** ends it.

Native terminal sessions use Durable SQLite storage. Print/JSON/RPC and the SDK use their own JSONL session interface; their session selectors and export commands are documented separately in [CLI Integration](cli-integration.md) and [Sessions](sessions.md).

## Add only the capabilities you need

| Need | Mechanism |
|---|---|
| Persistent folder instructions | [AGENTS.md](configuration.md#context-files) |
| Reusable prompts | [Prompt templates](prompt-templates.md) |
| Task instructions and supporting files | [Skills](skills.md) |
| Tools, commands, tasks, hooks or services in the default terminal/host | [Native plugins](plugin-runtime.md) |
| Extensions for SDK or print/RPC applications | [SDK extensions](extensions.md) |
| Model endpoint configuration | [Models](models.md) |

Select a native plugin with `-e /path/to/plugin`. `/plugins` shows its source and API; after editing that source, run `/reload` while idle. A failed candidate build preserves the active version. Changes to the application core or shell require rebuilding and restarting.

Markdown templates appear as `/name` commands; `/skill:name` loads a selected skill's instructions. Both expand before submission or follow-up queuing. Use `--no-prompt-templates`, `--no-skills` or `--no-themes` to disable discovery; explicit paths still load. `--theme /path/to/palette.json --use-theme <name>` uses a custom palette for this run. `--tui-mode regular` uses terminal scrollback instead of the default fullscreen presentation.

## Update or remove

Global package-manager installations can use `amazme update` once a matching release of their own package exists in npm. The update accepts only its own package name and a valid version. Update a source checkout through that checkout. Replace compiled releases with a complete AmazMe runtime from the source that supplied them.

For npm installations, `npm uninstall -g @amazme/coding-agent` removes the CLI package. Removing the release directory or package does not delete configuration, credentials or session data in `~/.amazme/agent`.
