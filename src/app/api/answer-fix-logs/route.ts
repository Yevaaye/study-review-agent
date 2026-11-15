import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * 答案修正审计台账。
 *
 * GET /api/answer-fix-logs?cardId=&trigger=user|rule&limit=
 * 规则层自动补齐（trigger=rule）与用户点「答案不全」（trigger=user）都在这里，
 * 每条带原因、修正前后文本、原文摘录、知识点与诊断，供复盘识别准确率。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cardId = url.searchParams.get("cardId") || undefined;
    const triggerParam = url.searchParams.get("trigger");
    const trigger = triggerParam === "user" || triggerParam === "rule" ? triggerParam : undefined;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));

    const store = await getStore();
    const logs = await store.listAnswerFixLogs({ cardId, trigger, limit });
    return Response.json({ logs, total: logs.length });
  } catch (e) {
    return errorResponse(e, "读取修正台账失败");
  }
}
