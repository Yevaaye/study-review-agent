/**
 * 答案正文的结构化整理（纯函数，不依赖 React）。
 *
 * 为什么需要它：
 * 模型常把「横向对比」这类答案写成 Markdown 表格，但换行在落库时被压成了空格
 * （见 answer-repair.ts 的 str()），存进库里就成了
 *   `|框架|执行权限|审批|OS隔离| |---|---|---|---| |Codex...|`
 * 一整行竖线。复习页按纯文本渲染，用户看到的就是一串「|」。
 *
 * 这里做两件事，互不越界：
 *   normalizeAnswerText —— 把这种被压扁的表格**恢复成逐行的 Markdown**（只加换行、
 *     不改字、不删字），顺带给缺分隔行的表补上分隔行，让文本本身可读；
 *   parseAnswerBlocks —— 把它切成可渲染的块（段落 / 列表 / 引用 / 标题 / 表格）。
 *
 * 两条硬约束：
 * 1）幂等：normalize(normalize(x)) === normalize(x)。否则每次渲染都改一遍文本，
 *    内容会随刷新漂移，排查起来是噩梦。
 * 2）不丢字：除「被识别为表格行边界」的空白外，一个字都不许消失。这条与
 *    linebreak.ts 的「分号断行不丢字符」是同一个原则。
 */

export type AnswerAlign = "left" | "center" | "right";

export type AnswerBlock =
  | { type: "text"; text: string }
  | { type: "heading"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; header: string[]; rows: string[][]; align: AnswerAlign[] };

/** Markdown 表格分隔行的一格：`---` / `:---` / `---:` / `:---:` */
const SEP_CELL = /^:?-{3,}:?$/;
/** 以竖线开头且以竖线结尾的行 —— 表格行的最小特征 */
const ROW_LINE = /^\s*\|.*\|\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s+(.+)$/;
const BULLET_LINE = /^\s*[-*•·]\s+(.+)$/;
const ORDERED_LINE = /^\s*(\d{1,2})[.、)）]\s+(.+)$/;
const QUOTE_LINE = /^\s*>\s?(.*)$/;

function isSep(token: string): boolean {
  return SEP_CELL.test(token.trim());
}

function alignOf(token: string): AnswerAlign {
  const t = token.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** 拆一行的单元格：去掉首尾竖线后按竖线切分，允许中间有空单元格 */
function cellsOf(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!body) return [];
  return body.split("|").map((c) => c.trim());
}

function formatRow(cells: string[]): string {
  return `|${cells.join("|")}|`;
}

function formatSep(align: AnswerAlign[]): string {
  const cell = (a: AnswerAlign) => (a === "center" ? ":---:" : a === "right" ? "---:" : "---");
  return `|${align.map(cell).join("|")}|`;
}

/**
 * 把连续的表格行整理成规范 Markdown：列数对齐、分隔行补齐、去掉行尾空格。
 *
 * 三种输入都要吃下：
 *   1) 标准表：表头一行、分隔行一行、数据各一行；
 *   2) 缺分隔行的表：靠「各行竖线数一致」判断；
 *   3) 被压扁的表（换行变空格）：进入本函数前已由 \n 恢复，这里只兜底列数。
 */
function buildTableLines(region: string[]): string[] | null {
  if (region.length === 0) return null;
  const rows = region.map(cellsOf).filter((r) => r.length > 0);
  if (rows.length === 0) return null;

  const sepIdx = rows.findIndex((r) => r.length > 0 && r.every(isSep));
  const header = rows[0];
  // 分隔行给出列数（最可信）；没有分隔行就按表头列数
  const width = sepIdx >= 0 ? rows[sepIdx].length : header.length;
  if (width < 2) return null; // 一列「表格」没有意义，交给普通段落渲染

  const align =
    sepIdx >= 0
      ? rows[sepIdx].map(alignOf)
      : (Array.from({ length: width }, () => "left") as AnswerAlign[]);

  const pad = (r: string[]): string[] => {
    const next = r.slice(0, width);
    while (next.length < width) next.push("");
    return next;
  };

  const bodyStart = sepIdx >= 0 ? sepIdx + 1 : 1;
  const body = rows.slice(bodyStart).map(pad);
  // 只有表头 + 分隔行、没有任何数据行：这更像误判，保持原样
  if (body.length === 0) return null;

  return [
    formatRow(pad(header)),
    formatSep(align),
    ...body.map((r) => formatRow(r)),
  ];
}

/**
 * 表格行被压成一行时，行与行之间剩下的是「竖线 + 空白 + 竖线」。
 * 在 Markdown 里这种写法只可能出现在表格里（正常单元格是 `| 内容 `，中间有字），
 * 所以可以放心地把它还原成换行。
 */
function restoreTableBreaks(text: string): string {
  return text.replace(/\|[ \t]+\|/g, "|\n|");
}

