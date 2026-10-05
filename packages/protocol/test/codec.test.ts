import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientMessageDecoder,
  encodeClientMessage,
  encodeCbor,
  encodeFrame,
  encodeServerMessage,
  errorBody,
  isSupportedVersion,
  MAX_ERROR_MESSAGE_LENGTH,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  resolveLimits,
  sameRoute,
  ServerMessageDecoder,
  type ClientMessage,
  type JsonValue,
  type ServerMessage,
} from "@amazme/protocol";

const server = { serverId: "srv-1" };
const runtime = { serverId: "srv-1", runtimeId: "rt.main", attachmentId: "att-1" };
const opaque = { anything: [1, "two", { nested: null, unknownField: true }] };

const clientMessages: ClientMessage[] = [
  { type: "hello", version: PROTOCOL_VERSION },
  { type: "request", id: "r1", route: server, call: opaque },
  { type: "request", id: "r2", route: runtime, call: "opaque string" },
  { type: "cancel", id: "r2", route: runtime },
];
const serverMessages: ServerMessage[] = [
  { type: "hello", version: PROTOCOL_VERSION, serverId: "srv-1" },
  { type: "hello_error", error: { code: "unsupported_version", message: "expected 2" } },
  { type: "response", id: "r1", ok: true, result: opaque },
  { type: "response", id: "r1", ok: true },
  { type: "response", id: "r2", ok: false, error: { code: "route_mismatch", message: "" } },
  { type: "service_update", subscriptionId: "s1", update: [opaque] },
  { type: "attachment", attachment: runtime },
  { type: "attachment", attachment: null },
];

function framed(value: JsonValue): Uint8Array {
  const limits = resolveLimits();
  return encodeFrame(encodeCbor(value, limits), limits.maxFrameBytes);
}

function protocolError(code: string) {
  return (error: unknown) => error instanceof ProtocolError && error.code === code;
}

test("every envelope round-trips through CBOR frames with opaque payloads intact", () => {
  const client = new ClientMessageDecoder();
  const all = clientMessages.map((message) => encodeClientMessage(message));
  const merged = new Uint8Array(all.reduce((sum, frame) => sum + frame.byteLength, 0));
  let at = 0;
  for (const frame of all) { merged.set(frame, at); at += frame.byteLength; }
  const decoded: ClientMessage[] = [];
  for (let offset = 0; offset < merged.byteLength; offset += 3) decoded.push(...client.push(merged.subarray(offset, offset + 3)));
  client.end();
  assert.deepEqual(decoded, clientMessages);

  const serverDecoder = new ServerMessageDecoder();
  assert.deepEqual(serverMessages.flatMap((message) => serverDecoder.push(encodeServerMessage(message))), serverMessages);
});

test("envelopes reject unknown fields at every level, empty codes and malformed routes", () => {
  const invalidClient: unknown[] = [
    { type: "hello", version: PROTOCOL_VERSION, extra: 1 },
    { type: "hello", version: -1 },
    { type: "hello", version: 1.5 },
    { type: "request", id: "r1", route: { ...server, extra: 1 }, call: 1 },
    { type: "request", id: "r1", route: { serverId: "srv-1", runtimeId: "rt" }, call: 1 },
    { type: "request", id: "", route: server, call: 1 },
    { type: "request", id: "has space", route: server, call: 1 },
    { type: "request", id: "x".repeat(129), route: server, call: 1 },
    { type: "request", id: "r1", route: server },
    { type: "cancel", id: "r1", route: server, reason: "x" },
    { type: "service_update", subscriptionId: "s", update: 1 },
  ];
  for (const message of invalidClient) {
    assert.throws(() => parseClientMessage(message), protocolError("invalid_message"), JSON.stringify(message));
    assert.throws(() => encodeClientMessage(message as ClientMessage), protocolError("invalid_message"));
    const decoder = new ClientMessageDecoder();
    assert.throws(() => decoder.push(framed(message as JsonValue)), protocolError("invalid_message"));
  }
  const invalidServer: unknown[] = [
    { type: "hello", version: 1, serverId: "srv-1" },
    { type: "hello", version: PROTOCOL_VERSION },
    { type: "hello_error", error: { code: "", message: "x" } },
    { type: "hello_error", error: { code: "Bad Code", message: "x" } },
    { type: "response", id: "r1", ok: false, error: { code: "x", message: "y", detail: 1 } },
    { type: "response", id: "r1", ok: true, error: { code: "x", message: "y" } },
    { type: "response", id: "r1", ok: false },
    { type: "response", id: "r1", ok: false, error: { code: "x", message: "y".repeat(MAX_ERROR_MESSAGE_LENGTH + 1) } },
    { type: "attachment", attachment: server },
    { type: "attachment" },
  ];
  for (const message of invalidServer) {
    assert.throws(() => parseServerMessage(message), protocolError("invalid_message"), JSON.stringify(message));
  }
});

