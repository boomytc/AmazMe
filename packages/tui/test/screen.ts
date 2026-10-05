import { parseLaneSnapshot } from "@amazme/runtime-service";
import { decodeKeys, emptyTui, reduceTui, renderTui, windowFrom, type TuiEffect } from "@amazme/tui";

/** 画面夹具共用的终端宽度。换行和截断按这个宽度。 */
export const SCREEN_COLUMNS = 60;
/** 画面夹具共用的终端高度。 */
export const SCREEN_ROWS = 16;

export interface KeyStep {
  type: "keys";
  input: string;
}

export interface SnapshotStep {
  type: "snapshot";
  snapshot: unknown;
}

export type ScreenStep = KeyStep | SnapshotStep;

export interface ScreenScript {
  steps: ScreenStep[];
}

export interface PlayedScreen {
  screen: string;
  effects: TuiEffect[];
}

const SGR = /\u001b\[[0-9;]*m/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStep(value: unknown): value is ScreenStep {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  if (value.type === "keys") return typeof value.input === "string";
  if (value.type === "snapshot") return "snapshot" in value;
  return false;
}

function isSteps(value: unknown): value is ScreenStep[] {
  if (!Array.isArray(value)) return false;
  for (const step of value) {
    if (!isStep(step)) return false;
  }
  return true;
}

export function parseScreenScript(value: unknown): ScreenScript {
  if (!isRecord(value) || !isSteps(value.steps)) throw new Error("invalid screen script");
  return { steps: value.steps };
}

/** 去掉颜色码后的可见字符。画面里如果还有别的转义，直接失败。 */
export function plainScreen(frame: string): string {
  const plain = frame.replace(SGR, "");
  if (plain.includes("\u001b")) throw new Error("画面里有不是颜色的转义");
  return plain;
}

/**
 * 按脚本喂按键和 lane 快照，渲染固定尺寸的纯文本画面。
 * 按键走 decodeKeys 和 reducer，快照先按协议解析，再经 windowFrom 进入同一个 reducer。
 * 不连接宿主，不打开终端，不读时钟或随机数。
 */
export function playScreen(script: ScreenScript): PlayedScreen {
  let state = emptyTui();
  const effects: TuiEffect[] = [];
  for (const step of script.steps) {
    if (step.type === "keys") {
      const decoded = decodeKeys(step.input);
      if (decoded.rest.length > 0) throw new Error("按键序列被截断");
      for (const key of decoded.keys) {
        const reduced = reduceTui(state, { type: "key", key });
        state = reduced.state;
        if (reduced.effect) effects.push(reduced.effect);
      }
      continue;
    }
    const snapshot = parseLaneSnapshot(step.snapshot);
    state = reduceTui(state, {
      type: "window",
      window: windowFrom(snapshot, [snapshot.lane], snapshot.lane),
    }).state;
  }
  return { screen: plainScreen(renderTui(state, SCREEN_COLUMNS, SCREEN_ROWS)), effects };
}
