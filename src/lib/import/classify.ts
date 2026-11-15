// 块分类与原题抽取 —— 纯规则，零 token。
//
// 定位：接在 parseMarkdown 之后。**不改动切章逻辑**，只对「已经切好的章与片段」
// 再做一次内容分类，并把原文里本来就有的题目抽成结构化对象。
//
// 两条独立能力：
//   A. classifyText(text)      单个片段 → fragment_type（打标签用）
//   B. extractQuestions(md, ch) 全文扫描 → 原题数组（题号全局连续、答案跨章 join）
//
// 为什么题目不能交给模型：材料里已有的题，模型重写会丢措辞、改答案、甚至编造选项。
// 这类内容必须逐字保留，且判分依据（答案/解析）要能按题号精确对上。模型只负责
// 「按知识点补新题」，不负责复述已有题。

import type { FragmentType } from "../db/types";
import type { ParsedChapter } from "./markdown";

export interface ExtractedQuestion {
  /** 题号（原文里的数字）；没有编号的问答对为 null */
  no: number | null;
  type: "choice" | "qa" | "cloze" | "judge";
  /** 题干 / 问句 / 含空的句子 / 陈述句（逐字保留原文措辞） */
  front: string;
  /** 答案：选择题为正确选项文本；判断题为「对/错」；问答为答句；填空为填入内容 */
  back: string;
  options?: string[];
  answer?: string;
  explanation?: string;
  /** 有题无答案：卡照建，不阻塞流程 */
  needs_answer: boolean;
  /** 归属章索引（chapters 数组下标） */
  chapterIndex: number;
  /** 原文行号区间，用于定位片段 */
  startLine: number;
  endLine: number;
  /**
   * 保真核对结果：题干 / 选项 / 答案能否在原文里逐字找到。
   * 只有新管线抽出的题会带；旧规则基线的题没有（undefined = 未校验，不误标）。
   */
  fidelity?: import("./fidelity").FidelityReport;
}

export interface ClassifyResult {
  questions: ExtractedQuestion[];
  /** 行号 → 片段类型（只记录非 normal 的块） */
  blockTypes: Array<{ startLine: number; endLine: number; type: FragmentType }>;
}

// ---------------------------------------------------------------------------
// 基础正则
// ---------------------------------------------------------------------------

/** 「1. 」「**1.**」「1、」「1)」开头的题号行 */
const Q_START = /^\s*\*{0,2}(\d{1,3})\s*[.、．)）]\*{0,2}\s*(.*)$/;
/** 选项行：「A. xxx」「A、xxx」「**A.** xxx」 */
const OPTION = /^\s*\*{0,2}([A-DＡ-Ｄa-d])\s*[.、．)）]\*{0,2}\s*(.+)$/;
/** 答案行：「答案：xxx」「答：xxx」（A：这种大写字母+冒号也算答句） */
const ANSWER_LINE = /^\s*\*{0,2}(?:答案|答|Answer|参考答案|正确答案|A)\s*[:：]\s*(.+)$/i;
/** 解析行 */
const EXPLAIN_LINE = /^\s*\*{0,2}(?:解析|分析|说明|Explanation)\s*[:：]\s*(.+)$/i;
/** 问句行 */
const ASK_LINE = /^\s*\*{0,2}(?:问|Q|问题|Question)\s*[:：]\s*(.+)$/i;
/** 填空：3 个及以上下划线 */
const CLOZE = /_{3,}/;
/** 判断题标记：（对）（错）（√）（×），或「（对/错）」「（√/×）」这种只标题型、不给答案的写法 */
const JUDGE_MARK =
  /[（(]\s*(对|错|√|×|✓|✗|正确|错误|T|F)\s*(?:[/／]\s*(对|错|√|×|✓|✗|正确|错误))?\s*[）)]\s*$/;
/** 表格行 */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** 表格分隔行 |---|---| */
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
/**
 * 单道题的题干字数上限。
 *
 * 中文资料经常整章没有空行，splitBlocks 会把整章并成一个块，再被当成一道题，
 * 产出「题干 15626 字、8 个 A 选项、无答案」的假选择题。除了选项字母去重，
 * 再加一道量级护栏：真题目干极少超过 2000 字，超过就判定为块切分失误。
 */
