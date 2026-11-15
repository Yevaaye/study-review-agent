import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * 批量审核：一次请求处理整批卡片。
 *
 * 之前的实现是前端 for 循环逐张 POST /api/cards/:id。
 * 60 张就是 60 次 HTTP + 60 次全量 db.json 写盘，耗时数秒；
 * 用户点完就切到首页看数字 → 页面卸载 → 未完成的 fetch 全部被浏览器 abort，
 * 最终只有第一张生效（用户看到的「全部拒绝只进去一张」）。
 * 服务端一次事务处理，天然原子，也快一个数量级。
 */
export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    const action = String(body.action ?? "");
    if (action !== "approve" && action !== "reject") {
      return Response.json({ error: "action 只能是 approve 或 reject" }, { status: 400 });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : [];
    if (ids.length === 0) {
      return Response.json({ error: "没有指定要处理的卡片" }, { status: 400 });
    }

    const store = await getStore();
    const result = await store.batchReview(ids, action);

    // 让首页 / 统计页的 RSC 结果与客户端路由缓存一起失效，
    // 否则返回首页时可能还渲染着操作前的快照（用户感知为「数据不同步」）。
    revalidatePath("/", "layout");

    return Response.json(
      { ...result, action },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "批量操作失败");
  }
}
