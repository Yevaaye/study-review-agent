/**
 * MD 手机端排版自动修复（v1.0 规范的实现）。
 *
 * 解决两个在窄屏上必然出现的排版问题：
 *   A. 宽表炸版：列数 ≥ 3 且存在 ≥ 60 字的单元格 → 手机上每列只剩一两个字宽，
 *      中文会竖着排成一列。转成「#### 序号、主题 + **表头**：值」的卡片式文字。
 *   B. 行内枚举连排：`①②③④` 或 `A. B. C. D.` 挤在同一行 → 在标记前插 `<br>`。
 *
 * 硬约束（违反即失败）：
 *   · 只允许换表格形态、插 `<br>`、加 `#### ` / `**表头**：` 结构标记；
 *     绝不改写、润色、重排、增删任何正文文字。
 *   · 代码块（``` / ~~~）、表格行内部、含反引号的行不碰。
 *   · 每一步都做守恒自检，校验失败该块回退原文。
 *
 * 关键陷阱：答案行 `A.①②③ B.①②④` 里的圈号是**选项组合**，不能拆。
 * 判别法：只在「圈号/字母前是空白」处插换行 —— `①②③` 里 `②` 前面是 `①`
 * 不是空白，天然不匹配，所以不会被拆成三行。
 */

export type Block =
  | { kind: "code"; text: string }
  | { kind: "table"; lines: string[] }
  | { kind: "text"; text: string };

export interface MobileFixReport {
  blocks: number;
  tablesConverted: number;
  brInserted: number;
  checks: {
    inlineConserved: boolean;
    tablesConserved: boolean;
    codeUntouched: boolean;
  };
  warnings: string[];
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const SEP_ROW = /^\s*\|?[\s:|-]+\|?\s*$/;
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);

/** ①②…⑳ */
export const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/**
 * STEP 1 · 切块。代码块与表格是保护区：后续只对 text 块做行内处理。
 */
export function splitBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      blocks.push({ kind: "text", text: buf.join("\n") });
      buf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ① 代码块：整段收走，后面绝不再碰
    if (FENCE.test(line)) {
      flush();
      const fence = [line];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        fence.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        fence.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "code", text: fence.join("\n") });
      continue;
    }

    // ② 表格：表头行 + 分隔行 + 连续数据行
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      SEP_ROW.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      flush();
      const t = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        t.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "table", lines: t });
      continue;
    }

    buf.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** `| a | b |` → ["a","b"]，保留转义竖线 `\|` */
export function parseCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((s) => s.trim());
}

/** STEP 2 · 检测宽表（只判不改） */
export function detectWideTable(
  block: { lines: string[] },
  minCols = 3,
  longCell = 60
): { hit: boolean; headers: string[]; rows: string[][]; maxCell: number } {
  const headers = parseCells(block.lines[0]);
  const rows = block.lines.slice(2).map(parseCells);
  const maxCell = Math.max(0, ...rows.flat().map((c) => c.length));
  const hit = headers.length >= minCols && maxCell >= longCell;
  return { hit, headers, rows, maxCell };
}

