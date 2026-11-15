// 规则提炼知识点 —— 零 token，不依赖模型。
//
// 为什么需要它：知识点原来只有「AI 提炼」一条路。模型超时、网关抽风、或者用户
// 直接选了「只收录」模式，章节页就会出现「知识点（0 条）」，而旁边还摆着 8 张卡 ——
// 用户既看不懂为什么空，也没法用这些卡去补题（补题要挂知识点）。
//
// 材料本身是有结构的（`### 4.2 财政政策 vs 货币政策` 这种小节标题），
// 直接用结构提炼就够用，而且确定、可复现、不花钱。AI 的职责收窄为
// 「拿着这些知识点出题」，这才是它真正擅长且不可替代的部分。

import type { ParsedChapter } from "../import/markdown";
import { classifyText } from "../import/classify";

export interface RuleKnowledgePoint {
  /** 归属章在 chapters 数组里的下标 */
  chapterIndex: number;
  /** 用于算确定性 id 的层级路径 */
  chapter_path: string[];
  /** 知识点陈述（一句话） */
  statement: string;
  /** 原文证据：必须是材料里真实出现的一句话 */
  evidence: string;
  sort_order: number;
  /** 来自哪个小节标题；章级兜底时为空串 */
  section: string;
}

/** 去掉 markdown 标记，只留文字 */
function plain(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[>\s]+/, "")
    .replace(/^[-*+]\s+/, "")
    // 「原文：」「答：」这类标签不是知识点内容，留着会让每条证据都长得一样
    .replace(/^(原文|答案|解析|答|问)\s*[:：]\s*/, "")
    .trim();
}

/** 是不是「没有实质内容」的行 */
function isNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[-=*_]{3,}$/.test(t)) return true;
  if (/^<details>|^<\/details>|^<summary>|^<\/summary>/i.test(t)) return true;
  if (/^\[.*\]\(#.*\)$/.test(t)) return true; // 目录项
  return false;
}

/** 选项行：`A. xxx` / `B、xxx`。正文几乎不会这样开头，可以放心跳过。 */
function isOptionLine(line: string): boolean {
  return /^[A-DＡ-Ｄ]\s*[.、)）]\s*\S/.test(line.trim());
}

/** 答案 / 解析行：`答案：xxx` / `解析：xxx`。这些是判分依据，不是知识点正文。 */
function isAnswerLine(line: string): boolean {
  return /^(答案|参考答案|正确答案|解析|答)\s*[:：]/.test(plain(line));
}

/**
 * 题干行 —— 不能拿它当知识点的陈述或证据。
 *
 * 真实材料里「一、什么是机器学习？」这种小标题就是题干，后面紧跟答案正文。
 * 把题干当知识点，会让「知识点 → 出题」变成「拿题出题」：AI 出一堆和原题
 * 语义重复的卡，而且 statement 和 evidence 明显对不上。
 *
 * 判据两选一：句末问号；或「编号 + 疑问词」。
 */
function isQuestionLine(line: string): boolean {
  const t = plain(line);
  if (!t) return false;
  if (/[？?]\s*$/.test(t)) return true;
  if (
    /^(\d{1,3}|[一二三四五六七八九十]+)\s*[.、)）]\s*/.test(t) &&
    /哪|什么|如何|为什么|是否|哪些|简述|试述|论述|请说明|请解释/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * 小节标题行。两种写法都算边界：
 *   `### 4.1 总要求`（真标题）
 *   `**一、关于经济工作的新认识**`（整行加粗的中文序号小节）
 *
 * 第二种在「消化清单 / 自测」这类材料里很常见，不认它的话整章只能出 1 条
 * 知识点，13 张填空卡全挤在同一处。
 * 注意必须排除 `**1.** 题干` —— 数字序号是题目，中文序号才是小节。
 */
function sectionTitle(line: string): string | null {
  const t = line.trim();
  const m = t.match(/^#{2,6}\s+(.+)$/);
  if (m) return plain(m[1]);
  const b = t.match(/^\*\*\s*([一二三四五六七八九十]+)\s*[、.．]\s*([^*]{2,30}?)\s*\*\*$/);
  if (b) return `${b[1]}、${b[2]}`;
  return null;
}

/** 取一段文本的第一句（按中文句末标点），截断到 n 字 */
function firstSentence(text: string, n = 60): string {
  const t = plain(text).replace(/\s+/g, " ");
  const m = t.match(/^(.+?[。！？；!?;])/);
  const one = (m ? m[1] : t).trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * 从一节的正文里挑「最像结论」的一句当陈述。
 *
 * 不能直接用组内第一句：很多材料的行是混排的，
 *   `a) 先看不同公司的题目 1. 日常有没有高频使用的 AI 产品？`
 * 第一句就是一道题。拿它当知识点，等于把题目抄成「要记住的内容」。
 *
 * 所以逐行往下找，跳过三类：编号行（多为题号）、带问号的行（题干）、
 * 过短的行（小标题碎片）。
 */
function pickLeadStatement(paras: string[], n = 42): string {
  for (const p of paras) {
    const raw = p.trim();
    if (!raw) continue;
    // 行内混着编号 + 问号 → 这是题目，哪怕开头不是数字
    if (/[？?]/.test(raw) && /(\d{1,3}|[a-z]|[一二三四五六七八九十]+)\s*[.、)）]/.test(raw)) continue;
    if (/^\d{1,3}\s*[.、)）]/.test(raw)) continue;
    if (/^[a-z]\s*[)）]/.test(raw)) continue;
    const s = firstSentence(raw, n);
    if (!s) continue;
    if (/[？?]\s*$/.test(s)) continue;
    if (s.length < 8) continue;
    return s;
  }
  return "";
}

