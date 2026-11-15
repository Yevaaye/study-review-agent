"use client";

import {
  answerNoteHint,
  answerNoteIsWarn,
  answerNoteText,
} from "@/lib/ui/answer-note";

/**
 * 「答案由 AI 提供」来源标注。
 *
 * 它回答两件事：答案文字**谁写的**（origin），以及原文**有没有依据**（grounded）。
 * 它是次要信息，不该跟答案抢注意力 —— 具体表现：
 *   - 11px（正文 14~17px 的一半左右），灰字；
 *   - 无底色、无描边（原来的 chip 有 12px + ring + 填充底，比答案还亮）；
 *   - 只有「原文没给、AI 自己补的」才转金色，把金色留给真正的风险。
 *
 * 文案本身在 `src/lib/ui/answer-note.ts`（纯函数，可被测试断言），三档：
 *   金色 `原文未给出`（grounded=false）/ 灰色 `AI 整理，依据原文`（true）
 *   / 灰色 `AI 提供`（null，未核对，不断言原文有没有）。
 */
export function AnswerSourceNote({
  origin,
  grounded,
  className = "",
}: {
  origin?: string | null;
  grounded?: boolean | null;
  className?: string;
}) {
  if (origin !== "ai") return null;
  const warn = answerNoteIsWarn(grounded);

  return (
    <span
      className={`source-note ${warn ? "source-note--warn" : ""} ${className}`}
      title={answerNoteHint(grounded)}
    >
      {answerNoteText(grounded)}
    </span>
  );
}
