import type { CardStore } from "../db/store";
import type { Card, ReviewSessionCard } from "../db/types";

/**
 * 会话快照的「答案保鲜」。
 *
 * 复习会话创建时会把整张卡复制进 review_session_cards.card_snapshot，
 * 这是**冻结的照片**：之后 AI 补全答案、用户改答案，快照都不会跟着变。
 * 于是「这题答案不对 → 让 AI 补 → 回到这道题」看到的仍是旧的半截答案，
 * 用户会以为补全没生效，反复补同一题。
 *
 * 这里只同步**答案侧**字段。题干与选项不动 —— 会话进行到一半把题干换掉，
 * 比看到旧答案更糟（人会怀疑自己刚才读错了题）。
 *
 * 判据用 content_revision：只有卡片在这轮会话开始后被编辑过才覆盖，
 * 没改过的卡原样返回（对象引用不变），避免每次读会话都重建一遍数组。
 */
const ANSWER_KEYS = [
  "back",
  "answer",
  "answers",
  "is_multi",
  "answer_origin",
  "answer_grounded",
] as const;

/** 空答案不得覆盖已有答案：补全失败 / 手工清空时不能把复习卡变成白板 */
function isEmptyAnswer(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/**
 * 把实时卡片的答案侧字段合并进快照。
 *
 * 返回同一个引用 = 无需更新；返回新对象 = 答案已刷新。
 */
export function mergeAnswerFields(
  snapshot: Record<string, unknown> | null | undefined,
  live: Pick<
    Card,
    | "back"
    | "answer"
    | "answers"
    | "is_multi"
    | "answer_origin"
    | "answer_grounded"
    | "content_revision"
  >
): Record<string, unknown> {
  const snap = snapshot ?? {};
  const snapRev = Number(snap.content_revision ?? 0) || 0;
  const liveRev = Number(live.content_revision ?? 0) || 0;

  // 没编辑过 → 保持原快照。旧快照缺 content_revision 时按 0 处理，
  // 只要实时卡有版本号就视为「值得同步一次」。
  if (liveRev <= snapRev) return snap;

  const next: Record<string, unknown> = { ...snap };
  let touched = false;

  for (const k of ANSWER_KEYS) {
    const v = (live as unknown as Record<string, unknown>)[k];
    // 只有 back 做空值保护：补全失败 / 手工清空时不要把复习卡变成白板。
    // answer 允许跟随实时值 —— 选择题改成多选后它本就该被清空（改用 answers 判题）。
    if (k === "back" && isEmptyAnswer(v)) continue;
    const normalized = v === undefined ? null : v;
    if (next[k] !== normalized) {
      next[k] = normalized;
      touched = true;
    }
  }

  if (!touched) return snap;
  next.content_revision = liveRev;
  return next;
}

/**
 * 批量刷新一轮会话里的卡片答案。
 *
 * 只读取、不写库：快照在磁盘上仍是历史原样，这里的覆盖只作用于本次响应。
 * 这样审计看到的「当时给用户看的是什么」不会被事后修改，
 * 而用户每次进复习页拿到的都是最新答案。
 */
export async function hydrateSessionAnswers(
  store: CardStore,
  rows: ReviewSessionCard[]
): Promise<ReviewSessionCard[]> {
  if (rows.length === 0) return rows;

  const ids = Array.from(new Set(rows.map((r) => r.card_id)));
  const liveById = new Map<string, Card>();
  // 一轮 20–50 张，逐个取是内存查找；全量 listCards 反而要遍历 800+ 张
  await Promise.all(
    ids.map(async (id) => {
      const c = await store.getCard(id);
      if (c && !c.deleted_at) liveById.set(id, c);
    })
  );

  let refreshed = 0;
  const out = rows.map((row) => {
    const live = liveById.get(row.card_id);
    if (!live) return row;
    const next = mergeAnswerFields(row.card_snapshot, live);
    if (next === row.card_snapshot) return row;
    refreshed++;
    return { ...row, card_snapshot: next };
  });

  // 没有一张需要刷新时返回原数组，调用方（含测试）可据此判断「无变化」
  return refreshed === 0 ? rows : out;
}
