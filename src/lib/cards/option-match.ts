/**
 * 选项文字与「正确答案」的宽容比对。
 *
 * 抽取出来的选择题常带这些噪声，两边长得不一样但其实是同一项：
 * - 选项保留了序号前缀：`A. 矛盾的普遍性…`
 * - 选项里残留 Markdown 强调符：`… 指标 3 步**`
 * - 答案末尾多了句号：`… 指标 3 步。`
 * - 答案只给了字母：`B`
 * - 答案是多个字母：`A、C`（多选题）
 *
 * 严格字符串相等会让「正确答案」高亮永远不出现，用户看不到哪一项对，
 * 所以这里统一去掉序号前缀、Markdown 符号和首尾标点后再比。
 *
 * 解析与集合判定集中在 answer-keys.ts：复习页判题、复习页高亮、审核台高亮
 * 必须共用同一把尺子，多选才不会出现「只高亮第一个正确项」。
 */

import { normalizeOptionText, parseAnswerKeys } from "./answer-keys";

export { normalizeOptionText };

/** 答案是否只给了选项字母（A/B/C/D…） */
export function answerLetter(input: string, optionCount: number): number | null {
  const m = String(input ?? "")
    .trim()
    .match(/^[（(]?\s*([A-Ha-h])\s*[)）]?\s*[.、．]?$/);
  if (!m) return null;
  const idx = m[1].toUpperCase().charCodeAt(0) - 65;
  return idx >= 0 && idx < optionCount ? idx : null;
}

/**
 * 判断第 index 个选项是否为正确答案（多选时：命中任意一个正确项即为 true）。
 * @param option 选项原文（可带 `A.` 前缀）
 * @param answer 卡片上的答案（选项全文 / 字母 / 多选字母列表）
 * @param index 选项下标（0 起）
 * @param optionCount 选项总数，用于校验字母答案的合法性
 * @param options 真实选项列表（可选；传了就支持「答案是多段选项全文」的多选写法）
 */
export function isCorrectOption(
  option: string,
  answer: string | null | undefined,
  index: number,
  optionCount: number,
  options?: string[] | null
): boolean {
  const a = String(answer ?? "").trim();
  if (!a) return false;

  // 真实选项优先；没有就退化成占位项，只用来拿 optionCount 这一约束。
  const opts =
    Array.isArray(options) && options.length > 0
      ? options
      : Array.from({ length: Math.max(optionCount, 0) }, (_, i) => `__opt_${i}`);
  const parsed = parseAnswerKeys(a, opts);

  // 字母 / 圈号 / 数字形态：下标直接可用
  if (parsed.keys.length > 0 && parsed.form !== "text") return parsed.keys.includes(index);
  if (parsed.keys.length > 1) return parsed.keys.includes(index);

  // 文本形态：按内容比（答案可能是选项全文，也可能带序号前缀/句号）
  const na = normalizeOptionText(a);
  if (na && normalizeOptionText(option) === na) return true;
  return parsed.keys.includes(index);
}
