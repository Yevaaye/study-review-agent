// 导入会话的状态机（纯函数）。
//
// 用户的原话是「切到别的页面再回来，不能出现页面不显示或状态丢失」。
// 状态丢失有两种来源，必须分开处理：
//   1. 组件卸载 —— 页面内 useState 全没了；
//   2. 请求被判死 —— 浏览器刷新后原来那条 fetch 已经不存在了。
// 所以状态既不能放组件里，也不能挂在某条请求的 Promise 上：
// 它必须由「服务端任务表里的 jobId」+「本地持久化的会话」共同决定。
//
// 这个文件只做纯计算（不碰 sessionStorage / fetch），
// 才能在 node 里被 scripts/import-session-check.mjs 直接断言。

export type ImportMode = "off" | "smart" | "deep";

export interface ImportResultSummary {
  import_job_id: string;
  chapter_count: number;
  original_card_count: number;
  needs_answer: number;
  knowledge_point_count: number;
  by_type?: { choice: number; qa: number; cloze: number; judge: number };
  textbook_id?: string;
  textbook_title?: string;
}

export type ImportPhase = "idle" | "running" | "done" | "error" | "lost";

export interface ImportSession {
  phase: ImportPhase;
  /** 服务端任务 id（/api/jobs 里能查到它，切页/刷新后靠它把状态找回来） */
  jobId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 提交时的表单快照：回来后输入框不该是空的 */
  title: string;
  markdown: string;
  fileName: string | null;
  mode: ImportMode;
  result: ImportResultSummary | null;
  error: string | null;
}

export const EMPTY_SESSION: ImportSession = {
  phase: "idle",
  jobId: null,
  startedAt: null,
  finishedAt: null,
  title: "",
  markdown: "",
  fileName: null,
  mode: "smart",
  result: null,
  error: null,
};

export interface BeginInput {
  jobId: string;
  startedAt?: number;
  title: string;
  markdown: string;
  fileName?: string | null;
  mode: ImportMode;
}

/**
 * 开始一次导入。
 * 已经在跑时直接返回原对象 —— 连点两次按钮不该发出两个请求（材料会重复入库）。
 */
export function beginImport(session: ImportSession, input: BeginInput): ImportSession {
  if (session.phase === "running") return session;
  return {
    ...session,
    phase: "running",
    jobId: input.jobId,
    startedAt: input.startedAt ?? Date.now(),
    finishedAt: null,
    title: input.title,
    markdown: input.markdown,
    fileName: input.fileName ?? null,
    mode: input.mode,
    result: null,
    error: null,
  };
}

