# Run AmazMe in an isolated environment

The default terminal and hosted workers run local tools with their process's operating-system permissions. A working directory is a resource and execution root, not a filesystem sandbox. See [Security](security.md).

## Run the complete application inside a boundary

Run the current AmazMe installation or complete release directory inside the container, VM or operating-system boundary you choose. Follow [Quickstart](quickstart.md) for a supported installation source; upstream Pi images and installers contain Pi rather than the AmazMe runtime.

Keep the runtime, installed dependencies, writable configuration directory and session storage in that environment. Mount the workspace the application should work in and supply the provider configuration needed there. Use the host and client commands documented in [Usage](usage.md); shared session state remains owned by that host.

The environment needs an appropriate Node.js runtime for the npm/checkout build, or the complete platform-specific compiled release. Copying only a compiled executable omits its runtime modules and assets. Remote Unix tool execution also needs the packaged daemon for its target architecture.

Which host files, credentials and network services remain accessible depends on the boundary and the mounts or permissions you configure. AmazMe's project trust and tool approval settings govern resource loading and tool admission; they do not create that boundary.

## Isolate tool execution in an integration

Native integrations can choose a Durable execution environment through the Harness environment resolver. The current default terminal and hosted worker select local `NodeExecutionEnv`; there is no default remote-environment picker or container CLI flag.

The existing `@amazme/env` remote implementation uses an authenticated SSH connection and the matching Unix daemon, with filesystem, command, observation and cleanup operations. Configure the target and its command environment in the integration. Native tools and plugins continue through the same Harness tasks and result persistence; application code and plugins running on the host remain outside the remote tool boundary.

The AgentSession SDK has separate custom shell/file-operation interfaces. Examples that replace SDK tools apply to an SDK application or Print/JSON/RPC session. A factory written for `ExtensionAPI` is not a native facet and does not become one by passing it to the default terminal's `-e` option. See [SDK](sdk.md), [SDK extensions](extensions.md) and [Native plugins](plugin-runtime.md).

## Check the actual boundary

Confirm where the application, tools and plugins execute, which workspace/configuration/storage paths are writable, and where credentials are provided. Start and stop through the chosen environment's normal process lifecycle. Keep persistent storage when restarting a host, and use that host's own session directory when reconnecting clients.
