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
import { MODEL_ENABLED_ACTION, PROVIDER_EDIT_ACTION, PROVIDER_EDIT_MODAL } from "../src/model-connections.ts";

let page: DesktopPage | undefined;
afterEach(() => { page?.dispose(); page = undefined; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function startPage(extra?: (path: string, options: RequestInit, query: URLSearchParams) => Response | undefined | Promise<Response | undefined>): Promise<{ page: DesktopPage; submitted: Submit[] }> {
 history.replaceState(null, "", "/");
 const html = readFileSync(resolve("src/page/index.html"), "utf8");
 document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
 const submitted: Submit[] = [];
 const selected = new Map<string, string>();
 class Socket { close() {} send() {} }
 vi.stubGlobal("WebSocket", Socket);
 vi.stubGlobal("fetch", vi.fn(async (input: URL, options: RequestInit = {}) => {
  const path = new URL(input).pathname, method = options.method ?? "GET";
  const session = path.match(/^\/api\/v1\/(?:sessions|session-models)\/([^/]+)/u)?.[1] ?? "a";
  const custom = await extra?.(path, options, new URL(input).searchParams);
  if (custom) return custom;
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (path.endsWith("/bootstrap")) return response({ build_id: "build", profile_id: "host", instance_id: "instance", pid: 1, host_epoch: 1, role: "host", protocol: "amazme-http/1" });
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: "a", title: "A", workspace: "primary" }] });
  if (path === "/api/v1/workspaces") return response({ workspaces: [{ name: "primary", host_path: "/work", primary: true }] });
  if (path === "/api/v1/models") return response({ models: [{ provider: "faux", model: "shown", label: "Shown", endpoint_editable: true }, { provider: "faux", model: "different", label: "Different", endpoint_editable: true }], current: { provider: "faux", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: true } });
  if (path === "/api/v1/accounts") return response({ revision: 0, accounts: [] });
  if (path === "/api/v1/plugin-packages") return response({ revision: 0, packages: [] });
  if (path.endsWith("/plugins")) return response({ plugins: [] });
  if (path === "/api/v1/settings") return response({ revision: 0 });
  if (path === "/api/v1/projects") return response({ projects: [] });
  if (path === "/api/v1/skills") return response({ context_files: [], skills: [], prompts: [], diagnostics: [] });
  if (path.endsWith("/attachments")) return response({ attachment_id: `attachment-${session}`, session_id: session, host_epoch: 1, build_id: "build" });
  if (path.startsWith("/api/v1/session-models/")) {
   if (method === "PUT") selected.set(session, parseContract("SessionModel", JSON.parse(String(options.body))).model);
   const model = selected.get(session);
   return model ? response({ session_id: session, provider: "faux", model }) : response({ code: "session_model_missing" }, 404);
  }
  if (path.endsWith("/resources")) return response({ context_files: [], skills: [], prompts: [], diagnostics: [] });
  if (path.endsWith("/usage")) return response({ session_id: session });
  if (path.endsWith("/feedback")) return response({ session_id: session, records: [] });
  if (path.endsWith("/history")) return response({ session_id: session, requests: [], events: [] });
  if (path.endsWith("/mcp-configuration")) return response({ revision: 0, workspace: "primary", path: "/profile/host.sqlite", servers: [] });
  if (path.endsWith("/mcp")) return response({ servers: [], calls: [] });
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
 if (connection) {
  connection.ready = true;
  connection.snapshot = { session_id: connection.sessionId, stream_id: "stream", seq: "0", state: "ready", requests: [], events: [] };
 }
 page.client.onChange();
 return { page, submitted };
}

test("a submission captures the displayed model, retries the same request, and preserves a newer draft", async () => {
 const { page, submitted } = await startPage();
 page.renderer.onSelectPermission("all");
 const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
 if (!prompt?.form) throw new Error("composer missing");
 prompt.value = "original"; prompt.dispatchEvent(new Event("input"));
 prompt.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await vi.waitFor(() => expect(submitted).toHaveLength(1));
 expect(prompt.value).toBe("original");
 expect(submitted[0].model_selection).toEqual({ provider: "faux", model: "shown" });
 expect(submitted[0].approval_policy).toBe("all");
 expect(submitted[0].time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
 page.renderer.onSelectPermission("auto");
 page.renderer.onSelectModel("faux", "different");
 await vi.waitFor(() => expect(page?.renderer.view?.model.label).toBe("Different"));
 page.renderer.onDraftChange("new draft"); page.renderer.setDraft("new draft");
 page.renderer.onSubmit("new draft");
 await vi.waitFor(() => expect(submitted).toHaveLength(2));
 expect(submitted[1]).toEqual(submitted[0]);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("new draft");
});

test("deleting the current session retires it before a pending list refresh and blocks stale selection", async () => {
 let removed = false;
 let finishRefresh: (value: Response) => void = () => { throw new Error("refresh not started"); };
 const refreshing = vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; }));
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions/a" && options.method === "DELETE") { removed = true; return new Response('{"removed":true}'); }
  if (path === "/api/v1/sessions" && removed) return refreshing();
  return undefined;
 });
 const original = page.client.connection;
 if (!original) throw new Error("connection missing");
 page.renderer.onDraftChange("deleted draft"); page.renderer.setDraft("deleted draft");
 page.renderer.onPanelAction({ kind: "command", id: A.SESSION_REMOVE_ACTION, data: "a" });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SESSION_REMOVE_MODAL, data: "a", fields: {} });
 await vi.waitFor(() => expect(refreshing).toHaveBeenCalledOnce());
 expect(original.active()).toBe(false);
 expect(page.client.connection).toBeUndefined();
 expect(new URLSearchParams(location.search).has("session")).toBe(false);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("");
 page.renderer.onSelect("a");
 await vi.waitFor(() => expect(document.body.textContent).toContain("会话不存在"));
 expect(page.client.connection).toBeUndefined();
 finishRefresh(new Response('{"sessions":[]}'));
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal).toBeUndefined());
});

test("a failed refresh cannot revive a deleted session or its composer", async () => {
 let removed = false;
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions/a" && options.method === "DELETE") { removed = true; return new Response('{"removed":true}'); }
  if (path === "/api/v1/sessions" && removed) return new Response('{"code":"refresh_failed"}', { status: 503 });
  return undefined;
 });
 const original = page.client.connection;
 page.renderer.onDraftChange("deleted draft"); page.renderer.setDraft("deleted draft");
 page.renderer.onPanelAction({ kind: "command", id: A.SESSION_REMOVE_ACTION, data: "a" });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SESSION_REMOVE_MODAL, data: "a", fields: {} });
 await vi.waitFor(() => expect(removed).toBe(true));
 await vi.waitFor(() => expect(page.client.connection).toBeUndefined());
 expect(original?.active()).toBe(false);
 expect(new URLSearchParams(location.search).has("session")).toBe(false);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("");
 expect(page.renderer.view?.roster.some(item => item.id === "a")).toBe(false);
});

test("a rejected deletion keeps the current connection and draft", async () => {
 const { page } = await startPage((path, options) => path === "/api/v1/sessions/a" && options.method === "DELETE"
  ? new Response('{"code":"session_busy"}', { status: 409 }) : undefined);
 const original = page.client.connection;
 page.renderer.onDraftChange("keep draft"); page.renderer.setDraft("keep draft");
 page.renderer.onPanelAction({ kind: "command", id: A.SESSION_REMOVE_ACTION, data: "a" });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SESSION_REMOVE_MODAL, data: "a", fields: {} });
 await vi.waitFor(() => expect(document.body.textContent).toContain("session_busy"));
 expect(page.client.connection).toBe(original);
 expect(original?.active()).toBe(true);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("keep draft");
});

