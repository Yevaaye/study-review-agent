import { getStore } from "@/lib/db/store";

export const dynamic = "force-dynamic";

// 导出 JSON：全部数据（材料/片段/卡片/FSRS 状态/复习事件）
export async function GET() {
  const store = await getStore();
  const textbooks = await store.listTextbooks();
  const cards = await store.listCards();
  // 导出是备份手段，不能静默截断：旧实现写死 10000 条，
  // 超过之后导出来的文件就少了一段复习历史，而且用户完全看不出来。
  const reviews = await store.listReviews(undefined, Number.POSITIVE_INFINITY);

  const books = await Promise.all(
    textbooks.map(async (t) => ({
      ...t,
      chapters: await store.listChapters(t.id),
      fragments: await store.listFragments(t.id),
    }))
  );

  const cardsWithFsrs = await Promise.all(
    cards.map(async (c) => ({
      ...c,
      fsrs: await store.getFsrsState(c.id),
      sources: await store.listCardSources(c.id),
    }))
  );

  const body = JSON.stringify(
    { exported_at: new Date().toISOString(), books, cards: cardsWithFsrs, reviews },
    null,
    2
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="study-export-${Date.now()}.json"`,
    },
  });
}
