// Markdown 标题层级归一 —— 在 parseMarkdown **之前**做，不改其内部任何一行。
//
// 要解决的问题（实测）：
//   标准 Markdown 写法是 `# 章` + `## 节`。但解析器的规则是「`##` 无条件成章」
//   （因为纯文本资料里 `##` 也常被当章用）。于是 `#` 章刚建立、还没有正文，
//   就被紧随其后的 `##` 另起一章，最后因「空章」被清理掉 ——
//   一本 6 章的书会变成 6 个 `## 节`，章标题全部错位。
//
// 修法：如果文档里出现 **≥2 个 `#` 标题**，说明作者确实在用 `#` 当章级，
// 那么把 `##` 及更深的标题整体降一级（`##`→`###`），让它们退回到「小节」，
//   不再抢章的位置。`#` 标题本身不动。
//
// 只有一个或零个 `#` 时不处理 —— 那种文档多半是「通篇用 `##` 当章」，
// 保持原行为，避免把整本书压成一个章。
//
// 行数不变、标题文字不变，所以：
//   · parseMarkdown 切出来的章标题文本与原文逐字一致
//   · 下游按标题文本回找行号（locateChapters）仍然对得上

export function normalizeMarkdownHeadings(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  // 代码块里的 # 不是标题，必须跳过（否则会把注释行改坏）
  let inFence = false;
  let level1Count = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#\s+\S/.test(line)) level1Count++;
  }

  if (level1Count < 2) return markdown;

  inFence = false;
  const out = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const m = line.match(/^(#{1,6})(\s+.*)$/);
    if (!m) return line;
    const level = m[1].length;
    // level 1 保持；2..5 各加一个 #；6 已是上限，原样保留（仍只作 heading_path）
    if (level === 1 || level === 6) return line;
    return `${"#".repeat(level + 1)}${m[2]}`;
  });

  return out.join("\n");
}
