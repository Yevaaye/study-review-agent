import type { ReactNode } from "react";

import { expandInlineEnumeration } from "@/lib/import/md-mobile-fix";

/**
 * 原文片段的轻量 Markdown 渲染。
 *
 * 为什么不用 react-markdown：整站只用到「标题 / 表格 / 列表 / 粗体 / 行内代码」
 * 这五种，而片段内容是导入时切好的原文，本身已经被限制在这些形式里。
 * 自己解析 20 行就能覆盖，还不用把整包 remark 拖进客户端。
 *
 * 重点解决两个手机上的问题：
 *   1. 原文里的 `### 4.1 总要求` 以前是原样显示的（三个井号露在白话里）；
 *   2. 竖线表格以前靠 pre-wrap 折行，手机上会折成一团看不懂的竖线 ——
 *      现在渲染成真表格，外面套一层横向滚动，宽度不够时只在表格内部滑动，不顶破页面。
 */

/** 行内标记：**粗体** / `代码`。其余原样输出。 */
export function MarkdownInline({ text }: { text: string }) {
  return <>{renderInline(text, "il")}</>;
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(<br\s*\/?>|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g);
  return parts.map((p, i) => {
    const key = `${keyBase}-${i}`;
    // <br>：导入管线按「手机端排版修复规范」插的强制换行，渲染成段内换行
    if (/^<br\s*\/?>$/i.test(p)) {
      return <span key={key} className="frag-br" />;
    }
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return (
        <strong key={key} className="font-semibold text-fg">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return (
        <code key={key} className="frag-code">
          {p.slice(1, -1)}
        </code>
      );
    }
    // Markdown 链接：[文字](#锚点) / [文字](https://…)
    // 锚点链接在原文卡片里没法跳，只留文字；外部链接保留可点。
    const link = p.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
    if (link) {
      const [, label, href] = link;
      if (/^https?:/i.test(href)) {
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {label}
          </a>
        );
      }
      return <span key={key}>{label}</span>;
    }
    return <span key={key}>{p}</span>;
  });
}

/**
 * 段落内部可能有多个「单换行分隔的行」（这类 Markdown 从 PDF 转换时常丢失空行，
 * 段落边界只剩一个 `\n`）。renderInline 会把换行原样输出，导致这些行首尾相接、
 * 挤成一团。这里把段落内的 `\n` 换成带间距的 <br>，让每一行在视觉上仍是独立的一段，
 * 同时不破坏「软换行仍属于同一段落」的语义。
 */
function renderInlineLines(text: string, keyBase: string): ReactNode[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    // 行内枚举拆行：`①… ②… ③…` 挤成一条长句在手机上极难扫读。
    // 已有内容的原文里没有 <br>（导入时不分行），所以这里渲染前补一次；
    // 新导入的文本已经带 <br>，第二次匹配不到空白前缀，天然幂等。
    const expanded = expandInlineEnumeration(line).text;
    const nodes = renderInline(expanded, `${keyBase}-l${i}`);
    if (i < lines.length - 1) {
      nodes.push(<span key={`${keyBase}-br${i}`} className="frag-br" />);
    }
    return nodes;
  });
}

/** `| a | b |` 的分隔行，如 `|---|:--:|` */
const TABLE_SEP = /^\|?[\s:|-]+\|?$/;

/**
 * 引用块内部的排版。
 *
 * 以前这里把整块 `> …` 用 join("\n") 拼成一段交给 renderInline，
 * 换行符被 HTML 折叠成空格 —— 导入时写的来源说明（来源 / 抓取时间 / 结构 /
 * 完整性说明 + 三条状态清单）在页面上变成一条两百多字的长句，读起来非常累。
 * 现在逐行渲染：普通行各成一段，`- ` 开头的合成一个列表，块内统一留行距。
 */