test("history arriving after deletion cannot restart session polling", async () => {
 let removed = false;
 let finishHistory: (value: Response) => void = () => { throw new Error("history not started"); };
 const reading = vi.fn(() => new Promise<Response>(resolve => { finishHistory = resolve; }));
 const health = vi.fn(() => new Response("{}"));
 const { page } = await startPage((path, options) => {
  if (path.endsWith("/history")) return reading();
  if (path === "/api/v1/health") return health();
  if (path === "/api/v1/sessions/a" && options.method === "DELETE") { removed = true; return new Response('{"removed":true}'); }
  if (path === "/api/v1/sessions" && removed) return new Response('{"sessions":[]}');
  return undefined;
 });
 await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
 vi.useFakeTimers();
 page.renderer.onPanelAction({ kind: "command", id: A.SESSION_REMOVE_ACTION, data: "a" });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SESSION_REMOVE_MODAL, data: "a", fields: {} });
 await vi.waitFor(() => expect(page.client.connection).toBeUndefined());
 finishHistory(new Response('{"session_id":"a","requests":[],"events":[]}'));
 await vi.advanceTimersByTimeAsync(4000);
 expect(health).not.toHaveBeenCalled();
});

test("a late deletion does not retire another session or replace its draft", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let removed = false;
 let finishDelete: (value: Response) => void = () => { throw new Error("delete not started"); };
 const deleting = vi.fn(() => new Promise<Response>(resolve => { finishDelete = resolve; }));
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions") return response({ sessions: [
   ...(!removed ? [{ session_id: "a", title: "A", workspace: "primary" }] : []),
   { session_id: "b", title: "B", workspace: "primary" },
  ] });
  if (path === "/api/v1/sessions/a" && options.method === "DELETE") return deleting();
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "command", id: A.SESSION_REMOVE_ACTION, data: "a" });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.SESSION_REMOVE_MODAL, data: "a", fields: {} });
 await vi.waitFor(() => expect(deleting).toHaveBeenCalledOnce());
 page.renderer.onSelect("b");
 await vi.waitFor(() => expect(page.client.connection?.sessionId).toBe("b"));
 const selected = page.client.connection;
 page.renderer.onDraftChange("B draft"); page.renderer.setDraft("B draft");
 removed = true; finishDelete(response({ removed: true }));
 await vi.waitFor(() => expect(page.renderer.view?.roster.some(item => item.id === "a")).toBe(false));
 expect(page.client.connection).toBe(selected);
 expect(selected?.active()).toBe(true);
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("B draft");
 expect(document.body.textContent).not.toContain("Unexpected request");
});

test("drafts stay with their session through switching and a late submission receipt", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let finishSubmit: (value: Response) => void = () => { throw new Error("submission not started"); };
 const submitting = vi.fn(() => new Promise<Response>(resolve => { finishSubmit = resolve; }));
 const { page } = await startPage((path) => {
  if (path === "/api/v1/sessions") return response({ sessions: [
   { session_id: "a", title: "A", workspace: "primary" }, { session_id: "b", title: "B", workspace: "primary" },
  ] });
  if (path.endsWith("/submissions")) return submitting();
  return undefined;
 });
 const prompt = () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value;
 page.renderer.onDraftChange("A only"); page.renderer.setDraft("A only");
 page.renderer.onSubmit("A only");
 await vi.waitFor(() => expect(submitting).toHaveBeenCalledOnce());
 const pendingKey = "amazme:write:host:a:submission";
 const pending: unknown = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
 if (!pending || typeof pending !== "object" || !("id" in pending) || typeof pending.id !== "string") throw new Error("pending submission missing");
 page.renderer.onSelect("b");
 await vi.waitFor(() => expect(page.client.connection?.attachment?.session_id).toBe("b"));
 expect(prompt()).toBe("");
 page.renderer.onDraftChange("B only"); page.renderer.setDraft("B only");
 finishSubmit(response({ request_id: pending.id, text: "A only", status: "queued" }));
 await vi.waitFor(() => expect(sessionStorage.getItem(pendingKey)).toBeNull());
 expect(prompt()).toBe("B only");
 page.renderer.onSelect("a");
 await vi.waitFor(() => expect(page.client.connection?.attachment?.session_id).toBe("a"));
 expect(prompt()).toBe("");
 page.renderer.onSelect("b");
 await vi.waitFor(() => expect(page.client.connection?.attachment?.session_id).toBe("b"));
 expect(prompt()).toBe("B only");
});

test("permission menu selects, survives reload, and stays scoped to the original session", async () => {
 const { page: first } = await startPage();
 const trigger = document.querySelector<HTMLButtonElement>(".permission-trigger");
 const dialog = document.querySelector<HTMLDialogElement>(".permission-menu");
 trigger?.click();
 expect(dialog?.open).toBe(true);
 expect(document.querySelectorAll('.permission-option[aria-checked="true"]')).toHaveLength(1);
 document.querySelector<HTMLButtonElement>('.permission-option[data-policy="auto"]')?.click();
 expect(dialog?.open).toBe(false);
 expect(first.renderer.view?.approvalPolicy).toBe("auto");
 expect(trigger?.dataset.policy).toBe("auto");
 first.dispose();
 const { page: restored } = await startPage();
 expect(restored.renderer.view?.approvalPolicy).toBe("auto");
 const connection = restored.client.connection;
 if (!connection) throw new Error("missing connection");
 restored.client.connection = { ...connection, sessionId: "other" };
 restored.client.onChange();
 expect(restored.renderer.view?.approvalPolicy).toBe("mutations");
 restored.client.connection = connection;
 restored.client.onChange();
 expect(restored.renderer.view?.approvalPolicy).toBe("auto");
 document.querySelector<HTMLButtonElement>(".permission-trigger")?.click();
 document.querySelector<HTMLDialogElement>(".permission-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
 expect(document.querySelector<HTMLDialogElement>(".permission-menu")?.open).toBe(false);
 connection.ready = false;
 restored.client.onChange();
 expect(document.querySelector<HTMLButtonElement>(".permission-trigger")?.disabled).toBe(true);
});

test("permission defaults reflect the connected host and invalid saved modes are ignored", async () => {
 sessionStorage.setItem("amazme:permission:host:a", "invalid");
 const { page } = await startPage(path => path.endsWith("/bootstrap") ? new Response(JSON.stringify({ build_id: "build", profile_id: "host", instance_id: "instance", pid: 1, host_epoch: 1, role: "host", protocol: "amazme-http/1", approval_policy: "all" })) : undefined);
 expect(page.renderer.view?.approvalPolicy).toBe("all");
});

test("a rejected composer draft remains editable and clears only after a successful receipt", async () => {
 const submitted: Submit[] = [];
 await startPage((path, options) => {
  if (!path.endsWith("/submissions")) return undefined;
  const body = parseContract("Submit", JSON.parse(String(options.body)));
  submitted.push(body);
  return new Response(JSON.stringify({ request_id: body.request_id, text: body.text, status: "queued" }), { status: 202 });
 });
 const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
 if (!prompt?.form) throw new Error("composer missing");
 prompt.value = "x".repeat(16001); prompt.dispatchEvent(new Event("input"));
 prompt.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await vi.waitFor(() => expect(document.body.textContent).toContain("请求不符合后端契约"));
 expect(prompt.value).toHaveLength(16001);
 expect(submitted).toEqual([]);
 expect(Object.keys(sessionStorage).some(key => key.endsWith(":submission"))).toBe(false);
 prompt.value = "corrected draft"; prompt.dispatchEvent(new Event("input"));
 prompt.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await vi.waitFor(() => expect(prompt.value).toBe(""));
 expect(submitted.map(request => request.text)).toEqual(["corrected draft"]);
});

test("desktop close preferences use the shared settings store and survive a fresh page", async () => {
 vi.stubGlobal("amazmeDesktop", { pickDirectories: async () => [] });
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let settings = parseContract("ProductSettings", { revision: 0, preferences: {} });
 const api = (path: string, options: RequestInit) => {
  if (path === "/api/v1/settings/preferences" && options.method === "PUT") {
   const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
   expect(body.expected_revision).toBe(settings.revision);
   settings = { ...settings, revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
  }
  if (path === "/api/v1/settings" || path === "/api/v1/settings/preferences") return response(settings);
  return undefined;
 };
 const first = await startPage(api);
 first.page.renderer.onPanelAction({ kind: "open", panel: P.SETTINGS_VIEW });
 const group = () => first.page.renderer.view?.panel.panel?.groups.find(item => item.id === "settings:desktop");
 expect(group()?.rows.map(row => row.title)).toEqual(["When closing a window", "Ask when tasks are running"]);
 expect(group()?.rows[0]?.controls?.[0]?.value).toBe("background");
 expect(group()?.rows[1]?.controls?.[0]?.value).toBe("true");
 first.page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "closeWindow", value: "quit" });
 await vi.waitFor(() => expect(settings.preferences?.closeWindow).toBe("quit"));
 first.page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "closeWindowPrompt", value: "false" });
 await vi.waitFor(() => expect(settings.preferences?.closeWindowPrompt).toBe(false));
 expect(settings.revision).toBe(2);
 first.page.dispose();
 const reopened = await startPage(api);
 reopened.page.renderer.onPanelAction({ kind: "open", panel: P.SETTINGS_VIEW });
 const restored = reopened.page.renderer.view?.panel.panel?.groups.find(item => item.id === "settings:desktop");
 expect(restored?.rows[0]?.controls?.[0]?.value).toBe("quit");
 expect(restored?.rows[1]?.controls?.[0]?.value).toBe("false");
 settings = { ...settings, revision: 3, preferences: { ...settings.preferences, closeWindow: "background", closeWindowPrompt: true } };
 window.dispatchEvent(new Event("focus"));
 await vi.waitFor(() => {
  const refreshed = reopened.page.renderer.view?.panel.panel?.groups.find(item => item.id === "settings:desktop");
  expect(refreshed?.rows[0]?.controls?.[0]?.value).toBe("background");
  expect(refreshed?.rows[1]?.controls?.[0]?.value).toBe("true");
 });
});

