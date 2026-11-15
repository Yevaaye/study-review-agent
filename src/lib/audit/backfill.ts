/**
 * 把「已经在库里、但没有台账」的历史痕迹回填成台账。
 *
 * 两批来源：
 *   1) answer_fix_logs（74 条存量）—— 每一次答案被修补的正式记录，
 *      但只有 textbook_id，没有节点链路 / 题型 / 函数管道；
 *   2) status=active 且 rejected_at 非空的卡 —— 历次「拒绝入复习」的结果，
 *      只有时间戳，没有「当时是什么状态」。
 *
 * 回填的目的不是补全历史，而是**让监督员一上手就有样本**（74 条足够看出
 * 「答案截断是主要漏法」这类结论），而不是等攒够 20 次操作才开始。
 *
 * 两条诚实约定：
 *   · id 用 `bf-` 前缀 + 原记录 id，天然幂等，重复回填不会写两遍；
 *   · 回填记录带 backfilled 标记 / pipeline 里写明「无原始管道数据」，
 *     免得监督员把「不知道」当成「当时就是 null」。
 */

import type { CardStore } from "../db/store";
import type { AnswerGapReason, AnswerGapReport, Card, ReviewRejection, SourceFragment } from "../db/types";
import { describeQuestionType, step } from "./ledger-model";
import { appendAnswerGap, appendRejections } from "./ledger-file";
import { resolveCardNode } from "./node-resolve";

const nowISO = () => new Date().toISOString();

/** answer_fix_logs.reason → 台账的 symptom（multi_answer 归入 truncated：都是「只抽到一段」） */
export function mapFixReason(reason: string | null | undefined): AnswerGapReason {
  if (reason === "missing") return "missing";
  if (reason === "inaccurate") return "inaccurate";
  return "truncated";
}

async function nodeOf(store: CardStore, card: Card) {
  // 复用 resolveCardNode 的同一套口径，避免回填与实时记录两条统计线
  return resolveCardNode(store, card);
}

export interface BackfillReport {
  gaps_added: number;
  gaps_scanned: number;
  rejections_added: number;
  rejections_scanned: number;
  skipped: number;
}

export async function backfillLedgers(store: CardStore): Promise<BackfillReport> {
  const report: BackfillReport = {
    gaps_added: 0,
    gaps_scanned: 0,
    rejections_added: 0,
    rejections_scanned: 0,
    skipped: 0,
  };

  // ---- 1. 答案修正记录 → 答案缺口台账 ----
  const fixLogs = await store.listAnswerFixLogs();
  report.gaps_scanned = fixLogs.length;
  const gapRows: AnswerGapReport[] = [];
  for (const log of fixLogs) {
    if (!log.card_id) {
      report.skipped++;
      continue;
    }
    const card = await store.getCard(log.card_id);
    if (!card) {
      report.skipped++;
      continue;
    }
    gapRows.push({
      id: `bf-gap-${log.id}`,
      node: await nodeOf(store, card),
      question: String(log.question ?? card.front ?? "").slice(0, 400),
      question_type: describeQuestionType(card),
      symptom: mapFixReason(log.reason),
      outcome: "fixed",
      block_reason: "",
      before_answer: String(log.before ?? "").slice(0, 1200),
      after_answer: String(log.after ?? "").slice(0, 1200),
      source_excerpt: String(log.source_excerpt ?? "").slice(0, 600),
      knowledge_points: Array.isArray(log.knowledge_points) ? log.knowledge_points.slice(0, 8) : [],
      diagnosis: String(log.diagnosis ?? "").slice(0, 600),
      grounded: log.grounded === true,
      user_note: log.note ?? null,
      pipeline: [
        step("backfill", "从 answer_fix_logs 回填，无原始管道数据", "info"),
        step(
          "trigger",
          log.trigger === "rule" ? "导入时规则层自动补齐" : "用户点「答案不全」后 AI 重生成",
          "info"
        ),
      ],
      created_at: log.created_at ?? nowISO(),
    });
  }
  for (const row of gapRows) {
    await appendAnswerGap(row);
  }
  report.gaps_added = gapRows.length;

  // ---- 2. 已拒绝入复习的卡 → 拒绝台账 ----
  const active = await store.listCards({ status: "active" });
  const rejected = active.filter((c) => !!c.rejected_at);
  report.rejections_scanned = rejected.length;
  const rejRows: ReviewRejection[] = [];
  for (const card of rejected) {
    rejRows.push(await backfillRejection(store, card));
  }
  await appendRejections(rejRows);
  report.rejections_added = rejRows.length;

  return report;
}

async function backfillRejection(store: CardStore, card: Card): Promise<ReviewRejection> {
  const at = card.rejected_at ?? card.updated_at ?? nowISO();
  let frags: SourceFragment[] = [];
  try {
    frags = await store.listCardSources(card.id);
  } catch {
    /* 来源表坏了也要能回填 */
  }
  return {
    id: `bf-rej-${card.id}`,
    node: await nodeOf(store, card),
    question: String(card.front ?? "").slice(0, 400),
    question_type: describeQuestionType(card),
    snapshot: {
      front: String(card.front ?? "").slice(0, 1200),
      back: String(card.back ?? "").slice(0, 1200),
      options: card.options ?? null,
      answer: card.answer ?? null,
      answers: card.answers ?? null,
      is_multi: card.is_multi === true,
      card_type: card.card_type ?? null,
    },
    context: {
      source: "cards",
      fsrs_before: null,
      due_after: at,
      batch_size: null,
      backfilled: true,
    },
    note: null,
    pipeline: [
      step("backfill", "从 status=active 且 rejected_at 非空的卡回填", "info"),
      step("applyVerdict", "当时未记录，只能确认结果：进了复习队列", "info"),
      step(
        "schedule",
        `来源片段 ${frags.length} 个；FSRS 当时状态未记录`,
        "info"
      ),
    ],
    created_at: at,
  };
}

/** 供脚本/接口返回用的计数辅助（避免上层重复实现） */
export function backfillSummary(r: BackfillReport): string {
  return (
    `答案缺口回填 ${r.gaps_added}/${r.gaps_scanned} 条，` +
    `拒绝台账回填 ${r.rejections_added}/${r.rejections_scanned} 条，` +
    `跳过 ${r.skipped} 条（卡片已删/无 card_id）`
  );
}
