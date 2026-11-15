// Markdown 解析回归测试：验证「章节识别 + 目录/正文区分」在各格式下都正确。
// 运行：npm run parse:check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Windows 下必须转成 file:// URL，直接用绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const { parseMarkdown } = await import(
  pathToFileURL(path.join(here, "../src/lib/import/markdown.ts")).href
);

const cases = [
  {
    name: "A. 目录用「1.」+ 正文用「一、」（最常见的混排）",
    md: `目录
1. 第一章
2. 第二章

一、第一章
正文一。

二、第二章
正文二。`,
    expect: ["一、第一章", "二、第二章"],
  },
  {
    name: "B. 无目录，正文直接用「一、」",
    md: `一、第一章
正文一。

二、第二章
正文二。`,
    expect: ["一、第一章", "二、第二章"],
  },
  {
    name: "C. 目录 + 正文都用数字（旧格式，不能回归）",
    md: `目录
1. 第一章
2. 第二章

1. 第一章
正文一。

2. 第二章
正文二。`,
    expect: ["1 第一章", "2 第二章"],
  },
  {
    name: "D. 目录 + 正文用「第X章」",
    md: `目录
1. 第一章
2. 第二章

第一章 第一章
正文一。

第二章 第二章
正文二。`,
    expect: ["第一章 第一章", "第二章 第二章"],
  },
  {
    name: "E. 纯 Markdown 标题（不能回归）",
    md: `# 第一章

正文一。

## 第二节

正文二。

# 第二章

正文三。`,
    expect: ["第一章", "第二节", "第二章"],
  },
  {
    name: "F. 列表项伪装成编号（不能误判成章）",
    md: `一、真实章节
正文。

1. Client Hello
2. Server Hello
3. Certificate`,
    expect: ["一、真实章节"],
  },
  {
    name: "G. 「一、」开头的正文句子（不能误判成标题）",
    md: `一、真实章节
边界澄清：
一、AIPM 不是算法工程师：不必会训练模型。
二、也不是纯需求翻译。

二、下一章
正文。`,
    expect: ["一、真实章节", "二、下一章"],
  },
  {
    name: "H. 目录项后面没有同名正文标题 → 目录项本身不当章节",
    md: `1. 列表一
2. 列表二
3. 列表三

正文段落一。

正文段落二。`,
    expect: ["全文"],
  },
  {
    name: "I. 目录同名锚点：章标题紧跟编号列表时靠同名救回（编号守卫会误杀）",
    md: `目录
1. Alpha
2. Beta
3. Gamma

一、Alpha
Alpha 正文。

二、Beta
Beta 开头。
1. 子步骤一
2. 子步骤二
三、Gamma
Gamma 正文。`,
    expect: ["一、Alpha", "二、Beta", "三、Gamma"],
  },
];

let pass = 0;
for (const c of cases) {
  const got = parseMarkdown(c.md).chapters.map((x) => x.title);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}`);
  if (!ok) {
    console.log(`   期望: ${JSON.stringify(c.expect)}`);
    console.log(`   实际: ${JSON.stringify(got)}`);
  }
}

// 完整样本（目录 9 项 + 正文 9 章 + 紧凑排版）
const sample = path.join(here, "fixtures/aipm-sample.md");
if (fs.existsSync(sample)) {
  const r = parseMarkdown(fs.readFileSync(sample, "utf8"));
  const titles = r.chapters.map((c) => c.title);
  const ok =
    titles.length === 9 &&
    titles.every((t) => /^[一二三四五六七八九十]+、/.test(t)) &&
    !titles.some((t) => /^\d+\s/.test(t)) &&
    !r.chapters[0].fragments[0]?.content.includes("角色定位与能力模型");
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} J. 完整样本：9 章中文序号、目录不混入正文`);
  if (!ok) console.log(`   实际: ${titles.join(" | ")}`);
  const total = cases.length + 1;
  console.log(`\n${pass}/${total} 通过`);
} else {
  console.log(`\n${pass}/${cases.length} 通过（未找到 fixtures/aipm-sample.md，跳过完整样本）`);
}