test("a failed queued setting remains visible when a later setting saves successfully", async () => {
 let failName: (response: Response) => void = () => { throw new Error("save not started"); };
 let nameStarted = false;
 let settings = parseContract("ProductSettings", { revision: 0, display_name: "original" });
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/settings" && options.method === "POST") return new Promise<Response>(resolve => { nameStarted = true; failName = resolve; });
  if (path === "/api/v1/settings/preferences") {
   const update = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
   settings = { ...settings, revision: 1, preferences: update.preferences };
   return new Response(JSON.stringify(settings));
  }
  if (path === "/api/v1/settings") return new Response(JSON.stringify(settings));
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "open", panel: P.SETTINGS_VIEW });
 page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "display_name", value: "new name" });
 await vi.waitFor(() => expect(nameStarted).toBe(true));
 page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "appearance", value: "dark" });
 failName(new Response(JSON.stringify({ code: "name_save_failed" }), { status: 503 }));
 await vi.waitFor(() => expect(settings.preferences?.appearance).toBe("dark"));
 await vi.waitFor(() => expect(document.body.textContent).toContain("name_save_failed"));
 expect(settings.display_name).toBe("original");
});

test("a confirmed receipt preserves even an identical draft typed after sending, and stale retry controls cannot submit again", async () => {
 const requests: Submit[] = [];
 let finish: (response: Response) => void = () => { throw new Error("submission not started"); };
 const { page } = await startPage((path, options) => {
  if (!path.endsWith("/submissions")) return undefined;
  requests.push(parseContract("Submit", JSON.parse(String(options.body))));
  return new Promise<Response>(resolve => { finish = resolve; });
 });
 page.renderer.onDraftChange("same words"); page.renderer.setDraft("same words");
 page.renderer.onSubmit("same words");
 await vi.waitFor(() => expect(requests).toHaveLength(1));
 const retry = page.renderer.view?.queue.find(item => item.id === requests[0].request_id)?.retry;
 if (!retry) throw new Error("pending retry missing");
 page.renderer.onDraftChange("same words"); page.renderer.setDraft("same words");
 finish(new Response(JSON.stringify({ request_id: requests[0].request_id, text: "same words", status: "queued" }), { status: 202 }));
 await vi.waitFor(() => expect(page.renderer.view?.queue.some(item => item.id === requests[0].request_id)).toBe(false));
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("same words");
 page.renderer.onPanelAction({ kind: "command", id: retry.id, data: retry.data });
 await vi.waitFor(() => expect(document.body.textContent).toContain("原请求已变化"));
 expect(requests).toHaveLength(1);
});

test("a pending request takes precedence over a newly typed command", async () => {
 const { page, submitted } = await startPage();
 page.renderer.onDraftChange("original"); page.renderer.onSubmit("original");
 await vi.waitFor(() => expect(document.body.textContent).toContain("receipt_lost"));
 page.renderer.onDraftChange("/new"); page.renderer.setDraft("/new");
 page.renderer.onSubmit("/new");
 await vi.waitFor(() => expect(submitted).toHaveLength(2));
 expect(submitted[1]).toEqual(submitted[0]);
 expect(page.client.connection?.sessionId).toBe("a");
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("/new");
});

test("a late command response cannot clear the draft edited while it ran", async () => {
 let exporting = false;
 let finish: (response: Response) => void = () => { throw new Error("export not started"); };
 vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
 vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
 const { page } = await startPage(path => path === "/api/v1/export" ? new Promise<Response>(resolve => { exporting = true; finish = resolve; }) : undefined);
 page.renderer.onDraftChange("/export"); page.renderer.onSubmit("/export");
 await vi.waitFor(() => expect(exporting).toBe(true));
 page.renderer.onDraftChange("next task"); page.renderer.setDraft("next task");
 finish(new Response(JSON.stringify({ format: "amazme/1" })));
 await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
 await new Promise(resolve => setTimeout(resolve, 0));
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("next task");
});

test("the original resource palette submits resource commands for Python expansion and keeps the displayed thinking level", async () => {
 const requests: Submit[] = [];
 const response = (value: unknown) => new Response(JSON.stringify(value));
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/models") return response({ models: [{ provider: "faux", model: "shown", label: "Shown", endpoint_editable: true, thinking_levels: ["off", "high"] }], current: { provider: "faux", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: true, thinking: "high" } });
  if (path.endsWith("/resources")) return response({ context_files: [], skills: [{ name: "review", path: "/skills/review/SKILL.md", description: "Review" }], prompts: [{ name: "explain", path: "/prompts/explain.md", description: "Explain" }], diagnostics: [] });
  if (!path.endsWith("/submissions")) return undefined;
  const request = parseContract("Submit", JSON.parse(String(options.body))); requests.push(request);
  return response({ request_id: request.request_id, text: request.text, status: "queued" });
 });
 page.renderer.onDraftChange("/");
 await vi.waitFor(() => expect(page.renderer.view?.palette?.rows.map(item => item.value)).toEqual(expect.arrayContaining(["explain", "skill:review"])));
 page.renderer.onPanelAction({ kind: "control", id: A.SUBMIT_MODE_ACTION, data: undefined, value: "steer" });
 page.renderer.onDraftChange("/explain original arguments"); page.renderer.onSubmit("/explain original arguments");
 await vi.waitFor(() => expect(requests).toHaveLength(1));
 expect(requests[0]).toMatchObject({ text: "/explain original arguments", thinking: "high", mode: "queue" });
 expect(requests[0].target_run_id).toBeUndefined();
});

