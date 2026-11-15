import crypto from "node:crypto";

import type { CardStore } from "../db/store";
import type { AnswerFixLog, AnswerGapReason, AnswerGapReport, AuditPipelineStep, Card } from "../db/types";
import { chatJSON, getLLMStatus } from "../llm";
import { buildAnswerRequest, selectMaterial } from "./answer-fill";
import { MAX_ANSWER_MATERIAL } from "./answer";
import { buildUserFixLog } from "./answer-fix-log";
import { describeQuestionType, step } from "../audit/ledger-model";
import { appendAnswerGap } from "../audit/ledger-file";
import { resolveCardNode } from "../audit/node-resolve";
import { findCardSourceAnswer, type SourceAnswer } from "./source-answer";
import { normalizeAnswerText, tidyInline, tidyModelText } from "./answer-format";

/**
 * 「答案不全」修复：用户在复习页发现参考答案漏了半句 / 被截断 / 与原文不符时，
 * 由 AI 先检索并分析该段落涉及的知识点，再重新生成完整答案。
 *
 * 与 fillCardAnswer 的区别（别混用）：
 *   · fill-answers 只处理「完全没有答案」的卡，答案 1~3 句、追求简短；
 *   · 这里处理「有答案但不完整/不准」，要求把题目问到的每个概念都答全，
 *     并且要给出 diagnosis —— 这次到底补了什么、原来为什么漏，落进审计日志。
 */

export type RepairReason = "missing" | "truncated" | "inaccurate";

export const REPAIR_REASONS: RepairReason[] = ["missing", "truncated", "inaccurate"];

export interface RepairDraft {
  answer: string;
  knowledge_points: string[];
  diagnosis: string;
  grounded: boolean;
  basis: string | null;
}

export interface RepairOptions {
  reason: RepairReason;
  note?: string | null;
  timeoutMs?: number;
  /**
   * 用户显式要求「在全书正文里找答案」。
   *
   * 默认只在「这张卡绑定的片段 + 它所在章节」里找 —— 范围小、命中准。
   * 有些书的答案被排到了别的章（复习时看到的就是半句），这时才需要放开全书。
   */
  fullText?: boolean;
}

export interface RepairResult {
  ok: boolean;
  /** 失败原因：no-material / insufficient / write-failed */
  reason?: string;
  answer?: string;
  knowledge_points?: string[];
  diagnosis?: string;
  grounded?: boolean;
  /**
   * 这条答案从哪来：
   *   "source" = 原文里就有完整答案，直接采用（未经 AI 改写）—— 这才是标准答案
   *   "ai"     = 原文没有，AI 依据材料整理
   * 前端据此决定标注与文案，别把「原文答案」说成「AI 生成」。
   */
  origin?: "source" | "ai";
  /** 采用原文答案时，命中的片段（供「看原文」定位） */
  source_fragment_id?: string | null;
  /** 检索范围：card（卡片片段）/ chapter（同章）/ book（全书） */
  scope?: "card" | "chapter" | "book";
  log?: AnswerFixLog;
  /** 本次落盘的答案缺口台账 id（成功与失败都有） */
  gap_id?: string | null;
}

const REASON_LABEL: Record<RepairReason, string> = {
  missing: "答案缺失（部分概念/要点完全没有）",
  truncated: "答案被截断（只拿到摘要句，后面还有内容）",
  inaccurate: "答案不准确（与原文不符或答非所问）",
};

