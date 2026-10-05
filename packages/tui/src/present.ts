import type { ReadStream, WriteStream } from "node:tty";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@amazme/client";
import { createUnixTransport } from "@amazme/client/unix";
import { emptyActivity, type EntryDto, type LaneSnapshotDto } from "@amazme/runtime-service";
import { RuntimeClient, type RemoteLane } from "@amazme/runtime-service/client";
import { executeSlash, finishDrive, type SlashActions } from "./commands.ts";
import { chatModelSpecs, cycleModels, scopedModels } from "./project.ts";
import { KeyDecoder, type Key } from "./keys.ts";
import { writeScreen } from "./diff.ts";
import type { UserContent } from "@amazme/ai";
import { imagePrompt } from "./images.ts";
import { emptyTui, EXIT_HINT, EXIT_WINDOW_MS, inputCursorSequence, reduceTui, renderTui, summarizeArgs, type Picker, type PickerRow, type TuiApproval, type TuiEffect, type TuiEntry, type TuiState, type TuiWindow } from "./reduce.ts";

export { finishDrive } from "./commands.ts";

/** Rows for bare `/tree`. Assistant text comes from content arrays, not only string content. */
export function treePickerRows(entries: readonly EntryDto[]): PickerRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: treeLabel(entry),
    detail: "",
    tone: "muted" as const,
  }));
}

/** Rows for bare `/model`. The list is the login `scopedModels`, not the host catalog. */
export function modelPicker(specs: readonly string[], current: { provider: string; modelId: string }): Picker {
  return {
    title: "Select model:",
    hint: "↑↓ navigate    enter select    escape cancel",
    query: "",
    index: 0,
    kind: "model",
    rows: chatModelSpecs(specs).map((spec) => {
      const slash = spec.indexOf("/");
      const provider = spec.slice(0, slash);
      const modelId = spec.slice(slash + 1);
      const selected = provider === current.provider && modelId === current.modelId;
      return {
        id: `${provider}\t${modelId}`,
        label: spec,
        detail: selected ? "current" : "",
        tone: selected ? "ok" as const : "muted" as const,
      };
    }),
  };
}

function treeLabel(entry: EntryDto): string {
  if (entry.payload.type === "compaction") return `summary ${entry.payload.summary}`.trim();
  const message = entry.payload.message as { role: string; content?: unknown; toolName?: string };
  return `${message.role} ${messageText(message)}`.trim();
}

export interface ProviderChoice {
  id: string;
  name: string;
  stored: boolean;
  /** Which saved credential is present, when `stored` is true. */
  storedType: "oauth" | "api_key" | null;
  oauth: boolean;
  apiKey: boolean;
}

export interface HostAccount {
  login(provider: string, handback: (text: string) => void, currentModel?: string): Promise<string>;
  logout(provider: string): Promise<string>;
  catalog?(): Promise<ProviderChoice[]>;
  saveApiKey?(providerId: string, key: string, currentModel?: string): Promise<string>;
}

export interface HostAttach {
  socket: string;
  serverId: string;
  runtimeId: string;
  lane: string;
  cwd?: string;
}

/** Extra clients on the host the fullscreen process already owns. */
export interface HostSurfaces {
  openWeb?(): Promise<string>;
  openGui?(): Promise<string>;
  /**
   * Called when the composer input contains an image.
   * Return a user-facing refusal to skip the turn. Undefined lets the turn through.
   */
  refuseImages?(provider: string, modelId: string, content: readonly { type: string }[]): string | undefined;
}

/** Read one rendered frame. The host keeps the runtime. */
export async function readHostFrame(attach: HostAttach, lane = attach.lane): Promise<string> {
  const client = new Client({ serverId: attach.serverId, transport: createUnixTransport({ path: attach.socket }) });
  await client.connect();
  try {
    const remote = new RuntimeClient(client);
    await remote.attach(attach.runtimeId);
    const remoteLane = remote.lane(lane);
    const snapshot = await remoteLane.snapshot();
    const pending = await remoteLane.pendingApprovals();
    return renderTui({
      ...emptyTui(lane),
      ...windowFrom(snapshot, [lane], lane, [], approvalCards(pending.items)),
    }, 100, 32, Date.now());
  } finally {
    await client.dispose();
  }
}

