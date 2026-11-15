import type { Card, CardType } from "../db/types";

/**
 * 题型的唯一口径。
 *
 * 全站三处要报题型（统计页副标题、资料库每本书的状态行、审核台筛选），
 * 以前各写各的：统计页已改成按 card_type，资料库还留着 is_choice 二分，
 * 于是同一份数据一边显示「选择 17」，另一边显示「选择题 48」。
 *
 * 存量卡可能没有 card_type（早期数据），按 is_choice 兜底推导：
 * 有选项 → 选择题，没有 → 问答卡。这是唯一允许读 is_choice 的地方。
 */
export const TYPE_ORDER: ReadonlyArray<readonly [CardType, string]> = [
  ["choice", "选择"],
  ["cloze", "填空"],
  ["judge", "判断"],
  ["qa", "问答"],
  ["contrast", "对比"],
];

export function cardTypeOf(card: Card): CardType {
  return card.card_type ?? (card.is_choice ? "choice" : "qa");
}

export function countByType(cards: readonly Card[]): Map<CardType, number> {
  const map = new Map<CardType, number>();
  for (const c of cards) {
    const k = cardTypeOf(c);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

/** 「选择 17 / 填空 13 / 判断 31」——为 0 的题型不出现 */
export function typeSummary(cards: readonly Card[], sep = " / "): string {
  const counts = countByType(cards);
  return TYPE_ORDER.filter(([k]) => counts.get(k))
    .map(([k, label]) => `${label} ${counts.get(k)}`)
    .join(sep);
}
