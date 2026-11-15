import { chatJSON } from "../llm";
import { tidyInline, tidyModelText } from "./answer-format";

/**
 * 「给没有答案的题补一条答案」。
 *
 * 背景：导入的题库里，很多题只给了题干，答案在原文里根本没有（或者被切到了
 * 别的片段里）。审核台上这些卡点「显示答案」是空的，复习时也没法对答案。
 *
 * 这里做的事：把「这道题 + 它绑定的知识点 + 所属章节正文」一起交给模型，
 * 让它**只依据这些材料**写一条可以直接背的答案。
 *
 * 最重要的约束是「不许编」：
 *   · 材料回答不了这道题时，返回 sufficient=false，我们宁可留空也不写一条像样的假答案；
 *   · 答案落库时会打 answer_origin="ai"，审核台显示「AI 生成」，
 *     使用者一眼就能分清「原文给的」和「AI 补的」。
 */

export interface AnswerRequest {
  /** 题干 */
  front: string;
  /** choice / qa / cloze / judge / contrast，缺省按 qa 处理 */
  cardType: string | null;
  /** 选择题选项（无选项为 null） */
  options: string[] | null;
  /** 绑定的知识点陈述（最有价值的上下文，通常就是答案要点） */
  kpStatement: string | null;
  /** 知识点的原文依据 */
  kpEvidence: string | null;
  /** 所属章节正文（已截断） */
  material: string;
  /** 原文自带的解析（若有，作为参考） */
  explanation: string | null;
}

export interface AnswerPayload {
  /** 可直接背的答案；选择题为选项字母 */
  answer: string;
  /** 为什么是这个答案（引用材料关键句） */
  explanation: string | null;
  /** 支撑答案的原文摘录，供人工核对；无依据时为空 */
  basis: string | null;
  /**
   * 答案是否能在原文里找到依据。
   *   true  = 严格来自材料，可信度高
   *   false = 原文没写，AI 用自己的专业知识补的 —— UI 必须把它标出来
   */
  grounded: boolean;
}

/** 材料上限：超过这个长度对答案质量没有帮助，只会拖慢并挤掉重点 */
export const MAX_ANSWER_MATERIAL = 6000;

const SYSTEM = `你是一名学习答疑老师。学生给你一道题，以及这份材料里的章节正文和知识点（材料可能很零碎，也可能根本没写答案）。

按两步处理：
第一步，先判断材料里有没有直接回答这道题的事实、结论或方法。
  · 有 → grounded = true，答案严格来自材料，一个字都不许超出材料的范围。
  · 没有 → grounded = false，用你自己的专业知识作答。题库多来自面试/岗位场景，答案要具体、可执行、能直接说出口。

两种情况下 answer 都必须写出来，不允许留空、不允许写"材料未提及"当作答案。

答案要求：
1. 1~3 句，最多 120 字，学生能直接背下来；分点优于长段落。
2. 不要重复题干，不要写"根据材料""综上所述"这类废话。
3. 选择题：answer 只填正确选项的字母（如 "B"），必须与给出的选项之一对应。
4. 判断题：answer 只填 "对" 或 "错"。
5. 填空题：直接给出应填内容，多个空用 " / " 分隔。

只输出 JSON，不要任何解释文字：
{"grounded": true, "answer": "答案正文", "explanation": "grounded=true 时引用材料里的关键句；false 时用一句话说明原文没写这条", "basis": "grounded=true 时逐字摘录支撑答案的原文（120 字内）；false 时留空字符串"}`;

/**
 * 答案正文收口：保留换行（表格 / 分点靠它活），见 answer-format.ts 的说明。
 * 单行字段（explanation / basis）另走 tidyInline，不能把诊断写成一堆换行。
 */
function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return tidyModelText(v, max);
}

/** 单行字段（explanation / basis）：换行在界面上只是一串空格，提前压掉 */
function oneLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return tidyInline(v, max);
}

