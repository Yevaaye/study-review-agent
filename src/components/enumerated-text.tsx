"use client";

import { expandInlineEnumeration } from "@/lib/import/md-mobile-fix";

/**
 * 题干/原文的枚举换行显示。
 *
 * `①… ②… ③… ④…` 挤在一条长句里，手机上要来回扫才能数清有几项；答案行
 * `A.①②③ B.①②④` 同理。这里复用导入侧的同一套规则（只在「空白 + 圈号/字母」
 * 处断行，答案组合 `①②③` 内部天然不匹配），把它渲染成多行。
 *
 * 纯显示层：不改动传进来的文本，也不落库。
 */
export function EnumeratedText({ text, className = "" }: { text: string; className?: string }) {
  const expanded = text
    .split("\n")
    .map((line) => expandInlineEnumeration(line).text)
    .join("\n");
  const parts = expanded.split(/<br\s*\/?>|\n/i).filter((p) => p.trim() !== "");

  if (parts.length <= 1) return <span className={className}>{text}</span>;

  return (
    <span className={className}>
      {parts.map((p, i) => (
        <span key={i} className="block">
          {p}
        </span>
      ))}
    </span>
  );
}
