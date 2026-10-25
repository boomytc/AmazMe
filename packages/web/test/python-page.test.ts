/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopPage } from "../src/python-page.ts";
import type { Submit } from "../src/python-contracts.ts";
import { parseContract } from "../src/python-api.ts";
import * as A from "../src/actions.ts";
import * as P from "../src/panels.ts";

let page: DesktopPage | undefined;
afterEach(() => { page?.dispose(); page = undefined; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function startPage(extra?: (path: string, options: RequestInit, query: URLSearchParams) => Response | undefined | Promise<Response | undefined>): Promise<{ page: DesktopPage; submitted: Submit[] }> {
 history.replaceState(null, "", "/");
 const html = readFileSync(resolve("src/page/index.html"), "utf8");
 document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
 const submitted: Submit[] = [];
 let selected = "shown";
 class Socket { close() {} send() {} }
 vi.stubGlobal("WebSocket", Socket);
 vi.stubGlobal("fetch", vi.fn(async (input: URL, options: RequestInit = {}) => {
  const path = new URL(input).pathname, method = options.method ?? "GET";
  const custom = await extra?.(path, options, new URL(input).searchParams);
  if (custom) return custom;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (path.endsWith("/bootstrap")) return response({ build_id: "build", profile_id: "host", instance_id: "instance", pid: 1, host_epoch: 1, role: "host", protocol: "amazme-http/1" });
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: "a", title: "A", workspace: "primary" }] });
  if (path === "/api/v1/workspaces") return response({ workspaces: [{ name: "primary", host_path: "/work", primary: true }] });
  if (path === "/api/v1/models") return response({ models: [{ provider: "faux", model: "shown", label: "Shown", endpoint_editable: true }, { provider: "faux", model: "different", label: "Different", endpoint_editable: true }], current: { provider: "faux", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: true } });
  if (path === "/api/v1/accounts") return response({ revision: 0, accounts: [] });
  if (path === "/api/v1/settings") return response({ revision: 0 });
  if (path === "/api/v1/projects") return response({ projects: [] });
  if (path === "/api/v1/skills") return response({ context_files: [], skills: [], prompts: [], diagnostics: [] });
  if (path.endsWith("/attachments")) return response({ attachment_id: "attachment", session_id: "a", host_epoch: 1, build_id: "build" });
  if (path === "/api/v1/session-models/a") {
   if (method === "PUT") selected = "different";
   return selected === "shown" ? response({ code: "session_model_missing" }, 404) : response({ session_id: "a", provider: "faux", model: selected });
  }
  if (path.endsWith("/resources")) return response({ context_files: [], skills: [], prompts: [], diagnostics: [] });
  if (path.endsWith("/usage")) return response({ session_id: "a" });
  if (path.endsWith("/history")) return response({ session_id: "a", requests: [], events: [] });
  if (path.endsWith("/submissions")) {
   const body = parseContract("Submit", JSON.parse(String(options.body)));
   submitted.push(body);
   if (submitted.length === 1) return response({ code: "receipt_lost" }, 503);
   return response({ request_id: body.request_id, text: body.text, status: "queued" }, 202);
  }
  if (method === "DELETE") return response({ removed: true });
  throw new Error(`Unexpected request: ${method} ${path}`);
 }));
 page = new DesktopPage("http://127.0.0.1:4310");
 await page.start();
 const connection = page.client.connection;
 if (!connection) throw new Error("Session was not attached");
 connection.ready = true;
 connection.snapshot = { session_id: connection.sessionId, stream_id: "stream", seq: "0", state: "ready", requests: [], events: [] };
 page.client.onChange();
 return { page, submitted };
}

test("a submission captures the displayed model, retries the same request, and preserves a newer draft", async () => {
 const { page, submitted } = await startPage();
 page.renderer.onDraftChange("original");
 page.renderer.setDraft("original");
 page.renderer.onSubmit("original");
 await vi.waitFor(() => expect(submitted).toHaveLength(1));
 expect(submitted[0].model_selection).toEqual({ provider: "faux", model: "shown" });
 page.renderer.onSelectModel("faux", "different");
 await vi.waitFor(() => expect(page?.renderer.view?.model.label).toBe("Different"));
 page.renderer.onDraftChange("new draft"); page.renderer.setDraft("new draft");
 page.renderer.onSubmit("new draft");
 await vi.waitFor(() => expect(submitted).toHaveLength(2));
 expect(submitted[1]).toEqual(submitted[0]);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("new draft");
});