test("the original compaction dialog pins its instructions and completed turn across retries and does not close a newer dialog", async () => {
 const requests: Array<import("../src/python-contracts.ts").CompactSession> = [];
 let finish: (response: Response) => void = () => { throw new Error("compaction retry not started"); };
 const { page } = await startPage((path, options) => {
  if (!path.endsWith("/compactions")) return undefined;
  requests.push(parseContract("CompactSession", JSON.parse(String(options.body))));
  if (requests.length === 1) return new Response(JSON.stringify({ code: "receipt_lost" }), { status: 503 });
  return new Promise<Response>(resolve => { finish = resolve; });
 });
 const connection = page.client.connection;
 if (!connection?.snapshot) throw new Error("session missing");
 connection.snapshot = { ...connection.snapshot, requests: [{ request_id: "done", text: "task", answer: "answer", kind: "root", status: "succeeded" }, { request_id: "failed", text: "bad", kind: "root", status: "failed" }] };
 page.client.onChange();
 page.renderer.onPanelAction({ kind: "command", id: A.COMPACT_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.data).toBe("a"));
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.COMPACT_MODAL, data: "a", fields: { instructions: "保留文件路径" } });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
 connection.snapshot = { ...connection.snapshot, requests: [{ request_id: "new", text: "next", kind: "root", status: "succeeded" }] };
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.COMPACT_MODAL, data: "a", fields: { instructions: "新要求" } });
 await vi.waitFor(() => expect(requests).toHaveLength(2));
 expect(requests[0]).toMatchObject({ through_request_id: "done", instructions: "保留文件路径" });
 expect(requests[1]).toEqual(requests[0]);
 page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(A.MODEL_SCOPE_MODAL));
 finish(new Response(JSON.stringify({ ...requests[0], basis: "basis", summary: "summary", message_count: 2 })));
 await vi.waitFor(() => expect(sessionStorage.getItem("amazme:write:host:a:compaction")).toBeNull());
 expect(page.renderer.view?.panel.modal?.id).toBe(A.MODEL_SCOPE_MODAL);
});

test("original answer feedback retries the original vote, toggles to retract, and rejects controls from another session", async () => {
 const session = "a".repeat(32), requests: Array<import("../src/python-contracts.ts").AnswerFeedbackWrite> = [];
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: session, title: "A", workspace: "primary" }] });
  if (path.endsWith("/attachments")) return response({ attachment_id: "attachment", session_id: session, host_epoch: 1, build_id: "build" });
  if (path.startsWith("/api/v1/session-models/")) return response({ code: "session_model_missing" }, 404);
  if (path.endsWith("/feedback")) {
   if (options.method !== "POST") return response({ session_id: session, records: [] });
   const request = parseContract("AnswerFeedbackWrite", JSON.parse(String(options.body))); requests.push(request);
   if (requests.length === 1) return response({ code: "receipt_lost" }, 503);
   return response({ operation_id: request.operation_id, session_id: session, request_id: request.request_id, rating: request.rating, revision: request.expected_revision + 1 });
  }
  return undefined;
 });
 const connection = page.client.connection;
 if (!connection?.snapshot) throw new Error("session missing");
 connection.snapshot = { ...connection.snapshot, requests: [{ request_id: "answer", text: "task", answer: "answer", kind: "root", status: "succeeded" }] };
 page.client.onChange();
 const controls = () => page.renderer.view?.blocks.find(block => block.kind === "assistant")?.feedback;
 await vi.waitFor(() => expect(controls()).toBeDefined());
 const original = controls();
 if (!original) throw new Error("feedback missing");
 page.renderer.onPanelAction({ kind: "command", id: original.up.id, data: original.up.data });
 await vi.waitFor(() => expect(document.body.textContent).toContain("receipt_lost"));
 page.renderer.onPanelAction({ kind: "command", id: original.down.id, data: original.down.data });
 await vi.waitFor(() => expect(controls()?.rating).toBe("up"));
 expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
 const selected = controls();
 if (!selected) throw new Error("confirmed feedback missing");
 page.renderer.onPanelAction({ kind: "command", id: selected.up.id, data: selected.up.data });
 await vi.waitFor(() => expect(controls()?.rating).toBeNull());
 expect(requests[2]).toMatchObject({ request_id: "answer", expected_revision: 1, rating: null });
 page.renderer.onPanelAction({ kind: "command", id: original.up.id, data: JSON.stringify(["b".repeat(32), "answer", null, 0]) });
 await vi.waitFor(() => expect(document.body.textContent).toContain("反馈不属于当前答案"));
 expect(requests).toHaveLength(3);
});

test("global model toggles constrain a session scope and survive a fresh page", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let settings = parseContract("ProductSettings", { revision: 0, preferences: {} });
 const api = (path: string, options: RequestInit) => {
  if (path !== "/api/v1/settings" && path !== "/api/v1/settings/preferences") return undefined;
  if (options.method === "PUT") {
   const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
   expect(body.expected_revision).toBe(settings.revision);
   settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
  }
  return response(settings);
 };
 const first = await startPage(api);
 first.page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 first.page.renderer.onPanelAction({ kind: "modal-submit", id: A.MODEL_SCOPE_MODAL, data: undefined, fields: { models: JSON.stringify(["faux/shown", "faux/different"]) } });
 await vi.waitFor(() => expect(first.page.renderer.view?.panel.modal).toBeUndefined());
 first.page.renderer.onPanelAction({ kind: "control", id: MODEL_ENABLED_ACTION, data: JSON.stringify(["faux", "shown"]), value: "false" });
 await vi.waitFor(() => expect(settings.preferences?.enabledModels).toEqual(["faux/different"]));
 expect(first.page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).not.toContain("shown");
 document.querySelector<HTMLButtonElement>(".composer-model-picker")?.click();
 expect(document.querySelector(".model-picker-notice")?.textContent).toContain("hidden");
 expect(first.page.renderer.view?.model.label).toBe("Shown");
 first.page.dispose();
 const reopened = await startPage(api);
 expect(reopened.page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]);
 reopened.page.renderer.onPanelAction({ kind: "control", id: MODEL_ENABLED_ACTION, data: JSON.stringify(["faux", "different"]), value: "false" });
 await vi.waitFor(() => expect(settings.preferences?.enabledModels).toEqual([]));
 const recover = document.querySelector<HTMLButtonElement>(`#transcript-empty [data-action="${A.MODEL_SCOPE_ACTION}"]`);
 expect(recover).not.toBeNull();
 recover?.click();
 await vi.waitFor(() => expect(reopened.page.renderer.view?.panel.current).toBe(P.SETTINGS_VIEW));
 expect(reopened.page.renderer.view?.panel.modal).toBeUndefined();
});

