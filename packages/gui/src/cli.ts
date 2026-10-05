import { createInterface } from "node:readline";
import { statusText } from "./document.ts";
import { runGuiSession } from "./session.ts";
import { tryOpenWindow } from "./window.ts";

export interface GuiCommandOptions {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
  prompt: string;
}

/** Graphical client. It prints each document the window would show, then leaves the host running. */
export async function runGuiCommand(argv: string[]): Promise<void> {
  const options = parseGuiArgs(argv);
  let lastDocument = "";
  const session = await runGuiSession({
    socket: options.socket,
    serverId: options.serverId,
    runtimeId: options.runtimeId,
    lane: options.lane,
    onView(view, document) {
      lastDocument = document;
      process.stdout.write(`${JSON.stringify({ document, status: statusText(view) })}\n`);
    },
  });
  try {
    if (options.prompt) await session.submit(options.prompt);
    const windowError = await tryOpenWindow(lastDocument);
    if (windowError) process.stderr.write(`GUI_WINDOW: ${windowError}\n`);
    if (process.stdin.isTTY) {
      await new Promise<void>(() => undefined);
    } else {
      await new Promise<void>((resolve) => {
        const lines = createInterface({ input: process.stdin });
        lines.on("close", () => resolve());
      });
    }
  } finally {
    void lastDocument;
    await session.close();
  }
}

function parseGuiArgs(argv: string[]): GuiCommandOptions {
  const options: GuiCommandOptions = { socket: "", serverId: "amazme", runtimeId: "workspace", lane: "main", prompt: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--socket") options.socket = argv[++index] ?? "";
    else if (token === "--server") options.serverId = argv[++index] ?? options.serverId;
    else if (token === "--runtime") options.runtimeId = argv[++index] ?? options.runtimeId;
    else if (token === "--lane") options.lane = argv[++index] ?? options.lane;
    else if (token === "--prompt") options.prompt = argv[++index] ?? "";
    else if (token) throw new Error(`unknown argument ${token}`);
  }
  if (!options.socket) throw new Error("gui requires --socket");
  return options;
}
