import { resolveCardOrigins } from "@/lib/cards/origin";
import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/http";
import { normalizeScope } from "@/lib/review/progress";
import { loadSessionCardsWithProgress } from "@/lib/review/session";

export const dynamic = "force-dynamic";

/**
 * 当前这一轮复习（当天、未完成）。
 *
 * 复习页每次挂载都会问一次：如果还有没刷完的一轮，就直接接着刷；
 * 没有才回到「选一本书」。这是修「答了 5 题回来又从第 1 题开始」的关键 ——
 * 会话归属由服务端说了算，客户端不需要（也无法）自己记着。
 *
 * `?book=<id>` 时只认这本书的轮次：从书详情 / 原文跳回来，用户点的是 A 书，
 * 不该因为「最近一轮是 B 书」而把他扔进 B 书。这本书没有进行中的轮次就回空，
 * 让页面走正常的「开始这一本」流程，而不是硬塞另一本。
 *
 * 没有会话时返回 200 + session: null，而不是 404：
 * 这是常态分支（今天已经刷完 / 第一次用），404 会让前端日志里全是假错误。
 */
export async function GET(req: Request) {
  try {
    const store = await getStore();
    const book = new URL(req.url).searchParams.get("book")?.trim() || null;

    const sessions = await store.listInProgressSessions();
    const session = book
      ? (sessions.find((s) => normalizeScope(s.scope).textbook_id === book) ?? null)
      : (sessions[0] ?? null);
    if (!session) return Response.json({ session: null, cards: [], origins: {} });

    const cards = await loadSessionCardsWithProgress(store, session);
    if (cards.length === 0) {
      await store.abandonReviewSession(session.id);
      return Response.json({ session: null, cards: [], origins: {} });
    }

    const textbookId =
      typeof session.scope?.textbook_id === "string" ? session.scope.textbook_id : null;
    let origins: Record<string, unknown> = {};
    try {
      origins = await resolveCardOrigins(
        store,
        cards.map((c) => c.card_id),
        textbookId
      );
    } catch {
      origins = {};
    }

    return Response.json({ session, cards, origins, resumed: true });
  } catch (e) {
    return errorResponse(e, "读取当前复习会话失败");
  }
}
