/**
 * 复习断点：把「这一轮刷到哪了」算成可直接展示的一组数字。
 *
 * 需求来源（用户实报）：在一本书里复习到一半，跳去别的页面看东西，
 * 回来要能接着上次的位置；并且要**看得清**哪些已经复习过、哪些还没。
 *
 * 所以进度不能只有「已答 N」这一个数，必须同时给出「还剩多少」与
 * 「下一张是第几张」——三者一起才能让用户判断「我是不是回到原位了」。
 *
 * 这里的函数都是纯函数：卡片只要求带 rated 位（服务端 rated 是唯一真相），
 * 不引入时间、不读存储，方便用真实样本回归。
 */

import { firstUnratedIndex, ratedCount, normalizeScope, type RatedLike } from "./progress";

export type ProgressSummary = {
  /** 这一轮一共有多少张（含已答与未答） */
  total: number;
  /** 已复习（服务端 rated=true） */
  rated: number;
  /** 还没复习的 */
  remaining: number;
  /** 下一张该答的下标；全部答完为 -1 */
  nextIndex: number;
  /** 已完成占比，0–100 的整数，直接喂给进度条 */
  percent: number;
};

export function summarizeProgress(cards: RatedLike[]): ProgressSummary {
  const total = cards.length;
  const rated = ratedCount(cards);
  const remaining = Math.max(0, total - rated);
  const nextIndex = firstUnratedIndex(cards);
  const percent = total === 0 ? 0 : Math.round((rated / total) * 100);
  return { total, rated, remaining, nextIndex, percent };
}

/**
 * 续接时的那句提示。
 *
 * 刻意写「第 k 张 / 共 n 张」而不是只写「继续」：用户抱怨过「回来像是没答过」，
 * 给出具体位置和已答张数，才能和记忆对上（第 6 张、前面 5 张答过）。
 */
export function resumeHintText(s: ProgressSummary): string {
  if (s.total === 0) return "";
  if (s.nextIndex < 0) return `这一轮 ${s.total} 张已全部复习完`;
  const at = s.nextIndex + 1;
  if (s.rated === 0) return `从第 1 张开始 · 共 ${s.total} 张`;
  return `已回到上次的中断处 · 第 ${at} 张 / 共 ${s.total} 张（前面 ${s.rated} 张已复习）`;
}

/** 「已完成 12 · 待复习 18」——页头用的对照文案 */
export function progressLabel(s: Pick<ProgressSummary, "rated" | "remaining">): string {
  if (s.rated === 0 && s.remaining === 0) return "";
  return `已完成 ${s.rated} · 待复习 ${s.remaining}`;
}

/** 选书页每一行右侧的断点徽标，例如「已答 12/30」 */
export function resumeBadgeText(s: Pick<ProgressSummary, "rated" | "total">): string {
  if (s.total === 0) return "";
  return `已答 ${s.rated}/${s.total}`;
}

/** 一轮进行中会话的摘要（/api/review/inprogress 的条目） */
export type ResumableSession = {
  session_id: string;
  scope: ReturnType<typeof normalizeScope>;
  total: number;
  rated: number;
  remaining: number;
  next_index: number;
  started_at: string;
  textbook_title: string | null;
};

function scopeKey(s: Pick<ResumableSession, "scope">): string {
  const n = normalizeScope(s.scope);
  return `${n.mode}\u0000${n.group ?? ""}\u0000${n.textbook_id ?? ""}`;
}

/**
 * 同一范围只留最新一轮。
 *
 * 历史上因为「续接时认领」失效，同一本书可能挂着好几条 in_progress；
 * 把它们全列出来会让选书页出现三行「继续同一本书」，用户只会更困惑。
 */
export function latestPerScope(items: ResumableSession[]): ResumableSession[] {
  const best = new Map<string, ResumableSession>();
  for (const it of items) {
    const k = scopeKey(it);
    const prev = best.get(k);
    if (!prev || it.started_at > prev.started_at) best.set(k, it);
  }
  return [...best.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

/**
 * 从一堆进行中会话里挑出「这本书」的那一轮。
 *
 * 用于 `/api/review/current?book=<id>`：从书详情 / 原文跳回复习页时，
 * 不该被「最近一轮是别的书」抢走，否则用户点的是 A 书、进的是 B 书。
 * 该书没有进行中的轮次时返回 null，交给调用方退回「最近一轮」。
 */
export function pickSessionForBook(
  items: ResumableSession[],
  textbookId: string | null | undefined
): ResumableSession | null {
  const id = typeof textbookId === "string" ? textbookId.trim() : "";
  if (!id) return null;
  return items.find((it) => normalizeScope(it.scope).textbook_id === id) ?? null;
}