/**
 * 表格片段 → 一句可读的陈述。
 * 表头 + 首行数据已经概括了这张表在比什么，比丢一句「见下表」有用得多。
 */
function tableSummary(content: string): string {
  const rows = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\|.*\|$/.test(l) && !/^\|[\s:|-]+\|$/.test(l))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => plain(c))
        .filter(Boolean)
    )
    .filter((r) => r.length > 0);
  if (rows.length === 0) return "";
  const head = rows[0];
  const first = rows[1];
  if (!first) return head.join(" / ");
  return `${head.join(" / ")}：${first.join(" / ")}`;
}

/** 一节正文里挑一句最像「要点」的原文做证据：优先带加粗术语的句子 */
function pickEvidence(paragraphs: string[]): string {
  const candidates = paragraphs
    .map((p) => plain(p))
    .filter((p) => p.length >= 8)
    // 行内混着题号的段落整段不要：证据一旦是题目，知识点就变成「拿题证题」
    .filter((p) => !(/[？?]/.test(p) && /(\d{1,3}|[a-z]|[一二三四五六七八九十]+)\s*[.、)）]/.test(p)))
    .flatMap((p) => p.split(/(?<=[。！？!?])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    // 疑问句不是结论，不能当依据
    .filter((s) => !/[？?]\s*$/.test(s));

  if (candidates.length === 0) return "";
  // 带书名号 / 顿号 / 数字的句子更像知识点，而不是过渡句
  const scored = candidates.map((s, i) => {
    let score = 0;
    if (/[「」“”《》]/.test(s)) score += 2;
    if (/[、；]/.test(s)) score += 1;
    if (/\d/.test(s)) score += 1;
    if (s.length >= 18 && s.length <= 80) score += 2;
    return { s, score: score - i * 0.01 };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].s;
  return best.length > 90 ? `${best.slice(0, 90)}…` : best;
}

/**
 * 一章 → 若干知识点。
 *
 * 切分粒度取「小节标题」：`### 4.2 财政政策 vs 货币政策` 就是一条知识点的边界。
 * 没有小节的章退化成整章一个知识点（这也是用户说的「分段识别到大类」）——
 * 宁可粗一点，也不要让知识点区空着。
 */
function kpsOfChapter(ch: ParsedChapter, chapterIndex: number): RuleKnowledgePoint[] {
  const out: RuleKnowledgePoint[] = [];
  const path = [ch.title];

  /*
   * 只拿「正文片段」提炼知识点，跳过题组与答案区。
   *
   * 不跳的话，一个以题目为主体的小节会提炼出这样的知识点：
   *   statement = 「1.1 政策工具：1. 下列哪项属于财政政策的工具？」
   *   evidence  = 「3. 财政政策由中央银行制定并执行。」
   * 于是「知识点 → 出题」就变成「拿题出题」，而且 evidence 和 statement
   * 对不上号 —— 用户核对时第一眼就会觉得系统在瞎编。
   *
   * 判定口径与 import 落库时的 fragment_type 完全一致（同一个 classifyText），
   * 所以不会出现「页面标成题目、提炼却当正文」的分裂。
   */
  const bodyFragments = ch.fragments.filter((f) => {
    const t = classifyText(f.content);
    return !t.startsWith("question_") && !t.startsWith("answer_");
  });
  // 整章都是题目时退回原片段：知识点宁可粗糙，也不能一条都没有（卡片无处可挂）
  const source = bodyFragments.length > 0 ? bodyFragments : ch.fragments;

  // 按小节标题把片段分组
  type Group = { title: string; paras: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const frag of source) {
    const lines = frag.content.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (isNoise(line)) continue;
      const st = sectionTitle(line);
      if (st) {
        current = { title: st, paras: [] };
        groups.push(current);
        continue;
      }
      /*
       * 题组三件套（题干 / 选项 / 答案）不进 paras。
       *
       * 依据只该来自「教材正文」，不能来自「考你的那道题」——否则知识点和题目
       * 互为证据，出题时会自我循环，核对时也看不出这条知识点的真正出处。
       * 题干跳过不影响答案：答案行的下一行往往就是解释正文，照收。
       */
      if (isOptionLine(line) || isAnswerLine(line) || isQuestionLine(line)) continue;
      if (!current) {
        current = { title: "", paras: [] };
        groups.push(current);
      }
      current.paras.push(line);
    }
  }

  for (const g of groups) {
    const text = g.paras.join("\n").trim();
    if (!text) continue;

    const isTable = /^\|/m.test(text);
    const evidence = isTable ? tableSummary(text) : pickEvidence(g.paras);
    if (!evidence) continue;

    // statement：有小节标题就用标题 + 首句要点；否则纯首句
    let statement = "";
    if (g.title) {
      const lead = isTable ? "" : pickLeadStatement(g.paras, 42);
      // 小节标题本身是问句（`### 什么是 RAG？`）时，不要拿它当陈述 ——
      // 那是题目口吻，不是「要记住的结论」。改用组内正文首句。
      const titleIsQuestion = isQuestionLine(g.title);
      if (titleIsQuestion) {
        statement = lead || "";
      } else {
        statement = lead && lead !== g.title ? `${g.title}：${lead}` : g.title;
      }
    } else if (isTable) {
      // 无小节的裸表格：拿表格摘要当陈述，别把 `| 项目 | 内容 |` 原样当知识点
      statement = evidence;
    } else {
      statement = pickLeadStatement(g.paras, 48) || firstSentence(text, 48);
    }
    statement = statement.trim();
    if (statement.length < 6) continue;

    out.push({
      chapterIndex,
      chapter_path: path,
      statement,
      evidence,
      sort_order: out.length,
      section: g.title,
    });
  }

  // 章级兜底：整章都没提炼出东西（比如全是题组），用章名建一条，
  // 保证这一章至少有地方挂卡片，页面不会出现「知识点 0 条 + 8 张卡」。
  if (out.length === 0) {
    // 用 source 而不是 bodyFragments：整章都是题时 source 已退回原片段，
    // 否则这里会一条也建不出来，卡片就真的无处可挂了。
    const firstText = source.map((f) => plain(f.content)).find((t) => t.length >= 6);
    if (firstText) {
      out.push({
        chapterIndex,
        chapter_path: path,
        statement: ch.title,
        evidence: firstSentence(firstText, 80),
        sort_order: 0,
        section: "",
      });
    }
  }

  // 一节拆得太碎会让知识点泛滥，保留前 12 条（已经覆盖主干）
  return out.slice(0, 12);
}

/** 全篇 → 规则知识点 */
export function extractRuleKnowledgePoints(chapters: ParsedChapter[]): RuleKnowledgePoint[] {
  const out: RuleKnowledgePoint[] = [];
  chapters.forEach((ch, i) => {
    // 目录章没有知识价值
    if (/^目录$/.test(ch.title.trim())) return;
    out.push(...kpsOfChapter(ch, i));
  });
  return out;
}

// ---------------------------------------------------------------------------
// 原题 → 知识点 的自动挂靠
// ---------------------------------------------------------------------------

function bigrams(s: string): Set<string> {
  const t = plain(s).replace(/[\s，。、；：""''（）()《》【】「」\-—…·,.:;!?]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 两个集合的重叠比例（相对较小的一方），0~1 */
function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / Math.min(a.size, b.size);
}

/**
 * 给每道原题挑一个知识点。
 *
 * 不匹配就挂该章第一条 —— 允许粗，但不允许「未关联」堆成一片。
 * 用户真正不想看到的是 41 道题挂在那里等他一条条手动选。
 */
export function bindQuestionsToKps(
  questions: Array<{ front: string; chapterIndex: number }>,
  kps: RuleKnowledgePoint[]
): number[] {
  const byChapter = new Map<number, number[]>();
  kps.forEach((k, i) => {
    const list = byChapter.get(k.chapterIndex) ?? [];
    list.push(i);
    byChapter.set(k.chapterIndex, list);
  });

  const kpGrams = kps.map((k) => bigrams(`${k.statement} ${k.evidence}`));

  return questions.map((q) => {
    const candidates = byChapter.get(q.chapterIndex);
    if (!candidates || candidates.length === 0) return -1;
    if (candidates.length === 1) return candidates[0];

    const qGrams = bigrams(q.front);
    let best = candidates[0];
    let bestScore = 0;
    for (const idx of candidates) {
      const score = overlapRatio(qGrams, kpGrams[idx]);
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    // 没有任何共享词汇时，挂该章第一条（粗归类好过不归类）
    return best;
  });
}
