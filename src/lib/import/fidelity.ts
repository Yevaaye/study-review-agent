// 抽取保真校验 —— 「这道题的内容是否逐字来自原文」。
//
// 为什么需要：抽题链路为了识别结构，会做几件「看似无害」的动作：
//   · stripEmphasis 去掉 ** / __ / 反引号（渲染符，不算改写内容）
//   · 多行题干 join("\n") 后 trim（行间空行被合并）
//   · 选项补 "A. " 前缀、答案按原文映射成选项文本
//   · 表格题从单元格切片
// 这些都会让「卡上的文字」与「原文的字面」不再严格相等。绝大多数情况是等价的，
// 但一旦某处真的改写了措辞、吞了半句、拼进了下一段，人工在审核台是看不出来的 ——
// 因为卡片上只有结果，没有原文对照。
//
// 所以这里做一次反向核对：把卡片内容归一化后回原文里找。找不到的就是可疑，
// 分级为 exact / partial / missing，落到卡片上给审核台显示。
//
// 设计原则（与项目其它模块一致）：
//   · 只读判断，不修改任何内容 —— 校验失败也不自动「修好」，由人来判
//   · 归一化只抹掉排版差异（空白 / 强调符 / 全半角），绝不抹掉措辞
//   · 宁可判 partial 也不判 missing：误报会让用户对所有标记失去信任

export type FidelityStatus = "exact" | "partial" | "missing";

export interface FieldFidelity {
  /** 是否整段逐字命中原文 */
  exact: boolean;
  /** 命中字符占比 0~1（1 = 整段在原文里连续出现） */
  coverage: number;
}

export interface FidelityReport {
  status: FidelityStatus;
  front: FieldFidelity;
  options: FieldFidelity;
  answer: FieldFidelity;
  /** 人可读说明（只在非 exact 且非空时给），例如「题干 42% 的字符在原文找不到」 */
  note: string;
}

