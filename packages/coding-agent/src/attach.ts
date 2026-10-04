import { createInterface } from "node:readline";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { LaneControl, renderControl } from "./control.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "./host.ts";

/** Connect to `amazme serve` and drive lane `main`. The host keeps running when this process exits. */
export async function runAttachedControl(socket: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  let rendered = "";
  const control = new LaneControl(remote.lane(HOST_LANE), (view) => {
    const text = `${renderControl(view)}\n`;
    if (text === rendered) return;
    rendered = text;
    output.write(text);
  });
  await control.open();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let stdinClosed = false;
  const closed = new Promise<void>((resolve) => lines.on("close", () => {
    stdinClosed = true;
    resolve();
  }));
  const queue: string[] = [];
  let pumping = false;
  lines.on("line", (line) => {
    queue.push(line);
    if (!pumping) void pump();
  });
  const pump = async () => {
    pumping = true;
    try {
      while (queue.length > 0) {
        const line = queue.shift() ?? "";
        try {
          await command(control, line);
        } catch (error) {
          output.write(`failure: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    } finally {
      pumping = false;
      if (queue.length > 0) void pump();
    }
  };
  await closed;
  while (pumping || queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  if (stdinClosed) {
    await control.close();
    await client.dispose();
  }
}

async function command(control: LaneControl, line: string): Promise<void> {
  if (line === "/abort") {
    await control.abort();
    return;
  }
  if (line === "/continue") {
    await control.continueRetry();
    return;
  }
  if (line === "/earlier") {
    await control.loadEarlier();
    return;
  }
  if (line.startsWith("/steer ")) {
    await control.steer(line.slice("/steer ".length));
    return;
  }
  await control.submit(line);
}
