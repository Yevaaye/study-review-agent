/**
 * 卡片 → 原文定位。
 *
 * 复习时用户答错常想「回原文看一眼这个知识点到底怎么说的」。
 * 卡片和原文不是直接连起来的，中间有三条可能的线索，按可信度依次尝试：
 *
 *   1. card_sources    导入/补题时写下的「卡 ↔ 片段」关联（最准）
 *   2. kp_id           卡绑定的知识点，知识点上有 source_fragment_id
 *   3. evidence        AI 卡从原文摘的支撑短语，拿它在同书片段里做包含匹配
 *   4. 会话的书籍       按书复习时至少能定位到这本书（旧数据/未关联卡）
 *
 * 之所以还要第 3 步：早期版本的 AI 生成卡把整批卡都挂到章节的第一个片段
 * （usable[0]），`card_sources` 有值但并不精确。evidence 通常能命中真正那一段。
 *
 * 本文件只依赖 CardStore 的只读方法，纯函数式解析，不写库。
 */

import type { CardStore } from "@/lib/db/store";
import type { ID, SourceFragment } from "@/lib/db/types";

/** 一张卡在原文里的落点。fragment_id 为空表示只能定位到书/章。 */
export type CardOrigin = {
  textbook_id: ID;
  textbook_title: string;
  fragment_id?: ID | null;
  chapter_id?: ID | null;
  /** 定位依据，用于按钮上说明「凭什么说这段是出处」 */
  via: "source" | "kp" | "evidence" | "book";
};

/** 比对时抹掉空白与常见标点：原文和 evidence 常差一个破折号或引号。 */
function normalize(s: string): string {
  return s.replace(/[\s，。、；：""''（）()【】\[\]{}.,;:!?？！—\-_/\\]/g, "").toLowerCase();
}

/** evidence 取前 14 个字做包含匹配：整句往往被模型改写过，前半截最稳。 */
const NEEDLE_LEN = 14;
const MIN_NEEDLE = 6;

/**
 * 批量解析：一次把关联、片段、书、卡、知识点全取回来，避免在 200 张卡的
 * 会话里逐卡查库（localStore 是内存对象，但每个方法都会同步一次磁盘）。
 */
export async function resolveCardOrigins(
  store: CardStore,
  cardIds: ID[],
  fallbackTextbookId?: ID | null
): Promise<Record<ID, CardOrigin>> {
  if (cardIds.length === 0) return {};
  const wanted = new Set(cardIds);

  const [links, frags, books, cards, kps] = await Promise.all([
    store.listAllCardSources(),
    store.listFragments(),
    store.listTextbooks(),
    store.listCards(),
    store.listKnowledgePoints(),
  ]);

  const fragById = new Map(frags.map((f) => [f.id, f]));
  const bookById = new Map(books.map((b) => [b.id, b]));
  const cardById = new Map(cards.filter((c) => wanted.has(c.id)).map((c) => [c.id, c]));
  const kpById = new Map(kps.map((k) => [k.id, k]));

  /** 卡 → 第一个有效来源片段 */
  const firstFragByCard = new Map<ID, SourceFragment>();
  for (const l of links) {
    if (!wanted.has(l.card_id) || firstFragByCard.has(l.card_id)) continue;
    const f = fragById.get(l.source_fragment_id);
    if (f) firstFragByCard.set(l.card_id, f);
  }

  const fragsByBook = new Map<ID, SourceFragment[]>();
  const normFrag = new Map<ID, string>();
  for (const f of frags) {
    const arr = fragsByBook.get(f.textbook_id) ?? [];
    arr.push(f);
    fragsByBook.set(f.textbook_id, arr);
    normFrag.set(f.id, normalize(f.content ?? ""));
  }

  const findByEvidence = (evidence: string | null | undefined, bookId: ID | null) => {
    const needle = normalize(evidence ?? "").slice(0, NEEDLE_LEN);
    if (needle.length < MIN_NEEDLE) return null;
    const pool = bookId ? (fragsByBook.get(bookId) ?? []) : frags;
    return pool.find((f) => (normFrag.get(f.id) ?? "").includes(needle)) ?? null;
  };

  const result: Record<ID, CardOrigin> = {};
  for (const id of cardIds) {
    const card = cardById.get(id);
    let frag: SourceFragment | null = firstFragByCard.get(id) ?? null;
    let via: CardOrigin["via"] = "source";

    // 2) 没有直接关联时，试知识点自带的片段
    if (!frag && card?.kp_id) {
      const f = kpById.get(card.kp_id)?.source_fragment_id;
      if (f) {
        frag = fragById.get(f) ?? null;
        if (frag) via = "kp";
      }
    }

    let bookId = frag?.textbook_id ?? fallbackTextbookId ?? null;

    // 3) evidence 优先纠正「挂错片段」的关联，也负责给完全没关联的卡找落点
    if (card?.evidence) {
      const needle = normalize(card.evidence).slice(0, NEEDLE_LEN);
      const alreadyHit = frag ? (normFrag.get(frag.id) ?? "").includes(needle) : false;
      if (needle.length >= MIN_NEEDLE && !alreadyHit) {
        const hit = findByEvidence(card.evidence, bookId);
        if (hit) {
          frag = hit;
          via = "evidence";
        }
      }
    }

    bookId = frag?.textbook_id ?? bookId;
    const book = bookId ? bookById.get(bookId) : null;
    if (!book) continue; // 连书都找不到，就不给「去原文」按钮（不跳一个 404）

    const sameBook = frag?.textbook_id === book.id;
    result[id] = {
      textbook_id: book.id,
      textbook_title: book.title,
      fragment_id: sameBook ? frag!.id : null,
      chapter_id: sameBook ? (frag!.chapter_id ?? null) : null,
      via: frag ? via : "book",
    };
  }
  return result;
}

/**
 * 构造「去原文」深链。
 *
 * 同时带 fragment 与 chapter：全文页的 HighlightTarget 优先滚到 #frag-xxx，
 * 但空片段会被渲染阶段剔掉、锚点不存在；这时它会退到 chapterFallback
 * （该章第一个片段），所以 chapter 参数要一起传，不能只给 fragment。
 * card 参数给全文页用来显示「刚才那道题」的题干，方便对照原文找依据。
 */
export function originReadHref(origin: CardOrigin, cardId: ID): string {
  const q = new URLSearchParams();
  if (origin.fragment_id) q.set("fragment", origin.fragment_id);
  if (origin.chapter_id) q.set("chapter", origin.chapter_id);
  q.set("from", "review");
  q.set("card", cardId);
  return `/read/${encodeURIComponent(origin.textbook_id)}?${q.toString()}`;
}
