"use client";

import type { ReactNode } from "react";
import { splitAnswerLines } from "@/lib/text/linebreak";
import { parseAnswerBlocks, type AnswerAlign } from "@/lib/cards/answer-format";

/**
 * 答案正文渲染。
 *
 * 两层逻辑，互不干扰：
 * 1）纯文本答案：按分号断行（原行为，一个字都不改）—— 中文答案常把要点用「；」
 *    串成一大段，断行后好扫读；`trailing` 挂在最后一行末尾，让来源标注紧贴答案。
 * 2）结构化答案：答案里出现表格 / 列表 / 引用 / 标题时，渲染成真正的结构。
 *    触发条件是「解析出了表格或列表」，不是「看起来像」—— 普通一段话不会被
 *    误拆成列表，这条边界由 answer-format.ts 的解析器保证。
 *
 * 为什么要有第 2 层：模型给的对比类答案本来是 Markdown 表格，落库时换行被压成
 * 空格，复习页按纯文本渲染就成了「|框架|执行权限|...|」一整串竖线。
 */
export function AnswerText({
  text,
  className = "",
  trailing,
}: {
  text: string;
  className?: string;
  trailing?: ReactNode;
}) {
  const blocks = parseAnswerBlocks(text);
  const structured = blocks.some((b) => b.type !== "text") || blocks.length > 1;

  if (!structured) {
    const lines = splitAnswerLines(text);
    if (lines.length <= 1) {
      return (
        <span className={className}>
          {text}
          {trailing}
        </span>
      );
    }
    return (
      <span className={className}>
        {lines.map((line, i) => (
          <span key={i} className="block">
            {renderInline(line, `l${i}`)}
            {i === lines.length - 1 ? trailing : null}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <div key={i} className="pt-1 text-[13px] font-medium text-muted">
                {renderInline(block.text, `h${i}`)}
              </div>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-line pl-3 text-fg/75 [&>span]:block"
              >
                {block.text.split("\n").map((line, j) => (
                  <span key={j}>{renderInline(line, `q${i}-${j}`)}</span>
                ))}
              </blockquote>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={i}
                className={`space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
              >
                {block.items.map((item, j) => (
                  <li key={j} className="pl-0.5">
                    {renderInline(item, `li${i}-${j}`)}
                  </li>
                ))}
              </ListTag>
            );
          }
          case "table":
            return (
              <AnswerTable
                key={i}
                header={block.header}
                rows={block.rows}
                align={block.align}
                id={`t${i}`}
              />
            );
          default:
            return (
              <p key={i} className="m-0">
                {splitAnswerLines(block.text).map((line, j) => (
                  <span key={j} className="block">
                    {renderInline(line, `p${i}-${j}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
      {trailing ? <div className="text-[11px] text-muted">{trailing}</div> : null}
    </div>
  );
}

const ALIGN_STYLE: Record<AnswerAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/**
 * 表格：窄屏（手机）允许横向滚动 —— 四列对比表在 360px 宽下不可能不挤，
 * 挤压换行比滚动更难读，所以选择「保持列宽、整表可滑」。
 */
function AnswerTable({
  header,
  rows,
  align,
  id,
}: {
  header: string[];
  rows: string[][];
  align: AnswerAlign[];
  id: string;
}) {
  const cellClass = (i: number) =>
    `px-3 py-2 align-top ${ALIGN_STYLE[align[i] ?? "left"]}`;

  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-line">
      <table className="w-full min-w-max border-collapse text-[13.5px] leading-[1.7]">
        <thead>
          <tr className="bg-surface-2">
            {header.map((h, i) => (
              <th
                key={i}
                scope="col"
                className={`border-b border-line font-medium text-fg/90 ${cellClass(i)}`}
              >
                {renderInline(h, `${id}-th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-line last:border-b-0">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`${cellClass(ci)} ${ci === 0 ? "text-fg/90" : "text-fg/80"}`}
                >
                  {cell ? renderInline(cell, `${id}-td${ri}-${ci}`) : <span className="text-muted/40">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 行内格式：只认 **粗体** 与 `代码`。
 *
 * 刻意不做完整 Markdown：答案里的 `_`、`*` 常出现在公式和型号里
 * （如 `gpt-4o_mini`、`5*5`），全量解析会把它们吃掉。
 */
function renderInline(text: string, keyBase: string): ReactNode {
  if (!text) return null;
  if (!/\*\*[^*\n]+\*\*|`[^`\n]+`/.test(text)) return text;
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-medium text-fg">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={`${keyBase}-${i}`}
          className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.92em] text-fg/90"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyBase}-${i}`}>{part}</span>;
  });
}