function QuoteLines({ lines, keyBase }: { lines: string[]; keyBase: string }) {
  const nodes: ReactNode[] = [];
  let items: string[] = [];

  const flushItems = () => {
    if (items.length === 0) return;
    const current = items;
    items = [];
    const k = nodes.length;
    nodes.push(
      <ul key={`${keyBase}-ul-${k}`} className="frag-ul">
        {current.map((it, ii) => (
          <li key={ii}>{renderInlineLines(it, `${keyBase}-qli-${k}-${ii}`)}</li>
        ))}
      </ul>
    );
  };

  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) {
      flushItems();
      return;
    }
    const li = t.match(/^[-*]\s+(.*)$/);
    if (li) {
      items.push(li[1]);
      return;
    }
    flushItems();
    nodes.push(
      <p key={`${keyBase}-p-${i}`} className="frag-p">
        {renderInlineLines(t, `${keyBase}-qp-${i}`)}
      </p>
    );
  });
  flushItems();

  return <>{nodes}</>;
}

/**
 * 片段里有没有值得看的内容。
 *
 * 导入切分时，原文里孤零零的一行 `---` 会单独成为一个片段。
 * 这种片段渲染出来是一条几乎看不见的线，但前后各有一份间距，
 * 在「全文」页上就是一块一百多像素的空洞 —— 用户会以为内容没加载出来。
 */
export function hasVisibleText(text: string): boolean {
  return text.replace(/[-*_=|\s#>]/g, "").length > 0;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

export function FragmentBody({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    const content = para.join("\n").trim();
    para = [];
    if (!content) return;
    out.push(
      <p key={`p-${key++}`} className="frag-p">
        {renderInlineLines(content, `p-${key}`)}
      </p>
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushPara();
      continue;
    }

    // 标题：### / ## / #
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(
        <div
          key={`h-${key++}`}
          className={level <= 2 ? "frag-h frag-h-lg" : "frag-h frag-h-sm"}
        >
          {renderInline(h[2], `h-${key}`)}
        </div>
      );
      continue;
    }

    // 表格：当前行是 | 行，且下一行是分隔行
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      flushPara();
      const head = splitRow(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitRow(lines[i]));
        i++;
      }
      i--; // 外层循环还会 i++
      out.push(
        <div key={`t-${key++}`} className="frag-table-wrap">
          <table className="frag-table">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci}>{renderInline(c, `th-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    <td
                      key={ci}
                      /*
                       * data-label 给手机用：窄屏下表格会变成「表头 值」的堆叠块
                       * （见 globals.css 的 max-width:767px 段），表头就从这里取。
                       * 序号列（表头是 #）在堆叠后没有意义，加类名隐藏。
                       */
                      data-label={/^#/.test(head[ci] ?? "") ? "" : head[ci] ?? ""}
                      className={/^#/.test(head[ci] ?? "") ? "frag-td-idx" : undefined}
                    >
                      {/*
                       * 手机端 td 是 display:flex（标签 + 值两栏），而 renderInline
                       * 会把一格文字拆成多个 <span>。多个 span 就成了多个 flex item，
                       * 每个都能被压到 min-content —— 于是「一句话」变成「一个字一列」
                       * 的竖排。这里把值包成一个 span，flex 里只有一个可伸缩项。
                       */}
                      <span className="frag-td-val">
                        {renderInline(row[ci] ?? "", `td-${ri}-${ci}`)}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 分隔线：原文里的 --- 有时是「以下是答案」的分界，画成一条细线而不是三个减号
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      out.push(<hr key={`hr-${key++}`} className="frag-hr" />);
      continue;
    }

    // 引用块：连续的 > 行
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      out.push(
        <div key={`q-${key++}`} className="frag-quote">
          <QuoteLines lines={quoted} keyBase={`q-${key}`} />
        </div>
      );
      continue;
    }

    // 有序列表：1. 2. 3.（目录、步骤都用这个形式）
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      i--;
      out.push(
        <ol key={`o-${key++}`} className="frag-ul frag-ol">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `oli-${ii}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      i--;
      out.push(
        <ul key={`u-${key++}`} className="frag-ul">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `li-${ii}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    para.push(trimmed);
  }
  flushPara();

  return <div className={`frag-md ${className}`.trim()}>{out}</div>;
}
