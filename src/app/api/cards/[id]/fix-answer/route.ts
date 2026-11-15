import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import {
  REPAIR_REASONS,
  repairCardAnswer,
  type RepairReason,
} from "@/lib/cards/answer-repair";

export const dynamic = "force-dynamic";
// 一次 AI 检索 + 生成可能几十秒
export const maxDuration = 90;

/**
 * 「答案不全」修复入口。
 *
 * body: { reason: "missing" | "truncated" | "inaccurate", note?: string, fullText?: boolean }
 *
 * 处理顺序：**先检索原文，找到就采用原文标准答案**；原文没有才让 AI 依据材料整理。
 * fullText=true 时把检索范围放开到全书正文（答案被排到别的章节时用）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await readJSON(req)) as Record<string, unknown>;
    const reason = String(body.reason ?? "") as RepairReason;
    if (!REPAIR_REASONS.includes(reason)) {
      return Response.json(
        { ok: false, error: `reason 必须是 ${REPAIR_REASONS.join(" / ")}` },
        { status: 400 }
      );
    }
    const note = body.note == null ? null : String(body.note).slice(0, 200);
    const fullText = body.fullText === true;

    const store = await getStore();
    const card = await store.getCard(id);
    if (!card) return Response.json({ ok: false, error: "卡片不存在" }, { status: 404 });

    const result = await repairCardAnswer(store, card, { reason, note, fullText });
    if (!result.ok) {
      // no-material / insufficient / write-failed：保留原答案，前端展示原因
      return Response.json({
        ok: false,
        error:
          result.reason === "no-material"
            ? "这张卡没有可用的原文材料，无法核对补全"
            : result.reason === "write-failed"
              ? "写入失败，原答案未改动"
              : result.reason === "llm-error"
                ? "模型调用失败（超时或未配置），原答案未改动"
                : "AI 没能给出可靠答案，原答案未改动",
        reason: result.reason,
        // 每次尝试（含失败）都会落一条答案缺口台账，这里回传 id 便于前端/监督员对上号
        gap_id: result.gap_id ?? null,
      });
    }

    revalidatePath("/cards");
    return Response.json({
      ok: true,
      back: result.answer,
      // "source" = 直接用了原文标准答案；"ai" = 原文没有、AI 整理
      origin: result.origin ?? "ai",
      scope: result.scope ?? null,
      source_fragment_id: result.source_fragment_id ?? null,
      knowledge_points: result.knowledge_points,
      diagnosis: result.diagnosis,
      grounded: result.grounded,
      log_id: result.log?.id ?? null,
      gap_id: result.gap_id ?? null,
    });
  } catch (e) {
    return errorResponse(e, "答案修复失败");
  }
}
