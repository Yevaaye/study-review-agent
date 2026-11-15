// 模型仲裁器 —— 复用项目现有的 chatJSON 封装与配置，不改密钥 / 模型 / 接入方式。
//
// 职责严格限定为「判断」：是不是题、题型是什么、题目边界在哪、答案区引用哪个题号。
// 模型**不产出**题干、选项、答案、解析的任何文本；这些字段一律由规则从原文逐字截取。
// 因此即使模型幻觉或返回畸形，最多影响某道题是否被保留，不可能编造出原文没有的内容。

import { chatJSON } from "../llm";
import type { JudgeRequest, LlmJudge, LlmVerdict, QuestionType } from "./question-types";

const ALLOWED_TYPES: QuestionType[] = ["choice", "qa", "cloze", "judge"];

/** 非选项时的回退身份白名单（spec: alt_identity）。 */
const ALT_IDENTITIES = ["question_number", "procedure_step", "answer_point", "other"] as const;
type AltIdentity = (typeof ALT_IDENTITIES)[number];

/**
 * labels / selected 只接受 A-H 单字母（可带括号、点）。
 * 其它内容一律丢弃：防止模型借这两个字段注入题干/答案原文。
 */
function toLetterList(v: unknown): string[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(/[,，\s、/]+/)
      : [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const m = item.trim().match(/^[（(]?\s*([A-Ha-h])\s*[)）]?\s*[.、．]?$/);
    if (m) out.push(m[1].toUpperCase());
    if (out.length >= 8) break;
  }
  return out;
}

const SYSTEM = [
  "你是「题目识别仲裁器」，只做判断，不做抽取和改写。",
  "输入是一批 Markdown 候选片段（含原文摘录与上下文）。对每个候选输出一条裁决：",
  "  - is_question: 是否为原文中真实存在的题目（普通知识点陈述、定义、目录、示例、修辞性问句均为 false）",
  "  - question_type: choice / qa / cloze / judge 之一；无法确定时省略",
  "  - start_line / end_line: 你判断的题目边界（原文行号），仅当题干跨多个段落时填写",
  "  - answer_ref: 若答案/解析在别处，填它引用的题号或标识（如「3」「第3题」）；没有则省略",
  "  - confidence: 0~1",
  "当候选的 signals 含 numeric_option_candidate（一组数字或圈号开头的条目）时，它可能是选项，也可能是题号清单 / 解析步骤 / 答案要点，必须额外判断：",
  "  - is_option_group: 这组条目是不是一道题的【答案选项】",
  "  - alt_identity: 不是选项时它是什么 —— question_number(题号清单) / procedure_step(解析步骤) / answer_point(答案要点) / other",
  "  - reasoning: 必须同时引用两类证据，缺一视为无效：",
  "      · 上下文证据：前导词是否为「解析/解/步骤/答/要点」、列表前有没有题干、每条目本身是不是完整题目",
  "      · 题面表现形式证据：题干是不是选择问（含？/下列/哪项/几项/正确的是）、条目是短促并列还是长句过程、条目长度是否接近、紧随是否有答案行",
  "  - needs_human: 你也没把握时置 true，不要硬给结论",
  "  - labels / selected: 可选，只能填字母标签（如 [\"A\",\"B\",\"C\"]），仅用于交叉校验",
  "严禁输出题干、选项、答案、解析的原文或改写文本；严禁生成原文不存在的内容（labels/selected 的字母除外）。",
  "只输出 JSON：{\"verdicts\":[{\"candidate_index\":0,\"is_question\":true,\"question_type\":\"choice\",\"confidence\":0.9}]}",
  "verdicts 数组长度必须与输入候选数一致，candidate_index 使用输入里的 index 值。",
].join("\n");

interface RawVerdict {
  candidate_index?: unknown;
  is_question?: unknown;
  question_type?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  answer_ref?: unknown;
  confidence?: unknown;
  is_option_group?: unknown;
  alt_identity?: unknown;
  reasoning?: unknown;
  needs_human?: unknown;
  labels?: unknown;
  selected?: unknown;
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** 字段白名单 + 类型校验：畸形裁决直接丢弃，不进入抽取结果。 */
function parseVerdicts(raw: unknown, size: number): LlmVerdict[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) return null;

