// 题目抽取管线 —— 8 个方法的纯实现，零运行时依赖（只 type-only import）。
//
// 设计约束（对应 2026-11-05 专项优化任务书）：
//   1. 抽取专用分块，绝不写入 source_fragments，不影响全文页 / 检索 / AI 出题。
//   2. 规则负责「逐字抽取」题干 / 选项 / 答案 / 解析；模型只做边界、题型、
//      答案引用的仲裁，**模型返回的任何文本都不进入题目**。
//   3. 所有分块都进入候选扫描；单个分块或单次模型调用失败只降级，不中断整份文档。
//   4. 不依赖空行切题 —— 题号 / 问句 / 字段行才是题目边界，解决「整章无空行全丢」。
//
// 本文件不 import 任何带副作用的运行时模块，因此可被 scripts/*.mjs 用 Node
// 原生 type-stripping 直接 import 做单元测试（无扩展名解析问题）。
// 唯一的例外是 answer-expansion：同为纯函数、零依赖，单独成文件只为方便测试。

import { expandAnswersFromContext } from "./answer-expansion";
import type {
  BlockKind,
  JudgeRequest,
  LlmVerdict,
  MarkdownBlock,
  PipelineOptions,
  PipelineResult,
  PipelineStats,
  QuestionCandidate,
  QuestionChunk,
  QuestionType,
  UnifiedQuestion,
} from "./question-types";

// ---------------------------------------------------------------------------
// 公共小工具（纯函数，无副作用）
// ---------------------------------------------------------------------------

/** FNV-1a 32bit：给 chunk 生成稳定 ID，不依赖 node:crypto，测试与浏览器都能跑。 */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 比较用归一化：去空白 / Markdown 强调 / 中英文标点差异，不改变措辞。 */
export function normalizeForCompare(s: string): string {
  return String(s ?? "")
    .replace(/[*`_~]/g, "")
    .replace(/\s+/g, "")
    .replace(/[，,]/g, ",")
    .replace(/[。．]/g, ".")
    .replace(/[：]/g, ":")
    .replace(/[？]/g, "?")
    .replace(/[（）()]/g, "")
    .toLowerCase();
}

/** 只去掉 Markdown 强调符，保留原文措辞（不允许改写内容）。 */
function stripEmphasis(s: string): string {
  return String(s ?? "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    // 跨行加粗（`**1 双产品面\n如何分工**`）会留下孤立星号。
    // 星号不可能是正文内容，清掉才不会让题干带上 `**` 这种残渣。
    .replace(/\*+/g, "")
    .trim();
}

/**
 * 一行塞多个选项，是中文题库最常见的排版：
 *   A.2 项 B.3 项 C.4 项 D.5 项
 *   A.①②③ B.①②④ C.①③④ D.②③④
 *
 * OPTION_LINE 只吃行首一个字母，`(.+)` 会把 `B.3 项 C.4 项 D.5 项` 整段
 * 吞成 A 的内容 —— 选项只剩 1 个，`options.length >= 2` 不成立，整道组合
 * 选择题被降级成「问答」，A/B/C/D 选项行凭空消失（真实事故：7 张卡）。
 * 旧分类器 classify.ts 早有此修复，新管线遗漏了，这里补齐。
 *
 * `startIndex` 必须是「已经收了多少个选项」，让「A 单独一行 + B/C/D 挤一行」
 * 的混合排版也能续上字母顺序。
 */
function parseInlineOptions(
  line: string,
  startIndex = 0
): Array<{ letter: string; text: string }> {
  const t = line.trim();
  if (!/^\*{0,2}[A-DＡ-Ｄa-d]\s*[.、．)）]/.test(t)) return [];

  const re = /([A-DＡ-Ｄa-d])\s*[.、．)）]\s*/g;
  const marks: Array<{ letter: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = m.index === 0 ? "" : t[m.index - 1];
    // 字母前必须是行首、空白或分隔标点；否则多半是单词/编号里的字母
    if (m.index !== 0 && !/[\s、，。；：|]/.test(before)) continue;
    marks.push({
      letter: m[1].toUpperCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (marks.length === 0) return [];

  const out: Array<{ letter: string; text: string }> = [];
  let expect = startIndex;
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i];
    const code = mk.letter.charCodeAt(0);
    const idx = code - (code > 127 ? 0xff21 : 65);
    // 字母不连续（A→C、B→A）说明切分误判，就此收手
    if (idx !== expect) break;
    const stop = i + 1 < marks.length ? marks[i + 1].start : t.length;
    const text = stripEmphasis(t.slice(mk.end, stop).trim());
    if (text) out.push({ letter: mk.letter, text });
    expect = idx + 1;
  }
  return out;
}

/** 全角 Ａ-Ｄ → 半角 A-D，其余原样。 */
function halfWidthLetter(letter: string): string {
  return letter.replace(/[Ａ-Ｄ]/, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xff21 + 65)
  );
}

// ---------------------------------------------------------------------------
// 数字 / 圈号选项（spec: high_recall_harvest.collectOptionGroups 的行级等价实现）
//
// 为什么必须单独做：`1. 北京` 与「第 1 题的题号」在源码上完全同形，Q_START 会把
// 选项行当成新题，一道选择题被切成 N 道问答、选项行整行丢失（真实事故形态）。
//
// 这里只折叠**强信号**组：任一条不满足就保持既有行为（不折），宁可漏不可误。
// 弱信号组仍然走原逻辑，并作为候选送模型审核。
// ---------------------------------------------------------------------------

/** 圈号序号表：U+2460 起依次 1..20 */
const CIRCLED_ORDER = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const CIRCLED_TO_DIGIT = new Map<string, number>(
  [...CIRCLED_ORDER].map((c, i) => [c, i + 1] as const)
);

/** 组前导词：出现这些说明后面是解析步骤 / 答案要点，不是选项 */
const NON_OPTION_LEAD =
  /^\s*\*{0,2}(?:解析|分析|解答|解|步骤|答|答案要点|要点|说明|方法|原理|过程|思路)\s*[:：]/;

/** 选择问特征：题干出现这些才更像「下面几项里选」 */
const CHOICE_CUE =
  /[？?]|下列|以下|哪一?项|哪些|几项|正确的是|错误的是|不属于|选出|选择|填空|（\s*）|\(\s*\)/;

/** 中文小数字：一~十（序数答案「第2项 / 第二项」用） */
function cnNumeral(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (s === "十一") return 11;
  if (s === "十二") return 12;
  return map[s] ?? null;
}

/** 拆一行「1. 北京」/「① 北京」为序号 + 文本；不是编号行返回 null。 */
function parseNumberedItem(line: string): { digit: number; text: string } | null {
  const t = line.trim().replace(/^\*{0,2}/, "").replace(/\*{0,2}$/, "");
  const num = t.match(/^(\d{1,3})\s*[.、．)）]\s*(.+)$/);
  if (num) return { digit: Number(num[1]), text: stripEmphasis(num[2]).trim() };
  const cir = t.match(/^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*[.、．)）]?\s*(.+)$/);
  if (cir) {
    const d = CIRCLED_TO_DIGIT.get(cir[1]);
    if (d) return { digit: d, text: stripEmphasis(cir[2]).trim() };
  }
  return null;
}

/** 答案是否能落到组内某一项（字母 / 数字 / 圈号）。 */
function answerTargetsGroup(answer: string, count: number): boolean {
  const t = stripEmphasis(answer).trim();
  const letter = t.match(/^[（(]?\s*([A-Da-dＡ-Ｄ])\s*[)）]?\s*[.、．]?$/);
  if (letter) {
    const code = letter[1].toUpperCase().charCodeAt(0);
    const idx = code - (code > 127 ? 0xff21 : 65);
    return idx >= 0 && idx < count;
  }
  const cir = t.match(/^([①②③④⑤⑥⑦⑧⑨⑩])$/);
  if (cir) {
    const d = CIRCLED_TO_DIGIT.get(cir[1]);
    return !!d && d <= count;
  }
  const num = t.match(/^第?\s*(\d{1,3})\s*(?:项|个|条)?$/);
  if (num) {
    const d = Number(num[1]);
    return d >= 1 && d <= count;
  }
  return false;
}

/** 这一条本身更像「题干」而不是「选项」：有选择问、过长、或整句陈述收尾。 */
function looksLikeStem(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (CHOICE_CUE.test(t)) return true;
  if (t.length > 60) return true;
  return /[。；;]$/.test(t);
}

/**
 * 找出「强信号」的数字/圈号选项组，返回 行下标 → 归一后的选项。
 *
 * 强信号 = 短且平行 + 不是题目清单 + 组前是题干 + 组后有答案或题干本身是选择问。
 * 四条同时满足才折叠，否则一律不折——误折会把两道独立题合成一道。
 */
interface NumberedGroupMember {
  letter: string;
  text: string;
  /** 该组对应的题干行下标（-1 = 没找到题干） */
  stemIndex: number;
}

function detectNumberedOptionGroups(
  lines: LineRef[]
): Map<number, NumberedGroupMember> {
  const out = new Map<number, NumberedGroupMember>();
  let i = 0;
  while (i < lines.length) {
    const head = parseNumberedItem(lines[i].line);
    if (!head) {
      i++;
      continue;
    }

    // 先把「连续编号段」整体收出来：中间断号就说明混入了别的内容
    const segStart = i;
    const seg: Array<{ index: number; digit: number; text: string }> = [];
    let j = i;
    while (j < lines.length) {
      const it = parseNumberedItem(lines[j].line);
      if (!it) break;
      if (seg.length > 0 && it.digit !== seg[seg.length - 1].digit + 1) break;
      seg.push({ index: j, digit: it.digit, text: it.text });
      j++;
    }
    if (seg.length < 2) {
      i = j > i ? j : i + 1;
      continue;
    }

    // 段首本身若是题干（典型：「1. 下列哪个是直辖市？」后面跟着「1. 北京」），
    // 题干不参与选项，选项组从第二行起算；否则组从段首起算。
    const firstIsStem = looksLikeStem(seg[0].text);
    const group = firstIsStem ? seg.slice(1) : seg;
    // 题干行：段首是题干就是段首；否则往上看最近的非空行
    let stemIndex = segStart;
    if (!firstIsStem) {
      stemIndex = segStart - 1;
      while (stemIndex >= 0 && !lines[stemIndex].line.trim()) stemIndex--;
    }

    // 选项组首数字：题干占「1.」时，选项通常接续编为 2/3/4；
    // 题干与首选项同为「1.」会被断号拆成两段（分别走 firstIsStem=false 分支），
    // 因此 firstIsStem=true 时只可能遇到从 2 起编。两种起编都放通，避免误拒整组选项。
    const expectedFirsts = firstIsStem ? [1, 2] : [1];
    if (group.length < 2 || group.length > 6 || !expectedFirsts.includes(group[0].digit)) {
      i = j;
      continue;
    }

    // ① 条目要短、长度要平行：选项是并列短语，解析步骤 / 答案要点是长句
    const lens = group.map((x) => x.text.length);
    const minLen = Math.min(...lens);
    const maxLen = Math.max(...lens);
    const shortAndParallel =
      minLen >= 1 && maxLen <= 60 && (minLen >= 4 ? maxLen / minLen <= 3 : maxLen <= 20);

    // ② 组内像「题目清单」：≥2 项各自都是完整题干 → 是题号，不是选项
    const questionLike = group.filter((x) =>
      /正确的是|错误的是|不属于|下列(?:哪|以下|关于)/.test(x.text)
    ).length;
    const looksLikeQuestionList = questionLike >= 2;

    // ③ 组前必须有题干行，且不能是标题 / 无序列表 / 解析步骤前导
    const stemLine = stemIndex >= 0 ? lines[stemIndex].line.trim() : "";
    const stemOk =
      !!stemLine &&
      lines[stemIndex]?.block.kind !== "heading" &&
      !/^\s*[-*+]\s+/.test(stemLine) &&
      !NON_OPTION_LEAD.test(stemLine);

    // ④ 组后最近非空行是答案行且答案指向组内 → 强证据
    let q = j;
    while (q < lines.length && !lines[q].line.trim()) q++;
    const afterLine = q < lines.length ? lines[q].line.trim() : "";
    const ans = afterLine.match(ANSWER_LINE);
    const answerFits = ans ? answerTargetsGroup(ans[1], group.length) : false;
    const stemLooksLikeChoice = CHOICE_CUE.test(stemLine);

    if (!(shortAndParallel && !looksLikeQuestionList && stemOk && (answerFits || stemLooksLikeChoice))) {
      i = j;
      continue;
    }

    group.forEach((it, k) => {
      out.set(it.index, {
        letter: String.fromCharCode(65 + k),
        text: it.text,
        stemIndex,
      });
    });
    i = j;
  }
  return out;
}

/**
 * 选择题答案归一（spec: ambiguity_rules）。
 *
 * 原文可能是 A / 2 / ② / 第2项 / 12 / ①③。
 * 只做「能唯一确定」的映射；多选与越界保持原文并回报歧义，由审核台人工处理——绝不猜。
 */
function resolveChoiceAnswer(
  raw: string,
  options: string[]
): { value: string; ambiguous: string | null } {
  const text = stripEmphasis(raw).trim();
  const n = options.length;
  const optionText = (idx: number): string | null =>
    idx >= 0 && idx < n ? options[idx].replace(/^[A-D]\.\s*/, "") : null;

  // 1) 字母（含全角与括号包裹）
  const letter = text.match(/^[（(]?\s*([A-Da-dＡ-Ｄ])\s*[)）]?\s*[.、．]?$/);
  if (letter) {
    const code = letter[1].toUpperCase().charCodeAt(0);
    const idx = code - (code > 127 ? 0xff21 : 65);
    const hit = optionText(idx);
    if (hit) return { value: hit, ambiguous: null };
  }

  // 2) 圈号单选 / 多选
  const cir = text.match(/^([①②③④⑤⑥⑦⑧⑨⑩])$/);
  if (cir) {
    const d = CIRCLED_TO_DIGIT.get(cir[1]);
    const hit = d ? optionText(d - 1) : null;
    if (hit) return { value: hit, ambiguous: null };
  }
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]{2,}$/.test(text)) {
    return { value: text, ambiguous: "multi_select_answer" };
  }

  // 3) 序数：第2项 / 第二项 / 第 2 条
  const ord = text.match(/^第?\s*([一二三四五六七八九十\d]{1,3})\s*(?:项|个|条|选项)$/);
  if (ord) {
    const d = cnNumeral(ord[1]);
    const hit = d ? optionText(d - 1) : null;
    if (hit) return { value: hit, ambiguous: null };
    return { value: text, ambiguous: "answer_out_of_range" };
  }

  // 4) 纯数字：2 → 第 2 项；12 在三义中取「越界则视为连写多选」
  const num = text.match(/^(?:第\s*)?(\d{1,3})$/);
  if (num) {
    const d = Number(num[1]);
    const hit = optionText(d - 1);
    if (hit) return { value: hit, ambiguous: null };
    // 「12」可能是 A+B，也可能是第 12 项：逐位都能当选项序号才按连写多选上报
    const digits = [...num[1]].map(Number);
    if (num[1].length >= 2 && digits.every((x) => x >= 1 && x <= n)) {
      return { value: text, ambiguous: "multi_select_answer" };
    }
    return { value: text, ambiguous: "answer_out_of_range" };
  }

  return { value: text, ambiguous: null };
}

// 题号行「1. 」「1、」「1)」「1．」，但**排除多级编号**「1.1」「2.3.1」——
// 那种是小节号（`### 1.1 RAG 和微调有什么区别?`），不是题号；误当题号会把
// 小节标题抽成一道「无答案」的假题，而真正的题目在下一行 `问题：` 字段里。
// 点号后紧跟数字即为多级编号，点号分支用 (?!\d) 排除；顿号/括号/全角点后跟数字
// 属正常正文（「1) 答案」「1、2 项」），不做排除。
const Q_START = /^\s*\*{0,2}(\d{1,3})(?:[、．)）]|[.](?!\d))\*{0,2}\s*(.*)$/;
const OPTION_LINE = /^\s*\*{0,2}([A-DＡ-Ｄa-d])\s*[.、．)）]\*{0,2}\s*(.+)$/;
const ANSWER_LINE = /^\s*\*{0,2}(?:答案|答|Answer|参考答案|正确答案)\s*[:：]\s*(.+)$/i;
const EXPLAIN_LINE = /^\s*\*{0,2}(?:解析|分析|说明|Explanation)\s*[:：]\s*(.+)$/i;
const ASK_FIELD = /^\s*\*{0,2}(?:问题|题目|问|Q|Question|练习)\s*\d{0,3}\s*[:：]\s*(.+)$/i;
const CLOZE = /_{3,}|＿{3,}|（\s{2,}）|\(\s{2,}\)/;
const JUDGE_MARK = /[（(]\s*(对|错|√|×|✓|✗|正确|错误|T|F)\s*(?:[/／]\s*(对|错|√|×|✓|✗|正确|错误))?\s*[）)]\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const LIST_LINE = /^\s*(?:[-*+]\s+|\d{1,3}\s*[.、．)）]\s+|[A-Da-dＡ-Ｄ]\s*[.、．)）]\s+)/;
const ASK_CUE =
  /(?:[？?]|什么|如何|怎么|怎样|为什么|哪些|是否|是什么|有哪些|请(?:简述|说明|分析|列举|比较|介绍)|区别|关系|应该怎么)/;