test("host-resolved model patterns provide concrete choices and toggles save the resolved list", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 const models = [
  { provider: "gateway", model: "shown", label: "Shown", endpoint_editable: true },
  { provider: "gateway", model: "different", label: "Different", endpoint_editable: true },
 ];
 let settings = parseContract("ProductSettings", { revision: 0, preferences: { enabledModels: ["gateway/*"] } });
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/models/scope") {
   const body = parseContract("ModelScopeRequest", JSON.parse(String(options.body)));
   expect(body.patterns).toEqual(["gateway/*"]);
   return response({ models: models.map(model => ({ model })), diagnostics: [] });
  }
  if (path === "/api/v1/models") return response({ models, current: { provider: "gateway", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: true } });
  if (path === "/api/v1/settings" || path === "/api/v1/settings/preferences") {
   if (options.method === "PUT") {
    const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
    settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
   }
   return response(settings);
  }
  return undefined;
 });
 const choices = () => page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId);
 expect(choices()).toEqual(["shown", "different"]);
 expect(page.renderer.view?.modelConnections?.enabledModels.map(model => model.modelId)).toEqual(["shown", "different"]);
 expect(page.renderer.view?.modelConnections?.state.enabledModelIds).toEqual(["gateway/shown", "gateway/different"]);
 page.renderer.onPanelAction({ kind: "control", id: MODEL_ENABLED_ACTION, data: JSON.stringify(["gateway", "shown"]), value: "false" });
 await vi.waitFor(() => expect(settings.preferences?.enabledModels).toEqual(["gateway/different"]));
 await vi.waitFor(() => expect(choices()).toEqual(["different"]));
});

test("an older global load cannot restore model choices superseded by a settings write", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let settings = parseContract("ProductSettings", { revision: 0, preferences: {} });
 let holdRefresh = false, refreshStarted = false, usages = 0;
 let finishRefresh = () => {};
 const { page } = await startPage((path, options) => {
  if (path.endsWith("/usage")) usages++;
  if (path === "/api/v1/settings" && holdRefresh) {
   holdRefresh = false; refreshStarted = true;
   return new Promise<Response>(resolve => { finishRefresh = () => resolve(response({ revision: 0, preferences: {} })); });
  }
  if (path === "/api/v1/settings" || path === "/api/v1/settings/preferences") {
   if (options.method === "PUT") {
    const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
    settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
   }
   return response(settings);
  }
  return undefined;
 });
 await vi.waitFor(() => expect(usages).toBe(1));
 const initialUsages = usages;
 holdRefresh = true;
 page.renderer.onPanelAction({ kind: "command", id: A.REFRESH_MODELS_ACTION, data: undefined });
 await vi.waitFor(() => expect(refreshStarted).toBe(true));
 page.renderer.onPanelAction({ kind: "control", id: MODEL_ENABLED_ACTION, data: JSON.stringify(["faux", "shown"]), value: "false" });
 await vi.waitFor(() => expect(settings.revision).toBe(1));
 expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]);
 finishRefresh();
 await vi.waitFor(() => expect(usages).toBeGreaterThan(initialUsages));
 expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]);
 expect(page.renderer.view?.modelConnections?.state.enabledModelIds).toEqual(["faux/different"]);
});

test("a slower persisted model scope cannot replace a newer session scope", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let settings = parseContract("ProductSettings", { revision: 0, preferences: {} });
 let persistStarted = false;
 let finishPersist = () => {};
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/settings/preferences" && !persistStarted) {
   const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
   persistStarted = true;
   return new Promise<Response>(resolve => { finishPersist = () => {
    settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
    resolve(response(settings));
   }; });
  }
  if (path === "/api/v1/settings" || path === "/api/v1/settings/preferences") {
   if (options.method === "PUT") {
    const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
    settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
   }
   return response(settings);
  }
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.MODEL_SCOPE_MODAL, data: undefined, fields: { models: JSON.stringify(["faux/shown", "faux/different"]), persist: "true" } });
 await vi.waitFor(() => expect(persistStarted).toBe(true));
 expect(page.renderer.view?.panel.modal?.pending).toBe(true);
 page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.MODEL_SCOPE_MODAL, data: undefined, fields: { models: JSON.stringify(["faux/different"]) } });
 await vi.waitFor(() => expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]));
 finishPersist();
 page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "textSize", value: "16" });
 await vi.waitFor(() => expect(page.renderer.view?.typography.textSize).toBe(16));
 expect(settings.preferences?.enabledModels).toEqual(["faux/shown", "faux/different"]);
 expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]);
});

test("a session model scope survives preferences completed during its bootstrap", async () => {
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 let settings = parseContract("ProductSettings", { revision: 0, preferences: {} });
 let holdBootstrap = false, bootstrapStarted = false;
 let finishBootstrap = () => {};
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: "a", title: "A", workspace: "primary" }, { session_id: "b", title: "B", workspace: "primary" }] });
  if (path.endsWith("/attachments")) {
   const sessionId = path.split("/")[4];
   return response({ attachment_id: `attachment-${sessionId}`, session_id: sessionId, host_epoch: 1, build_id: "build" });
  }
  if (path.startsWith("/api/v1/session-models/")) return response({ code: "session_model_missing" }, 404);
  if (path.endsWith("/bootstrap") && holdBootstrap) {
   holdBootstrap = false; bootstrapStarted = true;
   return new Promise<Response>(resolve => { finishBootstrap = () => resolve(response({ build_id: "build", profile_id: "host", instance_id: "instance", pid: 1, host_epoch: 1, role: "host", protocol: "amazme-http/1" })); });
  }
  if (path === "/api/v1/settings" || path === "/api/v1/settings/preferences") {
   if (options.method === "PUT") {
    const body = parseContract("PreferencesUpdate", JSON.parse(String(options.body)));
    settings = { revision: (settings.revision ?? 0) + 1, preferences: body.preferences };
   }
   return response(settings);
  }
  return undefined;
 });
 const markReady = () => {
  const current = page.client.connection;
  if (!current) throw new Error("connection missing");
  current.ready = true;
  current.snapshot = { session_id: current.sessionId, stream_id: "stream", seq: "0", state: "ready", requests: [], events: [] };
  page.client.onChange();
 };
 page.renderer.onSelect("b");
 await vi.waitFor(() => expect(page.client.connection?.sessionId).toBe("b"));
 markReady();
 page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.MODEL_SCOPE_MODAL, data: undefined, fields: { models: JSON.stringify(["faux/different"]) } });
 await vi.waitFor(() => expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]));
 page.renderer.onSelect("a");
 await vi.waitFor(() => expect(page.client.connection?.sessionId).toBe("a"));
 holdBootstrap = true;
 page.renderer.onSelect("b");
 await vi.waitFor(() => expect(bootstrapStarted).toBe(true));
 expect(page.client.connection).toBeUndefined();
 page.renderer.onPanelAction({ kind: "control", id: P.SETTINGS_FIELD_ACTION, data: "textSize", value: "16" });
 await vi.waitFor(() => expect(page.renderer.view?.typography.textSize).toBe(16));
 finishBootstrap();
 await vi.waitFor(() => expect(page.client.connection?.socket).toBeDefined());
 markReady();
 await vi.waitFor(() => expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId)).toEqual(["different"]));
});

