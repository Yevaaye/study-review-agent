import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/http";
import { normalizeScope } from "@/lib/review/progress";
import {
  latestPerScope,
  summarizeProgress,
  type ResumableSession,
} from "@/lib/review/resume";

export const dynamic = "force-dynamic";

/**
 * 当天所有「没刷完」的复习轮次，供选书页展示断点。
 *
 * 为什么单独一个接口：选书页原来只有「各书待复习数」，那是**排期**口径，
 * 说不清「我这轮刷到第几张」。用户在 A 书答了 5 张、去 B 书、再回来，
 * 页面上 A 书的数字可能因为排期变化而不同，看起来就是进度没了。
 * 这里直接给每本书对应的会话 id 与 rated/total，页面才能写「继续 · 已答 5/30」。
 *
 * 全答完但还没点「完成」的轮次不算断点（它会自己走到完成页），一并跳过。
 */
export async function GET() {
  try {
    const store = await getStore();
    const [sessions, textbooks] = await Promise.all([
      store.listInProgressSessions(),
      store.listTextbooks(),
    ]);
    const titleById = new Map(textbooks.map((t) => [t.id, t.title]));

    const items: ResumableSession[] = [];
    for (const s of sessions) {
      const rows = await store.listSessionCards(s.id);
      if (rows.length === 0) continue;
      const sum = summarizeProgress(rows);
      if (sum.remaining === 0) continue;
      const scope = normalizeScope(s.scope);
      items.push({
        session_id: s.id,
        scope,
        total: sum.total,
        rated: sum.rated,
        remaining: sum.remaining,
        next_index: sum.nextIndex,
        started_at: s.started_at,
        textbook_title: scope.textbook_id ? (titleById.get(scope.textbook_id) ?? null) : null,
      });
    }

    return Response.json({ items: latestPerScope(items) });
  } catch (e) {
    return errorResponse(e, "读取复习断点失败");
  }
}