// 区块级「这组编号条目是题目」的声明。命中后，该 chunk 内所有编号行都视为题目候选，
// 不再要求题干自带疑问词——这是区分「面试问题清单」与「正文编号步骤」的关键信号。
const QUESTION_SECTION_HINT =
  /(?:面试问题|面试题|问题清单|题目清单|试题|练习题|Questions?|Q\s*&\s*A)\s*(?:[（(]\s*\d+\s*(?:道|题)?\s*[)）])?\s*[:：]/i;

// 「参考答案：」换行再写内容的写法（冒号后为空）。命中即进入「答案区」。
const ANSWER_HEADER =
  /^\s*\*{0,2}(?:参考答案|参考解答|答案|解析|答)\*{0,2}\s*[:：]\s*\*{0,2}\s*$/;

// 元信息行（思考逻辑 / 考点 / 答题思路）：不进题干，避免把提示语混进题目正文。
const META_LINE =
  /^\s*\*{0,2}(?:💡\s*)?(?:思考逻辑|思路|考点|考察点|答题思路|解析思路)\*{0,2}\s*[:：]/;

// 答案引用头：`### Q1: …` / `### 第3题：…` / `【第3题】…` / `Q6：…`。
// 参考答案区用「Q1/Q6/Q11」或「第N题」指回题目区，冒号后是答案正文而非题目。
// 它与题目区的「Q1: 什么是 RAG？」形态相同，唯一可靠区分是所在章节——
// 出现在「参考答案 / 答案 / 解析」章节里的才是答案引用头，不产题。
const ANSWER_REF_HEADER =
  /^\s*\*{0,2}(?:Q\s*(\d{1,3})\s*[:：]|第\s*(\d{1,3})\s*题\s*[:：]|【\s*第\s*(\d{1,3})\s*题\s*】)/i;

/** 章节路径是否落在「答案 / 解析 / 参考答案」区。
 *
 * 只认「答案语义主导」的标题（以答案类词开头），刻意排除「核心概念详解与
 * 参考答案」「教程与参考答案」这类「题目+答案成对」的复合章节——那里面的
 * `### Q1: 什么是 Tokenizer？` 是题目，不是答案引用头，误判会让整章题归零。
 */
