export interface GuiEntry {
  role: string;
  text: string;
  title?: string;
}

export interface GuiView {
  entries: GuiEntry[];
  pendingText: string;
  tools: Array<{ name: string; status: string }>;
  directory: string;
  active: string;
  provider: string;
  modelId: string;
  thinking: string;
  busy: boolean;
}

/** The document the window shows. A blank transcript is an empty main, not a missing status line. */
export function renderGuiDocument(view: GuiView): string {
  const status = [view.directory, view.active, view.provider && view.modelId ? `${view.provider}/${view.modelId}` : "", view.thinking, view.busy ? "忙" : "空闲"]
    .filter((part) => part.length > 0)
    .join("  ");
  const blocks = view.entries.map((entry) => {
    const title = entry.role === "user" ? "你" : entry.title || (entry.role === "toolResult" || entry.role === "tool" ? "tool" : "AmazMe");
    return `<article class="${escapeAttr(entry.role)}"><header>${escapeText(title)}</header><p>${escapeText(entry.text)}</p></article>`;
  });
  if (view.pendingText) blocks.push(`<article class="assistant"><header>AmazMe</header><p>${escapeText(view.pendingText)}</p></article>`);
  for (const tool of view.tools) {
    blocks.push(`<article class="tool"><header>${escapeText(tool.name)}</header><p class="status">${escapeText(tool.status)}</p></article>`);
  }
  return `<!DOCTYPE html><meta charset="utf-8"><title>AmazMe</title><p id="status">${escapeText(status)}</p><main>${blocks.join("")}</main>`;
}

export function statusText(view: GuiView): string {
  return [view.directory, view.active, view.provider && view.modelId ? `${view.provider}/${view.modelId}` : "", view.thinking, view.busy ? "忙" : "空闲"]
    .filter((part) => part.length > 0)
    .join("  ");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll("\"", "&quot;");
}
