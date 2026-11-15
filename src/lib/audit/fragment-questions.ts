/**
 * 「原文查依据」的题目识别核对（纯函数，零 IO）。
 *
 * 现场：用户从复习页点「去原文查依据」，看到的是一整段原文 + 若干「N 张卡」标签。
 * 但他真正想知道的是：**这段里的题，是不是都被识别出来了**。
 * 没有这个核对视图，遗漏只能靠「感觉题数不对」，误抽只能等到复习时才撞见。
 *
 * 这里做四件事（都可单测）：
 *   1) splitKnowledgeBlocks —— 把一段原文按知识点/小标题切成可核对的块；
 *   2) scanCandidates      —— 规则扫描「像题目」的段落（零 token，先给全量候选）；
 *   3) matchIdentified     —— 候选与已有卡片对齐，标出「已识别 / 遗漏」；
 *   4) applyVerdicts       —— 把 AI 的判定合并进来（确认是题 / 不是题 / 待人工）。
 *
 * 规则只负责「发现」，定性交给 AI 或人 —— 与导入管线保持一致的分工，
 * 这样核对视图和导入结果不会出现「两套判断标准」。
 */

export interface KnowledgeBlock {
  index: number;
  /** 块标题（小标题或首句摘要） */
  heading: string;
  /** 块正文（已去掉标题行） */
  text: string;
  /** 在片段内的字符偏移 */
  start: number;
  end: number;
}

export type CandidateStatus = "identified" | "missing" | "rejected" | "pending";

export interface QuestionCandidateRow {
  id: string;
  /** 该候选所属知识点块（splitKnowledgeBlocks 的 index） */
  block: number;
  excerpt: string;
  start: number;
  end: number;
  /** 命中的规则信号：ask / question_no / options / answer / judge */
  signals: string[];
  /** 规则猜的题型；AI 可以改 */
  kind: "choice" | "qa" | "judge";
  options: string[];
  answer: string;
  /** 对齐到的已有卡片 */
  card_id: string | null;
  status: CandidateStatus;
  /** AI / 人的判定理由 */
  verdict: string;
  confidence: number;
}

export interface Coverage {
  total: number;
  identified: number;
  missing: number;
  rejected: number;
  pending: number;
  /** 已识别占比（0~1），用于显示进度 */
  ratio: number;
}

const norm = (s: string): string =>
  String(s ?? "")
    .replace(/[*`_~#>]/g, "")
    .replace(/[\s，。、；：！？""''（）()【】\[\]{}.,;:!?—\-_/\\]/g, "")
    .toLowerCase();

/** 标题行：Markdown 标题 / 中文编号小节 / 加粗引导句 */
function headingOf(line: string): { level: number; text: string } | null {
  const t = line.trim();
  if (!t) return null;
  const md = t.match(/^(#{1,6})\s+(.*)$/);
  if (md) return { level: md[1].length, text: md[2].replace(/[*_`]/g, "").trim() };
  const bold = t.match(/^\*\*([^*]{2,40})\*\*[:：]?\s*$/);
  if (bold) return { level: 4, text: bold[1].trim() };
  const num = t.match(/^(\d+(?:\.\d+)+)[.、．]?\s+(\S.{0,38})$/);
  if (num) return { level: 3, text: `${num[1]} ${num[2]}`.trim() };
  return null;
}

/**
 * 按知识点切块。
 *
 * 优先用标题（`## 3.2 权限模型`、`**核心结论**`）——那是作者自己划的知识点边界；
 * 完全没有标题的长段落才退化成「按空行 + 目标长度」切，并用首句当块名。
 * 不会为了切块改写任何原文：每块的 text 都是原文的连续切片。
 */
