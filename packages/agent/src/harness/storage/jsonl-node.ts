import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { Write } from "../storage.ts";
import { applyWrites, MemoryStorage } from "./memory.ts";

/** Node filesystem adapter. Each newline-terminated record is one atomic apply. */
export class JsonlStorage extends MemoryStorage {
  private readonly file: string;

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const text = repairTornTail(file, readFileSync(file, "utf8"));
      for (const line of text.split("\n").filter((line) => line.trim().length > 0)) {
        const record = JSON.parse(line) as { writes: Write[] };
        this.state = applyWrites(this.state, record.writes);
      }
    }
  }

  protected override persist(writes: readonly Write[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ writes })}\n`);
  }
}

/** Cut a torn tail off the file before the next append. */
function repairTornTail(file: string, text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const cut = text.lastIndexOf("\n");
  const kept = cut === -1 ? "" : text.slice(0, cut + 1);
  truncateSync(file, Buffer.byteLength(kept));
  return kept;
}
