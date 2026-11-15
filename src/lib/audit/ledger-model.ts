/**
 * 学习复盘监督员台账的「形状」定义与汇总（纯函数，零 IO）。
 *
 * 为什么要单独一层纯函数：
 *   监督员拿到两份 JSON 之后要回答的是「哪类题反复没好答案、哪批节点反复被拒」。
 *   这类判断必须**可复现** —— 同一批记录每次跑出来的分组、文案、结论都得一样，
 *   否则没法用它判断「这次改动到底有没有把问题修少」。所以这里不调模型、不读库。
 *
 * 只做 type-only import：Node 可以直接加载本文件跑单元测试（见
 * scripts/audit-ledger-check.mjs），不需要起 Next.js。
 */

import type {
  AnswerGapReport,
  AuditNodeRef,
  AuditPipelineStep,
  AuditQuestionType,
  Card,
  Chapter,
  KnowledgePoint,
  ReviewRejection,
  SourceFragment,
  Textbook,
} from "../db/types";

// ---- 题型画像 ------------------------------------------------------------

const CIRCLED = /[\u2460-\u2473]/; // ①..⑳
const LETTER_ONLY = /^[A-Ha-h]$/;
const LETTER_LIST = /^[A-Ha-h](?:\s*[、,，/]\s*[A-Ha-h])+$/;
const NUMERIC_ONLY = /^\d{1,2}$/;

/** 答案写法形态 —— 决定「答案没答清楚」是抽取问题还是渲染问题 */
export function describeAnswerForm(answer: string | null | undefined): AuditQuestionType["answer_form"] {
  const raw = String(answer ?? "").trim();
  if (!raw) return "none";
  if (CIRCLED.test(raw)) return "circled";
  if (LETTER_ONLY.test(raw) || LETTER_LIST.test(raw)) return "letter";
  if (NUMERIC_ONLY.test(raw)) return "numeric";
  return "text";
}

/**
 * 题型画像。
 *
 * 判定顺序别改：先看有没有选项（有选项就是选择题，card_type 可能为空或是脏值），
 * 再用多选标记细分；无选项的才去读 card_type 区分判断 / 填空 / 对比。
 */
export function describeQuestionType(card: Pick<Card,
  "kind" | "options" | "answers" | "is_multi" | "answer" | "card_type"
>): AuditQuestionType {
  const options = Array.isArray(card.options) ? card.options : [];
  const optionCount = options.length;
  const answerCount = Array.isArray(card.answers) ? card.answers.length : 0;
  const isMulti = card.is_multi === true || answerCount >= 2;
  const isChoice = optionCount >= 2 || card.kind === "choice";

  let kind: AuditQuestionType["kind"];
  if (isChoice) {
    kind = isMulti ? "multi_choice" : "single_choice";
  } else if (card.card_type === "judge") {
    kind = "judge";
  } else if (card.card_type === "cloze") {
    kind = "cloze";
  } else if (card.card_type === "contrast") {
    kind = "contrast";
  } else {
    kind = "qa";
  }

  return {
    kind,
    is_choice: isChoice,
    is_multi: isMulti,
    option_count: optionCount,
    answer_form: describeAnswerForm(card.answer),
    card_type: card.card_type ?? null,
    card_kind: card.kind,
  };
}

// ---- 节点链路 ------------------------------------------------------------

export interface NodeRefInput {
  card: Pick<Card, "id" | "kp_id" | "chapter_path">;
  textbook?: Pick<Textbook, "id" | "title"> | null;
  chapter?: Pick<Chapter, "id" | "title"> | null;
  kp?: Pick<KnowledgePoint, "id" | "title" | "summary"> | null;
  fragments?: Pick<SourceFragment, "id" | "locator">[];
}

/**
 * 把「这张卡在哪」摊平成一条可定位的链路：书 → 章节 → 知识点 → 原文片段。
 *
 * 缺字段一律用 null / 空数组，不做猜测补齐 —— 监督员看到 null 就知道
 * 「这张卡根本没绑知识点」，这本身就是一条可优化的规律（未关联池占比）。
 */
export function describeNode(input: NodeRefInput): AuditNodeRef {
  const kpText = input.kp
    ? (String(input.kp.title ?? "").trim() || String(input.kp.summary ?? "").trim())
    : "";
  const fragments = Array.isArray(input.fragments) ? input.fragments : [];
  return {
    card_id: input.card.id,
    textbook_id: input.textbook?.id ?? null,
    textbook_title: input.textbook?.title ?? null,
    chapter_id: input.chapter?.id ?? null,
    chapter_title: input.chapter?.title ?? null,
    chapter_path: Array.isArray(input.card.chapter_path) ? input.card.chapter_path.slice(0, 4) : [],
    kp_id: input.card.kp_id ?? input.kp?.id ?? null,
    kp_statement: kpText || null,
    fragment_ids: fragments.map((f) => f.id),
    locator: fragments.find((f) => f.locator)?.locator ?? null,
  };
}

// ---- 函数管道 ------------------------------------------------------------

/** 收口一条 pipeline 记录，长度与字段都夹紧，避免日志无限膨胀 */
export function step(name: string, detail: string, verdict: AuditPipelineStep["verdict"] = "info"): AuditPipelineStep {
  return {
    step: String(name).slice(0, 60),
    detail: String(detail).replace(/\s+/g, " ").trim().slice(0, 240),
    verdict,
  };
}