export function splitKnowledgeBlocks(text: string, maxLen = 900): KnowledgeBlock[] {
  const src = String(text ?? "");
  if (!src.trim()) return [];

  const lines = src.split("\n");
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }

  const blocks: KnowledgeBlock[] = [];
  let curHeading = "本段";
  let curStart = 0;
  let buf: string[] = [];

  const flush = (endOffset: number) => {
    const body = buf.join("\n").trim();
    if (!body) return;
    blocks.push({
      index: blocks.length,
      heading: curHeading,
      text: body,
      start: curStart,
      end: endOffset,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (h && h.level <= 4) {
      // 换块：先把上一块收掉，再以这一行作为新块的起点（标题不进正文）
      flush(offsets[i]);
      curHeading = h.text || "本段";
      curStart = offsets[i] + lines[i].length + 1;
      buf = [];
      continue;
    }
    buf.push(lines[i]);
  }
  flush(src.length);

  // 没有标题的长块再按空行切：单块超过 maxLen 就会让「段落级」的候选扫描失真
  const out: KnowledgeBlock[] = [];
  for (const b of blocks) {
    if (b.text.length <= maxLen) {
      out.push({ ...b, index: out.length });
      continue;
    }
    const paras = b.text.split(/\n{2,}/);
    let chunk: string[] = [];
    let len = 0;
    let cursor = b.start;
    const push = () => {
      const t = chunk.join("\n\n").trim();
      if (!t) return;
      const firstLine = t.split("\n").find((l) => l.trim()) ?? t;
      const heading =
        b.heading && b.heading !== "本段" ? b.heading : firstLine.slice(0, 24).replace(/[。；;]$/, "");
      out.push({ index: out.length, heading, text: t, start: cursor, end: cursor + t.length });
    };
    for (const p of paras) {
      if (len + p.length > maxLen && chunk.length > 0) {
        push();
        cursor += chunk.join("\n\n").length + 2;
        chunk = [];
        len = 0;
      }
      chunk.push(p);
      len += p.length + 2;
    }
    push();
  }
  return out;
}

const ASK_CUE =
  /(?:[？?]|什么|如何|怎么|怎样|为什么|哪些|是否|是什么|有哪些|请(?:简述|说明|分析|列举|比较|介绍)|区别|关系|应该怎么)/;
const QUESTION_FIELD = /^\s*\*{0,2}(?:问题|题目|问|Q)\s*\d{0,3}\s*[:：]\s*(.+)$/i;
const OPTION_LINE = /^\s*\*{0,2}([A-DＡ-Ｄa-d])\s*[.、．)）]\*{0,2}\s*(.+)$/;
const ANSWER_LINE = /^\s*\*{0,2}(?:答案|答|参考答案|正确答案)\s*[:：]\s*(.+)$/i;
const JUDGE_MARK = /[（(]\s*(对|错|√|×|✓|✗)\s*[)）]\s*$/;

/** 一段文本里的题干候选：返回按空行切出的段落级候选 */
function paragraphCandidates(block: KnowledgeBlock): QuestionCandidateRow[] {
  const paras = block.text.split(/\n{2,}/);
  const rows: QuestionCandidateRow[] = [];
  let cursor = block.start;

  for (const para of paras) {
    const text = para.trim();
    const start = cursor;
    cursor += para.length + 2;
    if (text.length < 6) continue;

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const options: string[] = [];
    let answer = "";
    let questionField = "";
    const signals: string[] = [];

    for (const line of lines) {
      const f = line.match(QUESTION_FIELD);
      if (f && !questionField) {
        questionField = f[1].trim();
        signals.push("question_field");
        continue;
      }
      const o = line.match(OPTION_LINE);
      if (o) options.push(line.replace(/^\*{0,2}/, "").replace(/\*{0,2}$/, ""));
      const a = line.match(ANSWER_LINE);
      if (a && !answer) {
        answer = a[1].trim();
        signals.push("answer");
      }
    }
    if (options.length >= 2) signals.push("options");
    if (/^\s*\d{1,3}[、．)）]\s+/.test(lines[0] ?? "")) signals.push("question_no");
    if (JUDGE_MARK.test(text)) signals.push("judge");

    const stem = questionField || lines[0] || "";
    const asked = ASK_CUE.test(stem) || ASK_CUE.test(text.slice(0, 120));
    if (asked) signals.push("ask");
    if (!asked && options.length < 2 && !questionField) continue;

    const kind: QuestionCandidateRow["kind"] =
      options.length >= 2 ? "choice" : signals.includes("judge") ? "judge" : "qa";

    // 置信度只用于排序与「先看哪些」，不用于自动入库：
    // 有明确字段/选项组的是强信号，光有问号的弱一些。
    const confidence =
      (questionField ? 0.5 : 0) + (options.length >= 2 ? 0.35 : 0) + (asked ? 0.2 : 0) + 0.05;

    rows.push({
      id: `c${rows.length}`,
      block: block.index,
      excerpt: text.slice(0, 600),
      start,
      end: start + text.length,
      signals,
      kind,
      options,
      answer,
      card_id: null,
      status: "pending",
      verdict: "",
      confidence: Math.min(1, Number(confidence.toFixed(2))),
    });
  }
  return rows;
}

/** 扫描整段原文的题目候选（按知识点块归属，便于界面分组渲染） */
export function scanCandidates(
  blocks: KnowledgeBlock[]
): QuestionCandidateRow[] {
  const out: QuestionCandidateRow[] = [];
  for (const b of blocks) {
    for (const row of paragraphCandidates(b)) {
      out.push({ ...row, id: `b${b.index}-${row.id}` });
    }
  }
  return out;
}

