// 原文锚定判断 —— 「这句话真的出自原文吗」「两段依据是不是同一处」。
//
// 从 cards/generate.ts 抽出来，原因有两个：
//   1) 它是纯函数、无依赖，能被回归脚本直接测（sanitize 依赖聊天层，测不了）
//   2) 「原文锚定」这件事在项目里不只用于出题闸门，将来补答案、绑知识点都要用
//
// 判定策略是「三级放宽」，全部失败才算编造 —— 宁可放过一句有依据的话，
// 也不能把真卡误杀成编造（误杀会让用户以为系统坏了）。反过来，只要有一条
// 12 字以上的连续片段是逐字命中的，就认为这句话确实引自原文。

/** 只抹排版差异（空白 / 强调符 / 全半角），不动措辞。 */
export function normForMatch(s: string): string {
  return String(s ?? "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[？]/g, "?")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[。．]/g, ".")
    .replace(/\s+/g, "")
    .toLowerCase();
}

const RUN = 12;

/**
 * evidence 是否真的出自原文。
 *
 *   1. 整段逐字包含（最常见）
 *   2. 去掉「原文：」这类前缀后再找
 *   3. 掐掉首尾 6 字后再找（模型爱把 evidence 包进一句话里）
 *   4. 任意 12 字连续片段命中（跨行/跨段拼接的情况）
 */
export function isGroundedIn(evidence: string, materialHay: string): boolean {
  const e = normForMatch(evidence);
  if (!e) return false;
  if (materialHay.includes(e)) return true;

  const trimmed = e.replace(/^原文:/, "");
  if (trimmed.length >= 6 && materialHay.includes(trimmed)) return true;

  if (e.length > 20) {
    const mid = e.slice(6, -6);
    if (mid.length >= 8 && materialHay.includes(mid)) return true;
  }

  if (e.length >= RUN) {
    for (let i = 0; i + RUN <= e.length; i++) {
      if (materialHay.includes(e.slice(i, i + RUN))) return true;
    }
  }
  return false;
}

/**
 * 两段 evidence 是否指向原文的同一处（同一段落/同一话题）。
 *
 * 用来挡「卡挂错知识点」：题挂到 kp_index=3，但依据出自第 1 条知识点所在的段落。
 * 这类错误在题面上完全看不出来，只能靠字面重合度判断。
 *
 * 为什么用 bigram 而不是「连续 N 字」：中文里同一段落的两句话常常不共享长片段
 * （「财政政策的主体是政府」vs「财政政策是指政府通过调整收支…」只共享「财政政策」），
 * 用连续片段会大量误杀真卡。bigram 重叠能抓住「同一话题」，而对不同话题又足够敏感
 * （「财政政策…」vs「货币政策由中央银行…」只重叠一个 bigram，判为不同源）。
 *
 * 信息不足时返回 true（不做否定判断）。
 */
export function sharesSourceRun(a: string, b: string): boolean {
  const A = normForMatch(a);
  const B = normForMatch(b);
  if (!A || !B) return true;
  if (A.includes(B) || B.includes(A)) return true;

  const ga = bigrams(A);
  const gb = bigrams(B);
  if (ga.size === 0 || gb.size === 0) return true;

  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  const ratio = hit / Math.min(ga.size, gb.size);
  // 至少要两个不同的二字组合重合，且占较短一方的 20% —— 单个「政策」不足以判同源
  return hit >= 2 && ratio >= 0.2;
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}