test("schedule creation retains its original session, ID and input after a lost receipt, and cannot close a newer dialog", async () => {
 const session = "a".repeat(32), saved: Array<import("../src/python-contracts.ts").ScheduleInput> = [];
 let finish: (response: Response) => void = () => { throw new Error("retry not started"); };
 let records: unknown[] = [];
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: session, title: "A", workspace: "primary" }] });
  if (path.endsWith("/attachments")) return response({ attachment_id: "attachment", session_id: session, host_epoch: 1, build_id: "build" });
  if (path.startsWith("/api/v1/session-models/")) return response({ code: "session_model_missing" }, 404);
  if (path.endsWith("/history")) return response({ session_id: session, requests: [], events: [] });
  if (path.endsWith("/usage")) return response({ session_id: session });
  if (path === "/api/v1/schedules") {
   if (options.method !== "POST") return response({ path: "/profile/host.sqlite", schedules: records });
   saved.push(parseContract("ScheduleInput", JSON.parse(String(options.body))));
   if (saved.length === 1) return response({ code: "receipt_lost" }, 503);
   return new Promise<Response>(resolve => { finish = resolve; });
  }
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "open", panel: P.AUTOMATION_VIEW });
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel?.id).toBe(P.AUTOMATION_VIEW));
 page.renderer.onPanelAction({ kind: "command", id: A.SCHEDULE_ADD_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(A.SCHEDULE_ADD_MODAL));
 const original = page.renderer.view?.panel.modal;
 if (!original) throw new Error("schedule dialog missing");
 const fields = { prompt: "original", kind: "interval", everyMinutes: "3", at: "", expression: "", timeZone: "UTC", busy: "queue", missed: "latest", graceMinutes: "10", timeoutSeconds: "600" };
 page.renderer.onPanelAction({ kind: "modal-submit", id: original.id, data: original.data, fields });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
 page.renderer.onPanelAction({ kind: "modal-close" });
 page.renderer.onPanelAction({ kind: "command", id: A.SCHEDULE_ADD_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(A.SCHEDULE_ADD_MODAL));
 const retry = page.renderer.view?.panel.modal;
 expect(retry?.data).toBe(original.data);
 expect(retry?.fields.find(field => field.id === "prompt")?.value).toBe("original");
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SCHEDULE_ADD_MODAL, data: retry?.data, fields: { ...fields, prompt: "changed" } });
 await vi.waitFor(() => expect(saved).toHaveLength(2));
 expect(saved[0].session_id).toBe(session);
 expect(saved[1]).toEqual(saved[0]);
 page.renderer.onPanelAction({ kind: "command", id: "skills:new", data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe("skills:create"));
 const record = { ...saved[0], workspace: "primary", generation: 1, enabled: true, created_at: 1000, next_run_at: 181000 };
 records = [record]; finish(response(record));
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe("skills:create"));
 await vi.waitFor(() => expect(sessionStorage.getItem(`amazme:write:host:${session}:schedule:create`)).toBeNull());
 expect(page.renderer.view?.panel.modal?.id).toBe("skills:create");
});


test("a late skill read cannot replace a subsequently opened creation dialog", async () => {
 let finish: (response: Response) => void = () => { throw new Error("read has not started"); };
 let signal: () => void = () => {};
 const entered = new Promise<void>(resolve => { signal = resolve; });
 const { page } = await startPage(path => path === "/api/v1/skills/one" ? new Promise<Response>(resolve => { finish = resolve; signal(); }) : undefined);
 page.renderer.onPanelAction({ kind: "command", id: "skills:edit", data: "one" });
 await entered;
 page.renderer.onPanelAction({ kind: "command", id: "skills:new", data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe("skills:create"));
 finish(new Response(JSON.stringify({ name: "one", path: "/agent/skills/one/SKILL.md", content: "old content", digest: "a".repeat(64), editable: true })));
 await new Promise(resolve => setTimeout(resolve, 20));
 expect(page.renderer.view?.panel.modal?.id).toBe("skills:create");
 expect(page.renderer.view?.panel.modal?.fields.find(field => field.id === "name")?.value).toBe("");
});


test("older transcript pages preserve newer live receipts and image-only user entries", async () => {
 const requested: string[] = [];
 const make = (id: string, revision: string, answer: string) => ({ request_id: id, text: id, answer, status: "succeeded", kind: "root", revision, accepted_revision: id === "recent" ? "20" : id === "two" ? "2" : "1" });
 const recent = make("recent", "20", "recent answer");
 const { page } = await startPage((path, _options, query) => {
  if (!path.endsWith("/history")) return undefined;
  const before = query.get("before") ?? "";
  requested.push(before);
  return new Response(JSON.stringify({ session_id: "a", requests: before ? [make("one", "1", "older answer"), make("two", "2", "stale answer")] : [recent], events: [], cursor: before ? "one" : "recent", more: !before }));
 });
 const connection = page.client.connection;
 if (!connection?.snapshot) throw new Error("Session was not attached");
 connection.snapshot = { ...connection.snapshot, seq: "99", requests: [{ ...make("two", "99", "fresh answer"), kind: "root", status: "succeeded" }, { ...recent, text: "", image_count: 1, kind: "root", status: "succeeded" }] };
 page.client.onChange();
 await vi.waitFor(() => expect(page.renderer.view?.history.more).toBe(true));
 page.renderer.onPanelAction({ kind: "command", id: "history:more", data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.blocks.some(block => block.text === "older answer")).toBe(true));
 expect(page.renderer.view?.blocks.filter(block => block.kind === "assistant").map(block => block.text)).toEqual(["older answer", "fresh answer", "recent answer"]);
 expect(page.renderer.view?.blocks.find(block => block.id === "recent:user")?.images?.[0].dataUrl).toBe("/api/v1/sessions/a/requests/recent/images/0");
 expect(connection.snapshot.seq).toBe("99");
 expect(connection.snapshot.requests).toHaveLength(2);
 expect(requested.filter(before => before === "recent")).toHaveLength(1);
});