/** 单块扫描（「再次识别这个知识点」用的就是它） */
export function scanBlock(block: KnowledgeBlock): QuestionCandidateRow[] {
  return paragraphCandidates(block);
}

/**
 * 候选 ↔ 已有卡片对齐。
 *
 * 判据用归一化前缀包含：卡片题干本来就从这段原文抽出来的（可能有 `**`、
 * 全角半角、答案拼接的差异），所以「互相包含归一后的前 16 字」即可认定同一题。
 * 反过来，若用严格相等，一句排版差异就会把「已识别的题」误报成「遗漏」。
 */
export function matchIdentified(
  rows: QuestionCandidateRow[],
  cards: Array<{ id: string; front: string }>
): QuestionCandidateRow[] {
  const normCards = cards.map((c) => ({ id: c.id, key: norm(c.front).slice(0, 24) }));

  return rows.map((r) => {
    if (r.status === "rejected") return r;
    const key = norm(r.excerpt);
    const stemKey = norm(r.excerpt.split("\n")[0] ?? "").slice(0, 24);
    const hit = normCards.find((c) => {
      if (c.key.length < 6) return false;
      return key.includes(c.key) || (stemKey.length >= 6 && c.key.startsWith(stemKey.slice(0, 16)));
    });
    return hit
      ? { ...r, card_id: hit.id, status: "identified" as CandidateStatus }
      : { ...r, card_id: null, status: r.status === "identified" ? "missing" : r.status };
  });
}

/**
 * 合并 AI（或人）的判定。
 *
 * 规则：AI 说「不是题」→ rejected（不再催用户补录，避免把正文当题目补进来）；
 * AI 说「是题」且没对应卡片 → missing（这才是真正要补的遗漏）；
 * AI 没把握 / 调用失败 → 保持 pending，交给人工入口。
 */
export function applyVerdicts(
  rows: QuestionCandidateRow[],
  verdicts: Array<{
    id: string;
    is_question: boolean | null;
    kind?: string | null;
    reason?: string | null;
    confidence?: number | null;
  }>
): QuestionCandidateRow[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return rows.map((r) => {
    const v = byId.get(r.id);
    if (!v) return r;
    if (r.card_id) {
      return { ...r, status: "identified", verdict: v.reason ?? r.verdict };
    }
    if (v.is_question === false) {
      return { ...r, status: "rejected", verdict: v.reason ?? "判定为正文/清单，不是题目" };
    }
    if (v.is_question === true) {
      const kind =
        v.kind === "choice" || v.kind === "qa" || v.kind === "judge" ? v.kind : r.kind;
      return {
        ...r,
        status: "missing",
        kind,
        verdict: v.reason ?? "判定是题目，但还没有对应卡片",
        confidence: typeof v.confidence === "number" ? v.confidence : r.confidence,
      };
    }
    return { ...r, verdict: v.reason ?? "AI 未能判定，建议人工确认" };
  });
}

export function coverage(rows: QuestionCandidateRow[]): Coverage {
  const total = rows.length;
  const identified = rows.filter((r) => r.status === "identified").length;
  const missing = rows.filter((r) => r.status === "missing").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  return {
    total,
    identified,
    missing,
    rejected,
    pending,
    ratio: total === 0 ? 1 : Number((identified / total).toFixed(2)),
  };
}

/**
 * 人工录入 / AI 确认后落库前的内容规整。
 *
 * 为什么不在界面层直接拼：题干必须逐字来自原文（可含换行），
 * 选项必须至少两项且按 A/B/C 顺序，答案允许为空（空 = 待补答案）。
 * 任何一条不满足就不建卡 —— 建一张坏卡比不建更贵（要人工去删）。
 */
export interface ManualCardInput {
  front: string;
  options: string[];
  answer: string;
  back: string;
  kind: "choice" | "qa" | "judge";
}

export function normalizeManualCard(raw: unknown): ManualCardInput | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const front = String(o.front ?? "").trim();
  if (front.length < 4) return null;

  const options = Array.isArray(o.options)
    ? o.options.map((v) => String(v ?? "").trim()).filter(Boolean)
    : String(o.options ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
  const answer = String(o.answer ?? "").trim();
  const back = String(o.back ?? "").trim();

  // 选项 <2 项一律按问答卡处理：二选一才叫选择题，一项选项没有意义
  if (options.length >= 2) {
    return { front, options, answer: answer || back, back: back || answer, kind: "choice" };
  }
  return {
    front,
    options: [],
    answer: "",
    back: back || answer,
    kind: "qa",
  };
}
