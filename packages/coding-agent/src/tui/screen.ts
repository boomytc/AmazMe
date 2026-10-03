import { StringDecoder } from "node:string_decoder";
import type { ReadStream, WriteStream } from "node:tty";
import { FullscreenController, type FullscreenSession } from "./controller.ts";
import { paintAnsi, renderFrame } from "./frame.ts";
import { KeyDecoder } from "./keys.ts";

export async function presentFullscreen(
  session: FullscreenSession,
  stdin: ReadStream = process.stdin,
  stdout: WriteStream = process.stdout,
): Promise<void> {
  if (typeof stdin.setRawMode !== "function" || stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let controller!: FullscreenController;
  const paint = (): void => {
    const columns = stdout.columns > 0 ? stdout.columns : 80;
    const rows = stdout.rows > 0 ? stdout.rows : 24;
    stdout.write(paintAnsi(renderFrame(controller.snapshot(), columns, rows).body));
  };
  controller = new FullscreenController(session, paint);
  const keys = new KeyDecoder();
  const utf8 = new StringDecoder("utf8");
  let restored = false;
  let onData: (chunk: Buffer | string) => void = () => {};

  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdin.off("data", onData);
    stdin.off("end", restore);
    stdout.off("resize", paint);
    if (stdin.isRaw) stdin.setRawMode(false);
    stdout.write("\x1b[?1049l\x1b[0m\x1b[?25h");
    stdin.pause();
    resolveExit();
  };

  onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk);
    for (const key of keys.push(text)) controller.handleInput(key);
    if (controller.wantsExit) {
      restore();
      return;
    }
    paint();
  };

  stdin.setRawMode(true);
  try {
    stdin.resume();
    stdout.write("\x1b[?1049h\x1b[?25h");
    paint();
    stdin.on("data", onData);
    stdin.on("end", restore);
    stdout.on("resize", paint);
    await exited;
  } finally {
    restore();
  }
}
