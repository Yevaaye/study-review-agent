// 题目抽取结果适配层 —— 把新管线的 UnifiedQuestion 转回既有 ExtractedQuestion。
//
// 这是本次改造的「兼容边界」：api/import/route.ts 逐字段消费 ExtractedQuestion，
// 其 no/type/front/back/options/answer/explanation/needs_answer/chapterIndex/startLine/endLine
// 一个都不能少，也不能改名。新管线多出来的 confidence / review_required / 来源信息
// 只留在模块内部（原题卡本来就是 status=draft 待审核，天然承接 review_required），
// 不往 Card 结构里塞新字段，因此数据库与其它业务模块零改动。

import type { ClassifyResult, ExtractedQuestion } from "./classify";
import type { ParsedChapter } from "./markdown";
import type { PipelineResult, UnifiedQuestion } from "./question-types";
import { checkFidelity } from "./fidelity";

/** 比较用归一化（与管线内一致，独立实现以避免跨文件运行时 import）。 */
function norm(s: string): string {
  return String(s ?? "")
    .replace(/[*`_~]/g, "")
    .replace(/\s+/g, "")
    .replace(/[，,]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[？?]/g, "?")
    .toLowerCase();
}

/** 章标题归一：解析器会把「1. 基础概念」写成「1 基础概念」，精确等值必然失配。 */
function titleKey(s: string): string {
  return norm(String(s ?? "").replace(/^#{1,6}\s*/, "").replace(/^第[一二三四五六七八九十\d]+[章节篇]\s*/, ""));
}

function chapterIndexFor(
  q: UnifiedQuestion,
  chapters: ParsedChapter[],
  fallback: ExtractedQuestion[]
): number {
  // 1) 同一道题若规则链路也抽到了，直接复用它的章归属（最可靠）
  const same = fallback.find((f) => norm(f.front).slice(0, 80) === norm(q.question_text).slice(0, 80));
  if (same && same.chapterIndex >= 0 && same.chapterIndex < chapters.length) return same.chapterIndex;

  // 2) 章节路径逐级匹配（归一后包含/相等），避免「数字编号章」被一律归到 0
  const path = q.chapter_path.filter(Boolean).map(titleKey);
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const key = path[depth];
    if (!key) continue;
    for (let i = 0; i < chapters.length; i++) {
      const t = titleKey(chapters[i].title);
      if (t === key || t.includes(key) || key.includes(t)) return i;
    }
  }
  return 0;
}

function lineOf(md: string, offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  const clamped = Math.min(Math.max(0, Math.trunc(offset)), md.length);
  let line = 0;
  for (let i = 0; i < clamped; i++) if (md.charCodeAt(i) === 10) line++;
  return line;
}

function questionKey(no: number | null, front: string): string {
  return `${no ?? "-"}|${norm(front).slice(0, 120)}`;
}

/** UnifiedQuestion → ExtractedQuestion（字段逐一对应，不新增/改名）。 */
export function adaptToExtractedQuestions(
  unified: UnifiedQuestion[],
  chapters: ParsedChapter[],
  markdownText: string,
  fallback: ExtractedQuestion[] = []
): ExtractedQuestion[] {
  const md = String(markdownText ?? "");
  const out: ExtractedQuestion[] = [];

  for (const q of unified) {
    const front = q.question_text.trim();
    if (!front) continue;
    const startLine = lineOf(md, q.source_start);
    const endLine = Math.max(startLine, lineOf(md, q.source_end));
    const options = q.question_type === "choice" && q.options.length >= 2 ? [...q.options] : undefined;
    const answer = q.answer || q.explanation || "";

    out.push({
      no: q.no,
      type: q.question_type,
      front,
      back: answer,
      options,
      answer: q.question_type === "choice" || q.question_type === "judge" ? q.answer || undefined : undefined,
      explanation: q.explanation || undefined,
      // needs_answer 与 back 的取值对齐：back 用 `answer || explanation` 兜底，
      // 这里也只看「两者皆空」才算缺答案。此前只认 q.answer，导致「解析已抓到、
      // 答案正文被塞进 explanation」的题被误标「缺答案要 AI 补」—— 假阳性主源。
      needs_answer: !q.answer && !q.explanation,
      chapterIndex: chapterIndexFor(q, chapters, fallback),
      startLine,
      endLine,
      // 反向核对：卡上的文字是否真的来自原文。不改内容，只留证据供审核台核对。
      fidelity: checkFidelity({ question_text: front, options, answer }, md),
    });
  }

  return out;
}

/**
 * 合并规则基线：新管线没覆盖到的旧格式题仍然保留，保证「只增不减」。
 * 模型失败时 question-entry 会直接返回整份 fallback，这里不会被执行。
 */
export function mergeWithRuleFallback(
  adapted: ExtractedQuestion[],
  fallback: ExtractedQuestion[]
): ExtractedQuestion[] {
  const seen = new Set(adapted.map((q) => questionKey(q.no, q.front)));
  const out = [...adapted];
  for (const q of fallback) {
    const key = questionKey(q.no, q.front);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** 统一产出 ClassifyResult，blockTypes 沿用规则链路（FragmentType 前缀不变）。 */
export function adaptToClassifyResult(
  pipeline: PipelineResult,
  chapters: ParsedChapter[],
  markdownText: string,
  fallback: ClassifyResult
): ClassifyResult {
  const adapted = adaptToExtractedQuestions(
    pipeline.questions,
    chapters,
    markdownText,
    fallback.questions
  );
  return {
    questions: mergeWithRuleFallback(adapted, fallback.questions),
    blockTypes: fallback.blockTypes,
  };
}