test("model choices follow configured connections and refresh an open picker without losing the draft", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 let configured = true;
 let loginRequired = false;
 const { page } = await startPage(path => {
  if (path === "/api/v1/models") return response({ models: [
   { provider: "gateway", model: "shown", label: "Shown", endpoint_editable: true },
   { provider: "gateway", model: "disabled", label: "Disabled", endpoint_editable: true },
   { provider: "oauth", model: "remote", label: "Remote", endpoint_editable: false },
   { provider: "missing", model: "phantom", label: "Phantom", endpoint_editable: true },
   { provider: "faux", model: "faux", label: "Faux", endpoint_editable: false },
  ], current: { provider: "gateway", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: configured } });
  if (path === "/api/v1/accounts") return response({ revision: configured ? 1 : 2, accounts: configured ? [{ provider: "oauth", type: "oauth", login_required: loginRequired }] : [] });
  if (path === "/api/v1/settings") return response({ revision: 0, preferences: { enabledModels: ["gateway/shown", "oauth/remote", "missing/phantom", "faux/faux"] } });
  return undefined;
 });
 expect(page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.label)).toEqual(["Shown", "Remote"]);
 expect(page.renderer.view?.modelConnections?.enabledModels.map(model => model.name)).toEqual(["Shown", "Remote"]);
 page.renderer.onDraftChange("keep this draft"); page.renderer.setDraft("keep this draft");
 document.querySelector<HTMLButtonElement>(".composer-model-picker")?.click();
 const dialog = document.querySelector<HTMLDialogElement>(".model-picker-menu");
 expect(dialog?.open).toBe(true);
 expect([...document.querySelectorAll(".model-picker-option-label")].map(node => node.textContent)).toEqual(["Shown", "Remote"]);
 loginRequired = true;
 page.renderer.onPanelAction({ kind: "command", id: A.REFRESH_MODELS_ACTION, data: undefined });
 await vi.waitFor(() => expect([...document.querySelectorAll(".model-picker-option-label")].map(node => node.textContent)).toEqual(["Shown"]));
 expect(page.renderer.view?.modelConnections?.state.providers.find(provider => provider.id === "oauth")?.configured).toBe(true);
 document.querySelector<HTMLButtonElement>(".model-picker-manage")?.click();
 await vi.waitFor(() => expect(document.querySelector('.connection-row[data-action-data="oauth"] .connection-row-state')?.textContent).toBe("Sign in again"));
 document.querySelector<HTMLButtonElement>('.connection-row[data-action-data="oauth"]')?.click();
 await vi.waitFor(() => expect(document.querySelector(".connection-provider-name")?.textContent).toBe("oauth"));
 expect(document.querySelector<HTMLInputElement>(".connection-model.is-unavailable input")?.disabled).toBe(true);
 document.querySelector<HTMLButtonElement>('#nav [data-view="chat"]')?.click();
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel).toBeUndefined());
 document.querySelector<HTMLButtonElement>(".composer-model-picker")?.click();
 configured = false;
 page.renderer.onPanelAction({ kind: "command", id: A.REFRESH_MODELS_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.model.groups).toEqual([]));
 expect(dialog?.open).toBe(true);
 expect(document.querySelectorAll(".model-picker-option")).toHaveLength(0);
 expect(document.querySelector(".model-picker-notice")?.textContent).toContain("unavailable");
 expect(document.querySelector(".model-picker-empty")?.textContent).toContain("No models");
 expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("keep this draft");
 document.querySelector<HTMLButtonElement>(".model-picker-manage")?.click();
 await vi.waitFor(() => expect(document.querySelector(".connection-default-select")).not.toBeNull());
 expect(document.querySelector(".connection-choose")?.textContent).toContain("Choose a provider");
 expect(document.querySelector(".connection-provider-name")).toBeNull();
 const defaults = document.querySelector<HTMLSelectElement>(".connection-default-select");
 expect(defaults?.disabled).toBe(true);
 expect(defaults?.selectedOptions[0]?.disabled).toBe(true);
 expect(defaults?.selectedOptions[0]?.textContent).toContain("unavailable");
});

test("provider configuration works before a session exists and a lost reply keeps its original public settings", async () => {
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 const configurations: Array<import("../src/python-contracts.ts").ConfigureProvider> = [];
 let modelWrites = 0;
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/sessions") return response({ sessions: [] });
  if (path === "/api/v1/accounts") return response({ revision: 4, accounts: [{ provider: "openai", type: "api_key" }] });
  if (path === "/api/v1/models") {
   if (options.method === "POST") modelWrites++;
   return response({ models: [{ provider: "openai", model: "gpt", label: "GPT", endpoint_editable: true, api: "openai-completions", base_url: "https://api.openai.com/v1" }],
    current: { provider: "openai", model: "gpt", base_url: "https://api.openai.com/v1", max_tokens: 2048, key_configured: true }, configuration_revision: 2 });
  }
  if (path === "/api/v1/providers/openai") {
   const body = parseContract("ConfigureProvider", JSON.parse(String(options.body))); configurations.push(body);
   if (configurations.length === 1) return response({ code: "receipt_lost" }, 503);
   return response({ operation_id: body.operation_id, revision: 3, credential_revision: 4, provider: body.provider });
  }
  return undefined;
 });
 expect(page.client.connection).toBeUndefined();
 page.renderer.onPanelAction({ kind: "command", id: PROVIDER_EDIT_ACTION, data: "openai" });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(PROVIDER_EDIT_MODAL));
 const fields = { name: "工作网关", baseUrl: "https://gateway.example/v1", api: "openai-responses", "key:openai": "" };
 page.renderer.onPanelAction({ kind: "modal-submit", id: PROVIDER_EDIT_MODAL, data: "openai", fields });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
 page.renderer.onPanelAction({ kind: "modal-submit", id: PROVIDER_EDIT_MODAL, data: "openai", fields: { ...fields, baseUrl: "https://unconfirmed-change.example" } });
 await vi.waitFor(() => expect(configurations).toHaveLength(2));
 expect(configurations[0]).toMatchObject({ provider: "openai", name: fields.name, base_url: fields.baseUrl, api: fields.api, expected_revision: 2 });
 expect(configurations[1]).toEqual(configurations[0]);
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal).toBeUndefined());
 expect(modelWrites).toBe(0);
});

test("a confirmed provider catalog refreshes before API key and OAuth completion", async () => {
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 for (const method of ["api_key", "oauth"]) {
  let configured = false;
  const { page } = await startPage((path, options) => {
   if (path === "/api/v1/models") {
    const model = configured ? "new-model" : "old-model";
    return response({ models: [
     { provider: "openai", model, label: model, endpoint_editable: true, api: "openai-completions", base_url: "https://gateway.example/v1" },
     { provider: "faux", model: "faux", label: "Faux", endpoint_editable: false },
    ], current: { provider: "faux", model: "faux", base_url: "http://model", max_tokens: 10, key_configured: true },
    providers: [{ provider: "openai", name: "OpenAI", base_url: "https://gateway.example/v1", api: "openai-completions", model_ids: [model] }], configuration_revision: configured ? 3 : 2 });
   }
   if (path === "/api/v1/accounts") return response({ revision: 4, accounts: [{ provider: "openai", type: "api_key" }] });
   if (path === "/api/v1/providers/openai") {
    const body = parseContract("ConfigureProvider", JSON.parse(String(options.body)));
    expect(body.model_ids).toEqual(["new-model"]); configured = true;
    return response({ operation_id: body.operation_id, revision: 3, credential_revision: 4, provider: body.provider });
   }
   if (method === "api_key" && path === "/api/v1/accounts/openai") return response({ code: "receipt_lost" }, 503);
   if (method === "oauth" && path === "/api/v1/accounts/oauth") {
    const body = parseContract("OAuthStart", JSON.parse(String(options.body)));
    return response({ login_id: body.login_id, provider: body.provider, phase: "pending", url: "https://login.example/authorize" });
   }
   return undefined;
  });
  page.renderer.onPanelAction({ kind: "command", id: PROVIDER_EDIT_ACTION, data: "openai" });
  await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(PROVIDER_EDIT_MODAL));
  page.renderer.onPanelAction({ kind: "modal-submit", id: PROVIDER_EDIT_MODAL, data: "openai", fields: {
   name: "OpenAI", baseUrl: "https://gateway.example/v1", api: "openai-completions", models: "new-model", [`method:openai`]: method,
   ...(method === "api_key" ? { "key:openai": "original-private-key" } : {}),
  } });
  if (method === "api_key") await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
  else await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(A.PROVIDER_AUTH_MODAL));
  const choices = page.renderer.view?.model.groups.flatMap(group => group.options).map(option => option.modelId) ?? [];
  expect(choices).toContain("new-model");
  expect(choices).not.toContain("old-model");
  expect(page.renderer.view?.modelConnections?.models.map(model => model.modelId)).toEqual(["new-model"]);
  page.dispose();
 }
});

