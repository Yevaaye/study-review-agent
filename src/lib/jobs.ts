// 后台 AI 任务登记表（进程内）。
//
// 为什么要这么做：一次「整章补充出题」要调一次模型，14 秒起步。
// 原来接口是同步的 —— 浏览器一直等，页面像卡住，用户不知道还要多久，
// 而且这段时间里他什么都不敢点。
//
// 现在接口立刻返回 job_id，真正的活在这个模块里继续跑：
//   · 前端随时能查进度（GET /api/jobs）
//   · 用户切到别的页面，任务照跑（任务属于服务端进程，不属于某个页面）
//
// 存在 globalThis 上是因为 Next dev 会热更新模块，普通模块级变量会被重置，
// 而任务正在进行中、重置就等于任务丢失。
import crypto from "node:crypto";

import { estimatePercent } from "./ui/progress";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  id: string;
  kind: "chapter-generate" | "import-generate" | "fill-answers" | "import-parse";
  /** 浮层上显示的一行标题，如「四、2026 年经济工作的政策取向」 */
  title: string;
  /** 完成后「查看」跳到哪 */
  href: string;
  status: JobStatus;
  /** 阶段名：准备素材 / 请求模型 / 写入卡片 */
  phase: string;
  message: string;
  /** 0~100，按时长估算（模型不给流式进度，用 elapsed/eta 逼近） */
  percent: number;
  started_at: number;
  /** 预估总时长（毫秒），用于「预计还需 X 秒」 */
  eta_ms: number;
  finished_at?: number;
  result?: Record<string, unknown>;
  error?: string;
}

const globalForJobs = globalThis as typeof globalThis & {
  __studyReviewJobs?: Map<string, Job>;
};

const jobs: Map<string, Job> = (globalForJobs.__studyReviewJobs ??= new Map());

/** 已结束的任务保留一段时间，方便前端看到「已完成 +N 张」再自动收起 */
const KEEP_DONE_MS = 90_000;

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== "running" && j.finished_at && now - j.finished_at > KEEP_DONE_MS) {
      jobs.delete(id);
    }
  }
}

export function createJob(input: {
  kind: Job["kind"];
  title: string;
  href: string;
  eta_ms: number;
}): Job {
  prune();
  const job: Job = {
    id: crypto.randomUUID(),
    kind: input.kind,
    title: input.title,
    href: input.href,
    status: "running",
    phase: "准备素材",
    message: "正在读取本章原文…",
    percent: 3,
    started_at: Date.now(),
    eta_ms: input.eta_ms,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function updateJob(id: string, patch: Partial<Job>) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

export function finishJob(id: string, result: Record<string, unknown>) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "done";
  job.percent = 100;
  job.phase = "完成";
  job.result = result;
  job.finished_at = Date.now();
  job.message = summarize(result);
  recordSample(job.kind, job.finished_at - job.started_at);
}

export function failJob(id: string, error: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "error";
  job.error = error;
  job.phase = "失败";
  job.message = error;
  job.finished_at = Date.now();
  recordSample(job.kind, job.finished_at - job.started_at);
}

/**
 * 实测耗时样本（按任务类型）。
 *
 * 为什么需要：固定公式（8 秒 + 每千字 2.5 秒）对一次真实的出题请求低了四倍，
 * 界面写着「还需约 12 秒」，实际跑了 70 秒 —— 估不准的倒计时比没有倒计时更伤人。
 * 这里把每次任务的真实耗时记下来，下一次用滑动平均去估计，
 * 同一个网关变慢/变快时它能自己跟上，不用改代码。
 */
type EtaState = { samples: Record<string, number[]> };
const globalForEta = globalThis as typeof globalThis & { __studyReviewEta?: EtaState };
const eta: EtaState = (globalForEta.__studyReviewEta ??= { samples: {} });

/** 只保留最近 6 次，旧的网络环境不再代表现在 */
function recordSample(kind: string, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const list = (eta.samples[kind] ??= []);
  // 失败的样本也记 —— 用户等的就是这段时间，哪怕最后失败
  list.push(Math.min(ms, 180_000));
  if (list.length > 6) list.shift();
}

/** 已知样本的中位数（失败那次通常最长，用中位数比平均数稳） */
export function learnedEta(kind: string): number | null {
  const list = eta.samples[kind];
  if (!list || list.length < 2) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(result: Record<string, unknown>): string {
  // 导入（解析 + 抽原题）：结果里带 chapter_count 而不是 added/filled
  if ("chapter_count" in result) {
    const ch = Number(result.chapter_count ?? 0);
    const cards = Number(result.original_card_count ?? 0);
    const kps = Number(result.knowledge_point_count ?? 0);
    if (cards === 0 && kps === 0) return `已解析 ${ch} 章，没有可收录的原文内容`;
    return cards > 0
      ? `已解析 ${ch} 章，收录原题 ${cards} 道`
      : `已解析 ${ch} 章，提炼知识点 ${kps} 条（原文没有现成题目）`;
  }
  // 「AI 补答案」任务：结果里带 filled，文案不该套用「生成卡片」那套说法
  if ("filled" in result) {
    const filled = Number(result.filled ?? 0);
    const skipped = Number(result.insufficient ?? 0) + Number(result.no_material ?? 0);
    if (filled === 0) return skipped > 0 ? `${skipped} 张卡没能生成答案，可再试一次` : "没有需要补答案的卡片";
    return skipped > 0
      ? `已为 ${filled} 张卡补上 AI 答案，${skipped} 张没成功`
      : `已为 ${filled} 张卡补上 AI 答案`;
  }
  const added = Number(result.added ?? 0);
  if (added > 0) return `已生成 ${added} 张卡片，进入待审核`;
  return "没有新增卡片（该知识点已补过一轮）";
}

/**
 * 「还在跑」的任务列表。前端浮层轮询它 —— 这样即使用户切到别的页面，
 * 也能看到进度，且知道后台还有活没干完。
 */
export function listJobs(): Job[] {
  prune();
  return [...jobs.values()].sort((a, b) => b.started_at - a.started_at);
}

/**
 * 进度推进器：模型调用期间没有任何真实进度可拿，用一个定时器按预估时长逼近。
 *
 * 两条规则：
 *   · 到 1×预估时长之前，走到 92% —— 在真正拿到结果前不该显示 100%；
 *   · 超过预估时长后，继续以极慢的速度往 96% 爬。
 *     早期版本直接停在 92%，任务真跑了 70 秒时，进度条 60 秒不动，
 *     看起来和卡死没有区别。
 */
export function startTicker(id: string, from = 8, to = 92) {
  const job = jobs.get(id);
  if (!job) return () => {};
  const timer = setInterval(() => {
    const cur = jobs.get(id);
    if (!cur || cur.status !== "running") return;
    // 估算公式与客户端共用一份（src/lib/ui/progress.ts），
    // 否则服务端与「导入页本地计时」会算出两个不同的百分比。
    const next = estimatePercent(Date.now() - cur.started_at, cur.eta_ms, from, to);
    cur.percent = Math.max(cur.percent, next);
  }, 500);
  return () => clearInterval(timer);
}
