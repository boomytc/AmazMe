/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, parseContract } from "../src/python-api.ts";
import { PythonClient, type ClientConnection } from "../src/python-client.ts";
import type { Attachment, Snapshot, Stream } from "../src/python-contracts.ts";
import { applyFrame } from "../src/python-stream.ts";
import { pythonView, transcriptBlocks } from "../src/python-view.ts";
import { PendingWrites } from "../src/python-writes.ts";
import { DEFAULT_TYPOGRAPHY } from "../src/typography.ts";
import { failureView } from "../src/view.ts";

const identity = { build_id: "build", profile_id: "host", instance_id: "host-instance", pid: 1, host_epoch: 1 };
const binding: Attachment = { attachment_id: "attachment", session_id: "a", host_epoch: 1, build_id: "build" };
const empty = (): Snapshot => ({ session_id: "a", stream_id: "stream", seq: "0", state: "ready", requests: [], events: [], approvals: [], previews: [], effects: [] });
const connection = (sessionId: string): ClientConnection => ({ sessionId, identity, generation: 1, attachment: { ...binding, session_id: sessionId }, ready: true, active: () => true });
const receipt = (id: string, status = "queued") => ({ request_id: id, text: "你好", status, revision: "1" });
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("Python schemas reject malformed enums, required fields and additional properties at the browser boundary", () => {
 expect(() => parseContract("Receipt", { ...receipt("a"), status: "invented" })).toThrow("契约");
 expect(() => parseContract("Receipt", { request_id: "a" })).toThrow("契约");
 expect(() => parseContract("Receipt", { ...receipt("a"), surprise: true })).toThrow("契约");
 expect(parseContract("Receipt", receipt("a")).request_id).toBe("a");
});

test("a malformed transaction cannot partially advance the rendered state or ACK", () => {
 const before = empty();
 const frame: Stream = { binding_id: "attachment", build_id: "build", stream_id: "stream", batches: [
  { stream_id: "stream", seq: "1", base_revision: "0", revision: "1", events: [{ seq: "1", kind: "accepted", request_id: "a", text: "", receipt: { ...receipt("a"), status: "queued" } }] },
  { stream_id: "stream", seq: "3", base_revision: "2", revision: "3", events: [{ seq: "3", kind: "status", request_id: "a", text: "" }] },
 ] };
 expect(() => applyFrame(before, frame, binding)).toThrow("顺序");
 expect(before).toEqual(empty());
 expect(() => applyFrame(before, { ...frame, binding_id: "other" }, binding)).toThrow("绑定");
});

test("late previews from another generation cannot replace a committed answer", () => {
 const before = empty();
 before.requests.push({ request_id: "a", text: "你好", status: "running", run_id: "run-2", generation: 2, revision: "0" });
 const after = applyFrame(before, { binding_id: "attachment", build_id: "build", stream_id: "stream", batches: [{ stream_id: "stream", seq: "1", base_revision: "0", revision: "1", events: [
  { seq: "1", kind: "preview", request_id: "a", text: "", preview: { request_id: "a", run_id: "run-1", generation: 1, preview_seq: "9", text: "stale" } },
 ] }] }, binding);
 expect(after.previews).toEqual([]);
 expect(transcriptBlocks("zh", after).map(block => block.text)).not.toContain("stale");
});

test("model journal records stay out of the transcript and applied tools stop animating", () => {
 const snapshot = empty();
 snapshot.requests = [{ ...receipt("a"), status: "succeeded", answer: "完成" }];
 snapshot.events = [
  { seq: "1", kind: "tool", request_id: "a", text: JSON.stringify({ kind: "model", result: "private reasoning", call: null }) },
  { seq: "2", kind: "tool", request_id: "a", text: JSON.stringify({ kind: "tool", phase: "applied", call: { id: "call", name: "bash", arguments: '{"command":"pwd"}' }, result: "output" }) },
 ];
 const blocks = transcriptBlocks("zh", snapshot);
 expect(blocks.map(block => block.kind)).toEqual(["user", "tool", "assistant"]);
 expect(blocks.some(block => block.text.includes("private reasoning"))).toBe(false);
 expect(blocks.find(block => block.kind === "tool")?.running).toBe(false);
});

test("the original approval controls retain the proposal ID and a blocked host prevents sending", () => {
 const scope = connection("a"), snapshot = empty();
 snapshot.approvals = [{ approval_id: "proposal", request_id: "request", run_id: "run", call_id: "call", call: { id: "call", name: "bash", arguments: "{}" }, build_id: "build", proposal_digest: "digest", revision: "1", state: "pending" }];
 scope.snapshot = snapshot;
 const view = pythonView({ locale: "zh", typography: DEFAULT_TYPOGRAPHY, sessions: [], workspaces: [], connection: scope, thinking: "off", enabledModels: null, rosterFilter: "", draft: "", paletteSelection: 0, commands: [], attachments: [], panel: failureView("zh", "").panel, mode: "followUp", welcomeDismissed: true, newSessionPending: false, ready: false });
 expect(view.approvals[0].approve.data).toBe("proposal");
 expect(view.approvalIndicator?.count).toBe(1);
 expect(view.readOnly).toBe(true);
});

