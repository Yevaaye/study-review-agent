// 把「完整原文」切成 [纯文本, 片段, 纯文本, 片段…]，供全文收录页渲染。
//
// 为什么要单独一层：原文与片段内容**并不是逐字相同**。
// 导入时每一行都被 trim 过 —— `   ↓` 变 `↓`、Markdown 硬换行（行尾两个空格）
// 被去掉、表格行前后空白被吃掉。所以直接拿片段内容去原文里 `indexOf` 会命中失败。
//
// 而恰好「题目块」全都带这些特征（难度行是硬换行、流程图有缩进箭头），
// 于是全书的题都定位不到：片段卡片不再渲染成独立块，统计标签整块消失，
// 页面上只剩上一段那句「暂无卡片」。实测一份材料 2501 个片段里 148 个定位失败，
// 23 张卡一张都没显示出来（2026-11-05 用户反馈「明明有题目为什么检测不到」）。
//
// 解法：在「逐行 trim 的检索副本」上找，再用偏移映射回到原文的真实位置。

import type { SourceFragment } from "../db/types";

export type RawBlock =
  | { kind: "text"; text: string }
  | { kind: "frag"; text: string; frag: SourceFragment };

/** 与检索副本同一套规则：逐行 trim，保留换行结构 */
export function normalizeForSearch(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
}

/** 逐行 trim 的检索副本 + 「副本下标 → 原文下标」映射 */
export function buildSearchHaystack(raw: string): { text: string; toRaw: number[] } {
  let text = "";
  const toRaw: number[] = [];
  let base = 0; // 当前行在原文里的起始偏移
  for (const line of raw.split("\n")) {
    const lead = line.length - line.trimStart().length;
    const trimmed = line.trim();
    for (let k = 0; k < trimmed.length; k++) {
      text += trimmed[k];
      toRaw.push(base + lead + k);
    }
    // 换行原样保留：片段内容里也是按 \n 拼的
    text += "\n";
    toRaw.push(base + line.length);
    base += line.length + 1;
  }
  return { text, toRaw };
}

/**
 * 逐个片段在原文里定位，找到就把它「包」起来，方便挂标注和锚点；
 * 定位不到（排版被改过）就跳过，正文照样完整渲染，只是少一处标注。
 */
export function segmentRaw(raw: string, frags: SourceFragment[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  const { text: haystack, toRaw } = buildSearchHaystack(raw);
  let cursor = 0; // 原文偏移
  let searchFrom = 0; // 检索副本偏移
  for (const f of frags) {
    const needle = normalizeForSearch((f.content ?? "").trim());
    if (!needle.trim()) continue;
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx < 0) continue;
    const start = toRaw[idx];
    const end = toRaw[idx + needle.length - 1] + 1;
    if (start > cursor) blocks.push({ kind: "text", text: raw.slice(cursor, start) });
    blocks.push({ kind: "frag", text: raw.slice(start, end), frag: f });
    cursor = end;
    searchFrom = idx + needle.length;
  }
  if (cursor < raw.length) blocks.push({ kind: "text", text: raw.slice(cursor) });
  return blocks;
}