/** 规范化答案文本：恢复表格行、压掉多余空行、整理列数。幂等。 */
export function normalizeAnswerText(raw: string): string {
  if (!raw) return "";
  let text = String(raw).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n");
  text = restoreTableBreaks(text);

  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ROW_LINE.test(line)) {
      out.push(line.replace(/[ \t]+$/, ""));
      continue;
    }
    // 收集连续的表格行，整体整理（列数、分隔行、对齐）
    const region: string[] = [];
    while (i < lines.length && ROW_LINE.test(lines[i])) {
      region.push(lines[i]);
      i++;
    }
    i--;
    const built = buildTableLines(region);
    if (built) out.push(...built);
    else out.push(...region.map((l) => l.replace(/[ \t]+$/, "")));
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTableStart(line: string): boolean {
  if (!ROW_LINE.test(line)) return false;
  const cells = cellsOf(line);
  return cells.length >= 2;
}

/**
 * 切成可渲染的块。
 *
 * 纯文本答案仍然返回单个 text 块 —— 上层照旧按分号断行，行为一个字都不变；
 * 只有确实出现表格 / 列表 / 引用 / 标题时才走结构化渲染，避免「本来好好的
 * 一句话被拆成列表」这种误伤。
 */
export function parseAnswerBlocks(raw: string): AnswerBlock[] {
  const text = normalizeAnswerText(raw);
  if (!text) return [];

  const lines = text.split("\n");
  const blocks: AnswerBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // ---- 表格 ----
    if (isTableStart(line)) {
      const region: string[] = [];
      while (i < lines.length && ROW_LINE.test(lines[i])) {
        region.push(lines[i]);
        i++;
      }
      const rows = region.map(cellsOf).filter((r) => r.length > 0);
      const sepIdx = rows.findIndex((r) => r.length > 0 && r.every(isSep));
      const width = sepIdx >= 0 ? rows[sepIdx].length : rows[0].length;
      if (width >= 2 && rows.length >= 2) {
        const pad = (r: string[]): string[] => {
          const next = r.slice(0, width);
          while (next.length < width) next.push("");
          return next;
        };
        const align =
          sepIdx >= 0
            ? rows[sepIdx].map(alignOf)
            : (Array.from({ length: width }, () => "left") as AnswerAlign[]);
        blocks.push({
          type: "table",
          header: pad(rows[0]),
          rows: rows.slice(sepIdx >= 0 ? sepIdx + 1 : 1).map(pad),
          align,
        });
        continue;
      }
      // 不是真表格 → 退回普通段落
      blocks.push({ type: "text", text: region.join("\n") });
      continue;
    }

    // ---- 标题 ----
    const heading = line.match(HEADING_LINE);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim() });
      i++;
      continue;
    }

    // ---- 引用 ----
    if (QUOTE_LINE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        buf.push((lines[i].match(QUOTE_LINE)?.[1] ?? "").trim());
        i++;
      }
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    // ---- 列表（无序 / 有序分开处理，避免编号被当成正文）----
    const bullet = line.match(BULLET_LINE);
    const ordered = line.match(ORDERED_LINE);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const b = cur.match(BULLET_LINE);
        const o = cur.match(ORDERED_LINE);
        if (isOrdered ? !o : !b) break;
        items.push((isOrdered ? o?.[2] : b?.[1])?.trim() ?? "");
        i++;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    // ---- 段落（保留原有换行，交给分号断行层）----
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isTableStart(lines[i])) {
      const cur = lines[i];
      if (
        HEADING_LINE.test(cur) ||
        QUOTE_LINE.test(cur) ||
        BULLET_LINE.test(cur) ||
        ORDERED_LINE.test(cur)
      ) {
        break;
      }
      buf.push(cur);
      i++;
    }
    // 防止死循环：上面若一条都没吃到，就强制前进一行
    if (buf.length === 0) {
      buf.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ type: "text", text: buf.join("\n") });
  }

  return blocks.filter((b) => (b.type === "text" ? b.text.trim() !== "" : true));
}

/** 这段答案里有没有可结构化的内容（表格/列表/引用/标题） */
export function hasAnswerStructure(raw: string): boolean {
  return parseAnswerBlocks(raw).some((b) => b.type !== "text");
}

/**
 * 收口模型返回的**整段正文**：压掉行内多余空白，但**保留换行**。
 *
 * 这条规则是「表格挤成一行」的根因修复点。原来两处收口都写成
 * `v.replace(/\s+/g, " ")` —— `\s` 含换行，模型给的 Markdown 表格落库后
 * 就变成 `|框架|执行权限|...| |---|---|---|---| |Codex...|` 一整行，
 * 渲染层再怎么结构化也无从下手。
 *
 * 换行是结构的一部分（表格行、分点、代码块），压缩它就等于丢信息。
 */
export function tidyModelText(v: string, max: number): string {
  if (!v) return "";
  const text = String(v)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, max).trim();
}

/** 收口**单行字段**（诊断、依据、知识点）：这类字段放不下换行，连换行一起压成空格 */
export function tidyInline(v: string, max: number): string {
  if (!v) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, max);
}