test("an unconfirmed credential keeps its original content and revision when its modal shows an error", async () => {
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 const writes: Array<import("../src/python-contracts.ts").CredentialUpdate> = [];
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/accounts") return response({ revision: 4, accounts: [{ provider: "openai", type: "api_key" }] });
  if (path === "/api/v1/models") return response({ models: [{ provider: "openai", model: "gpt", label: "GPT", endpoint_editable: true, api: "openai-completions", base_url: "https://api.openai.com/v1" }],
   current: { provider: "openai", model: "gpt", base_url: "https://api.openai.com/v1", max_tokens: 2048, key_configured: true } });
  if (path === "/api/v1/providers/openai") return response({ operation_id: parseContract("ConfigureProvider", JSON.parse(String(options.body))).operation_id, revision: 1, credential_revision: 4, provider: "openai" });
  if (path === "/api/v1/accounts/openai") {
   writes.push(parseContract("CredentialUpdate", JSON.parse(String(options.body))));
   return response({ code: writes.length === 1 ? "receipt_lost" : "credential_conflict" }, writes.length === 1 ? 503 : 409);
  }
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "command", id: PROVIDER_EDIT_ACTION, data: "openai" });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(PROVIDER_EDIT_MODAL));
 const fields = { name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions", "key:openai": "original-private-key" };
 page.renderer.onPanelAction({ kind: "modal-submit", id: PROVIDER_EDIT_MODAL, data: "openai", fields });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
 page.renderer.onPanelAction({ kind: "modal-submit", id: PROVIDER_EDIT_MODAL, data: "openai", fields: { ...fields, "key:openai": "replacement-key" } });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("credential_conflict"));
 expect(writes).toHaveLength(2);
 expect(writes[0]).toEqual({ expected_revision: 4, api_key: fields["key:openai"] });
 expect(writes[1]).toEqual(writes[0]);
 expect(Object.values(sessionStorage).join(" ")).not.toContain(fields["key:openai"]);
});

test("late OAuth controls cannot cancel or submit to a newer login, and confirmed cancellation clears only its own ID", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 const logins: Array<import("../src/python-contracts.ts").OAuthStart> = [], cancellations: string[] = [], inputs: string[] = [];
 let finish: (response: Response) => void = () => { throw new Error("cancellation not started"); };
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/accounts/oauth") {
   const request = parseContract("OAuthStart", JSON.parse(String(options.body))); logins.push(request);
   return response({ login_id: request.login_id, provider: request.provider, phase: "pending", url: "https://login.example/authorize" });
  }
  if (path.startsWith("/api/v1/accounts/oauth/")) {
   const login = logins.find(item => path.includes(item.login_id));
   if (!login) throw new Error("unknown login");
   if (options.method === "DELETE") { cancellations.push(login.login_id); return new Promise<Response>(resolve => { finish = resolve; }); }
   if (path.endsWith("/input")) inputs.push(login.login_id);
   return response({ login_id: login.login_id, provider: login.provider, phase: options.method === "DELETE" ? "cancelled" : "pending", url: "https://login.example/authorize" });
  }
  return undefined;
 });
 for (const provider of ["openai", "openrouter"]) {
  page.renderer.onPanelAction({ kind: "command", id: A.PROVIDER_AUTH_ACTION, data: provider });
  await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.fields.some(field => field.id === "provider")).toBe(true));
  page.renderer.onPanelAction({ kind: "modal-submit", id: A.PROVIDER_AUTH_MODAL, data: undefined, fields: { provider, [`method:${provider}`]: "oauth" } });
  await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.data).toContain(logins.find(item => item.provider === provider)?.login_id));
 }
 const [first, latest] = logins;
 expect(logins).toHaveLength(2);
 page.renderer.onPanelAction({ kind: "command", id: A.PROVIDER_AUTH_CANCEL_ACTION, data: first.login_id });
 page.renderer.onPanelAction({ kind: "modal-submit", id: A.PROVIDER_AUTH_MODAL, data: JSON.stringify([first.login_id, first.login_id]), fields: { value: "old-code" } });
 await new Promise(resolve => setTimeout(resolve, 0));
 expect(cancellations).toEqual([]); expect(inputs).toEqual([]);
 expect(page.renderer.view?.panel.modal?.data).toContain(latest.login_id);
 page.renderer.onPanelAction({ kind: "command", id: A.PROVIDER_AUTH_CANCEL_ACTION, data: latest.login_id });
 await vi.waitFor(() => expect(cancellations).toHaveLength(1));
 page.renderer.onPanelAction({ kind: "command", id: A.MODEL_SCOPE_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(A.MODEL_SCOPE_MODAL));
 finish(response({ login_id: latest.login_id, provider: latest.provider, phase: "cancelled" }));
 await vi.waitFor(() => expect(sessionStorage.getItem("amazme:oauth:host:openrouter")).toBeNull());
 expect(page.renderer.view?.panel.modal?.id).toBe(A.MODEL_SCOPE_MODAL);
 expect(cancellations).toEqual([latest.login_id]);
 expect(JSON.parse(sessionStorage.getItem("amazme:oauth:host:openai") ?? "null").login_id).toBe(first.login_id);
});