// ---- 汇总 ----------------------------------------------------------------

function countBy<T>(rows: T[], pick: (row: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row) || "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  // 计数从大到小，监督员第一眼看到的就是主要矛盾
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export interface AnswerGapTotals {
  count: number;
  by_outcome: Record<string, number>;
  by_symptom: Record<string, number>;
  by_question_type: Record<string, number>;
  /** 未补全的卡在哪个函数阶段被拦住 —— 直接指向要改的那个判定 */
  by_block_step: Record<string, number>;
  /** 有多少条根本没绑知识点（未关联池），是抽取环节的硬伤 */
  unbound_kp: number;
  textbook_count: number;
}

export function summarizeAnswerGaps(items: AnswerGapReport[]): AnswerGapTotals {
  const unfixed = items.filter((i) => i.outcome === "unfixed");
  const blockSteps: Record<string, number> = {};
  for (const item of unfixed) {
    // 取**第一个** reject 的步骤 = 真正卡住的地方。
    // 取最后一个会落到 "writeBack"（它永远是 reject），把所有失败都归成一类，
    // 监督员就会去翻写回逻辑，而真实原因可能是模型调用挂了或材料不足。
    const first = item.pipeline.find((p) => p.verdict === "reject");
    const key = first?.step ?? "unknown";
    blockSteps[key] = (blockSteps[key] ?? 0) + 1;
  }
  return {
    count: items.length,
    by_outcome: countBy(items, (i) => i.outcome),
    by_symptom: countBy(items, (i) => i.symptom),
    by_question_type: countBy(items, (i) => i.question_type?.kind),
    by_block_step: Object.fromEntries(Object.entries(blockSteps).sort((a, b) => b[1] - a[1])),
    unbound_kp: items.filter((i) => !i.node?.kp_id).length,
    textbook_count: new Set(items.map((i) => i.node?.textbook_id).filter(Boolean)).size,
  };
}

export interface RejectionTotals {
  count: number;
  by_question_type: Record<string, number>;
  by_source: Record<string, number>;
  /** 按书分布：某本书被拒得特别多，通常是那本书的抽取质量差 */
  by_textbook: Record<string, number>;
  /** 按知识点分布：整章被拒往往意味着这章原文本身不好抽 */
  by_kp: Record<string, number>;
  /** 拒绝时「从没学过」的占比 —— 新卡被拒说明审核标准偏保守 */
  first_time: number;
  unbound_kp: number;
  batch_sizes: Record<string, number>;
}

export function summarizeRejections(items: ReviewRejection[]): RejectionTotals {
  return {
    count: items.length,
    by_question_type: countBy(items, (i) => i.question_type?.kind),
    by_source: countBy(items, (i) => i.context?.source),
    by_textbook: countBy(items, (i) => i.node?.textbook_title ?? i.node?.textbook_id),
    by_kp: countBy(items, (i) => i.node?.kp_statement ?? (i.node?.kp_id ? i.node.kp_id : "未关联知识点")),
    // 回填记录取不到当时的 FSRS，不能算作「新卡被拒」，否则会虚高审核保守度
    first_time: items.filter((i) => !i.context?.fsrs_before && !i.context?.backfilled).length,
    unbound_kp: items.filter((i) => !i.node?.kp_id).length,
    batch_sizes: countBy(items, (i) =>
      i.context?.batch_size ? String(i.context.batch_size) : "单张"
    ),
  };
}

// ---- 字段释义（写进 JSON，让监督员自己看得懂，不必翻代码）------------------

export const ANSWER_GAP_LEGEND: Record<string, string> = {
  node: "这张卡在知识树里的位置：书 → 章节 → 知识点 → 原文片段",
  question_type: "题型画像（kind/option_count/answer_form）",
  symptom: "用户看到的症状或 AI 补不出来的成因：missing/truncated/inaccurate/no_material/insufficient",
  outcome: "fixed=已补全；unfixed=没补上，卡片保持原样",
  block_reason: "没补上时卡在哪一步（人话）",
  before_answer: "补全前的答案（用户看到的「没答清楚」原文）",
  source_excerpt: "原文里支撑答案的段落；为空说明材料本身就没写",
  pipeline: "函数决策点：哪个函数、看了什么量、判定 ok/reject",
  unbound_kp: "未绑定知识点的条数（抽取环节没对上知识点）",
  by_block_step: "未补全的记录按「被哪个函数拦下」分组",
};

export const REJECTION_LEGEND: Record<string, string> = {
  node: "被拒绝（放入复习列表）的节点：书 → 章节 → 知识点 → 原文片段",
  snapshot: "拒绝那一刻的卡片内容，后续改卡不影响样本",
  context: "拒绝来源（单张/批量）、拒绝前后的 FSRS 状态",
  "context.fsrs_before": "null = 从没学过的新卡，被直接推进复习队列",
  first_time: "新卡被拒的条数，占比高说明审核标准偏保守",
  by_kp: "按知识点分布，整章集中被拒通常说明该章抽取质量差",
  pipeline: "函数决策点：approve/reject 的判定与 FSRS 写入",
};
