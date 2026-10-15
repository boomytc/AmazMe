# @amazme/client

Transport-neutral client for the AmazMe protocol and native Chord channels.

```ts
import { Client, type ByteTransportFactory } from "@amazme/client";

const transportFactory: ByteTransportFactory = async (handlers) => {
  // Connect using WebSocket, Unix socket, or another ordered byte transport.
  return {
    async send(chunk) {
      // Deliver bytes in invocation order and honor backpressure.
    },
    close() {},
  };
};

const client = await Client.connect({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory,
});
const catalogue = await client.describeServices({ serverId: client.serverId });
const channel = await client.openLink({ serverId: client.serverId });
// Connect the Chord client with host.connect(channel.link, { principal: { host: channel.host } }).
// A ServiceScope uses { host: channel.host }; raw contracts carry placement in their input.
// await channel.close() joins remote cleanup when the channel is no longer needed.
```

The client verifies that the physical endpoint reports the expected logical `serverId`. Server-wide requests carry that ID, and every Session request carries the full live target `{ serverId, sessionId, attachmentId }`. The combined durable address prevents cross-server or cross-session misrouting; the server-generated attachment ID rejects delayed frames after switching or reattaching.

`openLink()` adapts the selected route to a native Chord Link. A Chord client Host owns typed handles, method calls, state snapshots and deltas. `describeServices()` returns the product capability catalogue; `request()` carries channel open/frame/close operations. Frames received during channel opening are buffered by the native link. A peer's `channel_closed` notification closes that link and rejects its pending calls without closing unrelated channels. `Client` tracks attachment changes and fences channels to their original route.

Application observation APIs such as the coding agent's `Transcript` are ordinary Chord services. The client does not interpret their snapshots or updates.

On disconnect or disposal, pending requests reject locally, but accepted work may still complete remotely before the attachment is released. The client clears its live attachment route. It never reconnects or replays requests automatically. After disconnection, call `reconnect()`, attach through the application's management service again, and explicitly repeat only operations known to be safe.

The experimental local coordinator only provides a stable endpoint and relays traffic. Replaceable server processes own Session and worker lifecycle outside the public client protocol.

Call transport handlers as follows:

- `handlers.onData(chunk)` for inbound bytes;
- `handlers.onClose()` for an orderly terminal close;
- `handlers.onError(error)` for transport failures.

A transport factory creates a fresh authenticated connection for each attempt. Requests are correlated by ID, and server failures are exposed as `ServerError`.

## Unix-domain sockets

Node.js and Bun consumers can use the separate Unix transport:

```ts
import { Client } from "@amazme/client";
import { createUnixTransportFactory } from "@amazme/client/unix";

const client = new Client({
  serverId: "01234567-89ab-4def-8123-456789abcdef",
  transportFactory: createUnixTransportFactory({ path: "/tmp/amazme.sock" }),
});
await client.connect();
```

Unix discovery scans an explicit physical-route directory, derives each expected server ID from its filename, and verifies it through the existing handshake:

```ts
import { discoverUnixServers } from "@amazme/client/unix";

const routes = await discoverUnixServers({ directory: "/run/user/1000/amazme" });
// [{ serverId: "...", path: "/run/user/1000/amazme/<serverId>.sock" }]
```

Malformed entries, non-sockets, stale or unresponsive endpoints, and server-ID mismatches are ignored. Discovery is read-only and probes at most 16 sockets concurrently. Unexpected filesystem and socket errors reject discovery. Pass `timeoutMs` to override the default probe timeout.

`ClientOptions.maxFrameLength` bounds protocol payloads. `maxPendingBytes` bounds queued Unix transport output. Configure matching limits on both peers.
