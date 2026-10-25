/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopPage } from "../src/python-page.ts";
import type { Submit } from "../src/python-contracts.ts";
import { parseContract } from "../src/python-api.ts";

let page: DesktopPage | undefined;
afterEach(() => { page?.dispose(); page = undefined; sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("a submission captures the displayed model, retries the same request, and preserves a newer draft", async () => {
 const html = readFileSync(resolve("src/page/index.html"), "utf8");
 document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
 const submitted: Submit[] = [];
 let selected = "shown";
 class Socket { close() {} send() {} }
 vi.stubGlobal("WebSocket", Socket);
 vi.stubGlobal("fetch", vi.fn(async (input: URL, options: RequestInit = {}) => {
  const path = new URL(input).pathname, method = options.method ?? "GET";
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (path.endsWith("/bootstrap")) return response({ build_id: "build", profile_id: "host", instance_id: "instance", pid: 1, host_epoch: 1, role: "host", protocol: "amazme-http/1" });
  if (path === "/api/v1/sessions") return response({ sessions: [{ session_id: "a", title: "A", workspace: "primary" }] });
  if (path === "/api/v1/workspaces") return response({ workspaces: [{ name: "primary", host_path: "/work", primary: true }] });
  if (path === "/api/v1/models") return response({ models: [{ provider: "faux", model: "shown", label: "Shown", endpoint_editable: true }, { provider: "faux", model: "different", label: "Different", endpoint_editable: true }], current: { provider: "faux", model: "shown", base_url: "http://model", max_tokens: 10, key_configured: true } });
  if (path === "/api/v1/accounts") return response({ revision: 0, accounts: [] });
  if (path === "/api/v1/settings") return response({ revision: 0 });
  if (path === "/api/v1/projects") return response({ projects: [] });
  if (path.endsWith("/attachments")) return response({ attachment_id: "attachment", session_id: "a", host_epoch: 1, build_id: "build" });
  if (path === "/api/v1/session-models/a") {
   if (method === "PUT") selected = "different";
   return selected === "shown" ? response({ code: "session_model_missing" }, 404) : response({ session_id: "a", provider: "faux", model: selected });
  }
  if (path.endsWith("/resources")) return response({ context_files: [], skills: [], prompts: [], diagnostics: [] });
  if (path.endsWith("/usage")) return response({ session_id: "a" });
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
 connection.snapshot = { session_id: "a", stream_id: "stream", seq: "0", state: "ready", requests: [], events: [] };
 page.client.onChange();
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