function isAnswerSection(chapterPath: string[]): boolean {
  return chapterPath.some((p) => {
    const t = p.replace(/^第[一二三四五六七八九十百\d]+[章节篇]\s*/, "").trim();
    return /^(?:参考答案|参考解答|答案解析|答案速查|答案|解析|Answer\b)/i.test(t);
  });
}

// 阈值刻意放宽：中文题库常见「题干 + 选项 + 答案」跨多段、整章无空行，
// 小块切分会把一道题劈成两半。宁可块大一点，也要保证题目完整落在同一分块；
// 章标题（level<=2）仍会稳定切块，长文档依然是多分块全量扫描。
const MAX_CHUNK_CHARS = 12000;
const MAX_QUESTION_CHARS = 2000;
const ANCHOR_SIGNALS = new Set(["question_no", "ask_field", "question_sentence", "cloze", "judge", "table_question"]);

interface LineRef {
  line: string;
  lineNo: number;
  offset: number;
  block: MarkdownBlock;
}

function chunkLines(chunk: QuestionChunk): LineRef[] {
  const out: LineRef[] = [];
  for (const b of chunk.blocks) {
    // 代码围栏内的 `1. xxx` / `A. xxx` 是示例、伪代码或日志，不是题目（spec: CODE_FENCE_跳过）。
    // 在这里统一过滤，候选检测与逐行抽取两处同时生效，避免同一个缺口修两遍还漏一处。
    if (b.kind === "code") continue;
    const ls = b.text.split("\n");
    let off = b.start;
    for (let k = 0; k < ls.length; k++) {
      out.push({ line: ls[k], lineNo: b.startLine + k, offset: off, block: b });
      off += ls[k].length + 1;
    }
  }
  return out;
}

function lineSignals(line: string, inTable: boolean): string[] {
  const t = line.trim();
  const out: string[] = [];
  if (!t) return out;
  if (Q_START.test(t)) out.push("question_no");
  if (OPTION_LINE.test(t)) out.push("option");
  if (ANSWER_LINE.test(t)) out.push("answer");
  // 答案区头「**参考答案：**」冒号后为空时，正文在下一行 —— 它同样属于
  // 上一道题的「答案」，必须产出 answer 信号，否则 blank 分支会误判成题目
  // 边界而提前 finish，导致紧随其后的答案正文成孤儿段落（组 3 事故）。
  if (ANSWER_HEADER.test(t)) out.push("answer");
  if (EXPLAIN_LINE.test(t)) out.push("explanation");
  if (ASK_FIELD.test(t)) out.push("ask_field");
  if (CLOZE.test(t)) out.push("cloze");
  if (JUDGE_MARK.test(t)) out.push("judge");
  if (ASK_CUE.test(t)) out.push("question_sentence");
  if (inTable) out.push("table_row");
  return out;
}

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// ---------------------------------------------------------------------------
// 1. parse_markdown_structure
// ---------------------------------------------------------------------------

/**
 * 把原文切成结构化内容块，保留原文字符偏移、行号、标题路径与出现顺序。
 * 所有行（含空行、代码围栏内文本）都会落进某个块，不丢内容。
 */
