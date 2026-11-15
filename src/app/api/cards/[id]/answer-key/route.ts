import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import { buildAnswerFields, answerLabels, correctKeysOf } from "@/lib/cards/answer-keys";
import { snapshotOf } from "@/lib/cards/error-report";

export const dynamic = "force-dynamic";

/**
 * 手动标注正确答案（单选 / 多选）。
 *
 * 场景就是用户的原话：「多选用于标注图片中正确答案」——
 * 抽出来的题，正确答案要么错、要么只标了其中一项，用户比 AI 清楚。
 * 这里一次做完三件事，缺一件都会让修正白做：
 *   1) 写回卡片：answer / answers / is_multi（由答案键派生，单一真源）；
 *   2) 留一条台账：kind = answer_key_wrong，marked_keys 记录用户标注；
 *   3) 返回可直接渲染的新字段，复习页不用重新拉接口。
 *
 * 为什么允许把单选改成多选：原文里「A、C 都对」的题，抽取时只拿到一个键，
 * 用户勾两个就是最直接的修复证据 —— 不让改，等于把这类题永远钉死在错误状态。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJSON(req);
    const store = await getStore();
    const card = await store.getCard(id);
    if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });

    const options = Array.isArray(card.options) ? card.options : [];
    if (options.length < 2) {
      return Response.json({ error: "这张卡没有选项，不能标注正确答案" }, { status: 400 });
    }

    const rawKeys = Array.isArray(body.keys) ? body.keys : [];
    const keys = [...new Set(rawKeys.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length))].sort(
      (a, b) => a - b
    );
    if (keys.length === 0) {
      return Response.json({ error: "至少选一个正确选项" }, { status: 400 });
    }

    const before = correctKeysOf(card);
    const fields = buildAnswerFields(options, keys);
    const updated = await store.updateCard(id, {
      answer: fields.answer,
      answers: fields.answers,
      is_multi: fields.is_multi,
    });
    if (!updated) return Response.json({ error: "写入失败" }, { status: 500 });

    const note =
      typeof body.note === "string" && body.note.trim()
        ? body.note.trim().slice(0, 400)
        : before.join(",") === keys.join(",")
          ? "用户确认正确答案（与原标注一致）"
          : `用户把正确答案从 ${before.map((i) => String.fromCharCode(65 + i)).join("、") || "未标注"} 改为 ${answerLabels(keys)}`;

    /*
     * backfill=true：批量补齐历史多选答案（脚本调用）。
     * 这不算「用户修正」—— 卡片本来就是对的，只是旧版本没把「①②③」解析成多选题。
     * 因此不写台账，否则错误台账会被几十条「已修正」冲淡，
     * 监督员看到的全是噪声，真正的人工反馈反而被埋掉。
     */
    if (body.backfill === true) {
      return Response.json({
        ok: true,
        answer: updated.answer,
        answers: updated.answers ?? null,
        is_multi: updated.is_multi === true,
        keys,
        report_id: null,
        backfilled: true,
      });
    }

    const [report] = await store.createCardErrorReports([
      {
        card_id: id,
        textbook_id: null,
        kind: "answer_key_wrong",
        note,
        // 快照取「改之前」的卡片：修好之后就再也看不到错在哪了
        snapshot: snapshotOf(card),
        marked_keys: keys,
        source: body.source === "cards" ? "cards" : "review",
        // 用户已经亲自改对了，记录直接记为 fixed，监督员不必再核
        status: "fixed",
        verdict: "用户在复习页手动标注正确答案",
        suggested_action: fields.is_multi ? "已改为多选判定" : "已改为单选判定",
        reviewed_at: new Date().toISOString(),
      },
    ]);

    return Response.json({
      ok: true,
      answer: updated.answer,
      answers: updated.answers ?? null,
      is_multi: updated.is_multi === true,
      keys,
      report_id: report?.id ?? null,
    });
  } catch (e) {
    return errorResponse(e, "标注失败");
  }
}
