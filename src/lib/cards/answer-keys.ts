/**
 * 选择题「正确答案」的解析与判定 —— 单选 / 多选共用一套。
 *
 * 为什么要单独成文件：原文里正确答案的写法五花八门，而判定必须在三个地方
 * 用同一把尺子（复习页判题、复习页高亮正确项、审核台高亮正确项），
 * 任何一处各写一套，就会出现「高亮了 A 却判你答错」「多选只认第一个字母」。
 *
 * 支持的写法（全部来自真实题库样本）：
 *   A / （A） / A.            单选字母
 *   A、C / AC / A C / A和C    多选字母（含连写、全角顿号、和字连接）
 *   ① / ③⑤                   圈号
 *   12                        两位数字：既能当第 12 项，也能当 A+B —— 按选项数裁定
 *   选项全文 / 选项全文；选项全文
 *
 * 解析原则：只认「能唯一确定」的映射；对不上的部分记进 unresolved，
 * 绝不猜一个下标出来 —— 猜错比不显示更糟（会把错误答案当成标准答案）。
 */

/**
 * 去掉 `A.` / `A、` / `A)` / `（A）` 这类序号前缀（去掉后才好按内容比）。
 * 放在这里而不是 option-match：normalizeOptionText 依赖它，两边各写一份必然漂移。
 */
function stripIndex(s: string): string {
  const t = s.trim();
  const bracketed = t.replace(/^[（(]\s*[A-Ha-h]\s*[)）]\s*[.、．]?\s*/, "");
  if (bracketed !== t) return bracketed.trim();
  const dotted = t.replace(/^[A-Ha-h]\s*[.、．]\s*/, "");
  return (dotted !== t ? dotted : t).trim();
}

/** 去掉 Markdown 强调符、行内代码符、列表符和首尾标点，用于内容比对 */
export function normalizeOptionText(input: string): string {
  return stripIndex(String(input ?? ""))
    .replace(/[*_`~]/g, "")
    .replace(/^[-•·]\s+/, "")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[。．.，,；;：:！!？?、]+$/g, "")
    .trim()
    .toLowerCase();
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";

/** 全角 Ａ-Ｈ → 半角，全角括号/顿号 → 半角（只用于解析，不改显示） */
function halfWidth(s: string): string {
  return s
    .replace(/[Ａ-Ｈａ-ｈ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[、，]/g, "、")
    .replace(/／/g, "/")
    .replace(/；/g, "；");
}

export interface ParsedAnswerKeys {
  /** 正确选项下标（升序、去重）；解析不出来时为空数组 */
  keys: number[];
  /** 是否多选（≥2 个正确项） */
  multi: boolean;
  /** 答案里对不上任何选项的片段，用于界面提示「答案无法定位」 */
  unresolved: string[];
  /** 答案解析形态，便于测试与诊断 */
  form: "letter" | "circled" | "digit" | "text" | "none";
}

const EMPTY: ParsedAnswerKeys = { keys: [], multi: false, unresolved: [], form: "none" };

/** 字母/圈号/数字序列的通用分隔符 */
const SEQ_SEP = /[\s、,，/／;；|&+和与及]/;

function dedupeSorted(list: number[]): number[] {
  return [...new Set(list)].sort((a, b) => a - b);
}

function validIndex(i: number, n: number): boolean {
  return i >= 0 && i < n;
}

/**
 * 解析答案 → 正确选项下标。
 * @param answer 卡片 / 原文里的答案文本
 * @param options 选项文本（可带 `A.` 前缀）
 */
export function parseAnswerKeys(
  answer: string | null | undefined,
  options: string[] | null | undefined
): ParsedAnswerKeys {
  const opts = Array.isArray(options) ? options : [];
  const n = opts.length;
  if (n === 0) return EMPTY;

  const raw = String(answer ?? "").replace(/[*_`~]/g, "").trim();
  if (!raw) return EMPTY;
  const text = halfWidth(raw);

  // ---- 1) 纯字母（含多选连写 A、C / AC / A C / A和C）----
  // 形态判定要严：只有「单字母」或「带分隔符的字母列表」或「全大写连写」才算字母答案。
  // 否则英文答案 `bad`（字母全在 A-H 区间）会被拆成 B+A+D 三个正确项。
  const noBrackets = text.replace(/[()（）]/g, "").trim();
  const singleLetter = /^[A-Ha-h]$/.test(noBrackets);
  const spacedLetters = /^(?:[A-H][\s、,，/／;；|&+和与及]*)+$/.test(noBrackets.toUpperCase());
  const pureUpper = spacedLetters && !/[a-h]/.test(noBrackets) && /[A-H]/.test(noBrackets);
  const separated = spacedLetters && SEQ_SEP.test(noBrackets);
  if (singleLetter || pureUpper || separated) {
    const letters = noBrackets.match(/[A-Ha-h]/g) ?? [];
    const keys = dedupeSorted(
      letters
        .map((c) => c.toUpperCase().charCodeAt(0) - 65)
        .filter((i) => validIndex(i, n))
    );
    if (keys.length > 0) {
      return { keys, multi: keys.length > 1, unresolved: [], form: "letter" };
    }
  }

  // ---- 2) 圈号（可多选连写 ③⑤）----
  const circledChars = [...text].filter((c) => CIRCLED.includes(c));
  if (circledChars.length > 0 && /^[\s①②③④⑤⑥⑦⑧⑨⑩、,，/／;；|+和与及]+$/.test(text)) {
    const keys = dedupeSorted(
      circledChars.map((c) => CIRCLED.indexOf(c)).filter((i) => validIndex(i, n))
    );
    if (keys.length > 0) {
      return { keys, multi: keys.length > 1, unresolved: [], form: "circled" };
    }
  }

  // ---- 3) 纯数字：2 → 第 2 项；12 → 先当第 12 项，越界则按连写多选拆位 ----
  const num = text.match(/^(?:第\s*)?(\d{1,3})\s*(?:项|个|条|选项)?$/);
  if (num) {
    const d = Number(num[1]);
    if (validIndex(d - 1, n)) {
      return { keys: [d - 1], multi: false, unresolved: [], form: "digit" };
    }
    const digits = [...num[1]].map(Number);
    if (digits.length >= 2 && digits.every((x) => validIndex(x - 1, n))) {
      const keys = dedupeSorted(digits.map((x) => x - 1));
      return { keys, multi: keys.length > 1, unresolved: [], form: "digit" };
    }
    return { keys: [], multi: false, unresolved: [raw], form: "digit" };
  }

  // ---- 4) 文本：整串等于某一项，或按分隔符拆开后逐段等于某一项 ----
  const whole = normalizeOptionText(text);
  const exact = opts.findIndex((o) => normalizeOptionText(o) === whole);
  if (exact >= 0) return { keys: [exact], multi: false, unresolved: [], form: "text" };

  const parts = text
    .split(/[、,，;；/／|]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const keys: number[] = [];
    const bad: string[] = [];
    for (const p of parts) {
      const np = normalizeOptionText(p);
      const idx = opts.findIndex((o) => {
        const no = normalizeOptionText(o);
        return no === np || (np.length >= 4 && no.includes(np));
      });
      if (idx >= 0) keys.push(idx);
      else bad.push(p);
    }
    if (keys.length > 0 && bad.length === 0) {
      const uniq = dedupeSorted(keys);
      return { keys: uniq, multi: uniq.length > 1, unresolved: [], form: "text" };
    }
    return { keys: dedupeSorted(keys), multi: keys.length > 1, unresolved: bad, form: "text" };
  }

  // ---- 5) 兜底：答案与某一项互为包含（长选项才敢做包含判断）----
  // 双向都要试：答案常常只是选项里的一截（「越快越该用 RAG」），
  // 也可能答案抄全了而选项被截断。短答案（「蓝」）不做反查，否则会命中一堆项。
  const contain = opts.findIndex((o) => {
    const no = normalizeOptionText(o);
    if (no.length < 4) return false;
    if (whole.includes(no)) return true;
    return whole.length >= 4 && no.includes(whole);
  });
  if (contain >= 0) {
    return { keys: [contain], multi: false, unresolved: [], form: "text" };
  }

  return { keys: [], multi: false, unresolved: [raw], form: "text" };
}

