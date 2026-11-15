// 答案修正台账的纯逻辑（只 type-only import，Node 可直接加载做单元测试）。
// 业务侧（导入路由 / AI 修复 / localStore 查询）都走这里，保证「原因分类」
// 只有一套定义，不会出现写入时叫 truncated、查询时找不到的问题。

import type { AnswerFixLog, AnswerFixReason, ID } from "../db/types";
import type { AnswerExpansion } from "../import/answer-expansion";

export type FixLogDraft = Omit<AnswerFixLog, "id" | "created_at">;

/** 规则层自动补齐：一条 expansion 对应一条审计记录。 */
export function buildRuleFixLogs(
  expansions: AnswerExpansion[],
  textbookId: ID | null,
  idByFront: Map<string, ID>
): FixLogDraft[] {
  return expansions.map((e) => ({
    card_id: idByFront.get(e.question) ?? null,
    textbook_id: textbookId,
    question: e.question,
    reason: e.reason as AnswerFixReason,
    trigger: "rule",
    before: e.before,
    after: e.after,
    source_excerpt: e.excerpt,
    knowledge_points: [],
    diagnosis:
      e.reason === "multi_answer"
        ? "答案行只抽到摘要句；同一原文段落里还有并列答案（第二个概念/第二种情况），主状态机因 cur.answer 非空把后续正文丢弃。"
        : "答案行只抽到摘要句；紧随其后的段落是完整答案，主状态机未把它并入 answer，属于答案截断。",
    grounded: true,
    note: null,
  }));
}

/** 用户点「答案不全」→ AI 重生成后的记录。 */
export function buildUserFixLog(input: {
  cardId: ID;
  textbookId?: ID | null;
  question: string;
  reason: AnswerFixReason;
  before: string;
  after: string;
  excerpt: string;
  knowledgePoints: string[];
  diagnosis: string;
  grounded: boolean;
  note?: string | null;
}): FixLogDraft {
  return {
    card_id: input.cardId,
    textbook_id: input.textbookId ?? null,
    question: input.question,
    reason: input.reason,
    trigger: "user",
    before: input.before,
    after: input.after,
    source_excerpt: input.excerpt,
    knowledge_points: input.knowledgePoints,
    diagnosis: input.diagnosis,
    grounded: input.grounded,
    note: input.note?.trim() || null,
  };
}

export interface FixLogFilters {
  cardId?: ID;
  trigger?: "user" | "rule";
  limit?: number;
}

export function filterFixLogs(logs: AnswerFixLog[], filters: FixLogFilters = {}): AnswerFixLog[] {
  let rows = logs.slice();
  if (filters.cardId) rows = rows.filter((l) => l.card_id === filters.cardId);
  if (filters.trigger) rows = rows.filter((l) => l.trigger === filters.trigger);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return filters.limit ? rows.slice(0, filters.limit) : rows;
}

/** 按原因汇总，供后续持续迭代识别准确率（哪种漏法最多，先修哪种）。 */
export function summarizeFixReasons(logs: AnswerFixLog[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of logs) out[l.reason] = (out[l.reason] ?? 0) + 1;
  return out;
}