const MAX_QUESTION_CHARS = 2000;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** 是不是标题行（# 或 中文/数字章标题的粗判，用于切断题目块） */
function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^第[一二三四五六七八九十百\d]+[章节篇]/.test(t)) return true;
  return false;
}

/** 把表格行拆成单元格 */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 去掉 markdown 加粗/斜体标记，但保留文字本身 */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
}

/** 判断题标记归一成「对」/「错」 */
function normalizeJudge(mark: string): "对" | "错" {
  const m = mark.trim();
  if (["对", "√", "✓", "正确", "T"].includes(m)) return "对";
  return "错";
}

/**
 * 一行里塞多个选项，是中文题库最常见的排版：
 *   `A.2 项 B.3 项 C.4 项 D.5 项`
 *   `A.①②③ B.①②④ C.①③④ D.②③④`
 *
 * 原来的 OPTION 正则只吃行首一个字母，`(.+)` 会把 `B.3 项 C.4 项 D.5 项`
 * 整段吞成 A 的内容 —— 选项只剩 1 个，题型判定因此不成立，整道题被丢弃。
 * 这里按「字母 + 分隔符」把一行切成多段。
 *
 * 只接受 A/B/C/D 且必须按字母顺序出现：正文里的「A.」小标题、缩写里的点
 * 不会连续排成 ABCD，因此不会误切。
 *
 * `startIndex` 必须是「已经收了多少个选项」（下一个期望字母的序号）。
 * 早前实现每个行都从 A 开始期待，于是**分行排版**（中文题库最常见的写法）
 * 里 `B.`/`C.`/`D.` 三个行全部被当成「字母不连续」丢掉，只剩一个 A ——
 * 选择题因此永远抽不出来；而每个题的 A 行都能单独通过，遇到整章无空行的块
 * 就会把多道题的 A 堆进同一张卡（真实事故：8 个 A、题干 1.5 万字）。
 */