/** 下标 → 选项字母（A/B/C…） */
export function keyLetter(index: number): string {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : "?";
}

/** 下标数组 → "A、C" */
export function answerLabels(keys: number[]): string {
  return dedupeSorted(keys).map(keyLetter).join("、");
}

/**
 * 多选判定：**集合相等**才算对。
 * 少选一个、多选一个都算错 —— 这是多选题的定义，不能因为「选中的都包含在答案里」就放过。
 */
export function judgeSelection(picked: number[], keys: number[]): boolean {
  const a = dedupeSorted(picked);
  const b = dedupeSorted(keys);
  if (b.length === 0 || a.length === 0) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** 由下标数组反查选项文本；下标非法时返回 null */
export function optionTextsAt(options: string[], keys: number[]): string[] {
  return dedupeSorted(keys)
    .map((i) => options[i])
    .filter((v): v is string => typeof v === "string");
}

/**
 * 从卡片字段还原「正确选项下标」。
 *
 * 优先用 answers（多选存的是全文，最可靠）；没有再解析 answer。
 * 复习页、审核台、章节页都用它，保证「判题」和「高亮正确答案」永远一致。
 */
export function correctKeysOf(card: {
  options?: string[] | null;
  answer?: string | null;
  answers?: string[] | null;
}): number[] {
  const opts = Array.isArray(card.options) ? card.options : [];
  if (opts.length === 0) return [];

  if (Array.isArray(card.answers) && card.answers.length > 1) {
    const keys = card.answers
      .map((t) => opts.findIndex((o) => normalizeOptionText(o) === normalizeOptionText(t)))
      .filter((i) => i >= 0);
    if (keys.length > 1) return dedupeSorted(keys);
  }
  return parseAnswerKeys(card.answer, opts).keys;
}

/**
 * 把「勾选的正确项」序列化成可直接落库的两个字段：
 *   answer  多选存字母 "A、C"（人能读、也能被 parseAnswerKeys 再解析回来）
 *           单选存选项全文（沿用旧数据形态，界面提示「正确答案是 …」更自然）
 *   answers 正确选项全文数组（多选才有值）
 */
export function buildAnswerFields(
  options: string[],
  keys: number[]
): { answer: string | null; answers: string[] | null; is_multi: boolean } {
  const uniq = dedupeSorted(keys).filter((i) => i >= 0 && i < options.length);
  if (uniq.length === 0) return { answer: null, answers: null, is_multi: false };
  if (uniq.length === 1) {
    return { answer: options[uniq[0]], answers: null, is_multi: false };
  }
  return {
    answer: answerLabels(uniq),
    answers: optionTextsAt(options, uniq),
    is_multi: true,
  };
}
