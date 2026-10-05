import { createInterface } from "node:readline";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { RuntimeClient } from "@amazme/runtime-service/client";
import { executeSlash, parseSlash, type SlashActions } from "@amazme/tui";
import { LaneControl, renderControl } from "./control.ts";
import { HOST_LANE, HOST_RUNTIME_ID, HOST_SERVER_ID } from "./host.ts";
import { formatHandback, loginProvider, logoutProvider } from "./login.ts";

/** Connect to `amazme serve` and drive lane `main`. The host keeps running when this process exits. */
export async function runAttachedControl(socket: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const client = new Client({ serverId: HOST_SERVER_ID, transport: createUnixTransport({ path: socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(HOST_RUNTIME_ID);
  let rendered = "";
  let active = HOST_LANE;
  const render = (view: ReturnType<LaneControl["view"]>): void => {
    const text = `${renderControl(view)}\n`;
    if (text === rendered) return;
    rendered = text;
    output.write(text);
  };
  let control = new LaneControl(remote.lane(active), render);
  await control.open();
  const actions: SlashActions = {
    lane: () => remote.lane(active),
    active: () => active,
    list: async () => {
      const names = await remote.conversations();
      return names.includes(active) ? names : [...names, active];
    },
    open: async (name) => {
      await control.close();
      active = name;
      rendered = "";
      control = new LaneControl(remote.lane(active), render);
      await control.open();
    },
    earlier: async () => {
      const page = await control.loadEarlier();
      return page.entries.length === 0 ? "没有更早的条目" : `更早 ${page.entries.length} 条`;
    },
    continueRetry: async () => {
      if (!control.view().retry) return "没有等待中的重试";
      await control.continueRetry();
      return "已继续";
    },
    login: (provider) => loginProvider(provider, {
      onHandback(value) { output.write(`${formatHandback(value)}\n`); },
    }).then((report) => report.message),
    logout: (provider) => logoutProvider(provider),
  };
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
          await command(control, line, actions, output);
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

async function command(control: LaneControl, line: string, actions: SlashActions, output: NodeJS.WritableStream): Promise<void> {
  const parsed = parseSlash(line);
  if (parsed.type === "prompt") {
    if (parsed.text) await control.submit(parsed.text);
    return;
  }
  if (parsed.type === "notice") {
    output.write(`${parsed.text}\n`);
    return;
  }
  if (parsed.type === "copy") {
    output.write("复制只在全屏客户端里可用\n");
    return;
  }
  const outcome = await executeSlash(parsed, actions);
  if (outcome.type === "quit") {
    output.write("结束输入即可离开附着端，宿主继续运行\n");
    return;
  }
  if (outcome.type === "notice") output.write(`${outcome.text}\n`);
}
