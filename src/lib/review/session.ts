import type { CardStore } from "@/lib/db/store";
import type { ReviewSession, ReviewSessionCard } from "@/lib/db/types";
import { hydrateSessionAnswers } from "./answer-freshness";
import { findAnsweredSince, normalizeScope } from "./progress";

/**
 * 读一轮会话的卡片，并把它跟「真实的作答事实」对齐。
 *
 * 单看 session_card.rated 会漏一种很常见的情况：同一张题在另一轮会话里被答过
 * （换了一本书又换回来、开了两个标签页、上一轮没点完成就退出）。这时旧会话里
 * 那张卡的 rated 仍是 false，续接时又把它推给用户 —— 用户看到的就是
 * 「我明明答过这道题，怎么又让我复习」。
 *
 * 所以以「这一轮开始之后有没有复习事件」补一次判定，并把结果写回会话卡：
 * 这样 /api/review/complete 的「已答 / 未答」统计、下一次续接都一致，
 * 不会出现「界面跳过了这张，完成页却说它没答」。
 *
 * 顺带做「认领」：把其它进行中的会话收尾。读接口做写操作不优雅，但这两个调用
 * 本来就只在「续接一轮」时发生（每次进复习页一次），换来的是状态机不会出现
 * 「两轮同时进行」这种自相矛盾的局面。
 */
export async function loadSessionCardsWithProgress(
  store: CardStore,
  session: ReviewSession
): Promise<ReviewSessionCard[]> {
  const rows = await store.listSessionCards(session.id);
  if (rows.length === 0) return rows;

  // 认领这一轮：同范围只留一个「进行中」，否则上一轮刚刷完，下一页进来
  // 又续接到更早的僵尸会话，看起来就是「又冒出几十道早就答过的题」。
  //
  // 注意只收尾**同范围**：跨书的进行中会话要各自活着 —— 用户「A 书刷一半 →
  // 去 B 书 → 回 A 书」时，A 那轮的 rated 位就是他能续接的全部依据。
  await store.abandonOtherInProgress(session.id, normalizeScope(session.scope));

  const reviews = await store.listReviewsAfter(session.started_at);
  const extra = findAnsweredSince(rows, reviews, session.started_at);

  for (const e of extra) {
    const row = rows[e.index];
    row.rated = true;
    // 指向「真正答过它的那次评分」，便于追溯；与自有会话卡的 review_id 同义
    row.review_id = e.reviewId;
    await store.markSessionCardRated(row.id, e.reviewId);
  }

  // 最后统一做答案保鲜：会话卡里存的是建会话那一刻的快照，
  // 之后 AI 补全 / 手工改答案都不会回写到快照。不同步的话，用户补完答案
  // 回到这道题看到的还是旧的半截答案，会以为补全没生效、反复补同一题。
  return hydrateSessionAnswers(store, rows);
}
