export type AdminLoadPhase = "idle" | "initial" | "usable-background" | "complete" | "error";
export type AdminLoadTrigger = "initial" | "navigation" | "manual" | "restore" | "reconnect" | "mutation";

export interface AdminLoadState {
  requestId: number;
  phase: AdminLoadPhase;
  trigger: AdminLoadTrigger;
  startedAt: number;
  listReadyAt: number | null;
  finishedAt: number | null;
  error: string;
}

export interface AdminLoadTiming {
  foregroundMs: number;
  backgroundMs: number;
  totalMs: number;
  active: boolean;
}

export const idleAdminLoadState: AdminLoadState = {
  requestId: 0,
  phase: "idle",
  trigger: "initial",
  startedAt: 0,
  listReadyAt: null,
  finishedAt: null,
  error: "",
};

export function beginAdminLoad(requestId: number, now: number, hasUsableList: boolean, trigger: AdminLoadTrigger): AdminLoadState {
  return {
    requestId,
    phase: hasUsableList ? "usable-background" : "initial",
    trigger,
    startedAt: now,
    // An existing list remains usable while a refresh runs.  Its foreground
    // wait is therefore zero for this request rather than inherited from a
    // previous visit or request.
    listReadyAt: hasUsableList ? now : null,
    finishedAt: null,
    error: "",
  };
}

export function markAdminListReady(state: AdminLoadState, now: number): AdminLoadState {
  if (state.phase === "complete" || state.phase === "error") return state;
  return { ...state, phase: "usable-background", listReadyAt: state.listReadyAt ?? now };
}

export function completeAdminLoad(state: AdminLoadState, now: number): AdminLoadState {
  return {
    ...state,
    phase: "complete",
    listReadyAt: state.listReadyAt ?? now,
    finishedAt: now,
    error: "",
  };
}

export function failAdminLoad(state: AdminLoadState, now: number, error: string): AdminLoadState {
  return { ...state, phase: "error", finishedAt: now, error };
}

export function adminLoadTiming(state: AdminLoadState, now: number): AdminLoadTiming {
  if (!state.startedAt) return { foregroundMs: 0, backgroundMs: 0, totalMs: 0, active: false };
  const end = state.finishedAt ?? now;
  const listReady = state.listReadyAt;
  return {
    foregroundMs: Math.max(0, (listReady ?? end) - state.startedAt),
    backgroundMs: listReady === null ? 0 : Math.max(0, end - listReady),
    totalMs: Math.max(0, end - state.startedAt),
    active: state.phase === "initial" || state.phase === "usable-background",
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

export function adminLoadStatusText(state: AdminLoadState, now: number): { title: string; detail: string; tone: AdminLoadPhase } | null {
  if (state.phase === "idle") return null;
  const timing = adminLoadTiming(state, now);
  if (state.phase === "initial") {
    return { title: "正在加载账号列表", detail: `首屏已等待 ${formatDuration(timing.foregroundMs)}`, tone: state.phase };
  }
  if (state.phase === "usable-background") {
    return {
      title: "账号列表已可操作，后台数据继续同步",
      detail: `首屏 ${formatDuration(timing.foregroundMs)} · 后台 ${formatDuration(timing.backgroundMs)}`,
      tone: state.phase,
    };
  }
  if (state.phase === "complete") {
    return {
      title: "本次加载完成",
      detail: `首屏 ${formatDuration(timing.foregroundMs)} · 总计 ${formatDuration(timing.totalMs)}`,
      tone: state.phase,
    };
  }
  return {
    title: state.listReadyAt === null ? "账号列表加载失败" : "账号列表可操作，后台同步失败",
    detail: `${state.listReadyAt === null ? "失败前" : `首屏 ${formatDuration(timing.foregroundMs)} · 后台` } ${formatDuration(state.listReadyAt === null ? timing.totalMs : timing.backgroundMs)}`,
    tone: state.phase,
  };
}