/** STEP 3 · 表格转卡片 */
export function tableToCards(headers: string[], rows: string[][]): string {
  const idxLike = /^(序号|#|编号|No\.?|序)$/i.test(headers[0] ?? "");
  const dash = (h: string, v: string) => (v ? `**${h}**：${v}` : "");

  return rows
    .map((row) => {
      // 序号表：用「序号、主题」当标题，其余列作字段
      if (idxLike && row.length >= 3 && (row[0] ?? "").length <= 6) {
        const rest = headers
          .slice(2)
          .map((h, i) => dash(h, row[i + 2] ?? ""))
          .filter(Boolean);
        return `#### ${row[0]}、${row[1]}\n\n${rest.join("\n\n")}`;
      }
      /*
       * 通用表：首列当标题，其余列作字段。
       * 规范原文这里是「纯字段列表」，但那样输出里没有可数的卡片边界，
       * §6 的「卡片数 = 数据行数」校验永远失败 → 每张表都被回退，等于没做。
       * 统一成 `#### 标题` 后既保留了行边界，又让校验真正生效。
       */
      const title = (row[0] ?? "").trim() || headers[0] || "条目";
      const rest = headers
        .slice(1)
        .map((h, i) => dash(h, row[i + 1] ?? ""))
        .filter(Boolean);
      return `#### ${title}\n\n${rest.join("\n\n")}`;
    })
    .join("\n\n");
}

/** STEP 4 · 检测行内枚举（只判不改） */
export function detectInlineEnumeration(line: string): {
  hit: boolean;
  circled: number;
  letters: number;
} {
  const circled = [...line].filter((c) => CIRCLED.includes(c)).length;
  const letters = (line.match(/[A-D][.、]/g) || []).length;
  return { hit: circled >= 2 || letters >= 2, circled, letters };
}

/** STEP 5 · 插入换行 */
export function expandInlineEnumeration(
  line: string,
  br = "<br>",
  alsoLetters = true
): { text: string; inserted: number } {
  // 含行内代码的行不碰（避免破坏 `code` 片段）
  if (line.includes("`")) return { text: line, inserted: 0 };

  let s = line;
  let n = 0;

  // ① 圈号：只匹配「空白 + ②~⑳」；①②③ 连写时 ② 前不是空白 → 天然不误拆
  if (detectInlineEnumeration(s).circled >= 2) {
    s = s.replace(
      new RegExp(`[ \\t]+([${CIRCLED.slice(1)}])`, "g"),
      (_m, c: string) => {
        n++;
        return `${br}${c}`;
      }
    );
  }

  // ② 字母选项：只匹配「空白 + B./C./D.」
  if (alsoLetters && (s.match(/[A-D][.、]/g) || []).length >= 2) {
    s = s.replace(/[ \t]+([B-D])[.、]/g, (_m, c: string) => {
      n++;
      return `${br}${c}.`;
    });
  }

  return { text: s, inserted: n };
}

const norm = (s: string) => s.replace(/<br\s*\/?>/gi, "").replace(/\s+/g, "");

/** 校验 1：行内拆行必须「一字不差」 */
export function verifyInlineConserved(before: string, after: string): boolean {
  return norm(before) === norm(after);
}

/** 校验 2：表格转卡片，每个数据单元格文本完整出现，且卡片数 = 数据行数 */
export function verifyTableConserved(rows: string[][], cards: string): boolean {
  const cells = rows
    .flat()
    .filter(Boolean)
    .map((c) => c.replace(/\*\*/g, "").trim());
  const plain = cards.replace(/\*\*/g, "");
  const cellsOk = cells.every((t) => plain.includes(t));
  const countOk = cards.split(/\n\n(?=#### )/).length === rows.length;
  return cellsOk && countOk;
}

/** STEP 6 + 7 · 主流程 */
export function normalizeMarkdownForMobile(
  md: string,
  opts: {
    minCols?: number;
    longCell?: number;
    br?: string;
    alsoLetters?: boolean;
    /** "cards" 把宽表转成卡片文字；"keep" 保持表格原样（渲染层会用堆叠布局） */
    tables?: "cards" | "keep";
  } = {}
): { text: string; report: MobileFixReport } {
  const { minCols = 3, longCell = 60, br = "<br>", alsoLetters = true, tables = "cards" } = opts;
  const blocks = splitBlocks(md);
  const out: string[] = [];

  const report: MobileFixReport = {
    blocks: blocks.length,
    tablesConverted: 0,
    brInserted: 0,
    checks: { inlineConserved: true, tablesConserved: true, codeUntouched: true },
    warnings: [],
  };

  for (const b of blocks) {
    if (b.kind === "code") {
      out.push(b.text);
      continue;
    }

    if (b.kind === "table") {
      const d = detectWideTable(b, minCols, longCell);
      if (!d.hit || tables === "keep") {
        out.push(b.lines.join("\n"));
        continue;
      }
      const cards = tableToCards(d.headers, d.rows);
      if (!verifyTableConserved(d.rows, cards)) {
        report.checks.tablesConserved = false;
        report.warnings.push(`表格转卡片校验失败，已回退该表（${d.headers.join(" | ")}）`);
        out.push(b.lines.join("\n"));
      } else {
        out.push(cards);
        report.tablesConverted++;
      }
      continue;
    }

    const after = b.text
      .split("\n")
      .map((l) => {
        const r = expandInlineEnumeration(l, br, alsoLetters);
        report.brInserted += r.inserted;
        return r.text;
      })
      .join("\n");

    if (!verifyInlineConserved(b.text, after)) {
      report.checks.inlineConserved = false;
      report.warnings.push("行内拆行守恒校验失败，该段已回退");
      out.push(b.text);
    } else {
      out.push(after);
    }
  }

  // 校验 3：代码块必须逐字未动
  const codeBlocks = blocks.filter((b): b is { kind: "code"; text: string } => b.kind === "code");
  const result = out.join("\n");
  report.checks.codeUntouched = codeBlocks.every((b) => result.includes(b.text));

  return { text: result, report };
}

/** 验收清单第 6 条：答案行（^[A-D]. 开头且含圈号）不得出现 <br>①②③ */
export function badAnswerLines(text: string): string[] {
  return text.split("\n").filter((l) => /^[A-D]\./.test(l) && /<br>[①②③④⑤]/.test(l));
}