export function parseMarkdownStructure(markdownText: string): MarkdownBlock[] {
  const md = String(markdownText ?? "").replace(/\r\n/g, "\n");
  const lines = md.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (const line of lines) {
    starts.push(acc);
    acc += line.length + 1;
  }

  const blocks: MarkdownBlock[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let seq = 0;
  let i = 0;

  const push = (
    kind: BlockKind,
    from: number,
    to: number,
    headingLevel = 0
  ): void => {
    const text = lines.slice(from, to + 1).join("\n");
    blocks.push({
      id: `b${seq++}`,
      kind,
      text,
      start: starts[from],
      end: starts[to] + lines[to].length,
      startLine: from,
      endLine: to,
      headingLevel,
      headingPath: stack.map((h) => h.text),
    });
  };

  while (i < lines.length) {
    const t = lines[i].trim();

    if (t === "") {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].trim() === "") j++;
      push("blank", i, j);
      i = j + 1;
      continue;
    }

    if (/^```/.test(t)) {
      let j = i + 1;
      while (j < lines.length && !/^```/.test(lines[j].trim())) j++;
      push("code", i, Math.min(j, lines.length - 1));
      i = Math.min(j + 1, lines.length);
      continue;
    }

    const hm = t.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const level = hm[1].length;
      const title = stripEmphasis(hm[2]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: title });
      push("heading", i, i, level);
      i++;
      continue;
    }

    if (TABLE_ROW.test(lines[i])) {
      let j = i;
      while (j + 1 < lines.length && TABLE_ROW.test(lines[j + 1])) j++;
      push("table", i, j);
      i = j + 1;
      continue;
    }

    if (/^\s*>/.test(lines[i])) {
      let j = i;
      while (j + 1 < lines.length && /^\s*>/.test(lines[j + 1])) j++;
      push("quote", i, j);
      i = j + 1;
      continue;
    }

    if (LIST_LINE.test(lines[i])) {
      let j = i;
      while (j + 1 < lines.length && LIST_LINE.test(lines[j + 1])) j++;
      push("list", i, j);
      i = j + 1;
      continue;
    }

    // 普通段落：连续的非空、非结构行
    let j = i;
    while (j + 1 < lines.length) {
      const n = lines[j + 1].trim();
      if (
        n === "" ||
        /^#{1,6}\s+/.test(n) ||
        /^```/.test(n) ||
        TABLE_ROW.test(lines[j + 1]) ||
        /^\s*>/.test(lines[j + 1]) ||
        LIST_LINE.test(lines[j + 1])
      ) break;
      j++;
    }
    push("paragraph", i, j);
    i = j + 1;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// 2. split_markdown_with_context
// ---------------------------------------------------------------------------

/** 结构化分块：按标题 / 表格 / 长度边界切，保留相邻块上下文与稳定 chunk_id。 */
export function splitMarkdownWithContext(blocks: MarkdownBlock[]): QuestionChunk[] {
  const chunks: QuestionChunk[] = [];
  let cur: MarkdownBlock[] = [];
  let context: MarkdownBlock[] = [];
  let index = 0;

  const flush = (): void => {
    if (cur.length === 0) return;
    const first = cur[0];
    const last = cur[cur.length - 1];
    const chapterPath = first.headingPath.length ? [...first.headingPath] : ["全文"];
    const chunkId = `qch_${stableHash(`${chapterPath.join(">")}|${first.start}|${last.end}`)}`;
    chunks.push({
      chunkId,
      index: index++,
      blocks: cur,
      contextBlocks: context,
      text: cur.map((b) => b.text).join("\n"),
      start: first.start,
      end: last.end,
      startLine: first.startLine,
      endLine: last.endLine,
      chapterPath,
      prevChunkId: null,
      nextChunkId: null,
    });
    // 重叠上下文：只带最后一个非空、非标题块，供跨段落题目识别用，不参与抽题
    const tail = cur.filter((b) => b.kind !== "blank" && b.kind !== "heading").slice(-1);
    context = tail;
    cur = [];
  };

  for (const b of blocks) {
    if (b.kind === "blank" && cur.length === 0) continue;
    if (b.kind === "heading" && b.headingLevel <= 2 && cur.length > 0) flush();

    const size = cur.reduce((n, x) => n + x.text.length + 1, 0);
    if (size + b.text.length > MAX_CHUNK_CHARS && cur.length > 0) {
      // 不在「选项 / 答案 / 解析」块之前切断：这些行属于上一道题
      const firstLine = b.text.split("\n")[0].trim();
      const belongsToPrevious =
        OPTION_LINE.test(firstLine) || ANSWER_LINE.test(firstLine) || EXPLAIN_LINE.test(firstLine);
      if (!belongsToPrevious) flush();
    }
    cur.push(b);
  }
  flush();

  for (let k = 0; k < chunks.length; k++) {
    chunks[k].prevChunkId = k > 0 ? chunks[k - 1].chunkId : null;
    chunks[k].nextChunkId = k + 1 < chunks.length ? chunks[k + 1].chunkId : null;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 3. detect_question_candidates
// ---------------------------------------------------------------------------

/** 规则扫描发现候选：只发现、不定性；每个 chunk 都会被扫描。 */
export function detectQuestionCandidates(chunks: QuestionChunk[]): QuestionCandidate[] {
  const out: QuestionCandidate[] = [];
  let seq = 0;

  for (const chunk of chunks) {
    const lines = chunkLines(chunk);
    if (lines.length === 0) continue;

    let anchorStart = -1;
    let anchorEnd = -1;
    let signals = new Set<string>();

    const emit = (start: number, end: number, sigs: Set<string>, orphan: boolean): void => {
      if (start < 0 || end < start) return;
      const slice = lines.slice(start, end + 1);
      const excerpt = slice.map((l) => l.line).join("\n").trim();
      if (!excerpt) return;
      const ctxBefore = lines.slice(Math.max(0, start - 2), start).map((l) => l.line).join(" ");
      const ctxAfter = lines.slice(end + 1, end + 3).map((l) => l.line).join(" ");
      // 数字/圈号条目候选：既可能是选项，也可能是题号清单、解析步骤或答案要点。
      // 这类候选规则层天然拿不准，必须让模型结合上下文与表现形式证真/证伪
      // （spec: ai_audit_layer.when_to_send 第 1 条）。
      const numberedItems = slice.filter((l) => {
        const t = l.line.trim();
        return /^\d{1,3}\s*[.、．)）]\s*\S/.test(t) || /^[①②③④⑤⑥⑦⑧⑨⑩]/.test(t);
      }).length;
      if (numberedItems >= 2) sigs.add("numeric_option_candidate");

      const sigArr = [...sigs];
      const hasAnchor = sigArr.some((s) => ANCHOR_SIGNALS.has(s));
      let confidence = 0.45;
      if (sigArr.includes("question_no")) confidence += 0.15;
      if (sigArr.includes("option")) confidence += 0.15;
      if (sigArr.includes("answer")) confidence += 0.1;
      if (sigArr.includes("question_sentence") || sigArr.includes("ask_field")) confidence += 0.1;
      if (sigArr.includes("cloze") || sigArr.includes("judge")) confidence += 0.1;
      out.push({
        id: `c${seq++}`,
        chunkId: chunk.chunkId,
        start: slice[0].offset,
        end: slice[slice.length - 1].offset + slice[slice.length - 1].line.length,
        startLine: slice[0].lineNo,
        endLine: slice[slice.length - 1].lineNo,
        signals: sigArr,
        excerpt,
        context: `${ctxBefore}\n${ctxAfter}`.trim().slice(0, 500),
        confidence: Math.min(0.95, confidence),
        // 无锚点（跨段落）、边界模糊、缺题号 → 交给模型仲裁；数字/圈号条目必审
        needsLlm:
          orphan ||
          !hasAnchor ||
          !sigArr.includes("question_no") ||
          sigArr.length < 2 ||
          sigArr.includes("numeric_option_candidate"),
      });
    };

    for (let k = 0; k < lines.length; k++) {
      const inTable = lines[k].block.kind === "table";
      const sig = lineSignals(lines[k].line, inTable);
      const isAnchor = sig.some((s) => ANCHOR_SIGNALS.has(s));
      const isContinuation =
        sig.includes("option") || sig.includes("answer") || sig.includes("explanation");

      if (isAnchor) {
        if (anchorStart >= 0) emit(anchorStart, anchorEnd, signals, false);
        anchorStart = k;
        anchorEnd = k;
        signals = new Set(sig);
        continue;
      }

      if (anchorStart >= 0) {
        // 锚点之后的普通行先归进候选；遇到空行且下一行不是选项/答案/解析时收尾
        if (sig.length === 0 && lines[k].line.trim() === "") {
          const next = lines[k + 1]?.line ?? "";
          const ns = lineSignals(next, lines[k + 1]?.block.kind === "table");
          if (!ns.some((s) => s === "option" || s === "answer" || s === "explanation")) {
            emit(anchorStart, anchorEnd, signals, false);
            anchorStart = -1;
            anchorEnd = -1;
            signals = new Set();
            continue;
          }
        }
        anchorEnd = k;
        for (const s of sig) signals.add(s);
        continue;
      }

      // 没有锚点却出现选项/答案/解析：可能是上一段题目的延续（跨段落题目）
      if (isContinuation) {
        const local = new Set(sig);
        emit(k, k, local, true);
      }
    }
    if (anchorStart >= 0) emit(anchorStart, anchorEnd, signals, false);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 4. extract_questions_from_chunk
// ---------------------------------------------------------------------------

interface Draft {
  no: number | null;
  type: QuestionType;
  front: string[];
  options: string[];
  answer: string;
  explanation: string;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  chapterPath: string[];
  chunkId: string;
  signals: Set<string>;
  candidateId: string | null;
  answerRef: string | null;
  extraBoundary: string[];
}

interface ExtractArgs {
  candidates?: QuestionCandidate[];
  verdicts?: LlmVerdict[];
  allBlocks?: MarkdownBlock[];
}

/** 找出与 draft 行区间重叠最多的候选。 */
function candidateFor(d: Draft, candidates: QuestionCandidate[]): QuestionCandidate | null {
  let best: QuestionCandidate | null = null;
  let bestOverlap = -1;
  for (const c of candidates) {
    const overlap = Math.min(d.endLine, c.endLine) - Math.max(d.startLine, c.startLine);
    if (overlap >= 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = c;
    }
  }
  return best;
}

interface VerdictEffect {
  keep: boolean;
  /** 模型与规则判断冲突：保留题目，但标记待人工审核 */
  disputed: boolean;
}

/** 模型裁决只允许改判断与定位，绝不注入文本。 */
function applyVerdict(
  d: Draft,
  verdict: LlmVerdict | undefined,
  allBlocks: MarkdownBlock[]
): VerdictEffect {
  if (!verdict) return { keep: true, disputed: false };

  // 规则已明确成题时，模型不能单方面否决。判据是「规则手里有没有硬证据」：
  //   · 原文里有 >=2 个选项
  //   · 原文直接给了答案 / 解析
  //   · 区块已声明这是题目清单且带题号（section_question）
  //   · 题干本身是明确疑问句，或写成「问题：xxx」字段式提问
  // 只有「以上全无」的候选（纯陈述、小节标题、修辞性问句）才允许模型判掉。
  //
  // 2026-11 实测两次事故：
  // 1) 模型把整批中文题库题判成「非题目」，一次裁决把多道题全删光；
  // 2) 同一份面试材料连跑 5 次，模型时而响应时而不响应，响应的那几次把
  //    名词短语题判掉 4 道（6→2）、把面经里的问句判掉 8 道（38→30），
  //    同一份材料的导入结果因此不可复现。
  // 现在这些题只会被标成待审核（model_disagrees），删除权留在审核台的人手上。
  const confirmed =
    d.options.length >= 2 ||
    !!d.answer ||
    !!d.explanation ||
    d.signals.has("section_question") ||
    d.signals.has("question_sentence") ||
    d.signals.has("ask_field");
  if (verdict.is_question === false) {
    return confirmed
      ? { keep: true, disputed: true }
      : { keep: false, disputed: false };
  }
  const allowed: QuestionType[] = ["choice", "qa", "cloze", "judge"];
  if (verdict.question_type && allowed.includes(verdict.question_type)) {
    d.type = verdict.question_type;
  }
  if (verdict.answer_ref) d.answerRef = String(verdict.answer_ref).slice(0, 40);

  // 模型对「这组数字/圈号条目是不是选项」给了否定结论、或自己也没把握：
  // 不改规则结果（选项文本是原文逐字截取的，不是模型生成的），但一定标待审核。
  // 这就是 spec 里 accept / review_required 两档落地到现有布尔字段的方式。
  const optionGroupDoubt =
    (verdict.is_option_group === false && (verdict.confidence ?? 0) >= 0.8) ||
    verdict.needs_human === true;

  if (
    typeof verdict.start_line === "number" &&
    typeof verdict.end_line === "number" &&
    verdict.end_line > verdict.start_line &&
    verdict.end_line - verdict.start_line < 60
  ) {
    // 跨段落题干：把裁决范围内的原文行逐字补进题干（不采纳模型生成的任何文本）
    const extra: string[] = [];
    for (const b of allBlocks) {
      if (b.endLine < verdict.start_line || b.startLine > verdict.end_line) continue;
      if (b.kind === "blank" || b.kind === "heading") continue;
      const ls = b.text.split("\n");
      for (let k = 0; k < ls.length; k++) {
        const lineNo = b.startLine + k;
        if (lineNo < verdict.start_line || lineNo > verdict.end_line) continue;
        if (lineNo >= d.startLine && lineNo <= d.endLine) continue;
        const t = stripEmphasis(ls[k]);
        if (t && !d.front.includes(t) && !d.options.some((o) => o.includes(t))) extra.push(t);
      }
    }
    if (extra.length) d.extraBoundary = extra.slice(0, 6);
  }
  return { keep: true, disputed: optionGroupDoubt };
}

/**
 * 规则逐字抽题 + 模型仲裁。题干、选项、答案、解析全部取自原文行；
 * 题号 / 问句 / 字段行是题目边界，不依赖空行，因此无空行文档也能逐题抽出。
 */
export function extractQuestionsFromChunk(
  chunk: QuestionChunk,
  args: ExtractArgs = {}
): UnifiedQuestion[] {
  const candidates = args.candidates ?? detectQuestionCandidates([chunk]);
  const allBlocks = args.allBlocks ?? chunk.blocks;
  const verdictMap = new Map<string, LlmVerdict>();
  for (const v of args.verdicts ?? []) {
    const c = candidates[v.candidateIndex];
    if (c) verdictMap.set(c.id, v);
  }

  const lines = chunkLines(chunk);
  // 区块是否已声明「这组编号条目是题目」：正文有「面试问题（N 道）：」之类的标记，
  // 或所在章节标题本身叫「题目列表 / 题库」。命中后，带题号的名词短语也能成题。
  const questionSectionHint =
    QUESTION_SECTION_HINT.test(chunk.text) ||
    chunk.chapterPath.some((p) => /(?:题目|试题|练习题|面试题|问题清单|题库)/.test(p));
  // 数字 / 圈号选项组先整体识别一遍：`1. 北京` 必须抢在 Q_START 之前判成选项，
  // 否则一道选择题会被切成 N 道问答（spec 的核心误抽形态）。
  const numberedOptions = detectNumberedOptionGroups(lines);
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let answerZone = false;

  const finish = (): void => {
    if (!cur) return;
    const d = cur;
    cur = null;
    answerZone = false;

    const frontText = stripEmphasis(
      [...d.front, ...d.extraBoundary].join("\n").trim()
    );
    if (!frontText) return;
    // 超长不丢：原来这里直接 return，等于把「题干很长」的真题静默丢弃。
    // 宁可多留一张人工能一眼否掉的卡，也不能让原文里真实存在的题消失。
    // 标记后由 extract 设为 review_required，审核台可见。
    if (frontText.length > MAX_QUESTION_CHARS) d.signals.add("too_long");

    // 区块已声明「这是题目清单」（正文「面试问题（N 道）：」或章节名叫题目列表/题库），
    // 且本行带题号 → 这一整组条目都是题目候选。
    //
    // section_question 是给仲裁层的「不可硬删」标记（见 applyVerdict）：这批题
    // 常写成名词短语、无选项无答案，恰好落在模型唯一有权否决的区间里，而它们
    // 正是本次修复要救回来的主体。标记在这里统一打上（而不是只打在「无问句」那条
    // 分支上），因为「区块声明 + 带题号」本身就是最强证据，有没有问号不改变这一点。
    const declaredQuestion = questionSectionHint && d.signals.has("question_no");
    if (declaredQuestion) d.signals.add("section_question");

    // 题型：以规则信号为准，模型裁决可覆盖（applyVerdict 已处理）
    let type: QuestionType = d.type;
    if (d.options.length >= 2) type = "choice";
    else if (CLOZE.test(frontText) || d.signals.has("cloze")) type = "cloze";
    else if (JUDGE_MARK.test(frontText) || d.signals.has("judge")) type = "judge";
    else if (
      d.signals.has("ask_field") ||
      d.signals.has("question_sentence") ||
      d.answer ||
      d.explanation
    ) type = "qa";
    // 面试题常写成名词短语（「Agent 项目背景」），没有疑问词也必须收；
    // 真伪交由审核台判，规则层不再把整批题静默丢掉。
    else if (declaredQuestion) type = "qa";
    else return; // 普通知识点陈述 / 编号列表 / 修辞性问句，不成题

    if (type === "choice" && d.options.length < 2) return;
    if (frontText.length < 4) return;

    const cand = candidateFor(d, candidates);
    d.candidateId = cand?.id ?? null;
    d.endLine = Math.max(d.endLine, d.startLine);
    drafts.push(d);
  };

  for (let k = 0; k < lines.length; k++) {
    const { line, lineNo, offset, block } = lines[k];
    const rawLine = line.trim();
    // heading 块原文带 `#`，剥掉前缀后再参与匹配，否则 `### 1. xxx` / `### Q: xxx`
    // 永远匹配不上 Q_START / ASK_FIELD（4 份文件整篇归零的根因）。
    // 只影响用于匹配的 raw；line / offset 不变，原文定位与证据截取完全不受影响。
    const raw = block.kind === "heading" ? rawLine.replace(/^#{1,6}\s*/, "") : rawLine;
    const inTable = block.kind === "table";

    // ---- 表格行不参与逐行抽题，统一由 extractTableQuestions 处理 ----
    if (inTable && TABLE_ROW.test(line)) continue;

    // ---- 答案区章节里的答案引用头（Q1: / 第3题: / 【第3题】）不产题 ----
    // 它们是「题目清单 + 参考答案区分离」材料的答案指回，正文已被
    // collectAnswerEntries 收为答案条目；若在这里误当题目，会产出一堆
    // 「答案正文当题干」的假题（组 1 事故：4 题变 7 题、答案还配不上）。
    if (isAnswerSection(chunk.chapterPath) && ANSWER_REF_HEADER.test(raw)) {
      continue;
    }

    if (!raw) {
      const next = lines[k + 1]?.line ?? "";
      const ns = lineSignals(next, lines[k + 1]?.block.kind === "table");
      if (
        cur &&
        // 正处于答案区（`参考答案：` 空头之后）时，答案正文常跨空行分段，
        // 不能因为中间的空行就收尾，否则答案正文会被截断、孤零零留在题干外。
        !answerZone &&
        !ns.some((s) => s === "option" || s === "answer" || s === "explanation")
      ) finish();
      continue;
    }

    // ---- 数字 / 圈号选项：必须先于 Q_START 判断 ----
    const grouped = numberedOptions.get(k);
    if (grouped) {
      // 无题号的题干（如「下列哪个是直辖市？」）本身不会起题，折叠选项时顺带把它立起来，
      // 否则选项没有归属，整组会被丢掉（讲义/PPT 导出的常见形态）。
      if (!cur && grouped.stemIndex >= 0) {
        const sl = lines[grouped.stemIndex];
        const stemText = stripEmphasis(sl.line.trim());
        if (stemText) {
          cur = {
            no: null,
            type: "qa",
            front: [stemText],
            options: [],
            answer: "",
            explanation: "",
            startLine: sl.lineNo,
            endLine: sl.lineNo,
            start: sl.offset,
            end: sl.offset + sl.line.length,
            chapterPath: [...chunk.chapterPath],
            chunkId: chunk.chunkId,
            signals: new Set(CHOICE_CUE.test(stemText) ? ["question_sentence"] : []),
            candidateId: null,
            answerRef: null,
            extraBoundary: [],
          };
        }
      }
      const sameGroup = cur ? cur.signals.has("numeric_option") : false;
      if (cur && !cur.answer && !cur.explanation && (cur.options.length === 0 || sameGroup)) {
        cur.options.push(`${grouped.letter}. ${grouped.text}`);
        cur.signals.add("option");
        cur.signals.add("numeric_option");
        cur.endLine = lineNo;
        cur.end = offset + line.length;
        continue;
      }
      // 上下文不成立（同一行前面已有答案等）：退回原逻辑，保持既有行为
    }

    // 答案区头：`**参考答案：**` 冒号后为空时进入答案区，后续有序列表并入答案，
    // 绝不再新起一道题（否则 10 题会膨胀成 27 题）。
    if (ANSWER_HEADER.test(raw)) {
      if (cur) {
        answerZone = true;
        cur.signals.add("answer");
        cur.endLine = lineNo;
        cur.end = offset + line.length;
      }
      continue;
    }
    // 元信息行（思考逻辑 / 考点 / 答题思路）：只延长边界，不进题干。
    if (META_LINE.test(raw)) {
      if (cur) {
        cur.endLine = lineNo;
        cur.end = offset + line.length;
      }
      continue;
    }

    const qm = raw.match(Q_START);
    const opt = raw.match(OPTION_LINE);
    const ask = raw.match(ASK_FIELD);
    const ans = raw.match(ANSWER_LINE);
    const exp = raw.match(EXPLAIN_LINE);

    if (qm) {
      // 答案区内的编号列表是答案要点，并进 explanation，绝不新起一道题。
      // 例外：标题形式的编号必定是新题，答案区到此结束。
      if (answerZone && block.kind !== "heading") {
        if (cur) {
          const t = stripEmphasis(raw);
          cur.explanation = cur.explanation ? `${cur.explanation}\n${t}` : t;
          cur.endLine = lineNo;
          cur.end = offset + line.length;
        }
        continue;
      }
      finish();
      cur = {
        no: Number(qm[1]) || null,
        type: "qa",
        front: stripEmphasis(qm[2]) ? [stripEmphasis(qm[2])] : [],
        options: [],
        answer: "",
        explanation: "",
        startLine: lineNo,
        endLine: lineNo,
        start: offset,
        end: offset + line.length,
        chapterPath: [...chunk.chapterPath],
        chunkId: chunk.chunkId,
        signals: new Set(["question_no"]),
        candidateId: null,
        answerRef: null,
        extraBoundary: [],
      };
      if (CLOZE.test(qm[2])) cur.signals.add("cloze");
      if (JUDGE_MARK.test(qm[2])) cur.signals.add("judge");
      if (ASK_CUE.test(qm[2])) cur.signals.add("question_sentence");
      continue;
    }

    if (ask) {
      finish();
      cur = {
        no: null,
        type: "qa",
        front: [stripEmphasis(ask[1])],
        options: [],
        answer: "",
        explanation: "",
        startLine: lineNo,
        endLine: lineNo,
        start: offset,
        end: offset + line.length,
        chapterPath: [...chunk.chapterPath],
        chunkId: chunk.chunkId,
        signals: new Set(["ask_field"]),
        candidateId: null,
        answerRef: null,
        extraBoundary: [],
      };
      continue;
    }

    if (opt) {
      // 小写 a) / b) 常是正文小节标题：没有题目上下文时不认作选项
      const lower = /^[a-d]/.test(opt[1]);
      if (!cur && lower) continue;
      if (!cur) {
        cur = {
          no: null,
          type: "qa",
          front: [],
          options: [],
          answer: "",
          explanation: "",
          startLine: lineNo,
          endLine: lineNo,
          start: offset,
          end: offset + line.length,
          chapterPath: [...chunk.chapterPath],
          chunkId: chunk.chunkId,
          signals: new Set<string>(),
          candidateId: null,
          answerRef: null,
          extraBoundary: [],
        };
      }
      // 一行可能塞了 A/B/C/D 四个选项；startIndex 续上已收的选项数，
      // 保证「分行排版」与「一行塞多个」混合时字母顺序仍然连续。
      const parts = parseInlineOptions(raw, cur.options.length);
      const list =
        parts.length > 0
          ? parts
          : [{ letter: halfWidthLetter(opt[1].toUpperCase()), text: stripEmphasis(opt[2]) }];

      // 同一题内选项字母必须按序递增，重复/跳号即说明混入了另一道题
      let broken = false;
      for (const p of list) {
        const letter = halfWidthLetter(p.letter);
        const expected = String.fromCharCode(65 + cur.options.length);
        if (letter !== expected) {
          finish();
          broken = true;
          break;
        }
        cur.options.push(`${letter}. ${p.text}`);
      }
      if (broken) continue;
      cur.signals.add("option");
      cur.endLine = lineNo;
      cur.end = offset + line.length;
      continue;
    }

    if (ans) {
      if (cur) {
        cur.answer = stripEmphasis(ans[1]);
        cur.signals.add("answer");
        cur.endLine = lineNo;
        cur.end = offset + line.length;
      }
      continue;
    }

    if (exp) {
      if (cur) {
        cur.explanation = stripEmphasis(exp[1]);
        cur.signals.add("explanation");
        cur.endLine = lineNo;
        cur.end = offset + line.length;
      }
      continue;
    }

    // 答案区内的普通行：`参考答案：` 空内容头之后紧跟的第一个正文段是「答案本体」，
    // 必须写进 answer 而不是 explanation —— 否则 needs_answer 永远为 true（
    // 后端 buildAnswerRequest 也拿不到答案，审核台误报「缺答案要 AI 补」）。
    // 答案写满后再来的普通行（解析/补充说明）才归 explanation。
    if (cur && answerZone) {
      const t = stripEmphasis(raw);
      if (t) {
        if (!cur.answer) {
          cur.answer = t;
          cur.signals.add("answer");
        } else {
          cur.explanation = cur.explanation ? `${cur.explanation}\n${t}` : t;
        }
        cur.endLine = lineNo;
        cur.end = offset + line.length;
      }
      continue;
    }

    // 普通行：题干续行（有选项后不再并进题干，避免把正文吞成题干）
    if (cur && cur.options.length === 0 && !cur.answer && !cur.explanation) {
      const t = stripEmphasis(raw);
      if (t) {
        cur.front.push(t);
        cur.endLine = lineNo;
        cur.end = offset + line.length;
        if (CLOZE.test(t)) cur.signals.add("cloze");
        if (JUDGE_MARK.test(t)) cur.signals.add("judge");
        if (ASK_CUE.test(t)) cur.signals.add("question_sentence");
      }
    }
  }
  finish();

  // ---- 表格题目：表头含「题目/问题/题干」时逐行成题；含「题号」时作为答案表 ----
  const tableQuestions = extractTableQuestions(chunk);

  const result: UnifiedQuestion[] = [];
  for (const d of [...drafts, ...tableQuestions]) {
    const cand = candidateFor(d, candidates);
    const verdict = cand ? verdictMap.get(cand.id) : undefined;
    const effect = applyVerdict(d, verdict, allBlocks);
    if (!effect.keep) continue;

    const frontText = stripEmphasis([...d.front, ...d.extraBoundary].join("\n").trim());
    if (!frontText) continue;
    // 超长题保留（见 finish() 注释），只打标记交给人工判断
    const tooLong = frontText.length > MAX_QUESTION_CHARS || d.signals.has("too_long");

    const options = d.options;
    let type = d.type;
    if (options.length >= 2) type = "choice";
    else if (CLOZE.test(frontText) || d.signals.has("cloze")) type = "cloze";
    else if (JUDGE_MARK.test(frontText) || d.signals.has("judge")) type = "judge";

    let answer = d.answer;
    let answerAmbiguous: string | null = null;
    if (type === "choice" && answer) {
      const resolved = resolveChoiceAnswer(answer, options);
      if (resolved.value !== answer || resolved.ambiguous) {
        answer = resolved.value;
        answerAmbiguous = resolved.ambiguous;
      } else {
        // 兜底：答案行写成「B 因为……」时取行首字母映射到选项（原有行为，别丢）
        const letter = answer.match(/^([A-Da-dＡ-Ｄ])(?:[.、．)）]|\s|$)/);
        if (letter) {
          const upper = halfWidthLetter(letter[1].toUpperCase());
          const hit = options[upper.charCodeAt(0) - 65]?.replace(/^[A-D]\.\s*/, "");
          if (hit) answer = hit;
        }
      }
    }
    if (type === "judge" && answer) {
      if (/^(√|✓|正确|对|T)$/i.test(answer)) answer = "对";
      else if (/^(×|✗|错误|错|F)$/i.test(answer)) answer = "错";
    }

    const evidenceLines = chunkLines(chunk)
      .filter((l) => l.lineNo >= d.startLine && l.lineNo <= d.endLine)
      .map((l) => l.line)
      .join("\n")
      .trim();

    result.push({
      question_text: frontText,
      question_type: type,
      options,
      answer,
      explanation: d.explanation,
      chapter_path: [...d.chapterPath],
      source_chunk_id: d.chunkId,
      source_start: d.start,
      source_end: d.end,
      source_evidence: (evidenceLines || frontText).slice(0, 1200),
      confidence: effect.disputed ? Math.min(cand?.confidence ?? 0.6, 0.5) : (cand?.confidence ?? 0.6),
      review_required:
        !answer ||
        (cand?.needsLlm ?? false) ||
        !cand ||
        effect.disputed ||
        !!answerAmbiguous ||
        tooLong,
      no: d.no,
      needs_answer: !answer,
      answer_ref: d.answerRef ?? undefined,
      sources: [`${d.chunkId}:${d.startLine}-${d.endLine}`],
      // flags 就是题目级的 audit trail：规则用了哪条信号、答案有没有歧义，都留痕
      flags: [
        ...(effect.disputed ? ["model_disagrees"] : []),
        ...(d.signals.has("numeric_option") ? ["numeric_option_group"] : []),
        ...(answerAmbiguous ? [`answer_ambiguous:${answerAmbiguous}`] : []),
        ...(tooLong ? ["too_long"] : []),
      ],
      audit_trail: {
        rule_signals: [...d.signals],
        rule_type: type,
        option_source: d.signals.has("numeric_option")
          ? "numbered"
          : options.length >= 2
            ? "letter"
            : "none",
        answer_ambiguous: answerAmbiguous,
        ai: verdict
          ? {
              is_question: verdict.is_question,
              confidence: verdict.confidence ?? null,
              is_option_group: verdict.is_option_group,
              alt_identity: verdict.alt_identity,
              reasoning: verdict.reasoning,
              needs_human: verdict.needs_human,
            }
          : null,
      },
    });
  }
  return result;
}

