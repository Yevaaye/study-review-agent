// Markdown 导入解析：把 Markdown 文本按标题切分为「章节 + 片段」。
//
// 规则（对齐 v3 需求，先只做 Markdown）：
//   · 按 # / ## 标题切分章节（## 为章，更深标题作为 heading_path 的一部分）。
//   · 每章内的段落切成 source_fragment，带 paragraph_index 与 heading_path。
//   · 产出是「结构化内容」：chapters + fragments，供校正台展示、AI 找知识点。
//
// 难点：很多中文资料用「1. 基础概念」这种数字编号当章节，但它和正文里的有序列表
// （如 TLS 握手的 "1. Client Hello"、OWASP 十条的 "1. 失效的访问控制"）长得一模一样。
// 只按正则会把这些列表项也切成章节，结果是一堆「有标题没正文」的空章，原文被打散。
// 这里用两条约束区分：① 必须是块起始（前一行是空行）；② 编号必须连续递增。

import crypto from "node:crypto";

export interface ParsedChapter {
  title: string;
  heading_path: string;
  fragments: Array<{
    content: string;
    locator: string;
    paragraph_index: number;
    /** 该片段所属小节（`章 > 小节`）。落库到 source_fragment.heading_path */
    heading_path?: string;
  }>;
}

export interface ParseResult {
  chapters: ParsedChapter[];
  content_hash: string;
}

// sha-256（Node 内置 crypto），用于识别同名/更新/重复上传。
// 旧实现用 try/catch 包住 `require("node:crypto")` 做降级 —— 这段代码只在
// 服务端（API 路由）运行，从来不会缺 crypto；而 require() 在 ESM 模块里本身
// 就是 lint error，还带着一条无效的 eslint-disable。改成顶部 import。
function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface Heading {
  level: number;
  title: string;
  /** 顶级编号的章号（"1." / "一、" 这种单层编号才有值） */
  num?: number;
}

/**
 * 中文数字 → 阿拉伯数字（支持到千位）。
 * 「一」→1、「十」→10、「十一」→11、「二十一」→21。识别不了返回 null。
 */
function cnToNumber(text: string): number | null {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in digits) {
      number = digits[ch];
      seen = true;
    } else if (ch in units) {
      const u = units[ch];
      // 「十二」里 十 前面没有数字，按 1 算
      section += (number === 0 ? 1 : number) * u;
      number = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? section + number : null;
}

/**
 * 标题归一化：去掉序号前缀与所有标点空白，只留标题本体。
 *
 * 用来判断「目录里的『1. 角色定位与能力模型』」与「正文里的『一、角色定位与能力模型』」
 * 是不是同一节 —— 是的话，目录那一行就不能再当成章节，否则同一节会被切成两章。
 *
 * 注意只能剥**一层**序号，且按优先级选一条：
 *   「第一章 角色定位」→ 本体是「角色定位」（序号是第X章）
 *   「一、第一章」      → 本体是「第一章」（序号是「一、」）
 * 若把所有序号前缀一路剥到底，「一、第一章」会被剥成空串，
 * 于是「一、第一章」和「二、第二章」归一化后都是空串 → 被误判成同名。
 */
function normalizeTitle(title: string): string {
  let t = title.trim();
  if (/^第[一二三四五六七八九十百\d]+[章节篇]\s*/.test(t)) {
    t = t.replace(/^第[一二三四五六七八九十百\d]+[章节篇]\s*/, "");
  } else if (/^\d+(?:\.\d+)*[.、]?\s*/.test(t)) {
    t = t.replace(/^\d+(?:\.\d+)*[.、]?\s*/, "");
  } else if (/^[一二三四五六七八九十百零〇两]+[、.．]?\s*/.test(t)) {
    t = t.replace(/^[一二三四五六七八九十百零〇两]+[、.．]?\s*/, "");
  }
  return t.replace(/[\s、，,。.·:：;；()（）]/g, "").toLowerCase();
}

