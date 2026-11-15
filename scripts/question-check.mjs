// 原题抽取回归测试：验证 classify.ts 在各类真实排版下「该抽的抽出来、不该成题的不成题」。
// 运行：npm run check:questions
//
// 起因（2026-11-05 真实事故）：材料整章没有空行 + 小节标题写成 `a) 回答结构框架`，
// 抽取器把每个题的 `a)` 都当成选项 A 收进同一张卡，产出「题干 15626 字、8 个 A 选项、
// 无答案」的假选择题，出现在卡片审核台里。
//
// 根因两层：
//   1) parseOptionLine 每行都从 A 开始期待字母，分行书写的 B/C/D 被当成「不连续」丢掉
//      → 分行排版的选择题永远抽不出来，只有 A 能通过；
//   2) 块切分依赖空行，整章无空行时整章并成一块，多个 A 就在一题内累积。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { extractQuestions } = await import(
  pathToFileURL(path.join(here, "../src/lib/import/classify.ts")).href
);

const chapters = [{ title: "第一章 测试", heading_path: "第一章 测试", fragments: [] }];

const cases = [
  {
    name: "标准选择题：选项分行 + 答案",
    md: `# 第一章 测试

1. 下列哪个是 HTTP 状态码 404 的含义？
A. 服务器错误
B. 资源未找到
C. 重定向
D. 请求超时
答案：B`,
    expect: { count: 1, type: "choice", options: 4, answer: "资源未找到" },
  },
  {
    name: "一行塞多个选项 A. B. C. D.",
    md: `# 第一章 测试

1. 一个字节等于多少位？
A.2 项 B.3 项 C.4 项 D.5 项
答案：A`,
    expect: { count: 1, type: "choice", options: 4 },
  },
  {
    name: "小写字母选项 a) b) c) d)",
    md: `# 第一章 测试

1. 下列哪项属于监督学习？
a) 线性回归
b) K-Means
c) PCA
d) 关联规则
答案：a`,
    expect: { count: 1, type: "choice", options: 4, answer: "线性回归" },
  },
  {
    name: "问答对",
    md: `# 第一章 测试

1. 问：什么是 CAP 理论？
答：一致性、可用性、分区容错性三者不可同时满足。`,
    expect: { count: 1, type: "qa" },
  },
  {
    name: "填空题",
    md: `# 第一章 测试

1. TCP 三次握手的第二步是 ______ 。
答案：SYN+ACK`,
    expect: { count: 1, type: "cloze" },
  },
  {
    name: "判断题",
    md: `# 第一章 测试

1. HTTP 是无状态协议。（对/错）
答案：对`,
    expect: { count: 1, type: "judge" },
  },
  {
    name: "整章无空行、多题混成一块（原事故形态）",
    md: `# 第一章 测试

一、总览：怎么准备
面试准备的核心是把面试拆成板块。
1. 自我介绍：讲清背景与优势
A. 回答结构框架
B. 只有结论
1. 技术选型：为什么用 RAG
A. 先看不同公司的题目
B. 先做评测
1. 项目复盘：怎么讲落地
A. 定位根因
B. 讲结果
1. 业务理解
A. 全局定位
B. 只讲功能
1. 行为面
A. 讲冲突
B. 讲协作
1. 反问环节
A. 问团队
B. 问流程`,
    expect: { count: 0 },
  },
  {
    name: "小节标题 a) b) 后接正文编号（不应成题）",
    md: `# 第一章 测试

a) 回答结构框架
1. 我是谁：一句话说清背景。
2. 相关经历：两项核心优势。
b) 模板
我叫某某，毕业院校是……
c) 注意事项
不要背稿，控制在 90 秒。`,
    expect: { count: 0 },
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const { questions } = extractQuestions(c.md, chapters);
  const e = c.expect;
  const checks = [[`题数 ${questions.length}`, questions.length === e.count]];
  if (e.type) checks.push([`类型 ${questions[0]?.type}`, questions[0]?.type === e.type]);
  if (e.options) {
    checks.push([`选项数 ${questions[0]?.options?.length}`, questions[0]?.options?.length === e.options]);
  }
  if (e.answer) checks.push([`答案 ${questions[0]?.answer}`, questions[0]?.answer === e.answer]);

  const ok = checks.every(([, v]) => v);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    for (const [label, v] of checks) if (!v) console.log(`          ✗ ${label}`);
    console.log(
      "          实得:",
      JSON.stringify(
        questions.map((q) => ({ t: q.type, o: q.options?.length, a: q.answer, f: q.front.slice(0, 30) }))
      ).slice(0, 240)
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