function parseOptionLine(
  line: string,
  startIndex = 0
): Array<{ letter: string; text: string }> {
  const t = line.trim();
  // 行首必须是「A. / A、/ A．/ **A.**」，否则这一行不是选项行
  if (!/^\*{0,2}[A-DＡ-Ｄa-d]\s*[.、．)）]/.test(t)) return [];

  const re = /([A-DＡ-Ｄa-d])\s*[.、．)）]\s*/g;
  const marks: Array<{ letter: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = m.index === 0 ? "" : t[m.index - 1];
    // 字母前必须是行首、空白或分隔标点；否则多半是单词里的字母
    if (m.index !== 0 && !/[\s、，。；：|]/.test(before)) continue;
    marks.push({
      letter: m[1].toUpperCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (marks.length === 0) return [];

  const out: Array<{ letter: string; text: string }> = [];
  let expect = startIndex; // 期望的下一个字母（A=0）；分行排版时由调用方续上
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i];
    const idx = mk.letter.charCodeAt(0) - (mk.letter.charCodeAt(0) > 127 ? 0xFF21 : 65);
    // 字母不连续（A→C、B→A）说明前面的切分是误判，就此收手
    if (idx !== expect) break;
    const stop = i + 1 < marks.length ? marks[i + 1].start : t.length;
    const text = t.slice(mk.end, stop).trim();
    if (text) out.push({ letter: mk.letter, text: stripEmphasis(text) });
    expect = idx + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. 单片段分类
// ---------------------------------------------------------------------------

interface QuestionDraft {
  no: number | null;
  type: "choice" | "qa" | "cloze" | "judge";
  front: string;
  answerText: string;
  options?: string[];
  explanation?: string;
}

/**
 * 尝试把一个「以题号开头 + 后续若干行」的块解析成题目。
 * 解析不出题型（既没选项、也没问答对、没空、没判断标记）就返回 null ——
 * 这一点很关键：正文里的编号列表长得和题目一模一样，只有内容特征能区分。
 */
function parseQuestionBlock(
  block: string[],
  no: number | null
): QuestionDraft | null {
  if (block.length === 0) return null;

  const head = block[0].trim();
  const headMatch = head.match(Q_START);
  const stemRaw = headMatch ? headMatch[2] : head;
  const stem = stripEmphasis(stemRaw);
  if (!stem) return null;

  const rest = block.slice(1);
  const options: string[] = [];
  /** 已经收进来的选项字母：同一题内 A/B/C/D 各只该出现一次 */
  const seenLetters = new Set<string>();
  let mixedBlocks = false;
  let answerText = "";
  let explanation = "";
  let ask = "";
  const extraStem: string[] = [];

  // 「问：xxx」经常直接写在题号后面（`1. 问：什么是 X？`），
  // 剥掉题号后它还在首行里 —— 只看后续行会漏掉这种最常见的写法。
  const askInHead = stem.match(ASK_LINE);
  if (askInHead) ask = stripEmphasis(askInHead[1]);

  for (const raw of rest) {
    const line = raw.trim();
    if (!line) continue;

    // 一行可能塞了多个选项，必须整体拆开再看题型；
    // startIndex 续上已收的选项数，否则分行排版只有 A 能通过。
    if (options.length < 8) {
      const inline = parseOptionLine(line, seenLetters.size);
      if (inline.length > 0) {
        // 选项字母重复 = 这个「块」里混了多道题（或正文小标题）。
        // 中文资料常整章没有空行，splitBlocks 会把整章并成一块，
        // 于是这一块的每道题的 A 选项都会被依次收进同一张卡：
        // 实测产出一张「题干 15626 字、8 个 A 选项、无答案」的假选择题。
        // 一旦发现重复字母，就判定整块不是一道题，交给后续分支或人工。
        if (inline.some((o) => seenLetters.has(o.letter))) {
          mixedBlocks = true;
          break;
        }
        for (const o of inline) {
          seenLetters.add(o.letter);
          options.push(`${o.letter}. ${o.text}`);
        }
        continue;
      }
    }

    // 选项之后又出现题号行：这个块里混进了下一道题。
    // 整章没有空行时 splitBlocks 会把整章并成一块，若只靠「选项字母续接」，
    // 前两题的 A/B 会被当成同一道题的两个选项，后面所有内容变成题干。
    if (options.length > 0 && Q_START.test(line)) {
      mixedBlocks = true;
      break;
    }

    const askM = line.match(ASK_LINE);
    if (askM) {
      ask = stripEmphasis(askM[1]);
      continue;
    }

    const ansM = line.match(ANSWER_LINE);
    if (ansM) {
      answerText = stripEmphasis(ansM[1]);
      continue;
    }

    const expM = line.match(EXPLAIN_LINE);
    if (expM) {
      explanation = stripEmphasis(expM[1]);
      continue;
    }

    // 选项的补充说明、跨行的题干续行
    extraStem.push(stripEmphasis(line));
  }

  // ---- 题型判定（优先级：choice > qa > cloze > judge）----
  if (mixedBlocks) return null;

  if (options.length >= 2) {
    const front = stem + (extraStem.length ? `\n${extraStem.join("\n")}` : "");
    // 题干长度护栏：一道题的题干不该有几千字。超过这个量级说明整章被当成了一个块，
    // 收进去只会得到一张没法读、也没法作答的卡（真实事故：15626 字的假选择题）。
    // 阈值放到常见案例分析题之上，宁可漏掉极端长题，也不产出垃圾卡。
    if (front.length > MAX_QUESTION_CHARS) return null;

    // 正确项：答案里如果写了「A」「B」这种字母，映射回选项文本；否则按文本匹配
    let answer = "";
    if (answerText) {
      const letter = answerText.match(/^([A-Da-dＡ-Ｄ])(?:[.、．)）]|\s|$)/);
      if (letter) {
        const idx = letter[1].toUpperCase().charCodeAt(0) - 65;
        answer = options[idx] ? options[idx].replace(/^[A-D]\.\s*/, "") : "";
      } else {
        // 「答案：选项文本」形式：只要包含在某个选项里就算命中
        const hit = options.find((o) =>
          o.replace(/^[A-D]\.\s*/, "").includes(answerText) ||
          answerText.includes(o.replace(/^[A-D]\.\s*/, ""))
        );
        answer = hit ? hit.replace(/^[A-D]\.\s*/, "") : answerText;
      }
    }
    return {
      no,
      type: "choice",
      front,
      options,
      answerText: answer,
      explanation: explanation || undefined,
    };
  }

  if (ask && answerText) {
    return { no, type: "qa", front: ask, answerText, explanation: explanation || undefined };
  }

  // 填空：空可能不在首行（块以小节标题开头、填空句在下一行），
  // 所以要在续行里也找一次，否则整块会被判成「无题型」而丢掉。
  const clozeLine = CLOZE.test(stem) ? stem : extraStem.find((l) => CLOZE.test(l)) ?? "";
  if (clozeLine) {
    return {
      no,
      type: "cloze",
      front: clozeLine,
      answerText,
      explanation: explanation || undefined,
    };
  }

  const judge = stem.match(JUDGE_MARK);
  if (judge) {
    // 判断题的题干不带「（对）」标记，答案是标记本身
    const front = stem.replace(JUDGE_MARK, "").trim();
    // 「（对/错）」只是题型标记：它说明这是一道判断题，但没说答案是哪一边。
    // 当成答案「对」会让所有判断题都变成同一个人为答案，必须留空等答案区补。
    const isPattern = /[/／]/.test(judge[0]);
    return {
      no,
      type: "judge",
      front,
      answerText: isPattern ? "" : normalizeJudge(judge[1]),
      explanation: explanation || undefined,
    };
  }

  // 有问句但没答案：仍算问答卡，标记待补答案
  if (ask) {
    return { no, type: "qa", front: ask, answerText: "", explanation: explanation || undefined };
  }

  return null;
}

/**
 * 单个片段分类：用于给 source_fragment 打 fragment_type。
 * 判定顺序与 extractQuestions 一致，保证「片段标签」与「抽出的题」不会互相矛盾。
 */
export function classifyText(text: string): FragmentType {
  const lines = text.split("\n");

  // 表格优先：整段基本是表格
  const tableLines = lines.filter((l) => TABLE_ROW.test(l));
  if (tableLines.length >= 2) {
    const header = cellsOf(tableLines[0]);
    if (header.some((c) => /题号/.test(c))) return "answer_table";
    if (
      header.some((c) => /陷阱|错误表述|易错|常见误/.test(c)) &&
      header.some((c) => /原文|正确|说明/.test(c))
    ) {
      return "error_table";
    }
    if (header.length >= 3 && /维度|对比|方面|项目|区别/.test(header[0])) return "contrast_table";
    return "normal";
  }

  // 题目块：逐块解析，出现任一题目即定标签
  const blocks = splitBlocks(lines);
  let type: FragmentType = "normal";
  for (const b of blocks) {
    const first = b[0]?.trim() ?? "";
    const m = first.match(Q_START);
    const draft = parseQuestionBlock(b, m ? Number(m[1]) : null);
    if (draft) {
      if (draft.type === "choice") return "question_choice";
      if (draft.type === "qa") type = "question_qa";
      else if (draft.type === "cloze" && type === "normal") type = "question_cloze";
      else if (draft.type === "judge" && type === "normal") type = "question_judge";
      continue;
    }
    if (m && /解析|分析/.test(b.join("\n"))) return "answer_analysis";
  }
  return type;
}

// ---------------------------------------------------------------------------
// 块切分
// ---------------------------------------------------------------------------

/**
 * 把行切成块：
 *   · 空行是天然分隔；但题目内的空行（题干与选项之间）不能断开，
 *     所以「空行之后紧跟选项/答案行」时继续留在同一块。
 *   · 表格单独成块。
 *   · 标题行单独成块（不并入题目）。
 */
function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let buf: string[] = [];
  let inTable = false;

  const flush = () => {
    if (buf.length > 0) {
      blocks.push(buf);
      buf = [];
    }
    inTable = false;
  };

  const nextNonBlank = (i: number): string => {
    for (let j = i + 1; j < lines.length; j++) {
      if (!isBlank(lines[j])) return lines[j];
    }
    return "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (TABLE_ROW.test(line)) {
      if (!inTable && buf.length > 0) flush();
      inTable = true;
      buf.push(line);
      continue;
    }
    if (inTable) flush();

    if (looksLikeHeading(line)) {
      flush();
      blocks.push([line]);
      continue;
    }

    if (isBlank(line)) {
      if (buf.length === 0) continue;
      const nxt = nextNonBlank(i);
      const continuesBlock =
        OPTION.test(nxt) || ANSWER_LINE.test(nxt) || EXPLAIN_LINE.test(nxt);
      if (continuesBlock) continue;
      flush();
      continue;
    }

    buf.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// B. 全文原题抽取
// ---------------------------------------------------------------------------

/**
 * 定位每章标题在原文中的行号。
 *
 * 不做第二次「章判定」—— 章节结果由 parseMarkdown 决定，这里只是把
 * `chapters[i]` 对回它在原文里的那一行，顺序匹配即可。
 * 标题重复出现（同名章）时按出现顺序依次吃掉，仍能对上。
 */
function locateChapters(lines: string[], chapters: ParsedChapter[]): number[] {
  const starts: number[] = new Array(chapters.length).fill(-1);
  let ci = 0;
  for (let li = 0; li < lines.length && ci < chapters.length; li++) {
    // 章标题行可能带 Markdown 前缀（`# 第一章 xxx`），而 chapter.title 只有正文，
    // 必须先剥掉 # 再比，否则一个都对不上 → 所有题都归到最后一章。
    const t = lines[li].trim().replace(/^#{1,6}\s+/, "");
    if (!t) continue;
    if (t === chapters[ci].title) {
      starts[ci] = li;
      ci++;
    }
  }
  // 兜底：没对上的章从 0 开始（宁可归属到第一章，也不丢题）
  return starts.map((s) => (s < 0 ? 0 : s));
}

function chapterIndexOf(starts: number[], line: number): number {
  let idx = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= line) idx = i;
    else break;
  }
  return idx;
}