const SYSTEM = `你是一名严谨的学习答疑老师。学生指出某张卡片的「参考答案」不完整或不准确，你要依据给出的原文材料重新生成一份完整答案。

工作顺序（严格按这三步）：
第一步：通读材料，列出这段原文涉及的**全部知识点**（knowledge_points 数组）。题目问了两个概念就要列两条，不要只列第一条。
第二步：对照「现有参考答案」诊断问题（diagnosis）。说清楚它是漏了并列答案、被截断在半句、还是与原文不符，并指明这次补上了什么。
第三步：重新写完整答案（answer）。

answer 的硬性要求：
1. 题目问到几个概念 / 几个方面，就必须答几个，每一个都要有明确结论。例如「什么是 A 和 B」必须同时解释 A 与 B，不能只写 A。
2. 优先逐字依据原文材料；材料里有更完整的段落（含摘要句 + 后续补充）时，必须用完整段落，不许只抄摘要句。
3. 不能截断在冒号、顿号或半句话上；不能写「材料未提及」当作答案。
4. 材料确实没有的内容，才用自己的专业知识补，并把 grounded 设为 false；答案严格来自材料时 grounded = true。
5. 题目问到几个要点就写几个，**篇幅以答全为准**（常见 150~600 字）。原文本身是分点列举的，就照它的分点结构完整落下来 —— 禁止只写第一句、禁止把 7 条要点压成一句话。不要重复题干，不要写「综上所述」「根据材料」这类套话。
6. 选择题只填正确选项字母；判断题只填「对」或「错」。

只输出 JSON，不要任何解释文字：
{"knowledge_points":["知识点1","知识点2"],"diagnosis":"原答案为什么不全/不准，这次补了什么","answer":"完整答案正文","grounded":true,"basis":"支撑答案的原文摘录（120 字内），没有则空字符串"}`;

const DODGE =
  /^(无法(从)?(材料|原文)?(中)?(确定|回答|判断)|材料(中|里)?(并)?(未|没有)(提及|说明|给出)|没有(相关)?(信息|依据))/;

/**
 * 答案正文收口：保留换行。
 *
 * 原来这里是 `v.replace(/\s+/g, " ")` —— 把换行也压成了空格，模型写的
 * Markdown 表格（对比类答案的常见形态）落库后就成了一整行竖线，复习页只能
 * 原样显示 `|框架|执行权限|...|`。换行是结构，压掉它就是丢信息。
 */
function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return tidyModelText(v, max);
}

/** 单行字段（诊断 / 依据 / 知识点）放不下换行，连换行一起压成空格 */
function oneLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return tidyInline(v, max);
}

/** 模型返回被拒的三种成因 —— 台账要能区分「没给答案」「给太短」「敷衍」 */
export type RepairReject = "not_object" | "answer_too_short" | "dodged";

/**
 * 带成因的收口。normalizeRepair 保持原签名（一堆回归脚本依赖它），
 * 这里多回一个 reject，只为让台账写清「为什么这次不算补上」。
 */
export function normalizeRepairDetailed(raw: unknown): {
  draft: RepairDraft | null;
  reject: RepairReject | null;
} {
  if (!raw || typeof raw !== "object") return { draft: null, reject: "not_object" };
  const o = raw as Record<string, unknown>;
  const answer = str(o.answer, 2000);
  if (DODGE.test(answer)) return { draft: null, reject: "dodged" };
  if (answer.length < 4) return { draft: null, reject: "answer_too_short" };

  const points = Array.isArray(o.knowledge_points)
    ? o.knowledge_points
        .map((p) => oneLine(p, 120))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return {
    reject: null,
    draft: {
      answer,
      knowledge_points: points,
      diagnosis: oneLine(o.diagnosis, 400) || "未给出诊断说明",
      grounded: o.grounded === true,
      basis: oneLine(o.basis, 300) || null,
    },
  };
}

/** 纯函数：把模型返回收口成可信结构，畸形一律拒绝（不写半条答案）。 */
export function normalizeRepair(raw: unknown): RepairDraft | null {
  return normalizeRepairDetailed(raw).draft;
}