/** Raw-mode screen. Ctrl+D on an empty idle prompt leaves. */
export async function presentHost(
  attach: HostAttach,
  stdin: ReadStream = process.stdin,
  stdout: WriteStream = process.stdout,
  account?: HostAccount,
  surfaces?: HostSurfaces,
): Promise<void> {
  if (typeof stdin.setRawMode !== "function" || stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("fullscreen requires a terminal");
  }
  const client = new Client({ serverId: attach.serverId, transport: createUnixTransport({ path: attach.socket }) });
  await client.connect();
  const remote = new RuntimeClient(client);
  await remote.attach(attach.runtimeId);
  const sessions = [attach.lane];
  let active = attach.lane;
  let state = emptyTui(active);
  let thinkingRows: string[] = [];
  let paint = (): void => undefined;
  let previousFrame: string | null = null;
  const frame = (): TuiWindow => windowFrom(lane.snapshot(), sessions, active, lane.earlier(), lane.approvals());
  let lane = new AttachedLane(remote.lane(active), () => {
    state = reduceTui(state, { type: "window", window: frame() }).state;
    paint();
  });
  await lane.open();
  state = reduceTui(state, { type: "window", window: frame() }).state;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25h\x1b[?2004h");
  let takeKeys: (incoming: Key[]) => void = () => undefined;
  const keys = new KeyDecoder((delayed) => takeKeys(delayed));
  const utf8 = new StringDecoder("utf8");
  let restored = false;
  let finish = (): void => undefined;
  const rememberSettings = async (): Promise<void> => {
    try {
      const settings = await remote.lane(active).configure();
      const listed = await remote.lane(active).catalog();
      state = {
        ...state,
        provider: settings.provider,
        modelId: settings.modelId,
        thinking: settings.thinkingLevel,
        directory: listed.directory,
      };
      thinkingRows = listed.thinkingLevels;
    } catch {
      // The footer keeps the last settings this lane could report.
    }
  };
  paint = () => {
    const columns = stdout.columns > 0 ? stdout.columns : 80;
    const rows = stdout.rows > 0 ? stdout.rows : 24;
    const next = renderTui(state, columns, rows, Date.now());
    previousFrame = writeScreen((chunk) => stdout.write(chunk), previousFrame, next);
    const cursor = inputCursorSequence(next);
    if (cursor.length > 0) stdout.write(cursor);
  };
  stdout.on("resize", paint);
  await rememberSettings();
  const currentModel = (): string | undefined =>
    state.provider && state.modelId ? `${state.provider}/${state.modelId}` : undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleExitArm = (): void => {
    if (exitTimer) clearTimeout(exitTimer);
    if (!state.exitArmed) return;
    exitTimer = setTimeout(() => {
      if (!state.exitArmed) return;
      state = { ...state, exitArmed: false, notice: state.notice === EXIT_HINT ? null : state.notice };
      paint();
    }, EXIT_WINDOW_MS);
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (exitTimer) clearTimeout(exitTimer);
    keys.stop();
    stdin.off("data", onData);
    stdout.off("resize", paint);
    if (stdin.isRaw) stdin.setRawMode(false);
    stdout.write("\x1b[?2004l\x1b[?1049l");
    stdin.pause();
    finish();
  };
  takeKeys = (incoming) => {
    if (restored) return;
    for (const key of incoming) {
      const reduced = reduceTui(state, { type: "key", key });
      state = reduced.state;
      scheduleExitArm();
      paint();
      if (reduced.effect?.type === "quit") {
        restore();
        return;
      }
      if (reduced.effect) {
        void apply(reduced.effect).catch((error: unknown) => {
          state = {
            ...state,
            deciding: false,
            decidingId: null,
            notice: error instanceof Error ? error.message : String(error),
          };
          paint();
        });
      }
    }
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk);
    takeKeys(keys.push(text));
  };
  const showLane = (): void => {
    state = reduceTui(state, { type: "window", window: frame() }).state;
    paint();
  };
  const actions: SlashActions = {
    lane: () => remote.lane(active),
    active: () => active,
    list: async () => {
      for (const name of await remote.conversations()) {
        if (!sessions.includes(name)) sessions.push(name);
      }
      return sessions;
    },
    open: async (name) => {
      if (!sessions.includes(name)) sessions.push(name);
      await lane.close();
      active = name;
      lane = new AttachedLane(remote.lane(active), showLane);
      await lane.open();
      await rememberSettings();
      showLane();
    },
    earlier: () => lane.loadEarlier(),
    continueRetry: async () => {
      const snap = await remote.lane(active).snapshot();
      if (snap.phase !== "retry_wait" || !snap.operationId) return "没有等待中的重试";
      await finishDrive(remote.lane(active), snap.operationId);
      return "已继续";
    },
    ...(attach.cwd ? { cwd: attach.cwd } : {}),
    ...(surfaces?.openWeb ? { openWeb: () => surfaces.openWeb!() } : {}),
    ...(surfaces?.openGui ? { openGui: () => surfaces.openGui!() } : {}),
    ...(account
      ? {
          login: async (provider: string) => {
            stdin.setRawMode(false);
            try {
              return await account.login(provider, (text) => {
                state = { ...state, notice: text };
                paint();
              }, currentModel());
            } finally {
              if (!restored && stdin.isRaw !== true) stdin.setRawMode(true);
            }
          },
          logout: (provider: string) => account.logout(provider),
        }
      : {}),
  };
  const openAccountPicker = async (mode: "login" | "logout"): Promise<void> => {
    if (!account?.catalog) {
      state = { ...state, notice: mode === "login" ? "当前客户端不能登录" : "当前客户端不能退出登录" };
      paint();
      return;
    }
    choices = await account.catalog();
    if (mode === "logout") {
      showPicker({
        title: "Select provider to logout:",
        hint: "↑↓ navigate    enter select    escape cancel",
        query: "",
        index: 0,
        rows: choiceRows("logout"),
        kind: "logout-provider",
      });
      return;
    }
    showPicker({
      title: "Select authentication method:",
      hint: "↑↓ navigate    enter select    escape cancel",
      query: "",
      index: 0,
      rows: [
        { id: "oauth", label: "Sign in with an account", detail: "", tone: "muted" },
        { id: "api_key", label: "Sign in with an API key", detail: "", tone: "muted" },
      ],
      kind: "login-entry",
    });
  };
  const applyPick = async (effect: Extract<TuiEffect, { type: "pick" }>): Promise<void> => {
    if (effect.kind === "model") {
      const split = effect.id.indexOf("\t");
      const provider = split >= 0 ? effect.id.slice(0, split) : "";
      const modelId = split >= 0 ? effect.id.slice(split + 1) : "";
      if (!provider || !modelId) return;
      await remote.lane(active).configure({ provider, modelId });
      await rememberSettings();
      state = { ...state, notice: `模型 ${provider}/${modelId}`, picker: null };
      paint();
      return;
    }
    if (effect.kind === "thinking") {
      if (effect.id !== "off" && effect.id !== "minimal" && effect.id !== "low" && effect.id !== "medium" && effect.id !== "high") return;
      await remote.lane(active).configure({ thinkingLevel: effect.id });
      await rememberSettings();
      state = { ...state, notice: `思考 ${effect.id}`, picker: null };
      paint();
      return;
    }
    if (effect.kind === "resume") {
      await actions.open(effect.id);
      state = { ...state, notice: `会话 ${effect.id}`, picker: null };
      paint();
      return;
    }
    if (effect.kind === "tree") {
      const admitted = await remote.lane(active).accept({ kind: "navigation", targetId: effect.id });
      await finishDrive(remote.lane(active), admitted.operationId);
      state = { ...state, notice: "已切换分支", picker: null };
      paint();
      return;
    }
    if (effect.kind === "logout-provider") {
      const message = account ? await account.logout(effect.id) : "当前客户端不能退出登录";
      state = { ...state, notice: message, picker: null };
      paint();
      return;
    }
    if (effect.kind === "api-key") {
      const message = account?.saveApiKey && effect.secret
        ? await account.saveApiKey(effect.id, effect.secret, currentModel())
        : "当前客户端不能保存 API key";
      state = { ...state, notice: message, picker: null };
      paint();
      return;
    }
    if (effect.kind === "login-entry") {
      const method = effect.id === "api_key" ? "api_key" : "oauth";
      const rows = providerRows(method);
      if (rows.length === 0) {
        state = { ...state, notice: method === "oauth" ? "没有可登录的账号供应商" : "没有可配置 API key 的供应商", picker: null };
        paint();
        return;
      }
      showPicker({
        title: method === "oauth" ? "Select provider to sign in:" : "Select provider for an API key:",
        hint: "↑↓ navigate    enter select    escape cancel",
        query: "",
        index: 0,
        rows,
        kind: "login-provider",
        subject: method,
      });
      return;
    }
    if (effect.kind === "login-provider") {
      const chosen = choices.find((item) => item.id === effect.id);
      if (!chosen) return;
      const method = effect.subject === "oauth" || effect.subject === "api_key" ? effect.subject : undefined;
      await continueProviderLogin(chosen, method);
      return;
    }
    if (effect.kind === "login-method") {
      const providerId = effect.subject ?? effect.id;
      if (effect.id === "api_key") {
        const name = choices.find((item) => item.id === providerId)?.name ?? providerId;
        showPicker({
          title: `API key for ${name}:`,
          hint: "enter save    escape cancel",
          query: "",
          index: 0,
          rows: [],
          kind: "api-key",
          subject: providerId,
          secret: true,
        });
        return;
      }
      if (!actions.login) {
        state = { ...state, notice: "当前客户端不能登录", picker: null };
        paint();
        return;
      }
      state = { ...state, picker: null };
      state = { ...state, notice: await actions.login(providerId) };
      paint();
      return;
    }
    const choice = choices.find((item) => item.id === effect.id);
    if (!choice) return;
    await continueProviderLogin(choice);
  };
  const providerRows = (method: "oauth" | "api_key"): PickerRow[] => choices
    .filter((choice) => method === "oauth" ? choice.oauth : choice.apiKey)
    .map((choice) => {
      const stored = method === "oauth" ? choice.storedType === "oauth" : choice.storedType === "api_key";
      return {
        id: choice.id,
        label: choice.name,
        detail: stored ? "✓ stored" : "• not configured",
        tone: stored ? "ok" as const : "muted" as const,
      };
    });
  const continueProviderLogin = async (choice: ProviderChoice, method?: "oauth" | "api_key"): Promise<void> => {
    const accountLogin = method === "oauth" || (method === undefined && choice.oauth && !choice.apiKey);
    const keyLogin = method === "api_key" || (method === undefined && choice.apiKey && !choice.oauth);
    if (accountLogin) {
      if (!actions.login) {
        state = { ...state, notice: "当前客户端不能登录", picker: null };
        paint();
        return;
      }
      state = { ...state, picker: null, notice: await actions.login(choice.id) };
      paint();
      return;
    }
    if (keyLogin) {
      showPicker({
        title: `API key for ${choice.name}:`,
        hint: "enter save    escape cancel",
        query: "",
        index: 0,
        rows: [],
        kind: "api-key",
        subject: choice.id,
        secret: true,
      });
      return;
    }
    if (choice.oauth && choice.apiKey) {
      showPicker({
        title: `Select authentication method for ${choice.name}:`,
        hint: "↑↓ navigate    enter select    escape cancel",
        query: "",
        index: 0,
        rows: [
          { id: "oauth", label: "Sign in with an account", detail: choice.storedType === "oauth" ? "✓ stored" : "• not configured", tone: choice.storedType === "oauth" ? "ok" : "muted" },
          { id: "api_key", label: "Sign in with an API key", detail: choice.storedType === "api_key" ? "✓ stored" : "• not configured", tone: choice.storedType === "api_key" ? "ok" : "muted" },
        ],
        kind: "login-method",
        subject: choice.id,
      });
      return;
    }
  };
  let choices: ProviderChoice[] = [];
  const pickerBase = { hint: "↑↓ navigate    enter select    escape cancel", query: "", index: 0, subject: undefined };
  const choiceRows = (mode: "login" | "logout"): PickerRow[] => choices
    .filter((choice) => mode === "logout" ? choice.stored : choice.oauth || choice.apiKey)
    .map((choice) => ({
      id: choice.id,
      label: choice.name,
      detail: choice.stored ? "✓ stored" : "• not configured",
      tone: choice.stored ? "ok" as const : "muted" as const,
    }));
  const showPicker = (picker: Picker): void => {
    state = { ...state, picker, notice: null };
    paint();
  };
  const apply = async (effect: TuiEffect): Promise<void> => {
    if (effect.type === "quit") {
      restore();
      return;
    }
    if (effect.type === "cycle-model") {
      await cycleModel();
      return;
    }
    if (effect.type === "approve") {
      await remote.lane(active).approve(effect.toolCallId, effect.decision, effect.session ? { session: true } : {});
      return;
    }
    if (effect.type === "submit") {
      const cwd = attach.cwd || process.cwd();
      const prepared = await imagePrompt(effect.text, cwd);
      if (!prepared.ok) {
        state = restoreComposer(state, effect.text, prepared.message);
        paint();
        return;
      }
      if (prepared.content && surfaces?.refuseImages) {
        const message = surfaces.refuseImages(state.provider, state.modelId, prepared.content);
        if (message) {
          state = restoreComposer(state, effect.text, message);
          paint();
          return;
        }
      }
      const followed = await lane.submit(effect.text, prepared.content);
      if (followed && state.busy) {
        state = { ...state, queued: state.queued + 1 };
        paint();
      }
    }
    else if (effect.type === "abort") await lane.abort();
    else if (effect.type === "pick") await applyPick(effect);
    else if ((effect.command.type === "login" || effect.command.type === "logout") && !effect.command.provider) {
      await openAccountPicker(effect.command.type);
    } else if (effect.command.type === "login" && effect.command.provider) {
      const providerId = effect.command.provider;
      if (!account?.catalog) {
        state = { ...state, notice: "当前客户端不能登录", picker: null };
        paint();
      } else {
        if (choices.length === 0) choices = await account.catalog();
        const chosen = choices.find((item) => item.id === providerId);
        if (!chosen) {
          state = { ...state, notice: `未知供应商 ${providerId}`, picker: null };
          paint();
        } else await continueProviderLogin(chosen);
      }
    } else if (effect.command.type === "model" && !effect.command.provider) {
      showPicker(modelPicker(attach.cwd ? scopedModels(attach.cwd) : [], { provider: state.provider, modelId: state.modelId }));
    } else if (effect.command.type === "thinking" && !effect.command.level) {
      showPicker({
        ...pickerBase,
        title: "Select thinking level:",
        kind: "thinking",
        rows: thinkingRows.map((level) => ({
          id: level,
          label: level,
          detail: level === state.thinking ? "current" : "",
          tone: level === state.thinking ? "ok" : "muted",
        })),
      });
    } else if (effect.command.type === "tree" && !effect.command.entryId) {
      const snap = await remote.lane(active).snapshot();
      showPicker({
        ...pickerBase,
        title: "Select entry:",
        kind: "tree",
        rows: treePickerRows(snap.entries),
      });
    } else if (effect.command.type === "resume" && !effect.command.name) {
      const names = await actions.list();
      showPicker({
        ...pickerBase,
        title: "Select session:",
        kind: "resume",
        rows: names.map((name) => ({
          id: name,
          label: name,
          detail: name === state.active ? "current" : "",
          tone: name === state.active ? "ok" : "muted",
        })),
      });
    } else {
      const outcome = await executeSlash(effect.command, actions);
      await rememberSettings();
      if (outcome.type === "submit") {
        const followed = await lane.submit(outcome.text);
        if (followed && state.busy) {
          state = { ...state, queued: state.queued + 1 };
          paint();
        }
      }
      else if (outcome.type === "notice") {
        state = { ...state, notice: outcome.text };
        paint();
      } else if (outcome.type === "quit") restore();
    }
  };
  const cycleModel = async (): Promise<void> => {
    const enabled = attach.cwd ? chatModelSpecs(scopedModels(attach.cwd)) : [];
    if (enabled.length === 0) {
      state = { ...state, notice: "模型循环未限制", picker: null };
      paint();
      return;
    }
    const current = state.provider && state.modelId ? `${state.provider}/${state.modelId}` : "";
    const next = cycleModels(enabled, current);
    const slash = next.indexOf("/");
    const provider = next.slice(0, slash);
    const modelId = next.slice(slash + 1);
    await remote.lane(active).configure({ provider, modelId });
    await rememberSettings();
    state = { ...state, notice: `模型 ${provider}/${modelId}`, picker: null };
    paint();
  };
  stdin.on("data", onData);
  paint();
  await new Promise<void>((resolve) => {
    finish = resolve;
    stdin.on("end", restore);
  });
  await lane.close();
  await client.dispose();
}

