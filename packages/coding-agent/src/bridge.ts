import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { LaneControl } from "./control.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "./host.ts";

export interface BridgeOptions {
  socket: string;
  port?: number;
}

export interface CodingBridge {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A loopback page in front of one Unix host. It attaches `workspace` / `main` and does not own the runtime.
 * The listener accepts only 127.0.0.1.
 */
export async function startCodingBridge(options: BridgeOptions): Promise<CodingBridge> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: options.socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  const listeners = new Set<ServerResponse>();
  let latest = "";
  const control = new LaneControl(remote.lane(HOST_LANE), (view) => {
    latest = JSON.stringify(view);
    const frame = `data: ${latest}\n\n`;
    for (const response of listeners) response.write(frame);
  });
  await control.open();
  latest = JSON.stringify(control.view());
  const server = createServer((request, response) => {
    void handle(request, response, control, () => latest, listeners).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) return;
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the bridge did not bind a port");
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    async close() {
      for (const response of listeners) response.end();
      listeners.clear();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await control.close();
      await client.dispose();
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  control: LaneControl,
  latest: () => string,
  listeners: Set<ServerResponse>,
): Promise<void> {
  const host = request.headers.host ?? "";
  const port = host.split(":").at(-1);
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("the bridge accepts only loopback");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (request.method === "GET" && url.pathname === "/view") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(latest());
    return;
  }
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${latest()}\n\n`);
    listeners.add(response);
    response.on("close", () => listeners.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/act") {
    const body = JSON.parse(await readBody(request)) as { action?: string; text?: string };
    const text = typeof body.text === "string" ? body.text : "";
    if (body.action === "submit") await control.submit(text);
    else if (body.action === "steer") await control.steer(text);
    else if (body.action === "abort") await control.abort();
    else if (body.action === "continue") await control.continueRetry();
    else if (body.action === "earlier") await control.loadEarlier();
    else throw new Error("unknown action");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(latest());
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("the action body exceeds 64 KiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>AmazMe</title>
<style>
  body { font: 14px/1.45 ui-monospace, monospace; margin: 24px; color: #172026; background: #f4f7f8; }
  pre { white-space: pre-wrap; background: white; padding: 16px; border: 1px solid #d5dee3; min-height: 240px; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  input { flex: 1; font: inherit; padding: 8px; }
  button { font: inherit; padding: 8px 12px; }
</style>
<pre id="view"></pre>
<form id="form">
  <input id="text" autocomplete="off" placeholder="prompt, or a follow-up while a turn is open">
  <button type="submit">Send</button>
  <button type="button" id="steer">Steer</button>
  <button type="button" id="abort">Abort</button>
  <button type="button" id="continue">Continue</button>
  <button type="button" id="earlier">Earlier</button>
</form>
<script>
  const view = document.querySelector("#view");
  const text = document.querySelector("#text");
  const paint = (raw) => { view.textContent = raw; };
  const source = new EventSource("/events");
  source.onmessage = (event) => paint(event.data);
  const act = (action) => fetch("/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, text: text.value }),
  }).then((response) => response.json()).then((value) => { paint(JSON.stringify(value)); if (action === "submit" || action === "steer") text.value = ""; });
  document.querySelector("#form").addEventListener("submit", (event) => { event.preventDefault(); act("submit"); });
  document.querySelector("#steer").addEventListener("click", () => act("steer"));
  document.querySelector("#abort").addEventListener("click", () => act("abort"));
  document.querySelector("#continue").addEventListener("click", () => act("continue"));
  document.querySelector("#earlier").addEventListener("click", () => act("earlier"));
</script>
`;