/** 中文序数 → 数字（一→1，十二→12）；不是序数返回 0 */
function cnToInt(s: string): number {
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const t = s.trim();
  if (!/^[一二三四五六七八九十]+$/.test(t)) return 0;
  if (t === "十") return 10;
  if (t.length === 1) return digits[t] ?? 0;
  const [a, b] = t.split("十");
  const tens = a ? digits[a] ?? 0 : 1;
  const ones = b ? digits[b] ?? 0 : 0;
  return tens * 10 + ones;
}

/** 填空自测里的小节标题：「**一、关于经济工作的新认识**」 */
const CLOZE_HEAD = /^\s*\*{1,2}\s*([一二三四五六七八九十]+)\s*[、.．]\s*(.+?)\s*\*{1,2}\s*$/;
/** 答案区里的分组答案：「**一**：经济 / 改革创新 / 放得活」 */
const CLOZE_ANSWER = /^\s*\*{1,2}\s*([一二三四五六七八九十]+)\s*\*{1,2}\s*[:：]\s*(.+)$/;

/**
 * 「先自测、再核对」类材料的填空题，答案常放在 `<details>` 折叠区，
 * 按小组用斜杠分隔：
 *   **一**：经济 / 改革创新 / 放得活 / 投资于人 / 苦练内功
 *
 * 原来的 ANSWER_LINE 只认「答案：/答：」，这些行一条都匹配不上，
 * 结果是填空卡全部被标成「缺答案」。这里单独收一遍，按组序号存起来。
 */
