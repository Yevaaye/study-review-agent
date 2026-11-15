import { getStore } from "@/lib/db/store";
import type { Card, CardStatus } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * 卡片列表。
 *
 * status: draft / active / mastered / all（缺省或 all = 不过滤）
 * type:   choice / qa / cloze / judge —— 按真实题型 card_type 过滤
 * fragmentId / chapterId：只看某段原文 / 某一章挂着的卡片
 *
 * 为什么不用 is_choice：早期判断题被存成「二选一」（is_choice=true, options=[对,错]），
 * 用 is_choice 筛「选择题」会连判断题一起捞出来，用户会以为材料里凭空多了一堆选择题。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const textbookId = url.searchParams.get("textbookId") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const fragmentId = url.searchParams.get("fragmentId") ?? undefined;
  const chapterId = url.searchParams.get("chapterId") ?? undefined;
  const store = await getStore();

  // all / 空 = 不过滤。注意不能把 "all" 直接塞给 listCards，那会一张都查不到。
  const filterStatus =
    rawStatus && rawStatus !== "all" ? (rawStatus as CardStatus) : undefined;

  /** 题型：新数据看 card_type，老数据退回 is_choice */
  const typeOf = (c: Card) => c.card_type ?? (c.is_choice ? "choice" : "qa");
  const matchType = (c: Card) => !type || type === "all" || typeOf(c) === type;

  const all = await store.listCards({ textbookId, fragmentId, chapterId });
  const typed = all.filter(matchType);
  const cards = filterStatus ? typed.filter((c) => c.status === filterStatus) : typed;
  const counts = {
    draft: typed.filter((c: Card) => c.status === "draft").length,
    active: typed.filter((c: Card) => c.status === "active").length,
    mastered: typed.filter((c: Card) => c.status === "mastered").length,
    invalid: typed.filter((c: Card) => c.status === "invalid").length,
    total: typed.length,
  };

  // 附带来源片段与复习进度，供审核台「回到原文」跳转、显示「复习过几次」
  const withSources = await Promise.all(
    cards.map(async (c) => {
      const fsrs = await store.getFsrsState(c.id);
      return {
        ...c,
        sources: await store.listCardSources(c.id),
        review: {
          /** 累计复习轮次 */
          reps: fsrs?.reps ?? 0,
          /** 遗忘次数（Again 的次数） */
          lapses: fsrs?.lapses ?? 0,
          /** FSRS 状态：0 新卡 / 1 学习中 / 2 复习 / 3 重学 */
          state: fsrs?.state ?? 0,
          schedule_status: fsrs?.schedule_status ?? "new",
          last_review_at: fsrs?.last_review_at ?? null,
          due_at: fsrs?.due_at ?? null,
        },
      };
    })
  );

  return Response.json({ cards: withSources, counts });
}
