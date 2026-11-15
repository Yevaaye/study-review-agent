/**
 * 出题错误台账的归一与聚合（纯函数，零 IO）。
 *
 * 两个使用方：
 *   1) 复习页「错误」按钮 —— 把用户随手点的东西归一成一条可入库的记录；
 *   2) 「学习复盘 Agent 监督员」—— 按病因聚类，找出反复出现的出题毛病，
 *      反向提出抽取规则 / 提示词的迭代建议。
 *
 * 这里刻意不调模型：监督员的「核查」第一步必须是**可复现的规则归因**，
 * 否则同一批数据每次跑出来的结论都不一样，没法据此判断改动有没有效。
 */

import type { Card, CardErrorKind, CardErrorReport } from "../db/types";

export interface ErrorKindMeta {
  key: CardErrorKind;
  label: string;
  /** 给用户看的解释：点这个等于告诉系统什么 */
  hint: string;
  /** 监督员的默认归因与建议（规则层，不调模型） */
  hypothesis: string;
  action: string;
}

export const ERROR_KINDS: ErrorKindMeta[] = [
  {
    key: "not_question",
    label: "这不是题目",
    hint: "原文这段是正文/清单/步骤，AI 误当成题抽了出来",
    hypothesis: "规则把并列要点（编号建议、步骤清单）当成了「题号 + 数字选项」",
    action: "收紧数字选项折叠：题干本身是编号项且后续编号连续时，视为并列清单不折叠",
  },
  {
    key: "answer_wrong",
    label: "答案错了",
    hint: "参考答案与原文不符，或答非所问",
    hypothesis: "答案关联到了错误的段落（相邻题的答案 / 摘要句）",
    action: "复核 reconcile 的题号与 stemRef 对齐，把该段落加入回归样本",
  },
  {
    key: "options_wrong",
    label: "选项有问题",
    hint: "选项缺项、错位，或者根本不是并行选项",
    hypothesis: "同一行多选项或编号折叠时被截断，选项数不足",
    action: "用该题原文片段回归 parseInlineOptions / 数字选项折叠规则",
  },
  {
    key: "answer_key_wrong",
    label: "正确答案标错了",
    hint: "题目和选项没问题，但标的正确项不对（含应为多选却标成单选）",
    hypothesis: "答案归一（字母/圈号/多选连写）没解析出全部正确项",
    action: "把该题的答案写法加入 answer-keys 的多选回归用例",
  },
  {
    key: "other",
    label: "其他问题",
    hint: "上面都不属于，补充说明即可",
    hypothesis: "人工判断的问题，需要看具体描述",
    action: "人工复核",
  },
];

const KIND_SET = new Set<string>(ERROR_KINDS.map((k) => k.key));

export function isErrorKind(v: unknown): v is CardErrorKind {
  return typeof v === "string" && KIND_SET.has(v);
}

export function errorKindMeta(kind: CardErrorKind): ErrorKindMeta {
  return ERROR_KINDS.find((k) => k.key === kind) ?? ERROR_KINDS[ERROR_KINDS.length - 1];
}

function cleanNote(v: unknown, max = 400): string {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanKeys(v: unknown, optionCount: number): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const raw of v) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(n) && n >= 0 && n < optionCount) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export interface ReportInput {
  kind: CardErrorKind;
  note: string;
  marked_keys: number[];
}

/** 卡片快照：错误记录的样本价值就在这里 —— 卡片后来改了，样本不能跟着改 */
export function snapshotOf(card: Card): CardErrorReport["snapshot"] {
  return {
    front: card.front,
    back: card.back,
    options: Array.isArray(card.options) ? [...card.options] : null,
    answer: card.answer ?? null,
    answers: Array.isArray(card.answers) ? [...card.answers] : null,
    is_multi: card.is_multi === true,
    card_type: card.card_type ?? null,
  };
}

/**
 * 校验并收口上报参数。
 * 规则：
 *   · kind 非法 → 落到 other（宁可记下来，也不要因为一个枚举值丢掉用户的反馈）；
 *   · 标注下标必须落在选项范围内，越界一律丢弃（否则会写出一条指向不存在选项的记录）；
 *   · 只在「答案键标错」时保留 marked_keys —— 其他病因下这些下标没有意义，
 *     留着会让监督员误以为用户已经给出正确答案。
 */
export function normalizeReportInput(raw: unknown, card: Card): ReportInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind: CardErrorKind = isErrorKind(o.kind) ? o.kind : "other";
  const optionCount = Array.isArray(card.options) ? card.options.length : 0;
  const marked = kind === "answer_key_wrong" ? cleanKeys(o.marked_keys, optionCount) : [];
  return { kind, note: cleanNote(o.note), marked_keys: marked };
}

/** 上报前的最后一道校验：什么都不填、也没标注，等于误点 */
export function reportIsUseful(input: ReportInput): boolean {
  return !!input.note || input.marked_keys.length > 0 || input.kind !== "other";
}

export interface ErrorSummary {
  total: number;
  open: number;
  by_kind: Array<{ kind: CardErrorKind; label: string; count: number }>;
  by_card: Array<{ card_id: string; front: string; count: number; kinds: CardErrorKind[] }>;
  by_book: Array<{ textbook_id: string; count: number }>;
  marked_multi: number;
  latest_at: string | null;
}

