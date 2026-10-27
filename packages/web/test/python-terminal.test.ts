/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { afterEach, expect, test, vi } from "vitest";
import type { TerminalType, TerminalView } from "../src/generated/contracts.ts";
import { TerminalInputQueue } from "../src/app/pending/terminal.ts";

const accepted: TerminalView = { terminal_id: "terminal", cols: 80, rows: 24, queued: 0, written: 0, output: "", phase: "running", input_status: "accepted" };
afterEach(() => { sessionStorage.clear(); });

test("fast typing and Ctrl-C queue in order while an earlier input is awaiting its receipt", async () => {
 let release: (view: TerminalView) => void = () => { throw new Error("input not sent"); };
 const sent: TerminalType[] = [];
 const send = vi.fn(async (input: TerminalType) => { sent.push(structuredClone(input)); if (sent.length === 1) return new Promise<TerminalView>(resolve => { release = resolve; }); return { ...accepted, input_id: input.input_id }; });
 const queue = new TerminalInputQueue(sessionStorage, "terminal:a");
 queue.bind({ active: () => true, send, error: error => { throw error; }, changed: () => {} });
 queue.enqueue("a"); queue.enqueue("bc"); queue.enqueue("\x03");
 expect(sent).toHaveLength(1);
 expect(queue.items.map(item => item.data).join("")).toBe("abc\x03");
 release({ ...accepted, input_id: sent[0].input_id });
 await vi.waitFor(() => expect(queue.items).toHaveLength(0));
 expect(sent.map(item => item.data).join("")).toBe("abc\x03");
 expect(new Set(sent.map(item => item.input_id)).size).toBe(sent.length);
});

test("Unicode paste is bounded without splitting code points, and overflow is explicitly rejected", () => {
 const queue = new TerminalInputQueue(sessionStorage, "terminal:a");
 queue.bind({ active: () => false, send: async () => accepted, error: () => {}, changed: () => {} });
 const text = "你好😀".repeat(1000);
 queue.enqueue(text);
 expect(queue.items.map(item => item.data).join("")).toBe(text);
 expect(queue.items.every(item => new TextEncoder().encode(item.data).length <= 4000 && !/[\uD800-\uDBFF]$/.test(item.data))).toBe(true);
 const before = sessionStorage.getItem("terminal:a");
 expect(() => queue.enqueue("x".repeat(65537))).toThrow("未接收");
 expect(sessionStorage.getItem("terminal:a")).toBe(before);
});

test("unknown input survives reload and reconnect and retries with the original ID", async () => {
 const queue = new TerminalInputQueue(sessionStorage, "terminal:a"), errors: unknown[] = [];
 queue.bind({ active: () => true, send: async () => ({ ...accepted, input_status: "unknown" }), error: error => errors.push(error), changed: () => {} });
 queue.enqueue("中文\x03");
 await vi.waitFor(() => expect(queue.paused).toBe(true));
 const original = structuredClone(queue.items);
 const restored = new TerminalInputQueue(sessionStorage, "terminal:a"), send = vi.fn(async (input: TerminalType) => ({ ...accepted, input_id: input.input_id }));
 restored.bind({ active: () => true, send, error: error => errors.push(error), changed: () => {} });
 expect(send).not.toHaveBeenCalled();
 expect(() => restored.enqueue("later")).toThrow("尚未确认");
 restored.retry();
 await vi.waitFor(() => expect(restored.items).toHaveLength(0));
 expect(send).toHaveBeenCalledWith(original[0]);
 expect(errors).toHaveLength(1);
});
