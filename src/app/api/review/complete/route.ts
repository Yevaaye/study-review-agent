import { getStore } from "@/lib/db/store";
import { readJSON, requireFields, errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

// 完成复习会话
export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    requireFields(body, ["session_id"]);
    const store = await getStore();
    const session = await store.getReviewSession(String(body.session_id));
    if (!session) return Response.json({ error: "会话不存在" }, { status: 404 });
    await store.completeReviewSession(session.id);

    // 本轮结果：已评分 / 未评分（没想起来的卡片再次进入队列）
    const sessionCards = await store.listSessionCards(session.id);
    const rated = sessionCards.filter((sc) => sc.rated).length;
    const unrated = sessionCards.filter((sc) => !sc.rated).length;
    return Response.json({ session, rated, unrated });
  } catch (e) {
    return errorResponse(e, "完成失败");
  }
}