// 判断一行是否为「标题」：
//   1) Markdown 标题：# / ##（更深标题不作章）
//   2) 中文序号："第一章 xx"、"第十二章 xx"
//   3) 中文顿号序号："一、角色定位与能力模型"（很多书的正文用这种写法）
//   4) 数字编号："1. 基础概念"（章）、"2.1 对称加密"（小节）
function parseHeading(line: string): Heading | null {
  const md = line.match(/^(#{1,6})\s+(.*)$/);
  if (md) return { level: md[1].length, title: md[2].trim() };

  const cn = line.match(/^第([一二三四五六七八九十百\d]+)[章节篇]\s*(.*)$/);
  if (cn) {
    const num = cn[1];
    const rest = cn[2].trim();
    const title = rest ? `第${num}章 ${rest}` : `第${num}章`;
    return { level: 2, title };
  }

  // 中文顿号序号：「一、角色定位与能力模型」
  // 必须转成数字才能参与「编号连续性」判定，否则正文里以「一、」开头的
  // 普通句子（一、首先要做的是……）会被误当成章节标题。
  const cnSeq = line.match(/^([一二三四五六七八九十百零〇两]+)、\s*(.+)$/);
  if (cnSeq) {
    const num = cnToNumber(cnSeq[1]);
    const body = cnSeq[2].trim();
    // 与数字编号同样的两条排除规则：正文句子（太长 / 以句末标点结尾）不当标题
    if (num !== null && body.length > 0 && body.length <= 40 && !/[。？！?!]$/.test(body)) {
      return { level: 2, title: `${cnSeq[1]}、${body}`, num };
    }
    return null;
  }

  const num = line.match(/^(\d+(?:\.\d+)*)[.、]?\s+(.+)$/);
  if (num) {
    const parts = num[1].split(".");
    const body = num[2].trim();
    // 排除「404 状态码属于哪一类？」这种以数字开头的正文句子
    if (body.length > 40) return null;
    if (/[。？！?!]$/.test(body)) return null;

    const isTop = parts.length === 1;
    const chapterNo = Number(parts[0]);
    if (isTop && chapterNo > 300) return null;

    return {
      level: isTop ? 2 : 3,
      title: `${num[1]} ${body}`,
      num: isTop ? chapterNo : undefined,
    };
  }

  return null;
}

/**
 * 收集一段文本里所有顶级标题的归一化名（用于「目录项 ↔ 正文标题」对应）。
 */
function collectTopTitles(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of lines) {
    const h = parseHeading(raw.trimEnd());
    if (h && h.level === 2) out.add(normalizeTitle(h.title));
  }
  return out;
}

/**
 * 检测目录区结束位置：文档开头若出现连续的顶级编号标题，判定为目录区，跳过。
 *
 * 关键：怎么区分「目录里的 1. 角色定位与能力模型」和「正文里的 一、角色定位与能力模型」？
 * 靠**同名对应** —— 如果这个标题在后面还会再出现（归一化后同名），它就是目录项；
 * 一旦某个候选标题后面不再出现，说明已经进入正文，目录就在那里结束。
 * 只看编号连续性是不够的：目录排到 9、正文接着是「十、」时编号会连成一片，
 * 结果整篇正文被当成目录吞掉。
 *
 * 返回目录结束的行号（从该行开始是正文）。无目录返回 0。
 */
function findTocEnd(lines: string[]): number {
  let i = 0;
  // 跳过开头空行和「目录」字样行
  while (i < lines.length && (lines[i].trim() === "" || /^(目录|目\s*录|Contents?)$/i.test(lines[i].trim()))) {
    i++;
  }

  const cand: Array<{ line: number; title: string }> = [];
  let j = i;
  let prevNum: number | undefined;
  while (j < lines.length) {
    const line = lines[j].trimEnd();
    const h = parseHeading(line);
    if (!(h && h.level === 2 && h.num !== undefined)) break;
    // 编号回退说明已经离开目录、进入正文了。
    // 典型场景：目录用「1. 2. 3. …9.」排完，紧接着正文用「一、」起头，
    // 编号从 9 跳回 1 —— 此时必须在这里断开，否则正文第一章会被当成目录项吞掉。
    if (prevNum !== undefined && h.num <= prevNum) break;
    cand.push({ line: j, title: h.title });
    prevNum = h.num;
    j++;
  }

  // 至少 3 个连续顶级标题才算目录（1~2 个可能是正文里的小标题）
  if (cand.length < 3) return 0;

  // 后文出现过的顶级标题名：出现在这里说明该候选是目录项，而不是正文章节
  const laterTitles = collectTopTitles(lines.slice(j));
  let sawMatch = false;
  for (const c of cand) {
    if (!laterTitles.has(normalizeTitle(c.title))) {
      // 前面有对得上的、这里对不上 → 目录到此为止
      // 第一个就对不上 → 这不是目录（只是一串编号列表或正文），不跳过任何内容
      return sawMatch ? c.line : 0;
    }
    sawMatch = true;
  }
  return j;
}

/**
 * 找出「是目录项」的行号：某个顶级标题在它之后又出现了同名标题，
 * 那么先出现的那个就是目录条目（后出现的才是正文章节）。
 *
 * 这是 findTocEnd 的兜底保险 —— 即使开头没识别出目录区，
 * 目录里的「1. xxx」也不会被误当成正文章节。
 */
function findDuplicateTopTitles(lines: string[]): Set<number> {
  const firstSeen = new Map<string, number>();
  const dup = new Set<number>();
  for (let li = 0; li < lines.length; li++) {
    const h = parseHeading(lines[li].trimEnd());
    if (!h || h.level !== 2) continue;
    const key = normalizeTitle(h.title);
    const prev = firstSeen.get(key);
    if (prev !== undefined) dup.add(prev);
    else firstSeen.set(key, li);
  }
  return dup;
}

/**
 * 这一行是「编号列表项」而不是章节标题吗？
 *
 * 判据：连续的编号行之间**没有正文** —— 也就是它自己紧挨着另一个编号标题。
 *   "1. 列表一 / 2. 列表二 / 3. 列表三"   → 整块是列表，不是三章
 *   "1. 第一章 / 正文一 / 2. 第二章"       → 章节（编号行后面跟着正文）
 *
 * 单看格式无法区分「紧凑排版的章节」和「编号列表」，区别只在于中间有没有正文。
 */
function isNumberedListItem(lines: string[], li: number): boolean {
  const isNum = (i: number): boolean => {
    if (i < 0 || i >= lines.length) return false;
    const h = parseHeading(lines[i].trimEnd());
    return !!h && h.level === 2 && h.num !== undefined;
  };
  if (isNum(li + 1)) return true; // 下一行还是编号标题
  if (isNum(li - 1) && isNum(li)) return true; // 与上一行同属一个编号块
  return false;
}

/**
 * 找出「真正的章标题」所在行号。
 *
 * 判定一个 "N. xxx" 是章而不是列表项，必须同时满足：
 *   a) 不能紧跟在标题/编号项后面 —— 那说明它只是列表的下一项
 *      （如 TLS 握手的 "2. Server Hello"、OWASP 的 "8. 软件与数据完整性失效"）；
 *      但前一行是普通段落时仍然算章（有些文档章之间不空行，属于常见排版）；
 *   b) 编号要接得上（从 1 开始、允许小幅跳号），不能突然回到 1。
 *
 * 例：正文第 6 章之后出现 "1. Client Hello"，编号 1 接不上 7 → 判为列表项。
 *
 * @param skip 需要忽略的行号（目录条目）。
 *   目录里的「1. 第一章」若被当成正文第一章，expected 会被推进到 2，
 *   正文真正的「一、第一章」（num=1）就接不上了 —— 整本书会丢掉第一章。
 * @param tocTitles 目录条目的归一化标题集（正向锚点）。
 *   「同名对应」是双向证据：它既证明目录行该剔除，也证明正文里的同名行
 *   就是目录里那一章 —— 命中即确认成章，不再受编号连续性约束。
 *   典型救回场景：某章标题恰好紧跟在编号列表后面（列表延续守卫会误杀它），
 *   或正文编号跳号超过容差 —— 只要目录里有这个名字，就不会丢章。
 */
function findChapterStarts(
  lines: string[],
  from: number,
  skip: Set<number> = new Set(),
  tocTitles: Set<string> = new Set()
): Set<number> {
  const starts = new Set<number>();
  let expected = 0; // 0 表示还没开始，允许 1~3 作为首章容错
  // 上一个被认作章的行号，以及那之后有没有出现过正文行。
  // 用来区分「紧挨着的下一章」（紧凑排版）和「编号列表的下一项」：
  // 列表的项与项之间永远不会有正文；章与章之间迟早会有。
  let lastAccepted = -1;
  let bodySinceAccepted = false;

  for (let li = from; li < lines.length; li++) {
    if (skip.has(li)) continue; // 目录条目不参与章节判定
    const h = parseHeading(lines[li].trimEnd());

    if (!h || h.level !== 2 || h.num === undefined) {
      if (lines[li].trim() !== "") bodySinceAccepted = true; // 非空正文行
      continue;
    }

    // ★ 目录同名锚点：正文标题与目录条目归一化后同名 → 权威地确认这就是那一章。
    // 必须放在编号判定之前 —— 编号守卫（列表延续 / 跳号容差）都可能误杀真章，
    // 而同名是不会撒谎的：目录里写过这个名字，正文这个行就是它。
    if (tocTitles.has(normalizeTitle(h.title))) {
      starts.add(li);
      expected = h.num + 1;
      lastAccepted = li;
      bodySinceAccepted = false;
      continue;
    }

    const prevBlank = li === from || lines[li - 1].trim() === "";
    const prev = !prevBlank ? parseHeading(lines[li - 1].trimEnd()) : null;
    const prevIsNumHeading = !!prev && prev.level === 2 && prev.num !== undefined;

    if (prevIsNumHeading) {
      const consecutive = prev!.num! + 1 === h.num;
      if (consecutive) {
        if (lastAccepted === li - 1 && !bodySinceAccepted) {
          // 上一行已被认作章、但两行之间没有任何正文 → 更可能是编号列表
          // （「1. 列表一 / 2. 列表二 / 3. 列表三」），跳过。
          continue;
        }
        if (lastAccepted !== li - 1) {
          // 上一行是被跳过的编号行、且编号正好延续（如 OWASP 列表 7→8→9→10）
          // → 当前列表还在继续，跳过。注意这一条必须先于编号连续性检查，
          // 否则列表项「8. 软件与数据完整性失效」会恰好命中 expected 被误认成章。
          continue;
        }
        // 走到这说明上一行是章、且之间有正文 → 紧凑排版的下一章，放行到 inSeq 判定
      } else {
        // 编号打破了上一行的序列：上一行多半是正文里的编号步骤
        // （如 TLS 小节末尾「4. 双方推导会话密钥…」后面跟着真正的「7. Web 安全」）
        // → 不因上一行是编号行而跳过，直接看编号是否接得上全局序列。
      }
    }

    const inSeq =
      expected === 0
        ? h.num >= 1 && h.num <= 3 // 首章容错：1~3 都可能是开头
        : h.num >= expected && h.num <= expected + 2; // 允许小幅跳号
    if (!inSeq) continue;
    starts.add(li);
    expected = h.num + 1;
    lastAccepted = li;
    bodySinceAccepted = false;
  }

  return starts;
}

/**
 * 单个片段的字数上限：超过就按行二次切开。
 *
 * 为什么需要：很多书的条目之间没有空行（像「1.1 xxx」「层级 能力项」这种逐行排版），
 * 段落切分就失效了 —— 整章变成一个几千字的片段。
 * 而生成卡片时每章只取前 8000 字，超长部分会被**静默丢弃**，
 * 表现为「书里后面几节的内容根本没出题」。
 * 按行切开后再送模型，每块的出处也更准。
 */
const MAX_FRAGMENT_CHARS = 1500;

/** 把过长的片段按行拆成若干块，locator 追加 (i/n) 以便区分 */
function splitLongFragments(chapters: ParsedChapter[]): void {
  for (const ch of chapters) {
    const out: ParsedChapter["fragments"] = [];
    for (const frag of ch.fragments) {
      if (frag.content.length <= MAX_FRAGMENT_CHARS) {
        out.push(frag);
        continue;
      }
      // 按行贪心装箱：尽量接近上限，但不切断一行
      const chunks: string[] = [];
      let buf: string[] = [];
      let len = 0;
      for (const line of frag.content.split("\n")) {
        if (buf.length > 0 && len + line.length > MAX_FRAGMENT_CHARS) {
          chunks.push(buf.join("\n"));
          buf = [];
          len = 0;
        }
        buf.push(line);
        len += line.length + 1;
      }
      if (buf.length > 0) chunks.push(buf.join("\n"));

      chunks.forEach((content, i) => {
        out.push({
          content,
          locator:
            chunks.length > 1
              ? `${frag.locator}（${i + 1}/${chunks.length}）`
              : frag.locator,
          paragraph_index: frag.paragraph_index,
        });
      });
    }
    ch.fragments = out;
  }
}

export function parseMarkdown(markdown: string): ParseResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  // 目录检测：文档开头若出现「连续的顶级编号标题、中间无正文」，判定为目录区，跳过。
  const tocEnd = findTocEnd(lines);

  // 目录条目兜底：某个顶级标题后面又出现同名标题 → 先出现的那个是目录条目，
  // 不管它落在目录区内外，都不能当成正文章节。
  const dupTopTitles = findDuplicateTopTitles(lines);

  // 目录标题集（归一化）：正向锚点。来源有两处 ——
  //   a) 目录区内的编号条目（目录区被识别出来时）；
  //   b) dupTopTitles 里的先行同名行（目录区没被识别出来时兜底，如目录只有 2 条的情况）。
  // 正文标题命中这个集合 = 目录里写过这一章 → 直接确认成章，不受编号约束。
  const tocTitles = new Set<string>();
  const collectTitle = (li: number) => {
    const h = parseHeading(lines[li].trimEnd());
    if (h && h.level === 2) tocTitles.add(normalizeTitle(h.title));
  };
  if (tocEnd > 0) for (let li = 0; li < tocEnd; li++) collectTitle(li);
  for (const li of dupTopTitles) collectTitle(li);

  // 章标题识别：严格模式（块起始 + 编号连续）。识别不出足够章时回退到宽松模式，
  // 避免因为文档排版紧凑（章之间没空行）导致整篇被当成一章。
  // 目录条目一律排除在外：它们既不是章节，也不能推进编号序列。
  let chapterStarts = findChapterStarts(lines, tocEnd, dupTopTitles, tocTitles);
  const numberedTopCount = lines
    .slice(tocEnd)
    .filter((l) => {
      const h = parseHeading(l.trimEnd());
      return h && h.level === 2 && h.num !== undefined;
    }).length;
  const strictMode = chapterStarts.size >= 2;
  if (!strictMode && numberedTopCount >= 3) {
    chapterStarts = new Set<number>();
    for (let li = tocEnd; li < lines.length; li++) {
      const h = parseHeading(lines[li].trimEnd());
      if (!h || h.level !== 2 || h.num === undefined) continue;
      if (dupTopTitles.has(li)) continue;
      // 目录同名锚点在宽松模式下同样生效
      if (tocTitles.has(normalizeTitle(h.title))) {
        chapterStarts.add(li);
        continue;
      }
      // 连续的编号行（中间没有正文）是一份列表，不是好几章
      if (isNumberedListItem(lines, li)) continue;
      chapterStarts.add(li);
    }
  }

  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter | null = null;
  let currentHeadingPath = "";
  let paraBuf: string[] = [];
  let paraIndex = 0;
  /**
   * 当前小节标题（`### 4.1 总要求` 这一行）。
   *
   * 只要进了小节，空行就不再切段 —— 一个片段 = 一个小节。
   * 原来的规则是「空行即切段」，于是 `### 4.1 总要求` 自己成了一段、
   * 它下面那句正文又成一段，页面上看起来像两条互不相干的原文，
   * 而它们本来就是「4.1 这一节」的内容。
   */
  let sectionPath = "";

  const flushParagraph = () => {
    const content = paraBuf.join("\n").trim();
    /*
     * 原文里孤零零的一行 `---`（章节之间常见的分隔）也会被当成一个段落。
     * 这种片段没有任何可读内容，渲染出来只是一条几乎看不见的细线，
     * 却要在「全文」页占一个块、在章节页占一张空卡，所以直接在切分时丢掉。
     */
    const meaningful = content.replace(/[-*_=|\s#>]/g, "").length > 0;
    if (content && meaningful && current) {
      current.fragments.push({
        content,
        locator: sectionPath
          ? `${current.title} · ${sectionPath.replace(/^#{1,6}\s+/, "")}`
          : `${current.title} · 第${paraIndex + 1}段`,
        paragraph_index: paraIndex,
        heading_path: sectionPath
          ? `${current.title} > ${sectionPath.replace(/^#{1,6}\s+/, "")}`
          : current.title,
      });
      paraIndex++;
    }
    paraBuf = [];
  };

  for (let li = 0; li < lines.length; li++) {
    if (li < tocEnd) continue; // 跳过目录区
    const raw = lines[li];
    const line = raw.trimEnd();
    const h = parseHeading(line);

    // 目录条目：后面还有同名的正文标题，说明这一行只是目录里的一项。
    // 它既不成为章节，也不该混进正文（否则第一章开头会多出「1. 角色定位与能力模型」）。
    if (h && h.level === 2 && dupTopTitles.has(li)) continue;

    // 数字编号的「伪标题」（其实是列表项）要落回正文，不能吞掉内容
    const isRealChapter =
      h !== null &&
      (h.level < 2 ||
        (h.level === 2 && (h.num === undefined || chapterStarts.has(li))));

    if (h && isRealChapter) {
      flushParagraph();
      if (h.level <= 2) {
        // # / ## 或顶级编号（数字或中文序号）视为「章」
        currentHeadingPath = h.title;
        current = {
          title: h.title,
          heading_path: h.title,
          fragments: [],
        };
        chapters.push(current);
        paraIndex = 0;
        sectionPath = "";
      } else {
        // 更深标题（### / 1.1 小节）作为 heading_path 的一部分（不单独成章）
        currentHeadingPath = `${current?.title ?? ""} > ${h.title}`;
        if (current) current.heading_path = currentHeadingPath;
      }
      continue;
    }

    // 小节标题（### / #### / 「1.1 xxx」）：**开启**一个新片段，并把标题行放进这段。
    //
    // 这是「4.1 到 4.2 之间算同一段」的实现点：小节标题不是独立内容块，
    // 它和下面的正文、表格属于同一节。标题行保留在片段里，
    // 是为了让卡片「定位原文」时能看出这段话出自哪一小节。
    if (h && h.level > 2) {
      flushParagraph();
      sectionPath = h.title;
      if (current) current.heading_path = `${current.title} > ${h.title}`;
      paraBuf.push(line.trim());
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") {
      // 小节内不按空行切段：一节 = 一段（段内空行原样保留）
      if (!sectionPath) flushParagraph();
      else paraBuf.push("");
      continue;
    }
    paraBuf.push(trimmed);
  }
  flushParagraph();

  // 无标题时退化为单章「全文」
  if (chapters.length === 0) {
    const fallback: ParsedChapter = { title: "全文", heading_path: "全文", fragments: [] };
    const text = markdown.trim();
    if (text) fallback.fragments.push({ content: text, locator: "全文", paragraph_index: 0 });
    chapters.push(fallback);
  }

  // 清理「只有标题、没有正文」的空章节：它们几乎都是被误判成章的列表项或装饰性小标题。
  // 原文已在 Textbook.raw_text 完整保存，这里剔除不会丢内容，只让章节列表不再一堆空壳。
  const nonEmpty = chapters.filter((c) => c.fragments.length > 0);
  const result = nonEmpty.length > 0 ? nonEmpty : chapters;

  // 过长的片段按行二次切开（紧凑排版的书会一整章变成一个巨片段）
  splitLongFragments(result);

  return { chapters: result, content_hash: hashContent(markdown) };
}
