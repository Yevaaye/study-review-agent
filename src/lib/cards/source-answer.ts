import type { CardStore } from "../db/store";
import type { Card, SourceFragment } from "../db/types";

/**
 * 「原文标准答案」定位器。
 *
 * 为什么需要它：AI 补答案给出的是**转述**，转述必然丢要点（实测把 7 条要点的
 * 答案压成 1 句）。而这段原文里本来就有一段完整的标准答案 —— 用户要的是那段
 * 原文，不是 AI 的改写。所以链路改成：先在原文里找答案，找到就直接用；
 * 找不到才让 AI 写，并打上「AI 整理」的标。
 *
 * 原文形态很杂，这里要能处理两大类写法：
 *
 * A. 有标签的（`extractAnswerFromText`）
 *   1. `**参考答案：**` 独占一行，答案在下一段（本库最常见）
 *   2. `答案：xxx` 同行给出，后面还跟着续写的段落（旧实现只抄了同行这一句，
 *      这是「答案只截第一句」的典型来源）
 *   3. `Q: xxx` / `### Q: xxx` / `1. xxx？` 之后跟 `答：xxx`
 *   4. 答案跨多段，中间夹着「解析」「思考逻辑」这类小标题
 *
 * B. 无标签、靠排版表达的（`findAdjacentAnswer`）
 *   5. 题干独占一段，答案就是紧跟着的下一段 —— 没有「答案：」两个字，
 *      但排版本身已经说明「下面是答案」。这类书（《Agent Harness 与编码代理
 *      测评》）的原文就是 `**8. 题干？**` 一段 + `> 答案正文` 一段，分片又恰
 *      好按题目切开，所以答案落在**下一个片段**里。以前只认标签，必然落空，
 *      于是一整本书的答案全被误判成「原文未给出」、交给 AI 重写。
 *
 * 判据宁可保守：宁可不命中（退回 AI），也不要把「解析」「下一题」粘进答案。
 */

/** 答案解析结果 */
export interface SourceAnswer {
  /** 原文答案正文（保留换行，去掉 markdown 强调符） */
  text: string;
  /** 命中的片段 id（便于「去原文查依据」定位） */
  fragment_id: string;
  chapter_id: string | null;
  /** 题干与片段的匹配分（越大越可信） */
  score: number;
}

/** 答案标签：允许加粗、允许「参考答案/正确答案/答」等写法 */
const ANSWER_LABEL = /^\s*\*{0,2}\s*(?:参考答案|标准答案|正确答案|答案|答|Answer)\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$/i;

/** 「下一题」的各种开头 —— 撞上就停止收集答案 */
const NEXT_QUESTION: RegExp[] = [
  /^\s*#{1,6}\s*.*\bQ\s*[:：]/i, // ### Q:
  /^\s*\*{0,2}\s*Q\s*[:：]/i, // **Q:**
  /^\s*\*{0,2}\s*(?:问|问题|题目|Question)\s*[:：]/i, // 问：
  /^\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[.、．)）]\s*\S/, // 12. xxx / 三、xxx
  /^\s*[-=]{3,}\s*$/, // 分隔线
];

/** 答案块内的子标题：出现即说明「答案正文结束、进入解析」 */
const ANSWER_TAIL: RegExp[] = [
  /^\s*\*{0,2}\s*(?:解析|分析|说明|点评|延伸|追问|思路)\s*\*{0,2}\s*[:：]/,
  /^\s*💡/,
  /^\s*\*{0,2}思考逻辑\*{0,2}/,
];