function restoreComposer(state: TuiState, text: string, notice: string): TuiState {
  const trimmed = text.trim();
  const history = state.history.at(-1) === trimmed ? state.history.slice(0, -1) : state.history;
  return { ...state, input: text, cursor: Array.from(text).length, notice, history, historyAt: null, draft: text };
}

class AttachedLane {
  private subscription: { current(): LaneSnapshotDto; coverage(): { omitted: number; skipped: number }; close(): Promise<void> } | undefined;
  private generation = 0;
  private earlierEntries: TuiEntry[] = [];
  private approvalCards: TuiApproval[] = [];
  private approvalEpoch = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly lane: RemoteLane, private readonly onView: () => void) {}

  snapshot(): LaneSnapshotDto {
    return this.subscription?.current() ?? emptySnapshot(this.lane.name);
  }

  earlier(): TuiEntry[] {
    return this.earlierEntries;
  }

  approvals(): TuiApproval[] {
    return this.approvalCards;
  }

  async open(): Promise<void> {
    this.subscription = await this.lane.subscribe(() => {
      const coverage = this.subscription?.coverage();
      const snap = this.subscription?.current();
      const parent = snap?.entries[0]?.parentId ?? null;
      const tail = this.earlierEntries.at(-1)?.id;
      if ((coverage && coverage.omitted === 0 && coverage.skipped === 0) || (tail !== undefined && tail !== parent)) {
        this.earlierEntries = [];
      }
      this.generation += 1;
      this.onView();
      void this.refreshApprovals();
      const waiting = this.waiters.splice(0);
      for (const wake of waiting) wake();
    });
    await this.refreshApprovals();
  }

  /**
   * The snapshot leaves parked calls out. Read `pendingApprovals` when the subscription moves,
   * which is the same commit that parked them. This is not a second retry timer.
   */
  private async refreshApprovals(): Promise<void> {
    const epoch = ++this.approvalEpoch;
    try {
      const pending = await this.lane.pendingApprovals();
      if (epoch !== this.approvalEpoch) return;
      this.approvalCards = approvalCards(pending.items);
    } catch {
      if (epoch !== this.approvalEpoch) return;
    }
    this.onView();
  }

  async close(): Promise<void> {
    await this.subscription?.close();
  }

  async submit(text: string, content?: UserContent[]): Promise<boolean> {
    const body = text.trim();
    const images = content?.some((block) => block.type === "image") === true;
    if (!body && !images) return false;
    const operationId = this.snapshot().operationId;
    if (operationId) {
      await this.lane.followUp(body, images && content ? { content } : undefined);
      return true;
    }
    const admitted = await this.lane.accept(images && content ? { kind: "prompt", text: body, content } : { kind: "prompt", text: body });
    const started = this.snapshot().version;
    await finishDrive(this.lane, admitted.operationId);
    await this.untilLeft(admitted.operationId, started);
    return false;
  }

  async abort(): Promise<void> {
    const operationId = this.snapshot().operationId;
    if (operationId) await this.lane.requestAbort(operationId);
  }

  async loadEarlier(): Promise<string> {
    const snap = this.snapshot();
    const oldest = this.earlierEntries[0]?.id ?? snap.entries[0]?.id;
    if (!oldest) return "没有更早的条目";
    const page = await this.lane.history(oldest, 20);
    const known = new Set([...this.earlierEntries.map((entry) => entry.id), ...snap.entries.map((entry) => entry.id)]);
    const added = page.entries.filter((entry) => !known.has(entry.id)).map(entryView);
    this.earlierEntries = [...added, ...this.earlierEntries];
    this.onView();
    return added.length === 0 ? "没有更早的条目" : `更早 ${added.length} 条`;
  }

  private async untilLeft(operationId: string, started: number): Promise<void> {
    while (true) {
      const snap = this.snapshot();
      if (snap.version > started && snap.operationId !== operationId) return;
      const seen = this.generation;
      await new Promise<void>((resolve) => {
        if (this.generation !== seen || (this.snapshot().version > started && this.snapshot().operationId !== operationId)) {
          resolve();
          return;
        }
        this.waiters.push(resolve);
      });
    }
  }
}