  const out: LlmVerdict[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const v = item as RawVerdict;
    const idx = toInt(v.candidate_index);
    if (idx === undefined || idx < 0 || idx >= size) continue;
    if (typeof v.is_question !== "boolean") continue;

    const clean: LlmVerdict = { candidateIndex: idx, is_question: v.is_question };
    if (typeof v.question_type === "string" && ALLOWED_TYPES.includes(v.question_type as QuestionType)) {
      clean.question_type = v.question_type as QuestionType;
    }
    const s = toInt(v.start_line);
    const e = toInt(v.end_line);
    if (s !== undefined && e !== undefined && e >= s && e - s < 60) {
      clean.start_line = Math.max(0, s);
      clean.end_line = Math.max(0, e);
    }
    if (typeof v.answer_ref === "string") clean.answer_ref = v.answer_ref.slice(0, 40);
    if (typeof v.confidence === "number" && Number.isFinite(v.confidence)) {
      clean.confidence = Math.min(1, Math.max(0, v.confidence));
    }

    // ---- 选项组证真/证伪：全部字段可选，缺省即「模型没表态」----
    if (typeof v.is_option_group === "boolean") clean.is_option_group = v.is_option_group;
    if (typeof v.alt_identity === "string" && ALT_IDENTITIES.includes(v.alt_identity as AltIdentity)) {
      clean.alt_identity = v.alt_identity as AltIdentity;
    }
    if (typeof v.reasoning === "string" && v.reasoning.trim()) {
      clean.reasoning = v.reasoning.trim().slice(0, 600);
    }
    if (typeof v.needs_human === "boolean") clean.needs_human = v.needs_human;
    const labels = toLetterList(v.labels);
    if (labels.length) clean.labels = labels;
    const selected = toLetterList(v.selected);
    if (selected.length) clean.selected = selected;

    out.push(clean);
  }
  return out.length > 0 ? out : null;
}

export interface LlmJudgeOptions {
  /** 单次调用超时；chatJSON 内部还有一次瞬态重试，这里再兜一层有限重试 */
  timeoutMs?: number;
  /** 格式错误 / 调用失败时的额外重试次数（总尝试数 = 1 + retries） */
  retries?: number;
  /** 便于测试注入，不暴露任何配置内容 */
  caller?: (system: string, user: string, timeoutMs: number) => Promise<unknown | null>;
}

/**
 * 创建默认启用的模型仲裁器。
 * 任何失败都返回 null，由 runQuestionPipeline 自动降级为纯规则，绝不抛给导入流程。
 * 日志只记录批次数与成败，不打印 user 内容、密钥或任何配置。
 */
export function createLlmJudge(options: LlmJudgeOptions = {}): LlmJudge {
  const timeoutMs = options.timeoutMs ?? 12000;
  const retries = Math.max(0, Math.min(2, options.retries ?? 1));
  const caller =
    options.caller ??
    (async (system: string, user: string, ms: number) =>
      chatJSON<unknown>({ system, user, timeoutMs: ms, temperature: 0.1 }));

  return async (req: JudgeRequest): Promise<LlmVerdict[] | null> => {
    if (!req.candidates.length) return [];
    // 只送判断所需的信号与摘录，不送任何配置 / 认证信息
    const user = JSON.stringify({
      candidates: req.candidates.map((c) => ({
        index: c.index,
        signals: c.signals,
        excerpt: c.excerpt.slice(0, 900),
        context: c.context.slice(0, 400),
      })),
    });

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await caller(SYSTEM, user, timeoutMs);
        const parsed = parseVerdicts(raw, req.candidates.length);
        if (parsed) return parsed;
      } catch {
        // 落到下一次重试；不打印异常内容，避免泄露网关返回的敏感信息
      }
    }
    return null;
  };
}
