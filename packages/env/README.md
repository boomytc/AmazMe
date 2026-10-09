# @amazme/env

Remote execution environments for [AmazMe Durable](../durable): an agent's tools run on another machine, usually over SSH,
while the Durable worker, its storage and credentials stay local.

- `amazme-env` (`daemon/`): a small Rust program that runs on the remote machine. It speaks a framed protocol on stdin and
  stdout ([docs/protocol.md](docs/protocol.md)) and performs file operations and commands there.
- `RemoteExecutionEnv`: a Durable `ExecutionEnv` that talks to the daemon through a `Connection`. Its results match
  `NodeExecutionEnv` running on the remote machine; only error messages may differ
  ([docs/semantics.md](docs/semantics.md)).

```ts
import { acceptHostKey, connectSsh, RemoteExecutionEnv, scanHostKey, sshConnection } from "@amazme/env";

const target = { host: "gpu-box", knownHostsFile: "/data/ssh/known_hosts", hostKeyAlias: "amazme-env-gpu" };
// Once: show the host's key fingerprint to the owner, who compares it out of band and accepts it.
const { lines, fingerprints } = await scanHostKey(target);
await acceptHostKey(target, lines);

// Detects the remote system, deploys the daemon if missing (named by its SHA-256 and verified before every start),
// and returns a connection that starts it over ssh.
const { connection } = await connectSsh(target);
const env = new RemoteExecutionEnv({ connection, id: "amazme-env:gpu", cwd: "/home/me/project" });

// Or lazily: nothing happens until the first operation, which detects, deploys and connects. A failure (no network,
// untrusted host key) is that operation's error, and the next operation tries again.
const lazy = sshConnection(target);
const lazyEnv = new RemoteExecutionEnv({ connection: lazy.connection, id: "amazme-env:gpu", cwd: "/home/me/project" });
```

The release package ships Linux and macOS daemons for x86-64 and arm64 in `bin/`. Linux builds use musl so deployment
does not require the remote host's glibc version to match the build host. `ssh` runs with `BatchMode`, strict host-key
checking against the application's own known-hosts file under a fixed alias, no forwarding of any kind, no shared
connections or configured commands, and without forwarding the local locale. On Windows, detection and deployment go
through PowerShell, and the daemon starts through the server's default shell (cmd.exe or PowerShell).

Android (Termux) and Windows retain their existing detection, deployment and execution implementations. Supply a
matching daemon through `connectSsh({ ...target, binary })`, or build the additional target into `bin/` before packing.
On Windows, string commands run through Git Bash as `NodeExecutionEnv` runs them there; argv commands run directly.

## Release daemons

`npm run build:daemons -- darwin-arm64 darwin-x64` compiles release daemons with the pinned Rust toolchain and stages
them in the directory used by `packagedDaemon()`. With no arguments it builds the current platform/architecture.
Install the matching Rust targets and cross-linker before cross-compiling. Build `linux-arm64` and `linux-x64` on
appropriate Linux builders; both use the corresponding `*-unknown-linux-musl` target. Android builds need the Android
NDK; Windows builds use the existing MSVC target.

The build records the package version, Rust source fingerprint, target and binary SHA-256 beside each artifact.
`npm pack` runs a prepack check for all four Unix artifacts and rejects missing, stale or mismatched binaries. Ordinary
TypeScript builds stay independent of Rust. Installers consume the packaged binaries without compiling Rust or running
package installation scripts. Explicitly passing `--ignore-scripts` to `npm pack` also skips this release check.

## Development

`npm run build:daemon` builds the daemon with Cargo; the tests talk to `daemon/target/debug/amazme-env` over a pipe, or to
the binary named by `AMAZME_ENV_DAEMON` (CI tests the release builds this way). They run Durable's env conformance suite
against `RemoteExecutionEnv` and compare random operation sequences and Durable's tools against `NodeExecutionEnv` on
the same machine. `test/ssh-external.test.ts` runs the suite over a real SSH server when `AMAZME_ENV_SSH_HOST` is set.