function parseClozeAnswers(markdown: string): Map<number, string> {
  const out = new Map<number, string>();
  const collect = (text: string) => {
    for (const line of text.split("\n")) {
      const m = line.match(CLOZE_ANSWER);
      if (!m) continue;
      const idx = cnToInt(m[1]);
      if (idx > 0) out.set(idx, m[2].trim());
    }
  };
  const details = markdown.match(/<details[\s\S]*?<\/details>/gi);
  if (details?.length) for (const d of details) collect(d);
  // 没有 <details> 的材料，答案区也可能直接写在正文里
  if (out.size === 0) collect(markdown);
  return out;
}

/**
 * 从整篇 Markdown 里抽出所有原题。
 *
 * 题号在**全文范围**维护（不做 per-chapter 重置），因为常见排版是
 * 「第九章 练习题」出题、「第十章 答案与解析」给答案 —— 分开处理就 join 不上。
 */
export function extractQuestions(markdown: string, chapters: ParsedChapter[]): ClassifyResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const starts = locateChapters(lines, chapters);
  const blocks = splitBlocks(lines);

  const drafts: Array<QuestionDraft & { chapterIndex: number; startLine: number; endLine: number }> =
    [];
  const answerMap = new Map<number, string>();
  const explainMap = new Map<number, string>();
  const blockTypes: ClassifyResult["blockTypes"] = [];
  const clozeAnswers = parseClozeAnswers(markdown);
  // 当前所在的填空小组（「**四、重点任务**」→ 4），答案按这个序号去对
  let clozeGroup = 0;

  // 行号反查：splitBlocks 没带行号，这里按内容顺序重建
  let cursor = 0;
  const blockStartLine = (b: string[]): number => {
    const first = b[0];
    for (let li = cursor; li < lines.length; li++) {
      if (lines[li] === first) {
        cursor = li;
        return li;
      }
    }
    return cursor;
  };

  for (const b of blocks) {
    const start = blockStartLine(b);
    const end = start + b.length - 1;
    const ci = chapterIndexOf(starts, start);

    // ---- 表格 ----
    if (TABLE_ROW.test(b[0] ?? "")) {
      const rows = b.filter((l) => !TABLE_SEP.test(l)).map(cellsOf);
      if (rows.length < 2) continue;
      const header = rows[0];
      const body = rows.slice(1);

      if (header.some((c) => /题号/.test(c))) {
        blockTypes.push({ startLine: start, endLine: end, type: "answer_table" });
        const noIdx = header.findIndex((c) => /题号/.test(c));
        const ansIdx = header.findIndex((c) => /答案|正确/.test(c));
        const expIdx = header.findIndex((c) => /解析|说明|分析/.test(c));

        if (ansIdx >= 0 && ansIdx !== noIdx) {
          // 竖向：| 题号 | 答案 | 解析 |
          for (const r of body) {
            const no = Number(String(r[noIdx] ?? "").replace(/[^\d]/g, ""));
            if (!no) continue;
            if (r[ansIdx]) answerMap.set(no, r[ansIdx].trim());
            if (expIdx >= 0 && r[expIdx]) explainMap.set(no, r[expIdx].trim());
          }
        } else {
          // 横向：表头就是题号行 | 题号 | 1 | 2 | 3 |，
          // 下一行首列写「答案」，按列对齐。「答案速查」几乎都是这种排版。
          const ansRow = body.find((r) => /^(答案|正确答案|参考答案|正确)/.test(r[0] ?? ""));
          if (ansRow) {
            for (let c = 0; c < header.length; c++) {
              if (c === noIdx) continue;
              const no = Number(String(header[c] ?? "").replace(/[^\d]/g, ""));
              const v = (ansRow[c] ?? "").trim();
              if (no && v) answerMap.set(no, v);
            }
          } else {
            // 没找到「答案」行时退回竖向读法，至少别把能读的丢掉
            for (const r of body) {
              const no = Number(String(r[noIdx] ?? "").replace(/[^\d]/g, ""));
              if (!no) continue;
              if (r[ansIdx] && ansIdx >= 0) answerMap.set(no, r[ansIdx].trim());
            }
          }
        }
        continue;
      }

      if (
        header.some((c) => /陷阱|错误表述|易错|常见误/.test(c)) &&
        header.some((c) => /原文|正确|说明/.test(c))
      ) {
        blockTypes.push({ startLine: start, endLine: end, type: "error_table" });
        const wrongIdx = header.findIndex((c) => /陷阱|错误表述|易错|常见误/.test(c));
        const rightIdx = header.findIndex((c) => /原文|正确|说明/.test(c));
        for (const r of body) {
          const wrong = stripEmphasis(r[wrongIdx] ?? "");
          const right = stripEmphasis(r[rightIdx] ?? "");
          if (!wrong || !right) continue;
          // 每一行直接转一张判断题：正面是错误表述，答案是「错」，back 给正确表述
          drafts.push({
            no: null,
            type: "judge",
            front: `${wrong}（对/错）`,
            answerText: "错",
            explanation: `正确表述：${right}`,
            chapterIndex: ci,
            startLine: start,
            endLine: end,
          });
        }
        continue;
      }

      if (header.length >= 3 && /维度|对比|方面|项目|区别/.test(header[0])) {
        blockTypes.push({ startLine: start, endLine: end, type: "contrast_table" });
        continue;
      }
      continue;
    }

    // ---- 题目 / 解析块 ----
    // 填空小节的组标题（「**四、重点任务**」）决定后面几行填空的答案归属
    for (const l of b) {
      const gh = l.match(CLOZE_HEAD);
      if (gh) {
        const g = cnToInt(gh[1]);
        if (g > 0) clozeGroup = g;
      }
    }

    const headMatch = (b[0] ?? "").trim().match(Q_START);
    const no = headMatch ? Number(headMatch[1]) : null;
    const whole = b.join("\n");
    const draft = parseQuestionBlock(b, no);

    if (draft) {
      // 填空：一块里可能连续好几行填空（中间没有空行），
      // 只取首行会把后面几行整段吞掉 —— 逐行成卡，一行一个空位组。
      if (draft.type === "cloze") {
        const rows = b
          .map((l) => l.trim())
          .filter((l) => l && CLOZE.test(l))
          .map((l) => stripEmphasis(l));
        const bodyRows = rows.length > 0 ? rows : [draft.front];
        const ans = clozeAnswers.get(clozeGroup) ?? "";
        // 组内多行时答案按「；」分段与行一一对应；单行时整段就是答案
        const segs = ans.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
        const perLine = bodyRows.length > 1 && segs.length === bodyRows.length;
        bodyRows.forEach((text, k) => {
          drafts.push({
            no,
            type: "cloze",
            front: text,
            answerText: perLine ? segs[k] : bodyRows.length === 1 ? ans : "",
            chapterIndex: ci,
            startLine: start + k,
            endLine: start + k,
          });
        });
        blockTypes.push({ startLine: start, endLine: end, type: "question_cloze" });
        continue;
      }

      drafts.push({ ...draft, chapterIndex: ci, startLine: start, endLine: end });
      blockTypes.push({
        startLine: start,
        endLine: end,
        type:
          draft.type === "choice"
            ? "question_choice"
            : draft.type === "qa"
              ? "question_qa"
              : "question_judge",
      });
      continue;
    }

    // 逐题解析列表：「1. **C（4 项）**。④错误：…」这种连续 15 行没有空行，
    // 整块当成一道题必然解析失败，要按行拆开、按题号存。
    const explRows = b
      .map((l) => l.trim())
      .map((l) => l.match(Q_START))
      .filter((m): m is RegExpMatchArray => !!m);
    if (explRows.length >= 2) {
      let hit = 0;
      for (const m of explRows) {
        const n = Number(m[1]);
        const text = stripEmphasis(m[2]);
        // 解析行开头就是答案字母（`C（4 项）。…` / `B。…`），正文编号列表没有这个特征
        if (n && /^[A-DＡ-Ｄ]\s*(?:[（(][^）)]{0,12}[）)])?\s*[.。、]/.test(text)) {
          explainMap.set(n, text);
          hit++;
        }
      }
      if (hit >= 2) {
        blockTypes.push({ startLine: start, endLine: end, type: "answer_analysis" });
        continue;
      }
    }

    // 解析块：「1. **B**。解析：……」—— 与题目区分在于没有选项/问答对，且含解析标记
    if (headMatch && /解析|分析/.test(whole)) {
      blockTypes.push({ startLine: start, endLine: end, type: "answer_analysis" });
      const n = Number(headMatch[1]);
      const text = whole.replace(Q_START, "$2").trim();
      if (n) explainMap.set(n, stripEmphasis(text));
    }
  }

  // ---- join：答案表 / 解析表 → 题目 ----
  const questions: ExtractedQuestion[] = drafts.map((d) => {
    let answer = d.answerText;
    let explanation = d.explanation;

    if (d.no !== null) {
      if (!answer && answerMap.has(d.no)) answer = answerMap.get(d.no)!;
      if (!explanation && explainMap.has(d.no)) explanation = explainMap.get(d.no);
    }

    // 选择题的答案可能是选项字母（答案表里常写 A/B/C/D），要映射成选项文本
    if (d.type === "choice" && d.options && answer) {
      const letter = answer.match(/^([A-Da-dＡ-Ｄ])(?:[.、．)）]|\s|$)/);
      if (letter) {
        const idx = letter[1].toUpperCase().charCodeAt(0) - 65;
        const opt = d.options[idx];
        if (opt) answer = opt.replace(/^[A-D]\.\s*/, "");
      }
    }

    // 判断题：答案表里可能写「√/×/正确/错误/对/错」
    if (d.type === "judge" && answer) {
      const a = answer.trim();
      if (/^(√|✓|正确|对|T)$/i.test(a)) answer = "对";
      else if (/^(×|✗|错误|错|F)$/i.test(a)) answer = "错";
    }

    return {
      no: d.no,
      type: d.type,
      front: d.front,
      back: answer,
      options: d.options,
      answer: d.type === "choice" ? answer || undefined : undefined,
      explanation,
      needs_answer: !answer,
      chapterIndex: d.chapterIndex,
      startLine: d.startLine,
      endLine: d.endLine,
    };
  });

  return { questions, blockTypes };
}