/** 基础统计：给页面看，也给监督员当输入 */
export function summarizeErrors(reports: CardErrorReport[]): ErrorSummary {
  const kindCount = new Map<CardErrorKind, number>();
  const cardMap = new Map<string, { front: string; count: number; kinds: Set<CardErrorKind> }>();
  const bookMap = new Map<string, number>();

  for (const r of reports) {
    kindCount.set(r.kind, (kindCount.get(r.kind) ?? 0) + 1);
    const at = cardMap.get(r.card_id);
    if (at) {
      at.count++;
      at.kinds.add(r.kind);
    } else {
      cardMap.set(r.card_id, {
        front: r.snapshot?.front ?? "",
        count: 1,
        kinds: new Set([r.kind]),
      });
    }
    if (r.textbook_id) bookMap.set(r.textbook_id, (bookMap.get(r.textbook_id) ?? 0) + 1);
  }

  return {
    total: reports.length,
    open: reports.filter((r) => r.status === "open").length,
    by_kind: ERROR_KINDS.map((k) => ({
      kind: k.key,
      label: k.label,
      count: kindCount.get(k.key) ?? 0,
    })),
    by_card: [...cardMap.entries()]
      .map(([card_id, v]) => ({ card_id, front: v.front, count: v.count, kinds: [...v.kinds] }))
      .sort((a, b) => b.count - a.count),
    by_book: [...bookMap.entries()].map(([textbook_id, count]) => ({ textbook_id, count })),
    marked_multi: reports.filter((r) => r.kind === "answer_key_wrong" && r.marked_keys.length > 1)
      .length,
    latest_at: reports.reduce<string | null>(
      (acc, r) => (!acc || r.created_at > acc ? r.created_at : acc),
      null
    ),
  };
}

export interface SupervisorFinding {
  kind: CardErrorKind;
  label: string;
  count: number;
  /** 同类问题的代表样本（最多 3 条），监督员据此给具体建议 */
  samples: Array<{ card_id: string; front: string; note: string }>;
  hypothesis: string;
  action: string;
  /** 影响面：涉及多少张不同的卡 */
  affected_cards: number;
}

export interface SupervisorReview {
  generated_at: string;
  total: number;
  open: number;
  findings: SupervisorFinding[];
  /** 建议优先处理的下一批动作 */
  next_actions: string[];
  /** 结论摘要，直接进复盘报告 */
  narrative: string;
}

/**
 * 监督员的「核查 + 总结」：把零散上报聚成可执行的结论。
 *
 * 为什么按病因而不是按卡片聚类：卡片是一张张修的，病因是批量的 ——
 * 只有「12 次都是 not_question」才能推出「数字选项折叠规则要收紧」这种
 * 能一次修掉一片的结论。
 */
export function buildSupervisorReview(
  reports: CardErrorReport[],
  now = new Date().toISOString()
): SupervisorReview {
  const open = reports.filter((r) => r.status === "open");
  const byKind = new Map<CardErrorKind, CardErrorReport[]>();
  for (const r of reports) {
    const arr = byKind.get(r.kind) ?? [];
    arr.push(r);
    byKind.set(r.kind, arr);
  }

  const findings: SupervisorFinding[] = [...byKind.entries()]
    .map(([kind, list]) => {
      const meta = errorKindMeta(kind);
      const cards = new Set(list.map((r) => r.card_id));
      return {
        kind,
        label: meta.label,
        count: list.length,
        samples: list.slice(0, 3).map((r) => ({
          card_id: r.card_id,
          front: (r.snapshot?.front ?? "").slice(0, 60),
          note: r.note,
        })),
        hypothesis: meta.hypothesis,
        action: meta.action,
        affected_cards: cards.size,
      };
    })
    .sort((a, b) => b.count - a.count);

  const nextActions: string[] = [];
  for (const f of findings.slice(0, 3)) {
    nextActions.push(`${f.label}（${f.count} 次 / ${f.affected_cards} 张卡）→ ${f.action}`);
  }
  if (open.length > 0) {
    nextActions.push(`仍有 ${open.length} 条待核查，先逐条确认「真错 / 误报」再改规则`);
  }
  if (nextActions.length === 0) {
    nextActions.push("暂无上报：继续积累样本，或先在复习页把可疑的题标出来");
  }

  const top = findings[0];
  const narrative =
    reports.length === 0
      ? "本轮没有出题错误上报。监督员无异常可总结。"
      : `本轮共 ${reports.length} 条上报（待核查 ${open.length} 条），最集中的问题是「${top.label}」${top.count} 次，` +
        `涉及 ${top.affected_cards} 张卡；初步归因：${top.hypothesis}。` +
        (findings.length > 1
          ? `其次是「${findings[1].label}」${findings[1].count} 次。`
          : "") +
        "建议按 next_actions 顺序处理，改完规则后用同一批样本回归。";

  return {
    generated_at: now,
    total: reports.length,
    open: open.length,
    findings,
    next_actions: nextActions,
    narrative,
  };
}