/** 常见「模型在敷衍」的开头，出现即认为没答到点上 */
const DODGE =
  /^(无法(从)?(材料|原文)?(中)?(确定|回答|判断)|材料(中|里)?(并)?(未|没有)(提及|说明|给出)|没有(相关)?(信息|依据))/;

function normalize(raw: unknown, req: AnswerRequest): AnswerPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const answer = str(o.answer, 600);
  if (!answer) return null;
  if (DODGE.test(answer)) return null;

  const grounded = o.grounded === true;

  // 选择题：必须是合法字母，且落在选项范围内
  if (req.cardType === "choice" && (req.options?.length ?? 0) > 0) {
    const letter = answer.toUpperCase().match(/^[A-Z]/)?.[0] ?? "";
    const idx = letter ? letter.charCodeAt(0) - 65 : -1;
    if (idx < 0 || idx >= (req.options?.length ?? 0)) return null;
    return {
      answer: letter,
      explanation: oneLine(o.explanation, 300) || null,
      basis: grounded ? oneLine(o.basis, 300) || null : null,
      grounded,
    };
  }

  // 判断题：收口到「对 / 错」
  if (req.cardType === "judge") {
    const v = /^(对|正确|是|true|√)/i.test(answer)
      ? "对"
      : /^(错|错误|否|false|×)/i.test(answer)
        ? "错"
        : null;
    if (!v) return null;
    return {
      answer: v,
      explanation: oneLine(o.explanation, 300) || null,
      basis: grounded ? oneLine(o.basis, 300) || null : null,
      grounded,
    };
  }

  return {
    answer,
    explanation: oneLine(o.explanation, 300) || null,
    basis: grounded ? oneLine(o.basis, 300) || null : null,
    grounded,
  };
}

function buildUser(req: AnswerRequest): string {
  const parts: string[] = [];
  const typeLabel =
    { choice: "选择题", qa: "问答题", cloze: "填空题", judge: "判断题", contrast: "对比题" }[
      req.cardType ?? "qa"
    ] ?? "问答题";

  parts.push(`【题型】${typeLabel}`);
  parts.push(`【题目】${req.front}`);
  if (req.options?.length) {
    parts.push(
      `【选项】\n${req.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n")}`
    );
  }
  if (req.kpStatement) parts.push(`【这道题考的知识点】${req.kpStatement}`);
  if (req.kpEvidence) parts.push(`【知识点对应的原文】${req.kpEvidence}`);
  if (req.explanation) parts.push(`【原文提供的解析（可参考）】${req.explanation}`);
  parts.push(`【章节正文（唯一可引用的事实来源）】\n${req.material}`);
  parts.push(
    "如果正文里确实找不到这道题的答案，就按规则用自己的专业知识作答，并把 grounded 设为 false；" +
      "能找到就严格照原文写，grounded=true。无论哪种情况都要给出 answer。"
  );
  return parts.join("\n\n");
}

/**
 * 生成一条答案。
 *
 * 返回 null 表示「没有可用的答案」：材料不足、模型判不出、模型返回畸形、
 * 或网关调用失败。调用方据此保留「待补答案」状态，不做任何写入。
 */
export async function generateCardAnswer(
  req: AnswerRequest,
  opts: { timeoutMs?: number } = {}
): Promise<AnswerPayload | null> {
  const material = (req.material ?? "").slice(0, MAX_ANSWER_MATERIAL);
  if (material.replace(/\s+/g, "").length < 20) return null;
  if (!req.front.trim()) return null;

  const raw = await chatJSON<unknown>({
    system: SYSTEM,
    // 补答案要贴着材料走，温度比出题低，减少自由发挥
    temperature: 0.2,
    // 网关偶发 30s+ 的慢响应，20s 会把这类题误伤成「生成失败」
    timeoutMs: opts.timeoutMs ?? 32000,
    user: buildUser({ ...req, material }),
  });

  return normalize(raw, req);
}