/**
 * 伪章合并：题目块被误判成「章」时（「2. 下列关于内存的说法正确的是？」恰好接上章号序列），
 * 会多出一个只有题目的章 —— 章节数虚高、真题归属错乱。
 *
 * 判据（命中其一即认为是伪章）：
 *   · 标题以数字编号开头，且正文首行就是选项（A. / B.）
 *   · 标题以数字编号开头，且正文首行是「答：」
 *   · 标题以数字编号开头，且标题里带（对/错）或正文含 ______
 *   · 标题以数字编号开头，且正文里有 ≥2 个选项行（原判据，兜住紧凑排版）
 *
 * 真章节不会满足这些：正文首行通常是叙述句，而不是 A. / 答：。
 *
 * 处理：把它的片段并回前一章，不丢内容、不重切。
 * 这是 parseMarkdown **输出之后**的修补，不触碰其内部切章规则。
 */
export function mergePseudoQuestionChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  if (chapters.length <= 1) return chapters;
  const out: ParsedChapter[] = [];

  for (const ch of chapters) {
    // parseHeading 把「1. xxx」规范化成「1 xxx」（点被吃掉），
    // 所以这里既要认「1. xxx」也要认「1 xxx」，还要认中文序号「一、xxx」。
    // 但必须排除「1.1 小节」这种多级编号 —— 它是小节，不是题目。
    const numbered =
      /^(?:\d{1,3}(?!\.\d)|[一二三四五六七八九十百]+)\s*(?:[.、．)]|\s)\s*\S/.test(ch.title);
    const firstBody = (ch.fragments[0]?.content ?? "").split("\n")[0].trim();

    // 判据必须只看「标题本身像不像题目」。
    //
    // 曾经用「正文里有选项 / 有 ______ / 有答：」来判断，结果把真正的
    // 「九、练习题（15 题）」「八、消化清单（填空自测）」这类章当成伪章合并掉，
    // 11 章变 9 章、整章题目被塞进上一章，用户在章节页直接看不到这一章。
    // 真章的正文当然会有选项和填空 —— 这恰恰是它该存在的原因，不是合并的理由。
    const titleLooksLikeQuestion =
      // 问句标题：「1. 下列关于内存的说法正确的是？」
      /[？?]\s*$/.test(ch.title) ||
      // 判断题标题：「1. HTTP 是无状态协议（对/错）」
      /[（(]\s*(对|错|√|×|✓|✗)\s*[/／]?\s*(对|错|√|×|✓|✗)?\s*[）)]\s*$/.test(ch.title) ||
      // 章名不会这么长；题干被误切时会很长
      ch.title.replace(/\s/g, "").length > 32;

    // 正文首行就是选项 —— 真章的首行是叙述句或小节标题，不会以 A. 开头
    const bodyStartsWithOption = OPTION.test(firstBody);

    const isPseudo = numbered && (titleLooksLikeQuestion || bodyStartsWithOption) && out.length > 0;

    if (isPseudo) {
      const prev = out[out.length - 1];
      // 标题本身也是题干的一部分，补回正文首行
      const head: ParsedChapter["fragments"][number] = {
        content: ch.title,
        locator: `${prev.title} · ${ch.title}（题干）`,
        paragraph_index: prev.fragments.length,
      };
      prev.fragments = [...prev.fragments, head, ...ch.fragments];
      continue;
    }
    out.push(ch);
  }

  return out;
}
