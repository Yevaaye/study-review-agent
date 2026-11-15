import { getStore } from "@/lib/db/store";
import { fillCardAnswer } from "@/lib/cards/answer-fill";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 给单张卡「AI 补答案」。
 *
 * 只依据卡片绑定的知识点 + 所属章节正文作答，材料不足时宁可不写：
 * 返回 422 并说明原因，卡片保持「待补答案」，不会出现一条编造的答案。
 * 成功时落 answer_origin="ai"，审核台据此显示「AI 生成」。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const store = await getStore();
    const card = await store.getCard(id);
    if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });

    if ((card.back ?? "").trim() && card.answer_origin !== "ai") {
      return Response.json(
        { error: "这张卡已经有答案了，不需要补", reason: "has-answer" },
        { status: 409 }
      );
    }

    const r = await fillCardAnswer(store, card);
    if (!r.ok) {
      const message =
        r.reason === "no-material"
          ? "这张卡找不到可依据的材料（知识点和章节正文都是空的），无法生成答案"
          : r.reason === "write-failed"
            ? "答案生成了但写入失败，请再试一次"
            : "AI 这次没给出可用答案，可以再试一次";
      return Response.json(
        { error: message, reason: r.reason },
        { status: r.reason === "write-failed" ? 500 : 422 }
      );
    }

    return Response.json({
      ok: true,
      answer: r.answer,
      origin: "ai",
      grounded: r.grounded ?? false,
    });
  } catch (e) {
    return errorResponse(e, "生成答案失败");
  }
}
