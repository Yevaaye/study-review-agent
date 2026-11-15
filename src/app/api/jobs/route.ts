import { listJobs } from "@/lib/jobs";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * AI 任务列表。
 *
 * 前端「AI 正在出题」浮层轮询这个接口：只读内存，不碰数据库，
 * 所以即使一边生成卡片一边每 800ms 查一次，也不会拖慢别的请求。
 */
export async function GET() {
  try {
    return Response.json({ jobs: listJobs() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e, "读取任务失败");
  }
}