/** 表格里的题：题干表逐行成题，答案表只收答案（由 reconcile 关联）。 */
function extractTableQuestions(chunk: QuestionChunk): Draft[] {
  const out: Draft[] = [];
  for (const b of chunk.blocks) {
    if (b.kind !== "table") continue;
    const rows = b.text.split("\n").filter((l) => TABLE_ROW.test(l) && !TABLE_SEP.test(l)).map(cellsOf);
    if (rows.length < 2) continue;
    const header = rows[0];
    const stemIdx = header.findIndex((c) => /题目|问题|题干/.test(c));
    const ansIdx = header.findIndex((c) => /答案|正确/.test(c));
    const expIdx = header.findIndex((c) => /解析|说明/.test(c));
    const noIdx = header.findIndex((c) => /题号|序号/.test(c));
    // 答案表（| 题号 | 答案 |）不产题，交给 reconcileAnswersAndExplanations
    if (noIdx >= 0 && stemIdx < 0) continue;
    if (stemIdx < 0) continue;

    for (const r of rows.slice(1)) {
      const stem = stripEmphasis(r[stemIdx] ?? "");
      if (!stem) continue;
      const tooLongRow = stem.length > MAX_QUESTION_CHARS;
      const no = noIdx >= 0 ? Number(String(r[noIdx] ?? "").replace(/[^\d]/g, "")) || null : null;
      const d: Draft = {
        no,
        type: "qa",
        front: [stem],
        options: [],
        answer: ansIdx >= 0 ? stripEmphasis(r[ansIdx] ?? "") : "",
        explanation: expIdx >= 0 ? stripEmphasis(r[expIdx] ?? "") : "",
        startLine: b.startLine,
        endLine: b.endLine,
        start: b.start,
        end: b.end,
        chapterPath: [...b.headingPath],
        chunkId: chunk.chunkId,
        signals: new Set(["table_question", "question_sentence"]),
        candidateId: null,
        answerRef: null,
        extraBoundary: [],
      };
      if (tooLongRow) d.signals.add("too_long");
      if (CLOZE.test(stem)) d.signals.add("cloze");
      if (JUDGE_MARK.test(stem)) d.signals.add("judge");
      out.push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. reconcile_answers_and_explanations
// ---------------------------------------------------------------------------

interface AnswerEntry {
  no: number | null;
  ref: string;
  answer: string;
  explanation: string;
  chapterPath: string[];
  lineNo: number;
  /** 答案引用头冒号后的「题目文本」（如 `### Q1: RAG 如何减少幻觉？` 里的题目），
   *  用于在题号对不上时按题干语义兜底对齐。 */
  stemRef?: string;
}

/** 收集全文分散的答案区（独立答案行、答案表、分组答案），不靠相邻位置硬配。 */
function collectAnswerEntries(blocks: MarkdownBlock[]): AnswerEntry[] {
  const out: AnswerEntry[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === "code" || b.kind === "blank") continue;
    const ls = b.text.split("\n");
    for (let k = 0; k < ls.length; k++) {
      const lineNo = b.startLine + k;
      // heading 块原文带 `#`，剥掉前缀再匹配答案引用头（### Q1: → Q1:），
      // 与 extractQuestionsFromChunk 里对 heading 的处理保持一致。
      const t = (b.kind === "heading" ? ls[k].replace(/^#{1,6}\s*/, "") : ls[k]).trim();
      if (!t) continue;

      // 表格：| 题号 | 答案 | 解析 | 或 | 题号 | 1 | 2 | + | 答案 | A | B |
      if (TABLE_ROW.test(t) && !TABLE_SEP.test(t)) {
        const rows: string[][] = [];
        let j = k;
        while (j < ls.length && TABLE_ROW.test(ls[j])) {
          if (!TABLE_SEP.test(ls[j])) rows.push(cellsOf(ls[j]));
          j++;
        }
        if (rows.length >= 2) {
          const header = rows[0];
          const noIdx = header.findIndex((c) => /题号|序号/.test(c));
          const ansIdx = header.findIndex((c) => /答案|正确/.test(c));
          const expIdx = header.findIndex((c) => /解析|说明|分析/.test(c));
          if (noIdx >= 0 && ansIdx >= 0) {
            for (const r of rows.slice(1)) {
              const no = Number(String(r[noIdx] ?? "").replace(/[^\d]/g, ""));
              if (!no) continue;
              out.push({
                no,
                ref: String(no),
                answer: stripEmphasis(r[ansIdx] ?? ""),
                explanation: expIdx >= 0 ? stripEmphasis(r[expIdx] ?? "") : "",
                chapterPath: [...b.headingPath],
                lineNo,
              });
            }
          } else if (noIdx >= 0) {
            const ansRow = rows.slice(1).find((r) => /^(答案|正确答案|参考答案)/.test(r[0] ?? ""));
            if (ansRow) {
              for (let c = 0; c < header.length; c++) {
                if (c === noIdx) continue;
                const no = Number(String(header[c] ?? "").replace(/[^\d]/g, ""));
                if (!no) continue;
                out.push({
                  no,
                  ref: String(no),
                  answer: stripEmphasis(ansRow[c] ?? ""),
                  explanation: "",
                  chapterPath: [...b.headingPath],
                  lineNo,
                });
              }
            }
          }
        }
        k = j - 1;
        continue;
      }

      // 答案引用头：`### Q1: RAG 如何减少幻觉？` / `### 第3题：…` / `【第3题】…`
      // —— 面试材料最普遍的「题目清单 + 参考答案区分离」形态。
      //
      // 两种子形态（真实材料都出现，必须都覆盖）：
      //   A. 冒号后直接是答案正文（`### Q1: 专门存储向量的数据库。`）
      //   B. 冒号后是**题目文本**、答案在接下来的列表/段落（`### Q1: RAG 如何减少幻觉？` + `- LLM 回答基于…`）
      // 区分：冒号后的内容若以「？/什么/如何」等问句结尾，它是题目文本（形态 B），
      // 答案正文在后续 block；否则是答案正文（形态 A）。
      // 这里把冒号后文本先按「题目引用」存进 stemRef，答案正文统一从后继 block 取，
      // 后继 block 没有内容时才回退用冒号后文本当答案（形态 A）。
      const ansHeader = t.match(
        /^(?:\*{0,2}Q\s*(\d{1,3})\s*[:：]|\*{0,2}第\s*(\d{1,3})\s*题\s*[:：]|【\s*第\s*(\d{1,3})\s*题\s*】)/i
      );
      if (ansHeader && ansHeader[0].length >= 2) {
        const n = Number(ansHeader[1] ?? ansHeader[2] ?? ansHeader[3]);
        if (Number.isFinite(n) && n > 0) {
          const body = t.replace(ansHeader[0], "").trim();
          // 后继 block 的文本 = 答案正文（形态 B 的 `- 列表` 答案，或形态 A 的下一段）
          const nextBlock = blocks[bi + 1];
          const following =
            nextBlock && nextBlock.kind !== "heading" && nextBlock.kind !== "blank"
              ? stripEmphasis(nextBlock.text).trim()
              : "";
          // 冒号后是问句 → 是题目引用，答案看后继；否则冒号后就是答案（形态 A）
          const bodyIsStem = /[？?]$/.test(body) || ASK_CUE.test(body);
          const answer = bodyIsStem ? following : body || following;
          out.push({
            no: n,
            ref: ansHeader[1] ? `Q${ansHeader[1]}` : `第${n}题`,
            answer: answer || "",
            explanation: "",
            chapterPath: [...b.headingPath],
            lineNo,
            stemRef: body || undefined,
          });
          continue;
        }
      }

      // 「3. 答案：B」「第3题答案：B」「答案：B」「3. B。解析：…」
      const noPrefix = t.match(/^\*{0,2}(\d{1,3})\s*[.、．)）]\*{0,2}\s*(.*)$/);
      const refMatch = t.match(/第\s*(\d{1,3})\s*题/);
      const body = noPrefix ? noPrefix[2] : t;
      const am = body.match(ANSWER_LINE);
      const em = body.match(EXPLAIN_LINE);
      if (am || em) {
        const no = refMatch ? Number(refMatch[1]) : noPrefix ? Number(noPrefix[1]) : null;
        out.push({
          no,
          ref: refMatch ? `第${refMatch[1]}题` : no ? String(no) : "",
          answer: am ? stripEmphasis(am[1]) : "",
          explanation: em ? stripEmphasis(em[1]) : "",
          chapterPath: [...b.headingPath],
          lineNo,
        });
        continue;
      }

      // 解析块常见写法：「2. B。RAG 外挂知识…」——题号 + 答案字母 + 解析正文，
      // 中文题库经常把答案与解析合在一行且没有「答案：」字样。
      if (noPrefix) {
        const m = noPrefix[2].match(
          /^\*{0,2}([A-DＡ-Ｄa-d])\*{0,2}\s*(?:[（(][^）)]{0,12}[）)])?\s*[.。、]\s*(.*)$/
        );
        if (m) {
          out.push({
            no: Number(noPrefix[1]),
            ref: String(noPrefix[1]),
            answer: m[1].toUpperCase().replace(/[Ａ-Ｄ]/, (c) =>
              String.fromCharCode(c.charCodeAt(0) - 0xff21 + 65)
            ),
            explanation: stripEmphasis(m[2] ?? ""),
            chapterPath: [...b.headingPath],
            lineNo,
          });
          continue;
        }
      }

      // 填空分组答案：「**一**：xxx / yyy」
      const group = t.match(/^\*{1,2}\s*([一二三四五六七八九十]+)\s*\*{1,2}\s*[:：]\s*(.+)$/);
      if (group) {
        out.push({
          no: null,
          ref: group[1],
          answer: stripEmphasis(group[2]),
          explanation: "",
          chapterPath: [...b.headingPath],
          lineNo,
        });
      }
    }
  }
  return out;
}

/** 答案/解析关联：只认题号与明确引用，不确定就留空并标待审核。 */
export function reconcileAnswersAndExplanations(
  questions: UnifiedQuestion[],
  blocks: MarkdownBlock[]
): UnifiedQuestion[] {
  const entries = collectAnswerEntries(blocks);
  if (entries.length === 0) return questions;

  const byNo = new Map<number, AnswerEntry[]>();
  for (const e of entries) {
    if (e.no === null) continue;
    const list = byNo.get(e.no) ?? [];
    list.push(e);
    byNo.set(e.no, list);
  }

  return questions.map((q) => {
    if (q.answer && q.explanation) return q;
    const next = { ...q };

    // 1) 模型给出的答案引用优先，但必须能落到实际存在的答案条目（不猜）
    //    answer_ref 可能是「3」「第3题」「Q3」三种形态，统一抠出数字。
    const refMatch = (q.answer_ref ?? "").match(/(\d{1,3})/);
    const targetNo = refMatch ? Number(refMatch[1]) : q.no;

    // 题号直配：仅当该 no 在答案区只出现一次（无冲突）时可信；冲突时不做硬配，
    // 交给下面的「顺序对齐」兜底，避免把题配错小节。
    if (!next.answer && targetNo !== null) {
      const pool = byNo.get(targetNo) ?? [];
      const unique = pool.filter((e) => e.answer);
      if (unique.length === 1) {
        next.answer = unique[0].answer;
        if (unique[0].explanation && !next.explanation) next.explanation = unique[0].explanation;
      } else if (pool.length === 1 && pool[0].answer) {
        next.answer = pool[0].answer;
        if (pool[0].explanation && !next.explanation) next.explanation = pool[0].explanation;
      }
    }
    if (targetNo !== null && !next.explanation) {
      const pool = byNo.get(targetNo) ?? [];
      const withExp = pool.filter((e) => e.explanation);
      if (withExp.length === 1) next.explanation = withExp[0].explanation;
    }

    // 2) 无题号、无引用的题：只在题干里出现「第N题」这类明确引用时才关联
    if (!next.answer && targetNo === null) {
      const ref = next.question_text.match(/第\s*(\d{1,3})\s*题/);
      if (ref) {
        const pool = byNo.get(Number(ref[1])) ?? [];
        const hit = pool.find((e) => e.answer);
        if (hit?.answer) next.answer = hit.answer;
      }
    }

    // 3) 答案引用头带「题目文本」的条目（### Q1: RAG 如何减少幻觉？）—— 题号可能
    //    因题目区按小节重置而对不上，这里用题干与 stemRef 做语义兜底：题干归一后
    //    与某条答案的 stemRef 高度重合，即认为它是这道题的答案（而不是硬靠数字）。
    if (!next.answer) {
      const stem = normalizeForCompare(next.question_text);
      if (stem.length >= 4) {
        let best: AnswerEntry | null = null;
        let bestScore = 0;
        for (const e of entries) {
          if (!e.answer || !e.stemRef) continue;
          const ref = normalizeForCompare(e.stemRef);
          if (ref.length < 4) continue;
          // 题干与 stemRef 双向包含 / 高度重合（去空白标点后）
          const score =
            stem.includes(ref) || ref.includes(stem)
              ? Math.max(stem.length, ref.length)
              : 0;
          if (score > bestScore) {
            bestScore = score;
            best = e;
          }
        }
        if (best && bestScore >= 4) {
          next.answer = best.answer;
          if (!next.explanation && best.explanation) next.explanation = best.explanation;
        }
      }
    }

    // 答案表里常只写字母（B / A），关联后同样要映射回选项文本
    if (next.question_type === "choice" && next.answer) {
      const letter = next.answer.match(/^([A-Da-dＡ-Ｄ])(?:[.、．)）]|\s|$)/);
      if (letter) {
        const idx = letter[1].toUpperCase().charCodeAt(0) - 65;
        const hit = next.options[idx]?.replace(/^[A-D]\.\s*/, "");
        if (hit) next.answer = hit;
      }
    }

    next.needs_answer = !next.answer;
    if (next.needs_answer) {
      next.review_required = true;
      next.flags = [...next.flags, "answer_unverified"];
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// 6. deduplicate_questions
// ---------------------------------------------------------------------------

/** 规范化指纹：题干 + 选项，不含章节路径。
 *
 * 此前把 chapter_path 并进指纹，导致同一道面试题在「题目清单章」与「参考答案章」
 * 各出现一次时不会被合并 —— 一个题变成两张卡，一张有答案一张没答案，
 * 拉低「有答案占比」的同时还污染复习列表。题干与选项归一后相同就是同一道题，
 * 跨章同题应当合并，保留有答案的那份（deduplicateQuestions 已按「后者补前者」合并）。
 */
function questionFingerprint(q: UnifiedQuestion): string {
  return [
    normalizeForCompare(q.question_text).slice(0, 300),
    normalizeForCompare(q.options.join("|")).slice(0, 200),
  ].join("::");
}

export function deduplicateQuestions(questions: UnifiedQuestion[]): UnifiedQuestion[] {
  const seen = new Map<string, UnifiedQuestion>();
  for (const q of questions) {
    const key = questionFingerprint(q);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...q, sources: [...q.sources], flags: [...q.flags], options: [...q.options] });
      continue;
    }
    // 合并：保留全部来源，取更完整的字段，置信度取高，待审核取「或」
    prev.sources = [...new Set([...prev.sources, ...q.sources])];
    prev.flags = [...new Set([...prev.flags, ...q.flags])];
    prev.confidence = Math.max(prev.confidence, q.confidence);
    prev.review_required = prev.review_required || q.review_required;
    if (!prev.answer && q.answer) prev.answer = q.answer;
    if (!prev.explanation && q.explanation) prev.explanation = q.explanation;
    if (prev.question_text.length < q.question_text.length && q.question_text.startsWith(prev.question_text)) {
      prev.question_text = q.question_text;
    }
    if (prev.options.length === 0 && q.options.length) prev.options = [...q.options];
    prev.needs_answer = !prev.answer;
    prev.source_end = Math.max(prev.source_end, q.source_end);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// 7. validate_question_sources
// ---------------------------------------------------------------------------

/** 校验原文依据、位置有效性、截断与异常字段；无法确认的一律标待审核。 */
export function validateQuestionSources(
  questions: UnifiedQuestion[],
  markdownText: string
): UnifiedQuestion[] {
  const md = String(markdownText ?? "");
  const hay = normalizeForCompare(md);
  const seen = new Set<string>();

  return questions.map((q) => {
    const next = { ...q, flags: [...q.flags], options: [...q.options] };
    const probe = (s: string, len: number): boolean => {
      const n = normalizeForCompare(s).slice(0, len);
      return n.length >= 4 && hay.includes(n);
    };

    if (!probe(next.question_text, 24)) {
      next.flags.push("stem_not_in_source");
      next.review_required = true;
      next.confidence = Math.min(next.confidence, 0.35);
    }
    for (const o of next.options) {
      if (!probe(o.replace(/^[A-D]\.\s*/, ""), 16)) {
        next.flags.push("option_not_in_source");
        next.review_required = true;
      }
    }
    // 判断题答案「对/错」是系统归一化枚举，不一定字面出现在原文，
    // 跳过其「答案未见于原文」探针（与 fidelity.ts 对 judge 选项的豁免一致）。
    if (next.answer && next.question_type !== "judge" && !probe(next.answer, 12)) {
      next.flags.push("answer_not_in_source");
      next.review_required = true;
    }
    if (next.explanation && !probe(next.explanation, 16)) {
      next.flags.push("explanation_not_in_source");
      next.review_required = true;
    }
    if (
      !Number.isFinite(next.source_start) ||
      !Number.isFinite(next.source_end) ||
      next.source_start < 0 ||
      next.source_end > md.length ||
      next.source_start >= next.source_end
    ) {
      next.flags.push("invalid_source_range");
      next.review_required = true;
    }
    // 截断 / 异常
    if (next.question_type === "choice" && next.options.length < 2) {
      next.flags.push("truncated_options");
      next.review_required = true;
    }
    if (next.question_text.length > MAX_QUESTION_CHARS || /[、：,]$/.test(next.question_text)) {
      next.flags.push("possibly_truncated");
      next.review_required = true;
    }
    const fp = questionFingerprint(next);
    if (seen.has(fp)) {
      next.flags.push("duplicate");
      next.review_required = true;
    }
    seen.add(fp);
    next.flags = [...new Set(next.flags)];
    return next;
  });
}

// ---------------------------------------------------------------------------
// 8. 统一入口
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 只接受白名单字段与合法下标，模型返回的越界/畸形裁决一律丢弃。 */
function sanitizeVerdicts(verdicts: LlmVerdict[], batchSize: number): LlmVerdict[] {
  const allowed: QuestionType[] = ["choice", "qa", "cloze", "judge"];
  const out: LlmVerdict[] = [];
  for (const v of verdicts) {
    if (!v || typeof v !== "object") continue;
    if (!Number.isInteger(v.candidateIndex) || v.candidateIndex < 0 || v.candidateIndex >= batchSize) continue;
    if (typeof v.is_question !== "boolean") continue;
    const clean: LlmVerdict = {
      candidateIndex: v.candidateIndex,
      is_question: v.is_question,
    };
    if (v.question_type && allowed.includes(v.question_type)) clean.question_type = v.question_type;
    if (Number.isFinite(v.start_line) && Number.isFinite(v.end_line)) {
      clean.start_line = Math.max(0, Math.trunc(v.start_line as number));
      clean.end_line = Math.max(0, Math.trunc(v.end_line as number));
    }
    if (typeof v.answer_ref === "string") clean.answer_ref = v.answer_ref.slice(0, 40);
    if (Number.isFinite(v.confidence)) {
      clean.confidence = Math.min(1, Math.max(0, Number(v.confidence)));
    }
    out.push(clean);
  }
  return out;
}

/**
 * 统一入口：原文 → 结构 → 分块 → 候选 → 抽题 → 答案关联 → 去重 → 校验。
 * 模型失败、返回畸形、单块异常都只降级，不抛给导入流程。
 */
export async function runQuestionPipeline(
  markdownText: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const md = String(markdownText ?? "");
  const blocks = parseMarkdownStructure(md);
  const chunks = splitMarkdownWithContext(blocks);
  const candidates = detectQuestionCandidates(chunks);

  const stats: PipelineStats = {
    totalChunks: chunks.length,
    scannedChunks: chunks.filter((c) => chunkLines(c).length > 0).length,
    totalCandidates: candidates.length,
    llmCalls: 0,
    llmFailed: 0,
    rawQuestions: 0,
    finalQuestions: 0,
    degraded: false,
    degradeReason: "",
  };

  // ---- 模型仲裁：默认启用（由 question-entry 注入），失败即降级 ----
  const verdictById = new Map<string, LlmVerdict>();
  const judge = options.judge;
  if (!judge) {
    stats.degraded = true;
    stats.degradeReason = "模型仲裁器未注入，使用纯规则";
  } else {
    const maxCalls = Math.max(0, options.maxLlmCalls ?? 2);
    const batchSize = Math.max(1, options.batchSize ?? 12);
    // 边界模糊 / 跨段落的候选优先送模型；标准格式清晰的题由规则直接定稿，
    // 既不浪费 token，也不让「模型链路默认启用」拖慢每次导入。
    //
    // 只送 needsLlm 的候选 + 少量补位：这份材料实测 1731 个候选，全送要
    // 几十批、单次导入 80~130 秒，用户以为解析失败。模型在这里只做仲裁，
    // 规则已经能定稿的候选没有再问一遍的价值。
    const fuzzy = candidates.filter((c) => c.needsLlm);
    const rest = candidates.filter((c) => !c.needsLlm);
    const ordered = [...fuzzy, ...rest].slice(0, maxCalls * batchSize);
    const batches = chunkArray(ordered, batchSize);

    // 批次并发：两批串行会把 12s 超时叠成 24s+，导入体感极差。
    const settled = await Promise.allSettled(
      batches.map(async (batch) => {
        if (batch.length === 0) return null;
        stats.llmCalls++;
        const req: JudgeRequest = {
          candidates: batch.map((c, index) => ({
            index,
            chunkId: c.chunkId,
            signals: c.signals,
            excerpt: c.excerpt.slice(0, 900),
            context: c.context.slice(0, 400),
          })),
        };
        const verdicts = await judge(req);
        if (!Array.isArray(verdicts)) throw new Error("malformed");
        return { batch, verdicts };
      })
    );

    for (const r of settled) {
      if (r.status === "rejected") {
        // 单批失败只降级这一批，其余批次的结果照常生效
        stats.llmFailed++;
        stats.degraded = true;
        stats.degradeReason =
          stats.degradeReason || (r.reason instanceof Error && r.reason.message === "malformed"
            ? "模型返回格式异常"
            : "模型调用异常");
        continue;
      }
      if (!r.value) continue;
      for (const v of sanitizeVerdicts(r.value.verdicts, r.value.batch.length)) {
        verdictById.set(r.value.batch[v.candidateIndex].id, v);
      }
    }
  }

  // ---- 逐块抽取：单块失败不影响整份文档 ----
  const byChunk = new Map<string, QuestionCandidate[]>();
  for (const c of candidates) {
    const list = byChunk.get(c.chunkId) ?? [];
    list.push(c);
    byChunk.set(c.chunkId, list);
  }

  let questions: UnifiedQuestion[] = [];
  for (const chunk of chunks) {
    try {
      const list = byChunk.get(chunk.chunkId) ?? [];
      // verdict 的 candidateIndex 是「单次请求内的下标」，这里重映射到本 chunk 的候选下标
      const remapped: LlmVerdict[] = [];
      for (let ci = 0; ci < list.length; ci++) {
        const v = verdictById.get(list[ci].id);
        if (v) remapped.push({ ...v, candidateIndex: ci });
      }
      questions.push(
        ...extractQuestionsFromChunk(chunk, {
          candidates: list,
          verdicts: remapped,
          allBlocks: blocks,
        })
      );
    } catch {
      // 单块异常：跳过该块，继续处理其余内容
    }
  }
  stats.rawQuestions = questions.length;

  questions = reconcileAnswersAndExplanations(questions, blocks);
  // 「答案：摘要句」后面常紧跟一段完整答案（同一段落里还有第二个并列答案）。
  // 主状态机会丢掉这段，这里按原文做确定性回填，并把每次修正留痕给审计。
  const expanded = expandAnswersFromContext(questions, md);
  questions = expanded.questions;
  questions = deduplicateQuestions(questions);
  questions = validateQuestionSources(questions, md);
  stats.finalQuestions = questions.length;

  return { questions, chunks, blocks, stats, expansions: expanded.expansions };
}
