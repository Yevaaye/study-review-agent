import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import { readLedgerSnapshot } from "@/lib/audit/ledger-file";
import { backfillLedgers, backfillSummary } from "@/lib/audit/backfill";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 学习复盘监督员的两个台账入口（独立 JSON 文件：data/audit/*.json）。
 *
 * GET  /api/audit/ledgers              两本台账全量 + 交叉结论
 * GET  /api/audit/ledgers?format=agent 精简：去掉长文本，只留归因需要的字段
 * POST /api/audit/ledgers { action: "backfill" }  把库里的历史痕迹回填进台账
 *
 * 为什么 GET 默认给全量：
 *   这两本台账本身就是「已经削过一刀」的样本集（只有过程缺陷，没有原文全文），
 *   条数天然有限。监督员要按题型/节点/函数阶段分组，缺字段反而没法归因。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get("format");
    const snapshot = await readLedgerSnapshot();

    if (format === "agent") {
      // 精简视图：保留节点标题、题型、成因、管道，砍掉 before/after 长文本
      const gaps = snapshot.answer_gaps.items.map((i) => ({
        id: i.id,
        card_id: i.node.card_id,
        book: i.node.textbook_title,
        chapter: i.node.chapter_title ?? i.node.chapter_path.join(" / "),
        kp: i.node.kp_statement,
        type: i.question_type.kind,
        symptom: i.symptom,
        outcome: i.outcome,
        block_reason: i.block_reason,
        diagnosis: i.diagnosis,
        // 第一个 reject 的步骤才是真正卡点（writeBack 永远 reject，取最后一个会全归成它）
        block_step: i.pipeline.find((p) => p.verdict === "reject")?.step ?? null,
        created_at: i.created_at,
      }));
      const rejections = snapshot.rejections.items.map((i) => ({
        id: i.id,
        card_id: i.node.card_id,
        book: i.node.textbook_title,
        chapter: i.node.chapter_title ?? i.node.chapter_path.join(" / "),
        kp: i.node.kp_statement,
        type: i.question_type.kind,
        first_time: !i.context.fsrs_before && !i.context.backfilled,
        source: i.context.source,
        created_at: i.created_at,
      }));
      return Response.json({
        ok: true,
        generated_at: snapshot.generated_at,
        answer_gaps: { totals: snapshot.answer_gaps.totals, items: gaps },
        rejections: { totals: snapshot.rejections.totals, items: rejections },
        cross_findings: snapshot.cross_findings,
      });
    }

    return Response.json({ ok: true, ...snapshot });
  } catch (e) {
    return errorResponse(e, "读取审计台账失败");
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    if (String(body.action ?? "") !== "backfill") {
      return Response.json({ error: "action 只能是 backfill" }, { status: 400 });
    }
    const store = await getStore();
    const report = await backfillLedgers(store);
    const snapshot = await readLedgerSnapshot();
    return Response.json({
      ok: true,
      report,
      message: backfillSummary(report),
      totals: {
        answer_gaps: snapshot.answer_gaps.totals,
        rejections: snapshot.rejections.totals,
      },
      cross_findings: snapshot.cross_findings,
    });
  } catch (e) {
    return errorResponse(e, "回填审计台账失败");
  }
}
