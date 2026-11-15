// 知识点（片段）级统计：把「复习了多少次 / 错了几次 / 是不是高频卡点」算到原文片段上。
//
// 为什么单独一层：卡片是 FSRS 的最小调度单元，而用户想看的粒度是「原文里的这一段」。
// 二者靠 card_sources 关联。资料库全文页、资料库首页、统计页都要这份数据，所以统一在这里算。

import type { CardStore } from "../db/store";
import type { CardFsrsState, ID, SourceFragment } from "../db/types";

export interface FragmentStat {
  fragment_id: ID;
  /** 挂在这一段上的卡片数 */
  card_count: number;
  /** 其中的选择题数 */
  choice_count: number;
  /** 这一段累计被复习的次数（关联卡片的复习事件总数） */
  review_count: number;
  /** 其中「没想起来」（Again）的次数 */
  again_count: number;
  /** 关联卡片的 FSRS 累计复习轮次（相同卡片多轮会重复计） */
  reps: number;
  lapses: number;
  /**
   * 被「拒绝」标记为需重学、且此后还没重新复习过的卡片数。
   * 用户在审核台点「拒绝（重学）」时不会产生复习事件，但那段原文必须体现出
   * 「这里被判定为不熟」，所以用 card.rejected_at 与 last_review_at 的比较来判断。
   */
  relearn_count: number;
  /**
   * 卡点等级：
   *   2 = 高频复习（错 2 次以上，或遗忘 2 次以上）
   *   1 = 需关注（错过 1 次，或反复复习 3 次以上）
   *   0 = 正常
   */
  hot: 0 | 1 | 2;
  last_review_at?: string | null;
}

function emptyStat(fragmentId: ID): FragmentStat {
  return {
    fragment_id: fragmentId,
    card_count: 0,
    choice_count: 0,
    review_count: 0,
    again_count: 0,
    reps: 0,
    lapses: 0,
    relearn_count: 0,
    hot: 0,
    last_review_at: null,
  };
}

function gradeHot(s: FragmentStat): 0 | 1 | 2 {
  if (s.again_count >= 2 || s.lapses >= 2 || s.relearn_count >= 2) return 2;
  if (s.again_count >= 1 || s.lapses >= 1 || s.review_count >= 3 || s.relearn_count >= 1) return 1;
  return 0;
}

/**
 * 计算每个片段的复习情况。
 * @param textbookId 只统计某份材料时传入（避免把别的书本的数据算进来）
 */
export async function computeFragmentStats(
  store: CardStore,
  textbookId?: ID
): Promise<Map<ID, FragmentStat>> {
  const stats = new Map<ID, FragmentStat>();
  const cards = await store.listCards(textbookId ? { textbookId } : undefined);
  if (cards.length === 0) return stats;

  const cardIds = new Set(cards.map((c) => c.id));
  const reviews = (
    await store.listReviews(undefined, Number.POSITIVE_INFINITY)
  ).filter((r) => cardIds.has(r.card_id));

  // 卡片 → 片段 的反向索引：一次批量取出，避免逐卡 N 次查询（O(N²) 回归点）。
  const allLinks = await store.listAllCardSources();
  const cardToFrags = new Map<ID, ID[]>();
  for (const link of allLinks) {
    if (!cardIds.has(link.card_id)) continue;
    const arr = cardToFrags.get(link.card_id) ?? [];
    arr.push(link.source_fragment_id);
    cardToFrags.set(link.card_id, arr);
  }

  // FSRS 状态同样批量取出，循环内只查表，不逐卡发起查询。
  const allFsrs = await store.listAllFsrsStates();
  const fsrsByCard = new Map<ID, CardFsrsState>();
  for (const s of allFsrs) fsrsByCard.set(s.card_id, s);

  for (const c of cards) {
    const fragIds = cardToFrags.get(c.id) ?? [];
    if (fragIds.length === 0) continue;
    const fsrs = fsrsByCard.get(c.id) ?? null;
    const cardReviews = reviews.filter((r) => r.card_id === c.id);
    // 拒绝过、且之后没再复习 → 视为「需重学」，要体现在原文标注上
    const needsRelearn =
      !!c.rejected_at && (!fsrs?.last_review_at || fsrs.last_review_at < c.rejected_at);

    for (const fid of fragIds) {
      const s = stats.get(fid) ?? emptyStat(fid);
      s.card_count += 1;
      if (c.is_choice) s.choice_count += 1;
      if (needsRelearn) s.relearn_count += 1;
      s.review_count += cardReviews.length;
      s.again_count += cardReviews.filter((r) => r.rating === 1).length;
      s.reps += fsrs?.reps ?? 0;
      s.lapses += fsrs?.lapses ?? 0;
      const last = cardReviews.reduce<string | null>(
        (acc, r) => (!acc || r.reviewed_at > acc ? r.reviewed_at : acc),
        s.last_review_at ?? null
      );
      s.last_review_at = last;
      stats.set(fid, s);
    }
  }

  for (const s of stats.values()) s.hot = gradeHot(s);
  return stats;
}

/** 材料级汇总：给资料库首页/统计页用 */
export function summarizeHot(
  fragments: SourceFragment[],
  stats: Map<ID, FragmentStat>
): { hotCount: number; watchCount: number; reviewCount: number; top: Array<{ frag: SourceFragment; stat: FragmentStat }> } {
  let hotCount = 0;
  let watchCount = 0;
  let reviewCount = 0;
  const rows: Array<{ frag: SourceFragment; stat: FragmentStat }> = [];

  for (const f of fragments) {
    const s = stats.get(f.id);
    if (!s) continue;
    reviewCount += s.review_count;
    if (s.hot === 2) hotCount++;
    else if (s.hot === 1) watchCount++;
    if (s.hot > 0) rows.push({ frag: f, stat: s });
  }

  rows.sort((a, b) => {
    if (b.stat.hot !== a.stat.hot) return b.stat.hot - a.stat.hot;
    if (b.stat.again_count !== a.stat.again_count) return b.stat.again_count - a.stat.again_count;
    return b.stat.review_count - a.stat.review_count;
  });

  return { hotCount, watchCount, reviewCount, top: rows };
}
