/** Bytes for one frame. A later frame rewrites changed rows and does not erase the display. */
export function terminalDiff(previous: string | null, next: string): string {
  if (previous === null) return `\x1b[H\x1b[J${next}`;
  const before = previous.split("\n");
  const after = next.split("\n");
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before[start] === after[start]) start += 1;
  const parts: string[] = [];
  const last = Math.max(before.length, after.length);
  for (let row = start; row < last; row += 1) {
    parts.push(`\x1b[${row + 1};1H\x1b[2K${after[row] ?? ""}`);
  }
  return parts.join("");
}

/** The fullscreen writer. Returns the frame that the next update should diff against. */
export function writeScreen(write: (chunk: string) => void, previous: string | null, next: string): string {
  const chunk = terminalDiff(previous, next);
  if (chunk.length > 0) write(chunk);
  return next;
}
