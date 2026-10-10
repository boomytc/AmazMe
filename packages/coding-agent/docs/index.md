# AmazMe

AmazMe is a modular coding agent built from Pi's packages. Give it a working directory and a task to inspect files, run tools, edit content and continue work across sessions.

## Start using AmazMe

Follow the [Quickstart](quickstart.md) to install a complete release or run from source, connect a model and submit a task.

- [Use the terminal or Web client](usage.md) for prompts, ongoing work and session navigation.
- [Choose a model](models.md) using a subscription, API key or compatible endpoint.
- [Continue or branch a session](sessions.md) without losing existing history.
- [Configure AmazMe](configuration.md) for defaults, project instructions and reusable resources.
- [Understand the runtime](how-pi-works.md) for context, owned tasks, storage and plugin lifecycles.

The default terminal uses Durable storage. `amazme web` and `amazme client` share a persistent host and its session roster. Print/RPC and the TypeScript SDK use their documented JSONL session API; see [Sessions](sessions.md) for each storage format and supported selectors.

## Customize AmazMe

Choose the smallest resource that fits the change: [prompt templates](prompt-templates.md) for reusable input, [skills](skills.md) for instructions, or [native plugins](plugin-runtime.md) for tools, commands and runtime hooks. Native plugins use the same Harness and resource lifecycles. Inspect selected sources with `/plugins`, edit them and use `/reload` while idle to rebuild them.

[Optional plugins](plugin-runtime.md) provide history, memory, checkpoints, verification and workflows only when selected. The default runtime does not load these capabilities automatically. SDK extension factories belong to the [SDK extension API](extensions.md), rather than the native plugin entry point.

## Automate or embed AmazMe

- [Print mode](cli.md#invocation-and-output) runs scripted tasks.
- [JSON event mode](json.md) streams structured events from a run.
- [RPC mode](rpc.md) controls the SDK runtime in a subprocess.
- The [TypeScript SDK](sdk.md) embeds the agent API in an application.
- [Host plugins](plugin-runtime.md) can access the selected Durable conversation or submit work to a fixed conversation through the existing controller.

## Reference and diagnostics

Use [read-only diagnostics](diagnostics.md), `amazme doctor`, or Web Settings → Files to inspect configuration and credential availability without provider requests. Reference pages cover [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md) and [environment variables](environment-variables.md).

Tools and plugins run with the process's operating-system permissions. [Project trust](security.md#understand-project-trust) controls resource loading; it does not sandbox tool execution. OAuth preserves Pi's provider identity while the product, package scope and command remain AmazMe.
