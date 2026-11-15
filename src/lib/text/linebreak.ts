/**
 * 文本断行规则（纯显示层，不改数据、不落库）。
 *
 * 只做一件事：把「一句话里用分号串起来的多个分句」拆成多行。
 * 中文分号 `；` 与英文 `;` 同等对待 —— 答案里两种都会出现。
 *
 * 三条约束：
 * 1. 分号留在**上一行末尾**（读起来是「一句一顿」，不是被截断）；
 * 2. 分号后原本就有换行的，不重复断（避免空行）；
 * 3. 拆出来短于 2 个字的碎片丢弃（防止 `；；` 之类脏数据产生孤立行）。
 *
 * 唯一会「消失」的是分号后面那个半角空格 —— 留着会让每行都缩进一格，
 * 显示层不需要它，可见字符一个不动。
 */

/** 一个字都不许丢：拆分只增加换行位置，不移动、不删改任何字符 */
export function splitAtSemicolons(line: string): string[] {
  if (!/[；;]/.test(line)) return [line];

  const parts = line
    .split(/(?<=[；;])\s*/)
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim().length > 0);

  // 去掉「只剩一个分号」这类碎片，并把它接回前一段（宁可不拆，也不丢字符）
  const out: string[] = [];
  for (const p of parts) {
    if (out.length > 0 && p.replace(/[；;\s]/g, "") === "") {
      out[out.length - 1] += p;
      continue;
    }
    out.push(p);
  }
  return out.length > 0 ? out : [line];
}

/** 整段答案按分号与原有换行拆成多行 */
export function splitAnswerLines(text: string): string[] {
  return text.split("\n").flatMap((l) => splitAtSemicolons(l));
}