/** 归一化：只抹排版差异，不动措辞。 */
export function normForFidelity(s: string): string {
  return String(s ?? "")
    // Markdown 强调 / 代码符
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    // 跨行加粗常留下孤立星号（`**1 双产品面\n如何分工**` 只成对匹配到一半），
    // 星号永远不会是正文内容，直接抹掉
    .replace(/\*+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    // 全角 ASCII → 半角（字母/数字/常用标点）
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    // 中文标点统一（仅是字形差异，不涉及措辞）
    .replace(/[，、]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[？]/g, "?")
    .replace(/[！]/g, "!")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[「」『』""'']/g, "")
    .replace(/[。．]/g, ".")
    // 空白一律去掉：原文换行、缩进、空格都不该影响比对
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 去掉选项的字母前缀（`A. ` / `(A) ` / `A、`），只用于比对，不改数据。 */
function stripOptionLabel(s: string): string {
  return s.replace(/^\s*[（(]?[A-Za-zＡ-Ｚ][)）.、．:：]\s*/, "");
}

/**
 * 去掉题干末尾的「题型标记」再比对。
 *
 * 易错表转判断题时，系统会把错误表述拼成 `物价合理下降（对/错）` ——
 * 「（对/错）」是题型提示，不是题干内容，原文里自然没有。
 * 不剥掉它就整批误判成 missing，反而掩盖真正被改写的题。
 */
function stripTypeMark(s: string): string {
  return s.replace(/[（(]\s*(对\s*\/\s*错|√\s*\/\s*×|正确\s*\/\s*错误|判断)\s*[)）]\s*$/i, "").trim();
}

/** 一句里的分段：按句末/分号/换行切，用来做「部分命中」评估。 */
function segments(s: string): string[] {
  return s
    .split(/[.?!;\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * needle 在 haystack 里的命中程度。
 *
 * 先用整段直接查找（最常见：完全逐字），失败后退到分句级、再退到定长切片级。
 * 之所以要退，是因为「多行题干」在原文里可能被别的行隔开（例如中间插了选项行），
 * 整段拼起来自然查不到，但每一句都能查到 —— 这属于排版，不算改写。
 */
function coverageOf(needleRaw: string, haystack: string): number {
  const needle = normForFidelity(needleRaw);
  if (!needle) return 1; // 空内容不构成问题
  if (haystack.includes(needle)) return 1;

  // 分句级：命中的句子按其归一化长度累计
  const segs = segments(needle);
  if (segs.length > 1) {
    let hit = 0;
    let total = 0;
    for (const seg of segs) {
      total += seg.length;
      if (seg.length >= 4 && haystack.includes(seg)) hit += seg.length;
    }
    if (total > 0) {
      const ratio = hit / total;
      if (ratio >= 0.999) return 1;
      // 分句全命中但整段查不到 → 必然是被别的内容隔开，属于排版差异
      if (hit === 0) return slidingCoverage(needle, haystack);
      return Math.max(ratio, slidingCoverage(needle, haystack));
    }
  }
  return slidingCoverage(needle, haystack);
}

/**
 * 定长切片兜底：每 10 字一片，统计能在原文找到的片数占比。
 * 这是「改写程度」的粗略度量 —— 逐字搬运应该接近 1，整段重写会明显偏低。
 */
function slidingCoverage(needle: string, haystack: string): number {
  const WIN = 10;
  if (needle.length <= WIN) return haystack.includes(needle) ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + WIN <= needle.length; i += WIN) {
    total++;
    if (haystack.includes(needle.slice(i, i + WIN))) hit++;
  }
  // 末尾不足一片的残段也算一次，避免短题干被放大误差
  const rest = needle.length % WIN;
  if (rest > 3) {
    total++;
    if (haystack.includes(needle.slice(needle.length - rest))) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

function grade(coverage: number): FieldFidelity {
  return { exact: coverage >= 0.999, coverage: Math.round(coverage * 1000) / 1000 };
}

/**
 * 阈值：≥0.99 视为逐字命中；≥0.6 视为「部分命中」（排版差异 / 少量拼接）；
 * 低于 0.6 视为「原文找不到」（疑似改写或凭空生成）。
 *
 * 0.6 偏松是有意的：标记的目的是「请人核对一眼」，不是自动定罪。
 */
const EXACT = 0.99;
const PARTIAL = 0.6;

function statusOf(covs: number[]): FidelityStatus {
  const min = Math.min(...covs);
  if (min >= EXACT) return "exact";
  if (min >= PARTIAL) return "partial";
  return "missing";
}

export interface FidelityInput {
  question_text: string;
  options?: string[] | null;
  answer?: string | null;
}

/**
 * 核对一道题是否忠实于原文。
 *
 * @param q        抽取结果（题干 / 选项 / 答案）
 * @param source   原文全文（归一化前后的都可以，这里会自己归一化）
 */
export function checkFidelity(q: FidelityInput, source: string): FidelityReport {
  const hay = normForFidelity(source);
  const front = grade(coverageOf(stripTypeMark(q.question_text), hay));

  // 选项：逐个比对后取最差的一项（有一个选项是编的，整道题就不可信）
  //
  // 例外：判断题的「对/错」是系统补的枚举值，原文里通常只有「（　）」或「√」，
  // 拿去比对必然 0% 命中 —— 那不是改写，是题型归一。这类选项直接跳过。
  const opts = (q.options ?? []).filter((o) => !!o && !!o.trim());
  const isJudgeOptions =
    opts.length === 2 && opts.every((o) => /^(对|错|正确|错误|√|×|✓|✗|T|F)$/i.test(o.trim()));
  let options: FieldFidelity = { exact: true, coverage: 1 };
  if (opts.length > 0 && !isJudgeOptions) {
    const covs = opts.map((o) => coverageOf(stripOptionLabel(o), hay));
    options = grade(Math.min(...covs));
  }

  // 答案：只有「答案本身就是原文片段」（问答/填空/解析）时才校验；
  // 选择题的答案是选项文本，已经在 options 里校验过，这里跳过避免重复计分。
  let answer: FieldFidelity = { exact: true, coverage: 1 };
  const ans = (q.answer ?? "").trim();
  if (ans) {
    const isOptionEcho = opts.some(
      (o) => normForFidelity(stripOptionLabel(o)) === normForFidelity(ans)
    );
    const isJudge = /^(对|错)$/.test(ans);
    const isLetter = /^[A-Za-z]$/.test(ans);
    if (!isOptionEcho && !isJudge && !isLetter) {
      answer = grade(coverageOf(ans, hay));
    }
  }

  /*
   * 定级只看「题干 + 选项」：
   *   这两者是「题目本身」，必须逐字来自原文，改写就是改题。
   *
   * 答案不参与定级 —— 问答卡的答案本来就可能是一句归纳（原文分散在几段），
   * 字面对不上不代表被改写。但如果答案明显不在原文（<60%），
   * 把整体降到 partial 并在 note 里说明，让人扫一眼。选择/判断的答案
   * 已经在 options 里校验过，这里不会重复计分。
   */
  let status = statusOf([front.coverage, options.coverage]);
  if (status === "exact" && answer.coverage < PARTIAL) status = "partial";

  let note = "";
  if (status !== "exact") {
    const bad: string[] = [];
    if (!front.exact) bad.push(`题干 ${Math.round(front.coverage * 100)}%`);
    if (!options.exact) bad.push(`选项 ${Math.round(options.coverage * 100)}%`);
    if (!answer.exact) bad.push(`答案 ${Math.round(answer.coverage * 100)}%`);
    note = `${bad.join(" / ")} 可在原文逐字比对`;
    if (front.coverage < PARTIAL || options.coverage < PARTIAL) {
      note += "（疑似改写，请核对原文）";
    }
  }

  return { status, front, options, answer, note };
}
