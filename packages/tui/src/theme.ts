/** ANSI colors for a dark terminal. The terminal keeps its own background. */
export const theme = {
  reset: "\x1b[0m",
  dim: "\x1b[38;5;245m",
  code: "\x1b[38;5;109m",
  text: "\x1b[38;5;252m",
  accent: "\x1b[38;5;147m",
  green: "\x1b[38;5;78m",
  border: "\x1b[38;5;110m",
  warm: "\x1b[38;5;180m",
} as const;

export function paint(color: string, text: string): string {
  if (text.length === 0) return text;
  return `${color}${text}${theme.reset}`;
}