function tidy(s: string): string {
  return s
    .replace(/\*{1,3}/g, "") // markdown 加粗
    .replace(/^#{1,6}\s*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 逐行的「光文本」：剥掉引用符、标题井号、行首行尾加粗、列表符。
 *
 * 为什么非要这一步：这本书的题干写成 `**8. AutoGen 的代码执行器……？**`，
 * 行首是 `**` 而不是数字，`^\d{1,3}\.` 这类正则一个都匹配不上 —— 「下一题」
 * 因此永远识别不到，答案收集会一路越过后面所有题目。剥一层壳之后
 * `8. AutoGen……？` 才和普通编号题长得一样。
 *
 * 只剥行首行尾的强调符，不碰行内（`**要点**` 留在 tidy 里统一处理）。
 */
function bare(line: string): string {
  let s = String(line ?? "").trim();
  s = s.replace(/^>+\s?/, ""); // 引用
  s = s.replace(/^#{1,6}\s*/, ""); // 标题
  s = s.replace(/^\*{1,3}\s*/, ""); // 行首加粗：**8. → 8.
  s = s.replace(/\s*\*{1,3}$/, ""); // 行尾加粗闭合
  s = s.replace(/^[-+•]\s+/, ""); // 列表符（不含 *，免得和加粗打架）
  return s.trim();
}

/**
 * 这一行是不是「另一道题」的开头。
 *
 * 编号规则要再紧一层：答案里本身就常有「1. 沙箱隔离 2. 网络限制」这样的分点，
 * 一律当下一题会把答案截断在第一个分点上。所以编号行还要求「问句结尾」或
 * 「整行原本加粗」（书名/题库里题干的典型排版）。
 */
function isQuestionStart(raw: string): boolean {
  const s = bare(raw);
  if (!s) return false;
  const numbered = /^(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[.、．)）]\s*\S/.test(s);
  if (numbered) {
    return /[？?]\s*$/.test(s) || /^\s*\*{1,3}.+\*{1,3}\s*$/.test(String(raw ?? "").trim());
  }
  return /^(?:Q|问|问题|题目|Question)\s*[:：]/i.test(s);
}

/**
 * 在若干行里定位题干所在行；找不到返回 -1。
 *
 * 按「与该行字符的重合度」挑最像的一行 —— 题干行通常还带 `Q:`、`### `、
 * `**8. ` 这类前缀，所以按包含率判断而不是相等。
 */
function locateQuestionLine(lines: string[], key: string): { index: number; score: number } {
  const head = key.slice(0, 24);
  let index = -1;
  let best = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = norm(lines[i]);
    if (!l) continue;
    let overlap = 0;
    for (const ch of new Set(key)) if (l.includes(ch)) overlap++;
    const ratio = overlap / new Set(key).size;
    if (ratio > best && (head.length <= 4 || l.includes(key.slice(0, 8)))) {
      best = ratio;
      index = i;
    }
  }
  return { index, score: Math.round(best * 100) / 100 };
}

/** 题干是否真的出现在这段正文里（前 24 字 + 后 24 字双段命中） */
function textHasQuestion(lines: string[], key: string): boolean {
  const flat = norm(lines.join(""));
  const head = key.slice(0, 24);
  const tail = key.slice(-24);
  return flat.includes(head) && (key.length <= 24 || flat.includes(tail));
}


/** 去掉空白与标点，用于题干匹配 */
function norm(s: string): string {
  return String(s ?? "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

/** 题干的核心：去掉尾部问号等之后的可比对串 */
function questionKey(front: string): string {
  const n = norm(front);
  // 太短的题干（「什么是 RAG」）容易误命中别的题，要求至少 6 个字
  return n.length >= 6 ? n : "";
}

/**
 * 从一段原文里，抽出「这道题的答案」。
 *
 * 只在题干确实出现在这段文字里时才动手 —— 宁可返回 null，也不猜。
 */
export function extractAnswerFromText(
  front: string,
  content: string
): { text: string; score: number } | null {
  const key = questionKey(front);
  if (!key) return null;

  const lines = String(content ?? "").split(/\r?\n/);

  // 题干必须真的出现在这段里（前 24 字 + 后 24 字双段命中，避免只命中半个短语）
  if (!textHasQuestion(lines, key)) return null;

  const found = locateQuestionLine(lines, key);
  const qLine = found.index;
  const best = found.score;
  if (qLine < 0) return null;

  // 从题干行往下找答案标签；中途撞到下一题就说明这题没给答案。
  // 一律拿 bare 后的「光文本」做判断 —— `**9. xxx**` 这种加粗编号题
  // 否则会从「下一题」判定里漏掉，答案收集会一路越界。
  let labelLine = -1;
  let inline = "";
  for (let i = qLine + 1; i < lines.length; i++) {
    const m = bare(lines[i]).match(ANSWER_LABEL);
    if (m) {
      labelLine = i;
      inline = tidy(m[1] ?? "");
      break;
    }
    if (NEXT_QUESTION.some((re) => re.test(bare(lines[i])))) return null;
  }
  if (labelLine < 0) return null;

  // 收集答案正文：同行内容 + 紧随其后的续写段落，直到下一题 / 解析小标题
  const parts: string[] = [];
  if (inline) parts.push(inline);
  for (let i = labelLine + 1; i < lines.length; i++) {
    const raw = bare(lines[i]);
    const line = raw.trim();
    if (NEXT_QUESTION.some((re) => re.test(raw))) break;
    if (ANSWER_TAIL.some((re) => re.test(raw))) break;
    if (!line) {
      // 空行只在不影响连续性时保留（段落分隔）
      if (parts.length > 0 && parts[parts.length - 1] !== "") parts.push("");
      continue;
    }
    parts.push(line);
    // 已经收够一段长文，不必把整段碎片全吃掉
    if (parts.join("\n").length > 1200) break;
  }

  const text = tidy(parts.join("\n"));
  if (!text) return null;
  return { text, score: Math.round(best * 100) / 100 };
}

/**
 * 「问答对排版」的答案：题干独占一段，紧跟着的下一段就是答案。
 *
 * 为什么单开一路：这本书（《Agent Harness 与编码代理测评》）原文是
 *   `**8. AutoGen 的代码执行器为什么默认本地有风险？生产如何隔离？**`
 *   `> 本地执行器直接以进程身份运行任意代码……`
 * 两段之间**没有任何「答案：」字样** —— 「下面是答案」是由排版本身表达的，
 * 分片又恰好按题目切开，答案就落在下一个片段里。只认标签的路径必然落空，
 * 于是整本书的答案都被判成「原文未给出」，白白交给 AI 重写一遍。
 *
 * 只在**片段边界**上启用，不动片段内部的逻辑：
 *   - 题干所在片段里，题干之后必须没剩多少内容（> 40 字说明答案本来就在
 *     同一片里，那是标签路径的活儿，也免得把正文当答案）；
 *   - 往后最多收 3 片，撞到下一题的题干就停。
 *
 * 反过来说，「题干 + 一句『只有题干没有答案。』」在同片段内的情形不会被这里
 * 当成答案 —— 那正是要躲开的瞎猜。
 */
export function findAdjacentAnswer(
  front: string,
  fragments: Pick<SourceFragment, "id" | "content" | "chapter_id">[]
): SourceAnswer | null {
  const key = questionKey(front);
  if (!key) return null;
  const frontNorm = norm(front);

  for (let i = 0; i < fragments.length; i++) {
    const lines = String(fragments[i].content ?? "").split(/\r?\n/);
    if (!textHasQuestion(lines, key)) continue;
    const found = locateQuestionLine(lines, key);
    if (found.index < 0) continue;

    // 题干之后在这片里还剩多少实质内容？剩得多就说明答案同片，交给标签路径
    const rest = lines.slice(found.index + 1).map(bare).filter(Boolean);
    if (rest.join("").length > 40) continue;

    // 往后收集答案：最多 3 片，空行保留成段落分隔
    const parts: string[] = [];
    let answerFragmentId = fragments[i].id;
    for (let j = i + 1; j < fragments.length && j <= i + 3; j++) {
      const sub = String(fragments[j].content ?? "").split(/\r?\n/);
      let stop = false;
      let tookAny = false;
      for (const rawLine of sub) {
        const s = bare(rawLine);
        if (!s) {
          if (parts.length > 0 && parts[parts.length - 1] !== "") parts.push("");
          continue;
        }
        if (isQuestionStart(rawLine)) {
          stop = true;
          break;
        }
        if (ANSWER_TAIL.some((re) => re.test(s))) {
          stop = true;
          break;
        }
        if (!tookAny) {
          tookAny = true;
          answerFragmentId = fragments[j].id;
        }
        parts.push(s);
        if (parts.join("\n").length > 1500) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }

    const text = tidy(parts.join("\n"));
    const textNorm = norm(text);
    if (textNorm.length < 6) continue;
    // 把题干又抄一遍，不算答案
    if (frontNorm && frontNorm.includes(textNorm)) continue;

    return {
      text,
      fragment_id: answerFragmentId,
      chapter_id: fragments[i].chapter_id ?? null,
      score: found.score,
    };
  }
  return null;
}

/**
 * 在一组片段里找这道题的原文答案。
 *
 * 按题干匹配分从高到低试；返回第一个「可用」的答案。
 * `minChars` 是完整度门槛：太短的命中多半只是把题干抄了一遍。
 */
export function findSourceAnswer(
  front: string,
  fragments: Pick<SourceFragment, "id" | "content" | "chapter_id">[],
  opts: { minChars?: number } = {}
): SourceAnswer | null {
  // 门槛压得很低（6 字）：短答案也是答案（「检索增强生成」就是完整答案）。
  // 真正要挡住的是「把题干抄一遍」——那个用下面的包含判定处理。
  const minChars = opts.minChars ?? 6;
  const frontNorm = norm(front);
  const hits: SourceAnswer[] = [];

  for (const f of fragments) {
    const got = extractAnswerFromText(front, f.content ?? "");
    if (!got) continue;
    const textNorm = norm(got.text);
    if (textNorm.length < minChars) continue;
    // 答案完全包含在题干里 = 只是把题目重抄了一遍，不算答案
    if (frontNorm && frontNorm.includes(textNorm)) continue;
    hits.push({
      text: got.text,
      fragment_id: f.id,
      chapter_id: f.chapter_id ?? null,
      score: got.score,
    });
  }

  if (hits.length === 0) {
    // 兜底：分片会把「答案标签」和「答案正文」切到两片里，逐片匹配会两片都落空。
    // 按给定顺序拼成一篇再找一次 —— 调用方按 fragment_index 排好序传进来即可。
    if (fragments.length > 1) {
      const doc = fragments.map((f) => f.content ?? "").join("\n\n");
      const got = extractAnswerFromText(front, doc);
      if (got && norm(got.text).length >= minChars && !(frontNorm && frontNorm.includes(norm(got.text)))) {
        const probe = got.text.slice(0, 24);
        const owner = fragments.find((f) => (f.content ?? "").includes(probe)) ?? fragments[0];
        return {
          text: got.text,
          fragment_id: owner.id,
          chapter_id: owner.chapter_id ?? null,
          score: got.score,
        };
      }
    }
    return null;
  }
  // 分数高者优先；同分取更长的（更完整）
  hits.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  return hits[0];
}

/**
 * 从库里取「这道题能用的原文片段」，再找答案。
 *
 * `fullText` = 用户显式要求「在全书正文里找」：把整本书的片段都拿来匹配。
 * 不开时只看这张卡绑定的片段（+ 紧邻后继片段）和它所在章节 —— 范围小、
 * 命中更准，也更快。
 *
 * 为什么要带上「后继片段」：分片是按长度切的，答案和题干经常被切到两片里。
 * 一种是标签与正文被切开（`**参考答案：**` 在 A 片、内容在 B 片），由
 * findSourceAnswer 内部拼成一篇文章兜住；另一种是整道题被切成「题干一片、
 * 答案一片」（问答对排版），由 findAdjacentAnswer 沿片段边界接住。
 */
export async function findCardSourceAnswer(
  store: CardStore,
  card: Card,
  opts: { fullText?: boolean; minChars?: number } = {}
): Promise<{ hit: SourceAnswer | null; scope: "card" | "chapter" | "book"; scanned: number }> {
  const sources = await store.listCardSources(card.id);
  const textbookId = sources.find((s) => s.textbook_id)?.textbook_id ?? null;
  const chapterId = sources.find((s) => s.chapter_id)?.chapter_id ?? null;

  const sortByIndex = (list: SourceFragment[]) =>
    [...list].sort((a, b) => (a.fragment_index ?? 0) - (b.fragment_index ?? 0));

  /**
   * 扫一批片段：先按标签找（最可信），标签落空再按「问答对排版」找。
   *
   * 两条路都在**有序片段数组**上跑 —— 标签路径自己在内部做跨片段拼接
   * （见 findSourceAnswer 的兜底），排版路径需要看得见片段边界，
   * 所以这里不能提前拼成一篇文章。
   */
  const scan = (list: SourceFragment[], scope: "card" | "chapter" | "book") => {
    if (list.length === 0) return null;
    const ordered = sortByIndex(list);
    const hit =
      findSourceAnswer(card.front ?? "", ordered, { minChars: opts.minChars }) ??
      findAdjacentAnswer(card.front ?? "", ordered);
    if (!hit) return { hit: null as SourceAnswer | null, scope, scanned: ordered.length };
    // 命中片段 = 包含答案开头的那一片，方便前端「去原文看依据」
    const probe = hit.text.slice(0, 24);
    const owner = ordered.find((f) => (f.content ?? "").includes(probe)) ?? ordered[0];
    return {
      hit: {
        ...hit,
        fragment_id: owner.id,
        chapter_id: owner.chapter_id ?? chapterId,
      },
      scope,
      scanned: ordered.length,
    };
  };

  // 章节片段先取一次：卡片片段的「后继片段」要靠它才知道是哪些
  const chapter = textbookId && chapterId ? sortByIndex(await store.listFragments(textbookId, chapterId)) : [];

  /**
   * 卡片片段 + 它在章节里的后继片段。
   *
   * 问答对排版里答案就在紧邻的下一片 —— 只看卡片自己那一片永远找不到。
   * 把后继几片带上，scope 仍算「card」（答案确实出自这张卡的出处段落），
   * 界面上说「来自本题绑定片段」才是老实话。
   */
  const own = sources.filter((s) => (s.content ?? "").trim().length > 0);
  const ownExpand: SourceFragment[] = [...own];
  if (chapter.length > 0) {
    for (const s of own) {
      const at = chapter.findIndex((f) => f.id === s.id);
      if (at < 0) continue;
      for (let k = 1; k <= 3 && at + k < chapter.length; k++) {
        const next = chapter[at + k];
        if (!ownExpand.some((f) => f.id === next.id)) ownExpand.push(next);
      }
    }
  }

  // 1) 卡片自己绑定的片段（+ 紧邻的后继片段）
  const ownHit = scan(ownExpand, "card");
  if (ownHit?.hit) return ownHit;

  if (!textbookId) return { hit: null, scope: "card", scanned: ownExpand.length };

  // 2) 同章节的全部片段（答案常被切到相邻片段里）
  if (chapter.length > 0) {
    const chapterHit = scan(chapter, "chapter");
    if (chapterHit?.hit) return chapterHit;
  }

  // 3) 全书（仅在用户显式要求时）
  if (opts.fullText) {
    const all = await store.listFragments(textbookId);
    const bookHit = scan(all, "book");
    if (bookHit) return bookHit;
  }

  // 没命中也要把「扫了多少」带回去，台账里要能看出这次检索的规模
  const scannedFallback = opts.fullText
    ? (await store.listFragments(textbookId)).length
    : chapter.length > 0
      ? chapter.length
      : ownExpand.length;
  return { hit: null, scope: opts.fullText ? "book" : "chapter", scanned: scannedFallback };
}
