/**
 * 复习进度：把「这一轮答到哪了」从客户端内存搬到可对账的判断上。
 *
 * 背景（用户实报）：复习到第 5 题 → 去原文查依据 → 顺手点进「卡片 / 资料」→
 * 再回到复习页，进度凭空消失；更糟的是从浏览器返回时会被拉回一张已经答过的题。
 *
 * 根因不是「状态没存」，而是**同一件事有两个真相**：
 *   1) 客户端 sessionStorage 快照 —— 有 cards[] + idx，但只在「去原文」这一个入口写；
 *   2) 服务端 review_session_cards —— 每张会话卡都有 rated 位，但前端从来没读过。
 * 两者各说各话：换个入口进来就是第二轮会话（idx=0，看着像没作答），
 * 用浏览器返回又拿到旧快照的 idx（指向已经答过的题）。
 *
 * 这里的函数只做一件事：**以服务端 rated 为唯一真相**算「下一张该答的题」，
 * 客户端据此跳号，服务端据此判断该不该复用会话。
 */

/** 只要能判断「答过没答过」即可，不绑定具体卡片结构（客户端 / 服务端共用） */
export type RatedLike = { rated?: boolean };

/**
 * 第一张没答过的题。
 * 全部答完返回 -1 —— 调用方据此走「本轮完成」，而不是把用户丢回第 1 题。
 */
export function firstUnratedIndex(cards: RatedLike[]): number {
  for (let i = 0; i < cards.length; i++) if (!cards[i]?.rated) return i;
  return -1;
}

/**
 * 从 from 开始（含）向后找第一张没答过的题。
 * 找不到返回 -1。用它替代 `idx + 1`，才能跳过「上一题回看时顺带重答过」的卡。
 */
export function nextUnratedIndex(cards: RatedLike[], from: number): number {
  const start = Math.max(0, from);
  for (let i = start; i < cards.length; i++) if (!cards[i]?.rated) return i;
  return -1;
}

export function ratedCount(cards: RatedLike[]): number {
  return cards.reduce((n, c) => (c?.rated ? n + 1 : n), 0);
}

/**
 * 找出「本轮开始之后，在别的地方答过」的题。
 *
 * 为什么需要这层：session_card.rated 只会被**属于它的那次评分**点亮。用户完全可能
 * 同一张题在两轮会话里各答一次（换了一次书、开了两个标签页、上一轮没点完成就退出），
 * 于是旧会话里那张卡的 rated 永远是 false —— 续接时又把它推给用户，
 * 这正是「已经答过的题又让我复习」的另一半来源。
 *
 * 判据用时间而非「有没有 review」：本轮开始之前的答对不算（那时候还没这一轮）。
 * 返回下标而不是改数组，落库交给调用方（GET 路由不该悄悄写盘）。
 */
export function findAnsweredSince<T extends { card_id: string; rated?: boolean }>(
  cards: T[],
  reviews: Array<{ id: string; card_id: string; reviewed_at: string }>,
  since: string
): Array<{ index: number; reviewId: string }> {
  const from = new Date(since).getTime();
  if (Number.isNaN(from)) return [];
  const latest = new Map<string, { id: string; at: number }>();
  for (const r of reviews) {
    const at = new Date(r.reviewed_at).getTime();
    if (Number.isNaN(at) || at < from) continue;
    const prev = latest.get(r.card_id);
    if (!prev || at >= prev.at) latest.set(r.card_id, { id: r.id, at });
  }
  const out: Array<{ index: number; reviewId: string }> = [];
  cards.forEach((c, index) => {
    if (c.rated) return;
    const hit = latest.get(c.card_id);
    if (hit) out.push({ index, reviewId: hit.id });
  });
  return out;
}

/**
 * 会话范围。三个字段决定「这一轮在刷什么」：
 *   mode        due = 今日到期；all = 全部 active（再复习一轮）
 *   group       due / new 分组，null = 混在一起
 *   textbook_id 限定某一本书，null = 全部材料
 *
 * 只有三者完全一致才算同一轮 —— 否则「换一本书」会被错误地续接成上一本。
 */
export type ReviewScopeKey = {
  /** retry = 今天答错、还没答对的题（当天可反复重做） */
  mode: "due" | "all" | "retry";
  group: "due" | "new" | null;
  textbook_id: string | null;
};

function normGroup(v: unknown): "due" | "new" | null {
  return v === "due" || v === "new" ? v : null;
}

function normText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 把任意 scope 对象（可能来自旧数据的 loose 结构）归一成可比较的键 */
export function normalizeScope(raw: unknown): ReviewScopeKey {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    mode: o.mode === "all" ? "all" : o.mode === "retry" ? "retry" : "due",
    group: normGroup(o.group),
    textbook_id: normText(o.textbook_id),
  };
}

export function sameScope(a: unknown, b: unknown): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  return x.mode === y.mode && x.group === y.group && x.textbook_id === y.textbook_id;
}

/**
 * 是否同一天（按本地日历日，不是 UTC）。
 * 跨天的 in_progress 会话一律不复用：昨天的队列今天续接，会把今天到期的卡挤到后面，
 * 用户看到的是「昨天那批题又要重刷」。这类会话按 abandoned 收尾。
 */
export function isSameLocalDay(a: string, b: Date = new Date()): boolean {
  const d = new Date(a);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === b.getFullYear() &&
    d.getMonth() === b.getMonth() &&
    d.getDate() === b.getDate()
  );
}