function buildUser(
  card: Card,
  material: string,
  opts: RepairOptions,
  kpStatement: string | null
): string {
  const parts: string[] = [];
  parts.push(`【题目】${String(card.front ?? "")}`);
  parts.push(`【用户指出的问题】${REASON_LABEL[opts.reason]}`);
  if (opts.note?.trim()) parts.push(`【用户补充】${opts.note.trim().slice(0, 200)}`);
  parts.push(`【现有参考答案（可能不全/不准）】${(card.back ?? "").trim() || "（空）"}`);
  if (kpStatement) parts.push(`【本题绑定的知识点】${kpStatement}`);
  if (card.options?.length) {
    parts.push(`【选项】\n${card.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n")}`);
  }
  parts.push(`【原文材料（含该段落及相邻章节，唯一可引用的事实来源）】\n${material}`);
  parts.push(
    "请先列出材料涉及的知识点，再诊断现有答案的问题，最后写出覆盖全部要点的完整答案。"
  );
  return parts.join("\n\n");
}

/** draftAnswerRepair 的完整结果 —— 失败时也要留下「为什么」的量化依据 */
export interface RepairDraftResult {
  draft: RepairDraft | null;
  /** no-material / insufficient */
  reason?: string;
  excerpt: string;
  /** 拼进提示词的原文材料字数（去空白后）—— 判断「原文到底有没有写」 */
  materialChars: number;
  /** 来源片段字数（区分「章节材料有、原文片段没有」这种半残情况） */
  sourceChars: number;
  /** normalize 层的拒绝成因 */
  reject: RepairReject | null;
  /** 模型给的 answer 原始长度（0 = 没给答案字段；1~3 = 敷衍） */
  rawAnswerChars: number;
  /** 题干为空 */
  emptyQuestion: boolean;
  /** reason="llm-error" 时的原始错误信息（超时 / 无 key / 5xx） */
  errorMessage?: string;
}