test("non-JSON values fail before the schema runs, so accessors are never invoked", () => {
  let reads = 0;
  const call = Object.defineProperty({}, "x", { get: () => { reads += 1; return 1; }, enumerable: true });
  const cases: unknown[] = [call, { x: undefined }, Number.NaN, 1n, [1, , 2], new Date(0), () => 1];
  for (const value of cases) {
    assert.throws(() => encodeClientMessage({ type: "request", id: "r", route: server, call: value as JsonValue }), protocolError("invalid_json"));
  }
  const envelope = Object.defineProperty({ id: "r", route: server, call: 1 }, "type", { get: () => { reads += 1; return "request"; }, enumerable: true });
  assert.throws(() => parseClientMessage(envelope), protocolError("invalid_json"));
  assert.equal(reads, 0);
});

test("the handshake version is exact and no other version is accepted", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(isSupportedVersion(2), true);
  for (const version of [0, 1, 8]) {
    assert.equal(isSupportedVersion(version), false);
    assert.deepEqual(parseClientMessage({ type: "hello", version }), { type: "hello", version }, "the server answers with hello_error");
    assert.throws(() => parseServerMessage({ type: "hello", version, serverId: "srv-1" }), protocolError("invalid_message"));
  }
});

test("a failed decoder stays failed and never yields later messages", () => {
  const decoder = new ServerMessageDecoder();
  const good = encodeServerMessage({ type: "attachment", attachment: null });
  assert.throws(() => decoder.push(framed(new Array(3).fill(0) as JsonValue)), protocolError("invalid_message"));
  assert.equal(decoder.failed, true);
  assert.throws(() => decoder.push(good), protocolError("decoder_failed"));
  assert.throws(() => decoder.end(), protocolError("decoder_failed"));

  const garbage = new ClientMessageDecoder();
  assert.throws(() => garbage.push(new Uint8Array([0, 0, 0, 1, 0xc1])), protocolError("invalid_cbor"));
  assert.throws(() => garbage.push(encodeClientMessage({ type: "hello", version: 1 })), protocolError("decoder_failed"));

  const truncated = new ClientMessageDecoder();
  const hello = encodeClientMessage({ type: "hello", version: 1 });
  assert.deepEqual(truncated.push(hello.subarray(0, hello.byteLength - 1)), []);
  assert.throws(() => truncated.end(), protocolError("invalid_frame"));
});

test("frame, depth and item limits apply to encode and decode alike", () => {
  const limits = { maxFrameBytes: 64, maxDepth: 3, maxItems: 8 };
  const request = (call: JsonValue): ClientMessage => ({ type: "request", id: "r", route: server, call });
  assert.equal(encodeClientMessage(request("x".repeat(17)), limits).byteLength, 68);
  assert.throws(() => encodeClientMessage(request("x".repeat(18)), limits), protocolError("limit_exceeded"));
  encodeClientMessage(request([[1]]), limits);
  assert.throws(() => encodeClientMessage(request([[[1]]]), limits), protocolError("limit_exceeded"));
  assert.throws(() => encodeClientMessage(request([1, 2, 3, 4, 5, 6]), limits), protocolError("limit_exceeded"));
  const decoder = new ClientMessageDecoder(limits);
  assert.throws(() => decoder.push(encodeClientMessage(request("x".repeat(64)))), protocolError("limit_exceeded"));
  assert.throws(() => encodeClientMessage(request(1), { maxFrameBytes: 0 }), RangeError);
});

test("route helpers and error bodies keep wire values valid", () => {
  assert.equal(sameRoute(runtime, { ...runtime }), true);
  assert.equal(sameRoute(runtime, { ...runtime, attachmentId: "att-2" }), false);
  assert.equal(sameRoute(server, runtime), false);
  assert.equal(sameRoute(server, { serverId: "srv-1" }), true);
  assert.equal(sameRoute(null, undefined), false);
  const long = errorBody("internal", `${"x".repeat(MAX_ERROR_MESSAGE_LENGTH - 2)}😀😀\ud800`);
  assert.ok(long.message.length <= MAX_ERROR_MESSAGE_LENGTH);
  encodeServerMessage({ type: "response", id: "r", ok: false, error: long });
  assert.equal(errorBody("x", "bad\udc00").message, "bad\ufffd");
});
