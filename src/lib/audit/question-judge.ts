/**
 * 「这段到底是不是题目」的 AI 判定。
 *
 * 与导入管线里的 question-llm 分工相同、用途不同：
 *   · 导入时：模型只对规则拿不准的候选做仲裁，且必须快（6s 超时、单批）；
 *   · 这里：用户主动点「再次识别 / 让 AI 判断」，可以慢一点、可以说明理由，
 *     因为结果会直接展示给用户看，理由比速度更重要。
 *
 * 硬约束：模型只回答「是不是题、什么题型、为什么」，**绝不返回改写后的题干**——
 * 一旦允许它输出文本，核对视图就会变成「AI 又编了一版题」，
 * 用户没法判断这到底是不是原文里的题。
 */

import { chatJSON } from "../llm";
import type { QuestionCandidateRow } from "./fragment-questions";

export interface JudgeVerdict {
  id: string;
  is_question: boolean | null;
  kind: "choice" | "qa" | "judge" | null;
  reason: string;
  confidence: number | null;
}

const SYSTEM = `你是题库校对员。用户会给你一段原文，以及从这段原文里切出来的若干「候选段落」。
你的任务是判断每个候选段落**是不是一道需要作答的题目**。

判定标准：
1. 只有「提出一个问题、要求作答」的才算题目（含选择题、问答题、判断题、填空题）。
2. 以下都不算题目：章节标题、正文说明、编号建议清单、操作步骤、要点罗列、复习笔记、代码块、答案/解析本身。
3. 特别小心「并列建议清单」：形如「1. … 2. … 3. …」各自是完整句子、彼此并列、没有在问什么，这是清单不是题目。
4. 题型：有 A/B/C/D 等选项组 → choice；一问一答 → qa；括号里标（对/错）→ judge。
5. 拿不准就把 is_question 设为 null，并在 reason 里说明卡在哪，不要硬判。

只输出 JSON，不要任何解释文字：
{"verdicts":[{"id":"候选id","is_question":true,"kind":"choice","reason":"20字内理由","confidence":0.8}]}`;

/** 单批最多送几个候选：太多会让模型开始敷衍，漏判比不判更糟 */
export const JUDGE_BATCH = 12;

export function buildJudgeUser(rows: QuestionCandidateRow[], context: string): string {
  const list = rows
    .map(
      (r, i) =>
        `[${i + 1}] id=${r.id}\n段落：${r.excerpt.replace(/\n{2,}/g, "\n").slice(0, 500)}`
    )
    .join("\n\n");
  return `原文上下文（供参考，不要复述）：\n${context.slice(0, 1200)}\n\n候选段落：\n${list}`;
}

/** 收口模型输出：畸形 / 未知 id 一律丢弃，绝不把半个判断写进界面 */
export function normalizeVerdicts(raw: unknown, allowedIds: string[]): JudgeVerdict[] {
  const allow = new Set(allowedIds);
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(obj.verdicts) ? obj.verdicts : Array.isArray(raw) ? raw : [];
  const out: JudgeVerdict[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? "").trim();
    if (!allow.has(id)) continue;

    const rawIsQ = o.is_question;
    const is_question =
      rawIsQ === true ? true : rawIsQ === false ? false : rawIsQ === null ? null : null;
    const kindRaw = String(o.kind ?? "").toLowerCase();
    const kind =
      kindRaw === "choice" || kindRaw === "qa" || kindRaw === "judge"
        ? (kindRaw as JudgeVerdict["kind"])
        : null;
    const reason = String(o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const confRaw = Number(o.confidence);
    const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : null;

    out.push({ id, is_question, kind, reason, confidence });
  }
  return out;
}

/**
 * 调模型判定一批候选。
 * 失败（未配置 / 超时 / 畸形）返回 null —— 调用方据此提示「AI 没能识别，走人工入口」，
 * 而不是假装判过了。
 */
export async function judgeCandidates(
  rows: QuestionCandidateRow[],
  context: string,
  opts: { timeoutMs?: number } = {}
): Promise<JudgeVerdict[] | null> {
  if (rows.length === 0) return [];
  const batch = rows.slice(0, JUDGE_BATCH);
  try {
    const raw = await chatJSON<unknown>({
      system: SYSTEM,
      user: buildJudgeUser(batch, context),
      temperature: 0.1,
      timeoutMs: opts.timeoutMs ?? 20000,
    });
    const verdicts = normalizeVerdicts(raw, batch.map((r) => r.id));
    return verdicts.length > 0 ? verdicts : null;
  } catch {
    return null;
  }
}