test("an uncertain write retains its original ID and only retries after an explicit send", async () => {
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("receipt lost")).mockResolvedValueOnce(new Response(JSON.stringify(receipt("request")), { status: 202 }));
 vi.stubGlobal("fetch", fetcher);
 const client = new PythonClient("http://127.0.0.1:4310"), scope = connection("a");
 const ledger = new PendingWrites(sessionStorage, "host", "a");
 const record = ledger.prepare("submit", "POST /api/v1/sessions/{session}/submissions", () => ({ path: { session: "a" }, body: { request_id: "request", text: "你好" } }));
 await expect(ledger.send("submit", record, client, scope)).rejects.toThrow("lost");
 const restored = new PendingWrites(sessionStorage, "host", "a");
 const original = restored.prepare("submit", record.operation, () => { throw new Error("must not replace the ID"); });
 expect(original).toEqual(record);
 expect(fetcher).toHaveBeenCalledTimes(1);
 await restored.send("submit", original, client, scope);
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(JSON.parse(fetcher.mock.calls[0][1].body));
 expect(restored.read("submit", record.operation)).toBeUndefined();
});

test("A's late reply neither clears B's pending ID nor a replacement record in A's key", async () => {
 let finish: (value: Response) => void = () => { throw new Error("fetch has not started"); };
 vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
 const client = new PythonClient("http://127.0.0.1:4310"), a = new PendingWrites(sessionStorage, "host", "a"), b = new PendingWrites(sessionStorage, "host", "b");
 const prepare = (ledger: PendingWrites, session: string) => ledger.prepare("submit", "POST /api/v1/sessions/{session}/submissions", id => ({ path: { session }, body: { request_id: id, text: session } }));
 const first = prepare(a, "a"), second = prepare(b, "b");
 const sending = a.send("submit", first, client, connection("a"));
 a.forget("submit", first);
 const replacement = prepare(a, "a");
 finish(new Response(JSON.stringify(receipt(first.body.request_id)), { status: 202 }));
 await sending;
 expect(b.read("submit", second.operation)?.id).toBe(second.id);
 expect(a.read("submit", first.operation)?.id).toBe(replacement.id);
 await expect(a.send("submit", replacement, client, connection("b"))).rejects.toThrow("其他会话");
});

test("unknown results and stale binding errors keep the original record", async () => {
 const client = new PythonClient("http://127.0.0.1:4310"), ledger = new PendingWrites(sessionStorage, "host", "a");
 const record = ledger.prepare("submit", "POST /api/v1/sessions/{session}/submissions", id => ({ path: { session: "a" }, body: { request_id: id, text: "你好" } }));
 vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(receipt(record.body.request_id, "unknown")), { status: 202 })).mockResolvedValueOnce(new Response('{"code":"stale_client_binding"}', { status: 409 })));
 await ledger.send("submit", record, client, connection("a"));
 expect(ledger.read("submit", record.operation)?.id).toBe(record.id);
 await expect(ledger.send("submit", record, client, connection("a"))).rejects.toBeInstanceOf(ApiError);
 expect(ledger.read("submit", record.operation)?.id).toBe(record.id);
});

test("a failed reconnect can recover, and selecting B cancels A's scheduled retry", async () => {
 vi.useFakeTimers();
 const sockets: string[] = [];
 class TestSocket {
  constructor(url: URL) { sockets.push(String(url)); }
  close() {}
  send() {}
 }
 vi.stubGlobal("WebSocket", TestSocket);
 let unavailable = true;
 const calls: string[] = [];
 vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
  calls.push(`${init.method} ${url.pathname}`);
  if (unavailable) { unavailable = false; return new Response('{"code":"runtime_recovering"}', { status: 503 }); }
  if (url.pathname.endsWith("bootstrap")) return new Response(JSON.stringify({ ...identity, role: "host", protocol: "amazme-http/1" }));
  if (url.pathname.endsWith("attachments")) return new Response(JSON.stringify({ ...binding, session_id: url.pathname.split("/")[4] }));
  return new Response('{"removed":true}');
 }));
 const client = new PythonClient("http://127.0.0.1:4310");
 await client.connect("a");
 expect(sockets).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(1000);
 expect(sockets).toEqual(["ws://127.0.0.1:4310/api/v1/events/a"]);
 client.retire();
 unavailable = true;
 await client.connect("a");
 await client.connect("b");
 const count = calls.length;
 await vi.advanceTimersByTimeAsync(1000);
 expect(calls).toHaveLength(count);
 expect(client.connection?.sessionId).toBe("b");
 client.retire();
});