/** 服务端任务的最小形状（避免这里依赖 lib/jobs 的完整类型） */
export interface JobLike {
  id: string;
  status: "running" | "done" | "error";
  started_at?: number;
  finished_at?: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** 任务结果 → 页面要的摘要。缺字段一律归零，绝不出现 NaN 卡在界面上。 */
export function fromJobResult(raw: Record<string, unknown> | undefined): ImportResultSummary {
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const bt = (raw?.by_type ?? {}) as Record<string, unknown>;
  return {
    import_job_id: String(raw?.import_job_id ?? ""),
    chapter_count: n(raw?.chapter_count),
    original_card_count: n(raw?.original_card_count),
    needs_answer: n(raw?.needs_answer),
    knowledge_point_count: n(raw?.knowledge_point_count),
    by_type: {
      choice: n(bt.choice),
      qa: n(bt.qa),
      cloze: n(bt.cloze),
      judge: n(bt.judge),
    },
    textbook_id: raw?.textbook_id ? String(raw.textbook_id) : undefined,
    textbook_title: raw?.textbook_title ? String(raw.textbook_title) : undefined,
  };
}

/**
 * 把服务端任务状态同步进会话。
 *
 * 两条不变量：
 *   · 已完成不会被后来的 running 覆盖（轮询有延迟，任务列表可能滞后一步）；
 *   · 只认自己那个 jobId 的任务，别把「别人的任务」写进这次导入。
 */
export function applyJob(session: ImportSession, job: JobLike): ImportSession {
  if (!session.jobId || job.id !== session.jobId) return session;
  if (session.phase === "done") return session;

  if (job.status === "running") {
    if (session.phase === "running") return session;
    return { ...session, phase: "running", error: null };
  }
  if (job.status === "done") {
    return {
      ...session,
      phase: "done",
      startedAt: session.startedAt ?? job.started_at ?? null,
      finishedAt: job.finished_at ?? Date.now(),
      result: fromJobResult(job.result),
      error: null,
    };
  }
  return {
    ...session,
    phase: "error",
    finishedAt: job.finished_at ?? Date.now(),
    error: job.error || "导入失败，请重试",
  };
}

/** 同步提交阶段就失败（400 / 409 / 网络）—— 还没拿到 jobId 的情况 */
export function failSession(session: ImportSession, error: string): ImportSession {
  return { ...session, phase: "error", finishedAt: Date.now(), error };
}

/**
 * 任务查不到了（服务重启 / 已过保留期）。
 *
 * 不能假装「还在跑」——那会永远转圈；也不能一声不响回到空白表单。
 * 明确告诉用户「这次没拿到结果」，并给出下一步（去资料库确认 / 重新导入）。
 */
export function markLost(session: ImportSession, reason?: string): ImportSession {
  if (session.phase !== "running") return session;
  return {
    ...session,
    phase: "lost",
    finishedAt: Date.now(),
    error:
      reason ??
      "这次导入的进度已经查不到了（服务可能重启过）。材料也许已经进了资料库，请先去资料库确认；确实没有再导入一次。",
  };
}

/**
 * 这个阶段还该不该继续跟服务端任务对账。
 *
 * 早期版本只在 running 时对账，于是 markLost 一旦写下就锁死：任务其实完成了、
 * 或者进程重启后任务又出现在列表里，页面也不会再看一眼 —— 「查不到了」永久挂在屏幕上。
 * 把 lost 也纳入对账，才有可能自愈。
 */
export function shouldSyncFromJob(phase: ImportPhase): boolean {
  return phase === "running" || phase === "lost";
}

/** 任务列表还没到、或任务确实不在表里时，等多久才下「丢了」的结论 */
export const LOST_GRACE_MS = 6000;

/**
 * 「任务不在列表里」该判什么。
 *
 * 两个坑都在这里修掉：
 *   · 计时基准必须是**会话里的 startedAt**。旧实现用组件 state 的 submitAt，
 *     切页再回来就变 null，`Date.now() - 0` 恒大于 4 秒，宽限期形同虚设 → 秒判丢；
 *   · 只有真的过了宽限期才判 lost。刚提交那一两秒 /api/jobs 还没回来是正常的。
 */
export function missingJobVerdict(input: {
  hasJob: boolean;
  phase: ImportPhase;
  startedAt: number | null;
  submitAt: number | null;
  now: number;
  graceMs?: number;
}): "sync" | "wait" | "lost" {
  if (input.hasJob) return "sync";
  if (!shouldSyncFromJob(input.phase)) return "sync";
  const since = input.startedAt ?? input.submitAt;
  if (since == null) return "wait";
  const grace = input.graceMs ?? LOST_GRACE_MS;
  return input.now - since < grace ? "wait" : "lost";
}

/** 「还要再导入一份吗？」→ 回到空白表单，但保留上次选的模式 */
export function resetSession(session: ImportSession): ImportSession {
  return { ...EMPTY_SESSION, mode: session.mode };
}

/** 从持久化数据还原：只接受形状正确的对象，脏数据直接丢弃回 idle */
export function reviveSession(raw: unknown): ImportSession {
  if (!raw || typeof raw !== "object") return EMPTY_SESSION;
  const o = raw as Partial<ImportSession>;
  const phases: ImportPhase[] = ["idle", "running", "done", "error", "lost"];
  if (!o.phase || !phases.includes(o.phase)) return EMPTY_SESSION;
  return {
    ...EMPTY_SESSION,
    phase: o.phase,
    jobId: typeof o.jobId === "string" ? o.jobId : null,
    startedAt: typeof o.startedAt === "number" ? o.startedAt : null,
    finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : null,
    title: typeof o.title === "string" ? o.title : "",
    markdown: typeof o.markdown === "string" ? o.markdown : "",
    fileName: typeof o.fileName === "string" ? o.fileName : null,
    mode: o.mode === "off" || o.mode === "deep" || o.mode === "smart" ? o.mode : "smart",
    result: o.result && typeof o.result === "object" ? (o.result as ImportResultSummary) : null,
    error: typeof o.error === "string" ? o.error : null,
  };
}
