// 导入会话的外部存储（浏览器侧）。
//
// 为什么不是普通的 useState：用户在等导入的时候一定会去别的页面看一眼
// （「生成时其他功能不受影响」本来就是这产品的卖点）。组件一卸载，
// useState 就没了；回来只剩一张空表单，看起来像「刚才那次导入根本没发生」。
//
// 所以这里做三件事：
//   1. 状态放模块级 + useSyncExternalStore，跨页面（同一 tab）都在；
//   2. 落 sessionStorage，刷新也能还原（刷新后 jobId 还在，服务端任务也还在）；
//   3. 只存「会话」，真正的进度永远以 /api/jobs 为准 —— 本地不估算、不编造。

import { useSyncExternalStore } from "react";

import {
  beginImport,
  EMPTY_SESSION,
  failSession,
  markLost,
  resetSession,
  reviveSession,
  applyJob,
  type ImportMode,
  type ImportSession,
  type JobLike,
} from "./session-state";

const KEY = "sr.import.session.v1";
/** markdown 可能很大（上限 8MB），超过这个长度就不进 sessionStorage，避免整条写入失败 */
const MAX_PERSIST_BODY = 200_000;

let state: ImportSession = EMPTY_SESSION;
const listeners = new Set<() => void>();
let hydrated = false;

function persist() {
  if (typeof window === "undefined") return;
  try {
    const slim: ImportSession =
      state.markdown.length > MAX_PERSIST_BODY ? { ...state, markdown: "" } : state;
    window.sessionStorage.setItem(KEY, JSON.stringify(slim));
  } catch {
    // 配额满 / 隐私模式禁用 storage：退化为「同一次会话内仍可切页」，
    // 刷新后丢失 —— 但绝不因为存不进去而让页面报错。
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify({ ...state, markdown: "" }));
    } catch {
      /* 放弃持久化 */
    }
  }
}

function emit(next: ImportSession) {
  if (next === state) return;
  state = next;
  persist();
  for (const l of listeners) l();
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return;
    const revived = reviveSession(JSON.parse(raw));
    if (revived.phase !== "idle") {
      state = revived;
      for (const l of listeners) l();
    }
  } catch {
    /* 脏数据忽略 */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  hydrate();
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => EMPTY_SESSION;

export function useImportSession(): ImportSession {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export interface StartImportInput {
  title: string;
  markdown: string;
  fileName?: string | null;
  mode: ImportMode;
}

/**
 * 提交一次导入。接口回 202 + job_id，真正的活在服务端跑。
 *
 * 注意这里没有 await 到「导入完成」——这正是重点：
 * 页面可以立刻离开，回来时凭 jobId 从 /api/jobs 取回进度与结果。
 */
export async function startImport(input: StartImportInput): Promise<void> {
  if (state.phase === "running") return;

  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, markdown: input.markdown }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    job_id?: string;
    started_at?: number;
  };

  if (!res.ok || !data.job_id) {
    emit(failSession(state, data.error || `导入失败（HTTP ${res.status}）`));
    return;
  }

  emit(
    beginImport(state, {
      jobId: data.job_id,
      startedAt: data.started_at,
      title: input.title,
      markdown: input.markdown,
      fileName: input.fileName ?? null,
      mode: input.mode,
    })
  );
}

/** 由页面把 /api/jobs 里对应的任务同步进来 */
export function syncSessionFromJob(job: JobLike | undefined | null): void {
  if (!job) return;
  emit(applyJob(state, job));
}

/** 任务查不到了（服务重启 / 过了保留期） */
export function loseImportSession(reason?: string): void {
  emit(markLost(state, reason));
}

/**
 * 内存任务表里找不到时，回数据库再问一次。
 *
 * /api/jobs 只活在进程里（结束 90 秒后清理、重启即空），而 import_jobs 一直落库。
 * 所以「查不到」要先到这里兜一圈：能查到就直接把最终结果还原成 done，
 * 只有库里也没有，才算真的丢了。
 *
 * 返回 true 表示已拿到可用状态（running / done / error 都算），调用方不要再判丢。
 */
export async function resumeFromServer(): Promise<boolean> {
  const id = state.jobId;
  if (!id) return false;
  try {
    const res = await fetch(`/api/import?job_id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as JobLike | { found?: boolean };
    if (!("id" in data) || !data.id) return false;
    emit(applyJob(state, data));
    return true;
  } catch {
    // 网络抖动不算「丢了」：等下一轮再试
    return false;
  }
}

/** 「再导入一份」/「清空」 */
export function resetImportSession(): void {
  emit(resetSession(state));
}

/** 只清错误（保留结果，方便用户看着结果重试） */
export function clearImportError(): void {
  if (!state.error) return;
  emit({ ...state, error: null, phase: state.result ? "done" : "idle" });
}

/** 表单草稿：输入时同步进会话，切页回来还在 */
export function updateDraft(patch: Partial<Pick<ImportSession, "title" | "markdown" | "fileName" | "mode">>): void {
  if (state.phase === "running") return; // 进行中不改写草稿，避免与提交时的快照打架
  emit({ ...state, ...patch });
}
