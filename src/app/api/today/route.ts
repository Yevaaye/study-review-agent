import { getStore } from "@/lib/db/store";

export const dynamic = "force-dynamic";

// 今日任务：待复习卡片数 + 预计耗时 + 卡片清单 + 各书待复习分布
export async function GET() {
  const store = await getStore();
  /**
   * 这里必须扫全量到期卡，不能用展示用的切片。
   *
   * 之前 books 的分布是拿 listDueCards(200) 算的：只要今日到期超过 200 张，
   * 排序靠后的书就会算出 due = 0、前端显示「无到期」，
   * 而顶部的 stats.due_count 又是真实的 494 —— 同一页两个口径，用户看到
   * 「首页说 494，进来只有两本书有题」。分布统计和总数必须同源。
   */
  const DUE_SCAN_LIMIT = 10000;
  const LIST_LIMIT = 200;
  const [stats, allDue, allRetry, textbooks, sources] = await Promise.all([
    store.getTodayStats(),
    store.listDueCards(DUE_SCAN_LIMIT),
    store.listTodayRetryCards(DUE_SCAN_LIMIT),
    store.listTextbooks(),
    store.listAllCardSources(),
  ]);

  // 片段 → 书 的归属表（card_sources 只挂片段，要经片段中转到书）
  const frags = (await Promise.all(textbooks.map((t) => store.listFragments(t.id)))).flat();
  const bookByFrag = new Map(frags.map((f) => [f.id, f.textbook_id]));
  const bookByCard = new Map<string, string>();
  for (const cs of sources) {
    const b = bookByFrag.get(cs.source_fragment_id);
    if (b) bookByCard.set(cs.card_id, b);
  }

  const dueByBook = new Map<string, number>();
  for (const d of allDue) {
    const b = bookByCard.get(d.card_id);
    if (b) dueByBook.set(b, (dueByBook.get(b) ?? 0) + 1);
  }

  // 今日错题也按书拆开：选书页要能直接说「这本还有 2 道答错的没重做」
  const retryByBook = new Map<string, number>();
  for (const c of allRetry) {
    const b = bookByCard.get(c.id);
    if (b) retryByBook.set(b, (retryByBook.get(b) ?? 0) + 1);
  }

  const books = textbooks.map((t) => ({
    id: t.id,
    title: t.title,
    due: dueByBook.get(t.id) ?? 0,
    retry: retryByBook.get(t.id) ?? 0,
  }));

  // due 只作为「今日待复习」清单的预览，分布统计已经用全量算过
  return Response.json({ stats, due: allDue.slice(0, LIST_LIMIT), books });
}
