// 卡片 / 知识点的确定性 id。
//
// 为什么不用自增 uuid：整套链路要求「幂等」——
//   · 重复导入同一份材料，不能把同样的题再出一遍；
//   · 同一个知识点点两次「出题」，第二次必须新增 0 张；
//   · 已经审核过、复习过的卡，绝不能被新导入的内容覆盖。
// 用 uuid 就只能靠「查一遍再插」来去重，而查重条件一多（题干归一化、章节路径、
// 材料）就容易写漏。改成「内容算 id」，重复即同 id，数据库层面天然冲突，
// 去重逻辑只剩一行 `existing.has(id)`。
//
// 注意：id 只由「材料 + 章节路径 + 归一化题干」决定，不含答案 ——
// 同一个问题补出了更好的答案，不应视为两张卡，而应走「编辑」而不是「新增」。

import crypto from "node:crypto";

/**
 * 题干归一化：去掉空白与标点、统一大小写。
 *
 * 只用于算 id 和查重，**不用于展示** ——
 * 归一化后的文案会丢标点，用它当题干会破坏中文可读性。
 * 原文措辞必须逐字保留（这是原题保真的要求）。
 */
export function normalizeFront(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/[，。、；：？！“”‘’（）()\[\]【】·,.;:?!"'`~—-]/g, "")
    .toLowerCase();
}

function hash16(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/** 章节标题路径的稳定键（用于 id 与日志） */
export function chapterPathKey(path: string[] | null | undefined): string {
  return (path ?? []).join(" > ");
}

/** 卡片确定性 id：c_ 前缀方便一眼认出是新链路生成的 */
export function cardIdFor(docId: string, chapterPath: string[] | null, front: string): string {
  return `c_${hash16([docId, chapterPathKey(chapterPath), normalizeFront(front)])}`;
}

/** 知识点确定性 id：k_ 前缀 */
export function kpIdFor(docId: string, chapterPath: string[] | null, statement: string): string {
  return `k_${hash16([docId, chapterPathKey(chapterPath), normalizeFront(statement)])}`;
}