test("original file navigation keeps paths relative, retains page on refresh, switches project roots and does not steal a later dock tab", async () => {
 const response = (value: unknown) => new Response(JSON.stringify(value));
 const requests: Array<{ path: string; offset: number }> = [];
 let reading = false;
 let finish: (response: Response) => void = () => { throw new Error("file read not started"); };
 const { page } = await startPage((path, options, query) => {
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: "a", title: "A", workspace: "primary", project_id: "project" }] });
  if (path === "/api/v1/projects") return response({ projects: [{ project_id: "project", name: "Multi", workspaces: ["primary", "docs"] }] });
  if (path === "/api/v1/workspaces") return response({ workspaces: [{ name: "primary", host_path: "/work", primary: true }, { name: "docs", host_path: "/docs", primary: false }] });
  if (path === "/api/v1/files/content") return new Promise<Response>(resolve => { expect(query.get("path")).toBe("grant/docs/slow.txt"); reading = true; finish = resolve; });
  if (path === "/api/v1/files") {
   const target = query.get("path") ?? "", offset = Number(query.get("offset") ?? 0); requests.push({ path: target, offset });
   return response({ path: target, absolute_path: target === "grant/docs" ? "/docs" : target === "dir" ? "/work/dir" : "/work", entries: [{ name: "dir", kind: "dir", size: 0 }], offset, limit: 200, total: 401 });
  }
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "command", id: A.DOCK_TAB_ACTION, data: "files" });
 await vi.waitFor(() => expect(page.renderer.view?.dock?.panel.groups.flatMap(group => group.rows ?? []).find(row => row.title === "dir")?.actions?.[0].data).toBe("/work/dir"));
 page.renderer.onPanelAction({ kind: "command", id: A.WORKSPACE_OPEN_ACTION, data: "/work/dir" });
 await vi.waitFor(() => expect(page.renderer.view?.dock?.panel.files?.path).toBe("dir"));
 expect(page.renderer.view?.dock?.panel.files?.breadcrumbs.map(item => item.path)).toEqual(["/work", "/work/dir"]);
 const next = page.renderer.view?.dock?.panel.groups.flatMap(group => group.actions ?? []).find(action => action.id === A.WORKSPACE_PAGE_ACTION);
 if (!next) throw new Error("next page missing");
 page.renderer.onPanelAction({ kind: "command", id: next.id, data: next.data });
 await vi.waitFor(() => expect(requests.at(-1)).toEqual({ path: "dir", offset: 200 }));
 page.renderer.onPanelAction({ kind: "command", id: A.WORKSPACE_RELOAD_ACTION, data: JSON.stringify({ kind: "open", path: "/work/dir" }) });
 await vi.waitFor(() => expect(requests.filter(item => item.path === "dir" && item.offset === 200)).toHaveLength(2));
 page.renderer.onPanelAction({ kind: "control", id: A.WORKSPACE_OPEN_ACTION, data: undefined, value: "/docs" });
 await vi.waitFor(() => expect(page.renderer.view?.dock?.panel.files?.cwd).toBe("/docs"));
 expect(requests.at(-1)).toEqual({ path: "grant/docs", offset: 0 });
 page.renderer.onPanelAction({ kind: "command", id: A.WORKSPACE_READ_ACTION, data: "/docs/slow.txt" });
 await vi.waitFor(() => expect(reading).toBe(true));
 page.renderer.onPanelAction({ kind: "command", id: A.DOCK_TAB_ACTION, data: "conversations" });
 await vi.waitFor(() => expect(page.renderer.view?.dock?.panel.id).toBe("conversations"));
 finish(response({ path: "grant/docs/slow.txt", digest: "abc", content: "kept file", truncated: false }));
 await new Promise(resolve => setTimeout(resolve, 0));
 expect(page.renderer.view?.dock?.panel.id).toBe("conversations");
 page.renderer.onPanelAction({ kind: "command", id: A.DOCK_TAB_ACTION, data: "files" });
 await vi.waitFor(() => expect(page.renderer.view?.dock?.panel.files?.path).toBe("slow.txt"));
 expect(requests.at(-1)).toEqual({ path: "grant/docs", offset: 0 });
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

test("a package add retries its original profile operation and a late response cannot close a newer dialog", async () => {
 const saved: Array<import("../src/python-contracts.ts").PluginPackageAdd> = [];
 let finish: (response: Response) => void = () => { throw new Error("retry not started"); };
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 let packages: unknown[] = [];
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/plugin-packages") {
   if (options.method !== "POST") return response({ revision: packages.length, packages });
   saved.push(parseContract("PluginPackageAdd", JSON.parse(String(options.body))));
   if (saved.length === 1) return response({ code: "receipt_lost" }, 503);
   return new Promise<Response>(resolve => { finish = resolve; });
  }
  if (path === "/api/v1/plugins" || path.endsWith("/plugin-packages/load")) return response({ plugins: [] });
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "open", panel: "plugins" });
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel?.groups[0].id).toBe("plugins:packages"));
 page.renderer.onPanelAction({ kind: "command", id: P.PLUGIN_PACKAGE_ADD_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe(P.PLUGIN_PACKAGE_MODAL));
 page.renderer.onPanelAction({ kind: "modal-submit", id: P.PLUGIN_PACKAGE_MODAL, data: undefined, fields: { path: "/original/extension.py" } });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.notice?.text).toContain("receipt_lost"));
 page.renderer.onPanelAction({ kind: "modal-close" });
 page.renderer.onPanelAction({ kind: "command", id: P.PLUGIN_PACKAGE_ADD_ACTION, data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.fields[0].value).toBe("/original/extension.py"));
 page.renderer.onPanelAction({ kind: "modal-submit", id: P.PLUGIN_PACKAGE_MODAL, data: undefined, fields: { path: "/different.py" } });
 await vi.waitFor(() => expect(saved).toHaveLength(2));
 expect(saved[1]).toEqual(saved[0]);
 page.renderer.onPanelAction({ kind: "command", id: "skills:new", data: undefined });
 await vi.waitFor(() => expect(page.renderer.view?.panel.modal?.id).toBe("skills:create"));
 packages = [{ package_id: saved[0].package_id, entry: saved[0].entry, phase: "installed" }];
 finish(response({ revision: 1, packages }));
 await vi.waitFor(() => expect(sessionStorage.getItem("amazme:plugin-package:host")).toBeNull());
 expect(page.renderer.view?.panel.modal?.id).toBe("skills:create");
});

test("the MCP switch retries its original revision and intent before accepting a new opposite change", async () => {
 const calls: Array<import("../src/python-contracts.ts").McpConfigPatch> = [];
 const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
 let revision = 4, enabled = true;
 const configuration = () => ({ revision, workspace: "primary", path: "/profile/host.sqlite", servers: [{ config_id: "c".repeat(32), launch_id: "d".repeat(32), name: "local", detail: "python3 server.py", scope: "global", enabled, exposure: "direct" }] });
 const { page } = await startPage((path, options) => {
  if (path === "/api/v1/plugin-packages") return response({ revision: 0, packages: [] });
  if (path === "/api/v1/plugins") return response({ plugins: [] });
  if (path.endsWith("/mcp-configuration")) {
   if (options.method !== "PATCH") return response(configuration());
   const body = parseContract("McpConfigPatch", JSON.parse(String(options.body)));
   calls.push(body);
   enabled = body.enabled ?? true; revision = calls.length === 1 ? 5 : calls.length === 2 ? 5 : 6;
   return calls.length === 1 ? response({ code: "mcp_config_apply_pending" }, 503) : response(configuration());
  }
  return undefined;
 });
 page.renderer.onPanelAction({ kind: "open", panel: "plugins" });
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel?.groups[1].rows?.[0].title).toBe("local"));
 page.renderer.onPanelAction({ kind: "control", id: P.PLUGIN_MCP_ENABLED_ACTION, data: "local", value: "false" });
 await vi.waitFor(() => expect(calls).toHaveLength(1));
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel?.notices?.[0].text).toContain("mcp_config_apply_pending"));
 page.renderer.onPanelAction({ kind: "control", id: P.PLUGIN_MCP_ENABLED_ACTION, data: "local", value: "true" });
 await vi.waitFor(() => expect(calls).toHaveLength(2));
 expect(calls[1]).toEqual(calls[0]);
 expect(calls[0]).toMatchObject({ enabled: false, expected_revision: 4, name: "local", scope: "global" });
 await vi.waitFor(() => expect(page.renderer.view?.panel.panel?.groups[1].rows?.[0].controls?.[0].value).toBe("false"));
 page.renderer.onPanelAction({ kind: "control", id: P.PLUGIN_MCP_ENABLED_ACTION, data: "local", value: "true" });
 await vi.waitFor(() => expect(calls).toHaveLength(3));
 expect(calls[2]).toMatchObject({ enabled: true, expected_revision: 5 });
 expect(calls[2].operation_id).not.toBe(calls[0].operation_id);
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