/** 只生成、不写库；便于测试与失败时保留原状。 */
export async function draftAnswerRepair(
  store: CardStore,
  card: Card,
  opts: RepairOptions
): Promise<RepairDraftResult> {
  const req = await buildAnswerRequest(store, card);

  // 修复场景比补答案更需要「该段落」：把这张卡绑定的来源片段原文也拼进来，
  // 否则模型只看到章节检索结果，容易漏掉紧邻的那半句答案。
  let sourceText = "";
  let bookText = "";
  try {
    const sources = await store.listCardSources(card.id);
    sourceText = sources
      .map((s) => (s.content ?? "").trim())
      .filter(Boolean)
      .join("\n\n");

    // 全书正文：只有用户显式要求时才扫（几千个片段，扫一遍是有代价的）。
    // 按 4-gram 相关度挑材料，避免「摘要句在窗口里、完整答案在 4000 字之外」。
    if (opts.fullText) {
      const textbookId = sources.find((s) => s.textbook_id)?.textbook_id ?? null;
      if (textbookId) {
        const all = await store.listFragments(textbookId);
        bookText = selectMaterial(all, String(card.front ?? ""), 24_000);
      }
    }
  } catch {
    /* 取不到来源不阻断，用章节材料兜底 */
  }

  const material = [req?.material ?? "", bookText, sourceText]
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, opts.fullText ? 30_000 : MAX_ANSWER_MATERIAL);

  const materialChars = material.replace(/\s+/g, "").length;
  const sourceChars = sourceText.replace(/\s+/g, "").length;
  const emptyQuestion = !String(card.front ?? "").trim();
  const failed = (reason: string): RepairDraftResult => ({
    draft: null,
    reason,
    excerpt: material.slice(0, 300),
    materialChars,
    sourceChars,
    reject: null,
    rawAnswerChars: 0,
    emptyQuestion,
  });

  if (materialChars < 20) return failed("no-material");
  if (emptyQuestion) return failed("no-material");

  // 模型调用失败（超时 / 没配 key / 上游 5xx）也要落一条：
  // 用户看到的是「补不出来」，如果不记，台账里这类占比永远是 0，
  // 监督员会误以为「补全功能很稳」，实际是失败根本没留痕。
  let raw: unknown;
  try {
    raw = await chatJSON<unknown>({
      system: SYSTEM,
      user: buildUser(card, material, opts, req?.kpStatement ?? null),
      temperature: 0.2,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
  } catch (e) {
    return {
      draft: null,
      reason: "llm-error",
      excerpt: material.slice(0, 300),
      materialChars,
      sourceChars,
      reject: null,
      rawAnswerChars: 0,
      emptyQuestion,
      errorMessage: (e as Error)?.message?.slice(0, 300) ?? String(e).slice(0, 300),
    };
  }

  // chatJSON 把「调用失败」吞成 null（网络/超时/没 key/5xx 一律返回 null）。
  // 这里必须把 null 认成 llm-error 而不是「模型给了坏 JSON」——
  // 否则台账会显示「模型返回的不是合法 JSON」，让监督员去改提示词，
  // 而真实原因是网关挂了，改提示词一点用没有。
  if (raw === null || raw === undefined) {
    return {
      draft: null,
      reason: "llm-error",
      excerpt: material.slice(0, 300),
      materialChars,
      sourceChars,
      reject: null,
      rawAnswerChars: 0,
      emptyQuestion,
      errorMessage: getLLMStatus().last_error ?? "模型未返回内容（超时 / 未配置 key / 上游 5xx）",
    };
  }

  const { draft, reject } = normalizeRepairDetailed(raw);
  const rawAnswer = (raw as { answer?: unknown } | null)?.answer;
  const rawAnswerChars = typeof rawAnswer === "string" ? rawAnswer.trim().length : 0;
  if (!draft) {
    return {
      draft: null,
      reason: "insufficient",
      excerpt: material.slice(0, 300),
      materialChars,
      sourceChars,
      reject,
      rawAnswerChars,
      emptyQuestion,
    };
  }
  return {
    draft,
    excerpt: (draft.basis || material).slice(0, 300),
    materialChars,
    sourceChars,
    reject: null,
    rawAnswerChars,
    emptyQuestion,
  };
}

/**
 * 把「没补上」的成因翻译成人话 —— 台账里最值钱的就是这一句。
 *
 * 监督员看的不该是 insufficient 这种代码，而是「模型说材料没提，但其实原文
 * 就在隔壁段」这种可执行结论。所以这里把量化依据一起写进去。
 */
export function blockReasonOf(input: {
  reason?: string;
  reject: RepairReject | null;
  materialChars: number;
  sourceChars: number;
  rawAnswerChars: number;
  emptyQuestion: boolean;
  errorMessage?: string;
}): string {
  if (input.reason === "llm-error") {
    return `模型调用失败，没拿到任何答案：${input.errorMessage ?? "未知错误"}。属于服务/配置问题，不是题目本身的问题。`;
  }
  if (input.reason === "no-material") {
    if (input.emptyQuestion) return "题干为空，AI 不知道要回答什么，未生成答案。";
    if (input.sourceChars === 0) {
      return `这张卡没有绑定原文片段（来源 0 字，仅章节材料 ${input.materialChars} 字），答案无从核对，AI 未生成。`;
    }
    return `可用材料仅 ${input.materialChars} 字（未达 20 字门槛），原文确实没写清楚，AI 无据可依。`;
  }
  if (input.reason === "insufficient") {
    if (input.reject === "not_object") return "模型返回的不是合法 JSON，无法解析出答案，已丢弃。";
    if (input.reject === "dodged") return "模型回答「材料未提及」——原文没给这个问题的答案，属于抽取阶段把没答案的段落也出了题。";
    if (input.reject === "answer_too_short") {
      return input.rawAnswerChars === 0
        ? "模型没有给出 answer 字段，只回了知识点/诊断，等于没答。"
        : `模型给的答案只有 ${input.rawAnswerChars} 字，明显是敷衍而不是完整作答。`;
    }
    return "模型返回结构不可用（缺字段或答案为空），已丢弃。";
  }
  return `补答案流程中断：${input.reason ?? "未知原因"}。`;
}

/**
 * 直接用原文答案写回。
 *
 * 这是「标准答案」路径：原文里本来就有完整答案，就不该让 AI 转述 ——
 * 转述必然丢要点（实测 7 条要点被压成 1 句），用户看到的还会是两层结果
 * （答案框里是 AI 写的、下面又挂着检索到的知识点）。
 *
 * 与 AI 路径的区别会写进 answer_fix_logs 的 diagnosis 和台账 pipeline，
 * 事后能分清「这题的答案到底是原文还是模型编的」。
 */
async function applySourceAnswer(
  store: CardStore,
  card: Card,
  opts: RepairOptions,
  hit: SourceAnswer,
  scope: "card" | "chapter" | "book"
): Promise<RepairResult> {
  const before = (card.back ?? "").trim();
  const isChoiceLike = (card.options?.length ?? 0) > 0;
  const scopeLabel =
    scope === "card" ? "卡片绑定片段" : scope === "chapter" ? "所在章节" : "全书正文";
  const diagnosis = `原文（${scopeLabel}）里已有完整答案 ${hit.text.length} 字，直接采用原文，未经 AI 改写。`;

  const updated = await store.updateCard(card.id, {
    // 原文里也可能是 Markdown 表格：落库前统一整理成逐行结构，
    // 免得「刚补完的原文答案」又在复习页挤成一行竖线
    back: normalizeAnswerText(hit.text),
    ...(isChoiceLike ? {} : { answer: null }),
    needs_answer: false,
    answer_origin: "source",
    answer_grounded: true,
    answer_generated_at: null,
    explanation: card.explanation ?? null,
  });

  if (!updated) {
    const gapId = await writeGap(store, card, opts, {
      symptom: opts.reason,
      outcome: "unfixed",
      after: hit.text,
      excerpt: hit.text.slice(0, 300),
      diagnosis: "已从原文找到完整答案，但写回卡片失败（磁盘/并发），原答案未改动。",
      knowledgePoints: [],
      grounded: true,
      pipeline: [
        step("findSourceAnswer", `${scopeLabel}命中，答案 ${hit.text.length} 字`, "ok"),
        step("updateCard", "写回失败", "reject"),
      ],
    });
    return { ok: false, reason: "write-failed", gap_id: gapId };
  }

  let textbookId: string | null = null;
  try {
    textbookId = (await store.listCardSources(card.id)).find((s) => s.textbook_id)?.textbook_id ?? null;
  } catch {
    /* 日志允许缺 textbook_id */
  }

  const [log] = await store.createAnswerFixLogs([
    buildUserFixLog({
      cardId: card.id,
      textbookId,
      question: card.front,
      reason: opts.reason,
      before,
      after: hit.text,
      excerpt: hit.text.slice(0, 300),
      knowledgePoints: [],
      diagnosis,
      grounded: true,
      note: opts.note,
    }),
  ]);

  const gapId = await writeGap(store, card, opts, {
    symptom: opts.reason,
    outcome: "fixed",
    after: hit.text,
    excerpt: hit.text.slice(0, 300),
    diagnosis,
    knowledgePoints: [],
    grounded: true,
    pipeline: [
      step(
        "findSourceAnswer",
        `${scopeLabel}命中片段 ${hit.fragment_id.slice(0, 8)}，答案 ${hit.text.length} 字（匹配分 ${hit.score}）`,
        "ok"
      ),
      step("updateCard", `back ${before.length} → ${hit.text.length} 字，answer_origin=source`, "ok"),
      step("chatJSON", "未调用模型（原文已有完整答案）", "info"),
      step("createAnswerFixLogs", "写 answer_fix_logs（正文比对用）", "ok"),
    ],
  });

  return {
    ok: true,
    answer: normalizeAnswerText(hit.text),
    knowledge_points: [],
    diagnosis,
    grounded: true,
    origin: "source",
    source_fragment_id: hit.fragment_id,
    scope,
    log,
    gap_id: gapId,
  };
}

/**
 * 生成 → 写回卡片 → 落审计日志。任一步失败都不写半成品。
 *
 * 顺序是**先检索原文、后调模型**：
 *   1. 原文里有这道题的完整答案 → 直接采用（answer_origin="source"），一个字不改；
 *   2. 原文没有 / 只有半句 → 才让 AI 依据材料整理，标 answer_origin="ai"。
 *
 * 成功和失败**都写答案缺口台账**：只记成功的样本里全是「已经修好的」，
 * 反而看不出「哪类题根本修不好」——那才是要改规则的地方。
 */
export async function repairCardAnswer(
  store: CardStore,
  card: Card,
  opts: RepairOptions
): Promise<RepairResult> {
  // ---- 第 1 步：原文优先 ----
  let sourceScan = { hit: null as SourceAnswer | null, scope: "card" as "card" | "chapter" | "book", scanned: 0 };
  try {
    sourceScan = await findCardSourceAnswer(store, card, { fullText: opts.fullText });
  } catch (e) {
    console.warn(`[repair] 原文答案检索失败：${(e as Error)?.message ?? e}`);
  }
  if (sourceScan.hit) {
    return applySourceAnswer(store, card, opts, sourceScan.hit, sourceScan.scope);
  }

  // ---- 第 2 步：原文没有 → AI 整理 ----
  const drafted = await draftAnswerRepair(store, card, opts);
  const { draft, reason, excerpt } = drafted;
  const scanNote = `原文未找到答案（扫描 ${sourceScan.scanned} 段，范围 ${opts.fullText ? "全书" : "章节"}）`;

  if (!draft) {
    const symptom: AnswerGapReason =
      reason === "no-material" ? "no_material" : reason === "llm-error" ? "llm_error" : "insufficient";
    const gapId = await writeGap(store, card, opts, {
      symptom,
      outcome: "unfixed",
      after: null,
      excerpt,
      diagnosis: blockReasonOf(drafted),
      knowledgePoints: [],
      grounded: false,
      pipeline: [
        step("findSourceAnswer", scanNote, "reject"),
        step(
          "draftAnswerRepair",
          `材料 ${drafted.materialChars} 字 / 来源片段 ${drafted.sourceChars} 字`,
          drafted.materialChars < 20 ? "reject" : "ok"
        ),
        step(
          "chatJSON",
          reason === "no-material"
            ? "未调用模型（材料不足或题干为空）"
            : reason === "llm-error"
              ? `模型调用失败：${drafted.errorMessage ?? "未知"}`
              : `模型返回 answer ${drafted.rawAnswerChars} 字`,
          reason === "llm-error" ? "reject" : "info"
        ),
        step(
          "normalizeRepair",
          reason === "insufficient" ? `校验不通过：${drafted.reject ?? "unknown"}` : "未执行",
          reason === "insufficient" ? "reject" : "info"
        ),
        step("writeBack", "未写回，卡片保持原答案", "reject"),
      ],
    });
    return { ok: false, reason, gap_id: gapId, origin: "ai", scope: sourceScan.scope };
  }

  const before = (card.back ?? "").trim();
  // 选择题的 answer 字段存的是选项文本，不能拿一段自然语言覆盖它
  const isChoiceLike = (card.options?.length ?? 0) > 0;
  const updated = await store.updateCard(card.id, {
    back: normalizeAnswerText(draft.answer),
    ...(isChoiceLike ? {} : { answer: null }),
    needs_answer: false,
    answer_origin: "ai",
    answer_grounded: draft.grounded,
    answer_generated_at: new Date().toISOString(),
    explanation: card.explanation ?? null,
  });
  if (!updated) {
    const gapId = await writeGap(store, card, opts, {
      symptom: opts.reason,
      outcome: "unfixed",
      after: draft.answer,
      excerpt: drafted.excerpt,
      diagnosis: "AI 已生成新答案，但写回卡片失败（磁盘/并发），原答案未改动。",
      knowledgePoints: draft.knowledge_points,
      grounded: draft.grounded,
      pipeline: [
        step("findSourceAnswer", scanNote, "reject"),
        step("draftAnswerRepair", `材料 ${drafted.materialChars} 字`, "ok"),
        step("normalizeRepair", `answer ${draft.answer.length} 字，通过校验`, "ok"),
        step("updateCard", "写回失败", "reject"),
      ],
    });
    return { ok: false, reason: "write-failed", gap_id: gapId, origin: "ai", scope: sourceScan.scope };
  }

  let textbookId: string | null = null;
  try {
    textbookId = (await store.listCardSources(card.id)).find((s) => s.textbook_id)?.textbook_id ?? null;
  } catch {
    /* 审计日志允许缺 textbook_id */
  }

  const [log] = await store.createAnswerFixLogs([
    buildUserFixLog({
      cardId: card.id,
      textbookId,
      question: card.front,
      reason: opts.reason,
      before,
      after: draft.answer,
      excerpt,
      knowledgePoints: draft.knowledge_points,
      diagnosis: draft.diagnosis,
      grounded: draft.grounded,
      note: opts.note,
    }),
  ]);

  const gapId = await writeGap(store, card, opts, {
    symptom: opts.reason,
    outcome: "fixed",
    after: draft.answer,
    excerpt,
    diagnosis: draft.diagnosis,
    knowledgePoints: draft.knowledge_points,
    grounded: draft.grounded,
    pipeline: [
      step("findSourceAnswer", scanNote, "reject"),
      step("draftAnswerRepair", `材料 ${drafted.materialChars} 字 / 来源片段 ${drafted.sourceChars} 字`, "ok"),
      step(
        "normalizeRepair",
        `answer ${draft.answer.length} 字 ≥4，未命中敷衍句式，知识点 ${draft.knowledge_points.length} 条`,
        "ok"
      ),
      step("updateCard", `back ${before.length} → ${draft.answer.length} 字，answer_origin=ai`, "ok"),
      step("createAnswerFixLogs", "写 answer_fix_logs（正文比对用）", "ok"),
    ],
  });

  return {
    ok: true,
    answer: normalizeAnswerText(draft.answer),
    knowledge_points: draft.knowledge_points,
    diagnosis: draft.diagnosis,
    grounded: draft.grounded,
    origin: "ai",
    scope: sourceScan.scope,
    log,
    gap_id: gapId,
  };
}

/**
 * 组装并落一条答案缺口台账。
 *
 * 这里包一层 try：台账失败绝不能把「补答案」这个操作搞挂（用户已经等了 30 秒）。
 * 节点查询同理 —— 查不到就记 null，台账宁可信息少一点，也不能阻断主流程。
 */
async function writeGap(
  store: CardStore,
  card: Card,
  opts: RepairOptions,
  input: {
    symptom: AnswerGapReason;
    outcome: "fixed" | "unfixed";
    after: string | null;
    excerpt: string;
    diagnosis: string;
    knowledgePoints: string[];
    grounded: boolean;
    pipeline: AuditPipelineStep[];
  }
): Promise<string | null> {
  try {
    const node = await resolveCardNode(store, card);
    const row: AnswerGapReport = {
      id: crypto.randomUUID(),
      node,
      question: String(card.front ?? "").slice(0, 400),
      question_type: describeQuestionType(card),
      symptom: input.symptom,
      outcome: input.outcome,
      block_reason:
        input.outcome === "unfixed" ? input.diagnosis : "",
      before_answer: String(card.back ?? "").trim().slice(0, 1200),
      after_answer: input.after ? input.after.slice(0, 1200) : null,
      source_excerpt: String(input.excerpt ?? "").slice(0, 600),
      knowledge_points: input.knowledgePoints.slice(0, 8),
      diagnosis: input.diagnosis.slice(0, 600),
      grounded: input.grounded,
      user_note: opts.note?.trim() ? opts.note.trim().slice(0, 200) : null,
      pipeline: input.pipeline.slice(0, 8),
      created_at: new Date().toISOString(),
    };
    await appendAnswerGap(row);
    return row.id;
  } catch (e) {
    console.warn(`[audit] 组装答案缺口记录失败：${(e as Error)?.message ?? e}`);
    return null;
  }
}
