import { normalizeAnswerText } from "./answer-format";
import type { CardStore } from "../db/store";
import type { Card, SourceFragment } from "../db/types";
import { generateCardAnswer, MAX_ANSWER_MATERIAL, type AnswerRequest } from "./answer";

/**
 * 把「一张没有答案的卡」变成「一条可用的答案」。
 *
 * 取值顺序（重要的在前面）：
 *   1. 卡片绑定的知识点（statement + evidence）—— 通常就是答案要点
 *   2. 卡片来源片段所在的章节正文 —— 事实来源
 *   3. 原文自带的解析（若有）
 *
 * 三条都太短时直接放弃，不浪费一次模型调用。
 */

export interface FillResult {
  ok: boolean;
  /** 失败原因，用于给用户一句能看懂的话 */
  reason?: "no-material" | "insufficient" | "write-failed";
  answer?: string;
  /** 答案是否有原文依据（false = AI 用专业知识补的） */
  grounded?: boolean;
}

/** 章节片段缓存：批量补答案时同一章只读一次盘 */
export type MaterialCache = Map<string, SourceFragment[]>;

/** 去掉空白与标点，只留可比对的字 */
function norm(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

function gramsOf(s: string, n = 4): Set<string> {
  const out = new Set<string>();
  const t = norm(s);
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

async function chapterFragments(
  store: CardStore,
  textbookId: string,
  chapterId: string,
  cache?: MaterialCache
): Promise<SourceFragment[]> {
  const key = `${textbookId}:${chapterId}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const list = await store.listFragments(textbookId, chapterId);
  cache?.set(key, list);
  return list;
}

/**
 * 从整章里挑出「和这道题最相关」的片段拼成材料。
 *
 * 早期实现是「取整章前 6000 字」——对 80 个片段、4 万字的大章来说，
 * 排在第 40 位的题目连窗口都进不去，模型只能回答「材料里没有」，等于白调一次。
 * 现在按 4-gram 重合度排序取前若干段，再按原来的顺序拼起来，保持上下文连贯。
 */
export function selectMaterial(
  frags: SourceFragment[],
  query: string,
  budget = MAX_ANSWER_MATERIAL
): string {
  if (frags.length === 0) return "";
  const qg = gramsOf(query);
  if (qg.size === 0) return frags.map((f) => f.content).join("\n\n").slice(0, budget);

  const scored = frags.map((f, i) => {
    const fg = gramsOf(f.content);
    let hit = 0;
    for (const g of qg) if (fg.has(g)) hit++;
    return { i, f, score: hit };
  });

  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked: typeof scored = [];
  let used = 0;
  for (const s of scored) {
    // 相关度为 0 的片段只在预算还有大量剩余时才带上（当背景，不当依据）
    if (s.score === 0 && picked.length >= 6) break;
    const len = s.f.content.length;
    if (picked.length > 0 && used + len > budget) continue;
    picked.push(s);
    used += len;
    if (used >= budget) break;
  }

  // 还原成原文顺序，避免把上下文拼成碎片
  picked.sort((a, b) => a.i - b.i);
  return picked
    .map((s) => s.f.content)
    .join("\n\n")
    .slice(0, budget);
}

export async function buildAnswerRequest(
  store: CardStore,
  card: Card,
  cache?: MaterialCache
): Promise<AnswerRequest | null> {
  const sources = await store.listCardSources(card.id);

  let chapterId: string | null = sources.find((s) => s.chapter_id)?.chapter_id ?? null;
  let textbookId: string | null = sources.find((s) => s.textbook_id)?.textbook_id ?? null;

  let kpStatement: string | null = null;
  let kpEvidence: string | null = null;

  if (card.kp_id) {
    const kp = await store.getKnowledgePoint(card.kp_id);
    if (kp) {
      kpStatement = (kp.statement ?? kp.title ?? "").trim() || null;
      kpEvidence = (kp.evidence ?? "").trim() || null;
      if (!chapterId && kp.chapter_id) {
        chapterId = kp.chapter_id;
        const ch = await store.getChapter(kp.chapter_id);
        textbookId = textbookId ?? ch?.textbook_id ?? null;
      }
    }
  }

  let material = "";
  if (textbookId && chapterId) {
    const frags = await chapterFragments(store, textbookId, chapterId, cache);
    // 检索用的查询词：题干 + 知识点，两者都指向「该去哪找依据」
    material = selectMaterial(frags, `${card.front} ${kpStatement ?? ""}`);
  }

  // 答案可能在**另一章**：题目在「高频面试题」章、答案在「参考答案要点」章。
  // 只检索题目所在章节会把答案原文挡在门外，模型只能 grounded=false 编答案。
  // 这里在当前章节材料明显不足（检索不到答案线索）时，扩展到整本书再检索一次，
  // 让「先在原文上下文搜索补全」真正生效 —— 找到就 grounded=true，找不到才 AI 兜底。
  if (textbookId && material.replace(/\s+/g, "").length < 120) {
    const allFrags = await store.listFragments(textbookId);
    // 去掉当前章节已检索过的片段，只补「别的章节」里可能藏着答案的部分
    const otherChapterFrags = allFrags.filter((f) => f.chapter_id !== chapterId);
    if (otherChapterFrags.length > 0) {
      const extra = selectMaterial(otherChapterFrags, `${card.front} ${kpStatement ?? ""}`);
      if (extra.replace(/\s+/g, "").length > material.replace(/\s+/g, "").length) {
        material = extra;
      }
    }
  }

  // 正文、知识点、原解析三样都没有 → 没有任何可依据的材料
  const basisLength =
    material.replace(/\s+/g, "").length +
    (kpStatement?.replace(/\s+/g, "").length ?? 0) +
    (kpEvidence?.replace(/\s+/g, "").length ?? 0);
  if (basisLength < 30) return null;

  // 正文不足时，把知识点补进材料，保证模型至少拿得到考点的表述
  if (material.replace(/\s+/g, "").length < 60) {
    material = [kpStatement, kpEvidence, material].filter(Boolean).join("\n\n");
  }

  return {
    front: card.front,
    cardType: card.card_type ?? (card.is_choice ? "choice" : "qa"),
    options: card.options ?? null,
    kpStatement,
    kpEvidence,
    material,
    explanation: card.explanation ?? null,
  };
}

export interface DraftResult {
  ok: boolean;
  reason?: "no-material" | "insufficient" | "write-failed";
  /** 落 back 的值：问答是答案正文，选择题是选项文本 */
  back?: string;
  /** 落 answer 的值：只有选择题/判断题才有 */
  answer?: string | null;
  explanation?: string | null;
  /** 答案是否能在原文里找到依据（false = AI 用专业知识补的） */
  grounded?: boolean;
}

/**
 * 只生成、不写库。
 * 批量补答案时先攒够一批再一次性落盘，避免每张卡都全量写一次 5MB 的库。
 */
export async function draftCardAnswer(
  store: CardStore,
  card: Card,
  opts: { cache?: MaterialCache; timeoutMs?: number } = {}
): Promise<DraftResult> {
  const req = await buildAnswerRequest(store, card, opts.cache);
  if (!req) return { ok: false, reason: "no-material" };

  const payload = await generateCardAnswer(req, { timeoutMs: opts.timeoutMs });
  if (!payload) return { ok: false, reason: "insufficient" };

  const isChoiceLike = (card.options?.length ?? 0) > 0;
  if (isChoiceLike) {
    // 选择题：模型只给字母，落库要存选项文本（与导入链路一致，不依赖索引）
    const idx = payload.answer.charCodeAt(0) - 65;
    const opt = card.options?.[idx] ?? null;
    if (!opt) return { ok: false, reason: "insufficient" };
    return {
      ok: true,
      back: opt,
      answer: opt,
      explanation: payload.explanation ?? null,
      grounded: payload.grounded,
    };
  }

  return {
    ok: true,
    back: payload.answer,
    answer: null,
    explanation: payload.explanation ?? null,
    grounded: payload.grounded,
  };
}

/**
 * 生成并写入一条答案（单卡路径）。
 * 返回 ok=false 时不写库，卡片保持「待补答案」，不会留下半成品。
 */
export async function fillCardAnswer(
  store: CardStore,
  card: Card,
  opts: { cache?: MaterialCache; timeoutMs?: number } = {}
): Promise<FillResult> {
  const draft = await draftCardAnswer(store, card, opts);
  if (!draft.ok || !draft.back) return { ok: false, reason: draft.reason };

  const updated = await store.updateCard(card.id, {
    // 表格 / 分点靠换行活着：落库前统一整理成逐行结构
    back: normalizeAnswerText(draft.back),
    answer: draft.answer ?? null,
    needs_answer: false,
    answer_origin: "ai",
    answer_grounded: draft.grounded ?? false,
    answer_generated_at: new Date().toISOString(),
    // 原文解析优先保留；没有时才用模型给的说明
    explanation: card.explanation ?? draft.explanation ?? null,
  });

  if (!updated) return { ok: false, reason: "write-failed" };
  return { ok: true, answer: draft.back, grounded: draft.grounded ?? false };
}

/** 这张卡是否还缺答案 */
export function missingAnswer(card: Card): boolean {
  if (card.needs_answer) return true;
  return !(card.back ?? "").trim();
}
