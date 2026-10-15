# @amazme/protocol

Runtime-neutral routed envelopes, CBOR encoding, and byte-stream framing for the experimental AmazMe protocol.

Protocol version `11` defines:

- a version handshake that identifies the logical `serverId`;
- explicit server and Session request targets;
- correlated requests and responses with opaque strict-JSON payloads;
- request cancellation, native Chord frame and channel-close events, and out-of-band attachment changes;
- non-empty opaque error codes and bounded transport messages.

A server target contains `{ serverId }`; a Session target contains `{ serverId, sessionId, attachmentId }`. The combined route fences calls to one logical server, durable Session, and live presentation attachment. Management `attach()` and `detach()` return no routing identifiers; the server publishes the selected live route in an out-of-band `attachment` message. Disconnecting releases only that presentation's attachment after admitted calls settle.

Channel requests use the discriminant `kind`: `catalogue`, `open`, `frame` and `close`. Open returns the Chord host name; frame transports one native Chord Frame. Server events `channel_frame` and `channel_closed` address the channel ID. A closed endpoint must notify the receiver even when a worker exits unexpectedly, so in-flight method roots cannot wait forever.

`ChannelEndpoint` binds links to an authenticated attachment and distinct principal. It releases and cancels records when channels close. `openChannel()` adapts an application-owned invoker to a native Chord protocol 4 Link. `@amazme/protocol/services` declares the product's domain interfaces and resource ownership on Chord Host; remote services use `hostFamily("services:", "host")`, with their target in the contract input. `createServiceHost()` creates an owner, and `ServiceScope(host, { host: target })` holds its UI references and waits for Chord's hydration barrier. Host creation supplies `self`, and connecting a parent link supplies its `principal`. Chord owns contract checking, calls, state deltas and reload. No previous service-control grammar is accepted.

Session-directory state, management results, transcripts, models, plugins, and all other application values remain opaque service data. The durable Session and its Harness remain local to the Session worker process. Server and Session calls route opaquely to their owning providers, where Chord and the application validate and invoke them.

Server and worker lifecycle is intentionally outside this public protocol. The experimental local coordinator is only an opaque message router; each replaceable server process owns the private lifecycle protocol.

Each wire frame consists of a four-byte unsigned big-endian payload length followed by one definite-length CBOR item. `encodeClientMessage()` and `encodeServerMessage()` validate and encode complete frames. `ClientMessageDecoder` and `ServerMessageDecoder` accept arbitrary stream fragmentation and coalescing.

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@amazme/protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

All envelope schemas reject unknown object properties, and codecs recursively reject non-JSON opaque payloads, including non-finite numbers, byte arrays, `undefined`, prototypes, and cycles. Envelope violations, malformed CBOR, and invalid framing throw `ProtocolValidationError`. Payload-specific adapters must perform their own semantic validation after decoding. Transports must preserve byte order. Peer authentication and authenticated service contexts are not implemented by the experimental transport.

Default limits are 16 MiB per CBOR payload/frame, 1,000,000 array elements or map entries, and 64 nested item levels. The protocol is experimental and has no compatibility guarantees.
