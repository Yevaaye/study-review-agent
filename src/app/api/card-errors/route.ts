import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import type { CardErrorKind, CardErrorReport, CardErrorStatus } from "@/lib/db/types";
import {
  buildSupervisorReview,
  isErrorKind,
  normalizeReportInput,
  reportIsUseful,
  snapshotOf,
  summarizeErrors,
} from "@/lib/cards/error-report";

export const dynamic = "force-dynamic";

const STATUSES = new Set<CardErrorStatus>(["open", "reviewed", "fixed", "dismissed"]);

/**
 * 出题错误台账。
 *
 * GET  ?status=open|reviewed|fixed|dismissed  ?kind=  ?cardId=  ?textbookId=  ?limit=
 *      ?view=summary  只回统计
 *      ?view=review   回统计 + 监督员核查结论（学习复盘 Agent 直接取这个）
 *      ?format=agent  紧凑格式：去掉快照里的大字段，只留监督员需要的
 * POST  上报一条（复习页「错误」按钮 / 标注正确答案）
 * PATCH 监督员回填结论（status / verdict / suggested_action）
 *
 * 为什么 GET 就够给 Agent 用：监督员是「拉取 → 聚类 → 出结论」的只读流程，
 * 不需要拿全库；真正的写回（改卡 / 改规则）由人确认后走卡片接口。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const store = await getStore();
    const cardId = url.searchParams.get("cardId") ?? undefined;
    const textbookId = url.searchParams.get("textbookId") ?? undefined;
    const rawStatus = url.searchParams.get("status");
    const rawKind = url.searchParams.get("kind");
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const view = url.searchParams.get("view");
    const format = url.searchParams.get("format");

    const status = rawStatus && STATUSES.has(rawStatus as CardErrorStatus)
      ? (rawStatus as CardErrorStatus)
      : undefined;
    const kind = isErrorKind(rawKind) ? (rawKind as CardErrorKind) : undefined;

    const reports = await store.listCardErrorReports({
      cardId,
      textbookId,
      status,
      kind,
      // 统计类视图要看全量，明细才限条数
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });

    const summary = summarizeErrors(reports);

    if (view === "review") {
      const review = buildSupervisorReview(reports);
      return Response.json({ ok: true, summary, review, count: reports.length });
    }
    if (view === "summary") {
      return Response.json({ ok: true, summary, count: reports.length });
    }
    if (format === "agent") {
      // 给 Agent 的紧凑视图：保留病因、标注、监督员结论，砍掉长文本快照里用不到的部分
      const rows = reports.map((r) => ({
        id: r.id,
        card_id: r.card_id,
        kind: r.kind,
        note: r.note,
        marked_keys: r.marked_keys,
        status: r.status,
        created_at: r.created_at,
        front: (r.snapshot?.front ?? "").slice(0, 120),
        answer: r.snapshot?.answer ?? null,
        options: r.snapshot?.options ?? null,
        is_multi: r.snapshot?.is_multi ?? false,
      }));
      return Response.json({ ok: true, summary, reports: rows, count: rows.length });
    }

    return Response.json({ ok: true, summary, reports, count: reports.length });
  } catch (e) {
    return errorResponse(e, "读取错误台账失败");
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    const cardId = String(body.card_id ?? "").trim();
    if (!cardId) return Response.json({ error: "缺少 card_id" }, { status: 400 });

    const store = await getStore();
    const card = await store.getCard(cardId);
    if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });

    const input = normalizeReportInput(body, card);
    if (!reportIsUseful(input)) {
      return Response.json({ error: "请至少选择一个错误类型或写一句说明" }, { status: 400 });
    }

    const textbookId =
      (typeof body.textbook_id === "string" ? body.textbook_id : null) ?? null;

    const [row] = await store.createCardErrorReports([
      {
        card_id: cardId,
        textbook_id: textbookId,
        kind: input.kind,
        note: input.note,
        snapshot: snapshotOf(card),
        marked_keys: input.marked_keys,
        source: body.source === "cards" ? "cards" : "review",
        verdict: null,
        suggested_action: null,
      },
    ]);

    return Response.json({ ok: true, report: row });
  } catch (e) {
    return errorResponse(e, "上报失败");
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await readJSON(req);
    const id = String(body.id ?? "").trim();
    if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });

    const patch: Partial<Omit<CardErrorReport, "id" | "created_at">> = {};
    const nextStatus = body.status;
    if (typeof nextStatus === "string" && STATUSES.has(nextStatus as CardErrorStatus)) {
      patch.status = nextStatus as CardErrorStatus;
      patch.reviewed_at = new Date().toISOString();
    }
    if (typeof body.verdict === "string") patch.verdict = body.verdict.slice(0, 500);
    if (typeof body.suggested_action === "string") {
      patch.suggested_action = body.suggested_action.slice(0, 300);
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "没有可更新的字段" }, { status: 400 });
    }

    const store = await getStore();
    const row = await store.updateCardErrorReport(id, patch);
    if (!row) return Response.json({ error: "记录不存在" }, { status: 404 });
    return Response.json({ ok: true, report: row });
  } catch (e) {
    return errorResponse(e, "更新失败");
  }
}