/** 把 lane 快照收成 reducer 窗口。宿主附着和屏幕夹具走同一条。 */
export function windowFrom(
  snapshot: LaneSnapshotDto,
  sessions: string[],
  active: string,
  earlier: TuiEntry[] = [],
  approvals: TuiApproval[] = [],
): TuiWindow {
  const seen = new Set(snapshot.entries.map((entry) => entry.id));
  return {
    entries: [...earlier.filter((entry) => !seen.has(entry.id)), ...snapshot.entries.map(entryView)],
    pendingText: pendingText(snapshot),
    tools: snapshot.tools.map((tool) => ({
      name: tool.name,
      status: tool.status,
      ...(tool.outputTail !== undefined ? { outputTail: tool.outputTail } : {}),
    })),
    busy: snapshot.operationId !== null,
    sessions,
    active,
    activity: snapshot.activity,
    approvals,
  };
}

function approvalCards(items: readonly { toolCallId: string; name: string; arguments: unknown }[]): TuiApproval[] {
  return items.map((item) => ({
    toolCallId: item.toolCallId,
    name: item.name,
    summary: summarizeArgs(item.arguments),
  }));
}

function entryView(entry: EntryDto): TuiEntry {
  if (entry.payload.type === "compaction") return { id: entry.id, role: "other", text: entry.payload.summary };
  const message = entry.payload.message;
  const role = message.role === "user" || message.role === "assistant" || message.role === "toolResult"
    ? (message.role === "toolResult" ? "tool" : message.role)
    : "other";
  const named = message as { role: string; toolName?: string };
  const title = named.role === "toolResult" && typeof named.toolName === "string" ? named.toolName : undefined;
  return { id: entry.id, role, text: messageText(message), ...(title ? { title } : {}) };
}

function pendingText(snapshot: LaneSnapshotDto): string {
  const pending = snapshot.pendingResponse;
  if (!pending) return "";
  return pending.content.map((block) => {
    const text = (block as { text?: unknown }).text;
    return block.type === "text" && typeof text === "string" ? text : "";
  }).join("");
}

function messageText(message: { role: string; content?: unknown; toolName?: string; errorMessage?: unknown }): string {
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => {
          if (!block || typeof block !== "object") return "";
          const record = block as { type?: string; text?: string; name?: string };
          if (record.type === "text" && typeof record.text === "string") return record.text;
          if (record.type === "image") return "[image]";
          if (record.type === "toolCall" && typeof record.name === "string") return record.name;
          return "";
        }).join("")
      : "";
  if (text.length > 0) return text;
  return typeof message.errorMessage === "string" ? message.errorMessage : "";
}

function emptySnapshot(lane: string): LaneSnapshotDto {
  return {
    version: 0,
    lane,
    tipId: null,
    phase: null,
    operationId: null,
    lastOperationId: null,
    status: null,
    entries: [],
    pendingResponse: null,
    tools: [],
    activity: emptyActivity(),
  };
}
