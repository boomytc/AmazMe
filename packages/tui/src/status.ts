import type { ActivityDto } from "@amazme/runtime-service";

/**
 * 底栏上多出来的片段。数字来自快照里的 `activity`，这里不读 git，也不估算 token 或费用。
 * `hitRate` 是 `usage()` 给出的比值（缓存读 / 整段提示）。写成百分数只是显示。
 * `now` 由画面在绘制时传入。没有它就不显示耗时和倒计时，渲染本身不读时钟。
 */
export function footerParts(
  activity: ActivityDto | undefined,
  compaction: "off" | "active" | "done",
  now?: number,
): string[] {
  if (!activity) return compaction === "done" ? ["压缩完成"] : [];
  const parts: string[] = [];
  if (activity.branch) parts.push(activity.branch);
  const session = elapsed(activity.sessionStartedAt, now);
  if (session) parts.push(`会话 ${session}`);
  const turn = elapsed(activity.turnStartedAt, now);
  if (turn) parts.push(`本轮 ${turn}`);
  const retry = retryPart(activity, now);
  if (retry) parts.push(retry);
  if (activity.compacting) parts.push("压缩中");
  else if (compaction === "done") parts.push("压缩完成");
  const lastHit = hitPart("本轮命中", activity.usage.lastTurn?.hitRate);
  if (lastHit) parts.push(lastHit);
  const totalHit = hitPart("累计命中", activity.usage.total.hitRate);
  if (totalHit) parts.push(totalHit);
  const lastCost = money(activity.usage.lastTurn?.cost?.total);
  if (lastCost) parts.push(`本轮 ${lastCost}`);
  const totalCost = money(activity.usage.total.cost?.total);
  if (totalCost) parts.push(`累计 ${totalCost}`);
  return parts;
}

/** 压缩从进行中回到停止。下一次本轮开始时间变化后清掉。 */
export function nextCompaction(
  previous: "off" | "active" | "done",
  before: ActivityDto | undefined,
  after: ActivityDto | undefined,
): "off" | "active" | "done" {
  if (after?.compacting) return "active";
  if (before?.compacting) return "done";
  const turnMoved = after?.turnStartedAt != null && after.turnStartedAt !== before?.turnStartedAt;
  if (turnMoved) return "off";
  return previous;
}

function retryPart(activity: ActivityDto, now: number | undefined): string | null {
  if (activity.retryReason == null) return null;
  if (typeof now !== "number" || activity.notBefore == null || !Number.isFinite(now) || !Number.isFinite(activity.notBefore)) {
    return `重试 ${activity.retryReason}`;
  }
  const seconds = Math.max(0, Math.ceil((activity.notBefore - now) / 1000));
  return `重试 ${activity.retryReason} ${seconds}s`;
}

function elapsed(start: number | null, now: number | undefined): string | null {
  if (start == null || typeof now !== "number" || !Number.isFinite(start) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${minutes}:${pad(rest)}`;
}

function hitPart(label: string, rate: number | null | undefined): string | null {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  const percent = rate * 100;
  const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "");
  return `${label} ${text}%`;
}

function money(total: number | null | undefined): string | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const text = total.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}
