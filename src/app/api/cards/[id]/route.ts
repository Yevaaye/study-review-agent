import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";

export const dynamic = "force-dynamic";

// 卡片操作：approve（审核通过）/ reject（加入复习）/ invalidate（内容错误作废）/ restore / 编辑 / 删除
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await readJSON(req);
    const action = String(body.action ?? "");
    const store = await getStore();

    switch (action) {
      case "approve": {
        const result = await store.approveCard(id);
        if (!result) return Response.json({ error: "卡片不存在" }, { status: 404 });
        revalidatePath("/", "layout"); // 首页/统计页的待复习数必须跟着变
        return Response.json({ card: result.card, fsrs: result.fsrs });
      }
      case "reject": {
        const result = await store.rejectCard(id);
        if (!result) return Response.json({ error: "卡片不存在" }, { status: 404 });
        revalidatePath("/", "layout");
        return Response.json({ card: result.card, fsrs: result.fsrs });
      }
      case "invalidate": {
        // 内容错误：AI 把非题目内容误判成题。既不通过也不复习，数据保留可恢复。
        const card = await store.invalidateCard(id);
        if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });
        revalidatePath("/", "layout");
        return Response.json({ card });
      }
      case "restore": {
        // 撤销「内容错误」：放回待审核
        const card = await store.restoreCard(id);
        if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });
        revalidatePath("/", "layout");
        return Response.json({ card });
      }
      case "edit": {
        // content_revision 由 store 在内容变更时自动自增，不读客户端传值
        const card = await store.updateCard(id, {
          front: body.front ? String(body.front) : undefined,
          back: body.back ? String(body.back) : undefined,
        });
        if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });
        return Response.json({ card });
      }
      case "bindKp": {
        // 手动把「未关联」的原题归属到某个知识点（或解绑）。
        // 只改 kp_id，不碰状态机 —— 归属错了不该影响审核/复习进度。
        const kpId = body.kp_id === null ? null : String(body.kp_id ?? "");
        if (kpId !== null && !kpId) return Response.json({ error: "缺少 kp_id" }, { status: 400 });
        const ok = await store.patchCardMeta(id, { kp_id: kpId });
        if (!ok) return Response.json({ error: "卡片不存在" }, { status: 404 });
        revalidatePath("/", "layout");
        return Response.json({ ok: true, kp_id: kpId });
      }
      default:
        return Response.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (e) {
    return errorResponse(e, "操作失败");
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await getStore();
  const ok = await store.deleteCard(id);
  if (!ok) return Response.json({ error: "卡片不存在" }, { status: 404 });
  return Response.json({ ok: true });
}
