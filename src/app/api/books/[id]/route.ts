import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * 删除一份材料（连同它的章节 / 片段 / 卡片 / 复习记录）。
 * 用于「删掉重传」的测试循环 —— 硬删除，不残留孤儿卡。
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const store = await getStore();
    const result = await store.deleteTextbook(id);
    if (!result.ok) return Response.json({ error: "材料不存在" }, { status: 404 });

    // 首页待复习数、统计总数都会变，必须让缓存失效
    revalidatePath("/", "layout");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e, "删除材料失败");
  }
}
