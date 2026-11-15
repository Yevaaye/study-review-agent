import type { UnifiedQuestion } from "./question-types";

/**
 * 答案完整性回填：把「答案行只是摘要句、完整答案在紧随其后的段落」补齐。
 *
 * 现场（真实素材《AI产品经理面试高频100题》）：
 *
 *   问题：什么是过拟合和欠拟合？
 *   答案：过拟合指模型…学习了噪声。          ← 抽取只拿这一行
 *
 *   过拟合指模型…学习了噪声。欠拟合指模型…   ← 同一段落里的第二个答案，整段被丢掉
 *
 * 根因在 extractQuestionsFromChunk：`答案：` 命中后 `cur.answer` 非空，
 * 后续普通行既不满足题干续行的 `!cur.answer`，又不在 `answerZone`，
 * 于是被静默丢弃。这里不改主状态机（那会牵动整条抽题链路），
 * 而是在管线末尾按「原文段落」做一次确定性回填。
 *
 * 只在「后续段落以已抽到的答案为前缀、且确实更长」时才替换 ——
 * 这是对「摘要 + 完整版」这种排版的最小充分判据，不会把无关正文吞进答案。
 */

/** 修正原因：同一段落漏了并列答案 / 答案被截断 */
export type ExpansionReason = "multi_answer" | "truncated";

export interface AnswerExpansion {
  question: string;
  before: string;
  after: string;
  reason: ExpansionReason;
  /** 原文摘录，供审计核对 */
  excerpt: string;
}

export interface ExpansionResult {
  questions: UnifiedQuestion[];
  expansions: AnswerExpansion[];
}

/** 答案行前缀（段落开头可能带「答案：」） */
const ANSWER_PREFIX =
  /^\s*\*{0,2}(?:参考答案|正确答案|标准答案|答案|答|Answer)\s*[:：]\s*\*{0,2}\s*/i;

/** 这些段落不是答案正文，绝不能拿来扩写 */
const NOT_ANSWER =
  /(?:^\s*#{1,6}\s|\*{2}(?:难度|出现频率|考察点|考点|相关阅读|总结与建议|追问延伸|思考逻辑)|\b(?:问题|题目|解析|分析)\s*[:：]|^\s*[-|>]\s|\b(?:第\s*\d+\s*题)\s*[:：])/i;

/** 段落以这些结尾，说明下一段是它的要点列表（不接上就是答案截断） */
const CONT_HINT = /(?:[:：]|如下|以下|几个方面|几类)\s*$/;
/** 要点列表段落 */
const LIST_PARA = /^\s*(?:[-*•]\s|\d{1,3}[.、．)）]\s|（\d{1,3}）)/m;
/** 续段里出现这些就是下一道题/别的板块，不能再并 */
const NEW_BLOCK =
  /(?:^\s*#{1,6}\s|\b(?:问题|题目)\s*[:：]|\*{2}(?:难度|出现频率|考察点|相关阅读|追问延伸))/i;

/** 新答案比原答案多出的内容上限：超过就说明吞进了别的段落 */
const MAX_TAIL = 500;
/** 太短的答案串容易在全文里误命中，不参与回填 */
const MIN_ANSWER = 8;

function norm(s: string): string {
  return s.replace(/\*/g, "").replace(/\s+/g, "").replace(/\u200b/g, "").trim();
}

/** 新增部分形成了完整的第二句 → 判定为「同段落多答案」，否则按截断记 */
function reasonOf(tail: string): ExpansionReason {
  return /[。；;!?！？]/.test(tail) ? "multi_answer" : "truncated";
}

export function expandAnswersFromContext(
  questions: UnifiedQuestion[],
  markdown: string
): ExpansionResult {
  const md = String(markdown ?? "");
  const expansions: AnswerExpansion[] = [];
  if (!md.trim() || questions.length === 0) return { questions, expansions };

  // 按空行切段落；同一个段落内的换行不切开（题目 + 答案行通常紧挨着）
  const allParas = md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const paras = allParas
    .map((raw, i) => ({ raw, i, body: norm(raw.replace(ANSWER_PREFIX, "")) }))
    .filter((p) => p.body.length >= MIN_ANSWER && !NOT_ANSWER.test(p.raw));

  const out = questions.map((q) => {
    const a = norm(q.answer ?? "");
    if (a.length < MIN_ANSWER) return q;

    // startsWith 在首字不匹配时立即返回，几百题 × 几千段也不会拖慢导入
    let best: { raw: string; body: string; i: number } | null = null;
    for (const p of paras) {
      if (!p.body.startsWith(a)) continue;
      const tail = p.body.slice(a.length);
      if (!tail || tail.length > MAX_TAIL) continue;
      if (!best || p.body.length > best.body.length) best = p;
    }
    if (!best) return q;

    let after = best.raw.replace(ANSWER_PREFIX, "").trim();
    // 「…包括以下几类：」后面接一个要点列表，列表本身在下一个段落里。
    // 不并进来答案就停在冒号上（仍是截断），这里只在结尾有明显引导语、
    // 且下一段确实是列表时才接，避免把下一道题吞进答案。
    const next = allParas[best.i + 1];
    if (
      next &&
      CONT_HINT.test(after) &&
      LIST_PARA.test(next) &&
      !NEW_BLOCK.test(next) &&
      norm(next).length <= 300
    ) {
      const joined = `${after}\n${next.trim()}`;
      if (norm(joined).length - a.length <= MAX_TAIL) after = joined;
    }
    if (!after || norm(after) === a) return q;
    const tail = norm(after).slice(a.length);
    const reason = reasonOf(tail);

    expansions.push({
      question: q.question_text,
      before: q.answer,
      after,
      reason,
      excerpt: after.slice(0, 300),
    });

    return {
      ...q,
      answer: after,
      needs_answer: false,
      flags: [...q.flags.filter((f) => f !== "answer_unverified"), "answer_expanded"],
    };
  });

  return { questions: out, expansions };
}
