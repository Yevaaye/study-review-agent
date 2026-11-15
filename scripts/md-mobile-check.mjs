// 「MD 手机端排版自动修复」回归：npm run check:mdfix
//
// 守三条不变量（对应规范 §5 验收清单）：
//   1. 行内拆行没改一个字（去掉 <br> 后归一化必须完全相等）
//   2. 表格转卡片后每个单元格文本都在，卡片数 = 数据行数
//   3. 代码块逐字未动；答案行 `A.①②③` 不得被拆成 <br>①
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const M = await import(
  pathToFileURL(path.join(root, "src/lib/import/md-mobile-fix.ts")).href
);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  ← " + extra : ""}`);
  }
};

const norm = (s) => s.replace(/<br\s*\/?>/gi, "").replace(/\s+/g, "");

console.log("MD 手机端排版修复\n");

// ── 1. 行内枚举：题干里 5 个圈号 → 4 个换行 ──────────────────────────
{
  const line =
    "下列关于经济工作的说法，正确的有几项？ ①必须充分挖掘经济潜能 ②必须坚持政策支持 ③必须做到既「放得活」又「管得好」 ④必须坚持投资于物 ⑤必须以苦练内功应对外部挑战";
  const r = M.expandInlineEnumeration(line);
  ok("题干圈号插 4 个换行", r.inserted === 4, `inserted=${r.inserted}`);
  ok("题干内容守恒", M.verifyInlineConserved(line, r.text));
  ok("每项独立成行", (r.text.match(/<br>/g) || []).length === 4);
}

// ── 2. 答案行：A.①②③ B.①②④ 只拆字母、绝不拆圈号 ──────────────────
{
  const line = "A.①②③ B.①②④ C.①③④ D.②③④";
  const r = M.expandInlineEnumeration(line);
  ok("答案行 4 个选项分行", r.inserted === 3, `inserted=${r.inserted}`);
  ok("答案行无 <br>①", !/<br>[①②③④⑤]/.test(r.text), r.text);
  ok("答案行内容守恒", M.verifyInlineConserved(line, r.text));
}

// ── 3. 保护区：代码块 / 行内代码 ────────────────────────────────────
{
  const md = ["```", "① a ② b", "| x | y |", "```"].join("\n");
  const { text, report } = M.normalizeMarkdownForMobile(md);
  ok("代码块逐字未动", text === md, JSON.stringify(text));
  ok("代码块不计入 br", report.brInserted === 0);

  const inline = "这段有 `① ②` 行内代码 ①甲 ②乙";
  const r = M.expandInlineEnumeration(inline);
  ok("含反引号的行不处理", r.text === inline && r.inserted === 0);
}

// ── 4. 宽表 → 卡片 ─────────────────────────────────────────────────
{
  const long = "坚持内需主导，建设强大国内市场，提振消费专项行动，制定实施城乡居民增收计划".repeat(2);
  const md = [
    "| 序号 | 主题 | 核心举措 |",
    "| --- | --- | --- |",
    `| 一 | 内需主导 | ${long} |`,
    `| 二 | 创新驱动 | ${long} |`,
  ].join("\n");
  const { text, report } = M.normalizeMarkdownForMobile(md);
  ok("宽表命中并转换", report.tablesConverted === 1, JSON.stringify(report.warnings));
  ok("转出 2 张卡片", (text.match(/^#### /gm) || []).length === 2);
  ok("卡片带表头标记", text.includes("**核心举措**："));
  ok("表格内容守恒", report.checks.tablesConserved);
}

// ── 5. 窄表不动（2 列 / 短单元格） ──────────────────────────────────
{
  const md = ["| 错误表述 | 正确表述 |", "| --- | --- |", "| 物价合理下降 | 物价合理回升 |"].join("\n");
  const { text, report } = M.normalizeMarkdownForMobile(md);
  ok("2 列短表原样保留", text === md && report.tablesConverted === 0);
}

// ── 6. 真实材料全篇跑一遍（库里已导入的原文） ────────────────────────
{
  const dbPath = path.join(root, "data/db.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const book = (db.textbooks ?? []).find((t) => (t.raw_text ?? "").length > 5000);
  if (!book) {
    console.log("  SKIP  真实材料：库里没有足够大的原文");
  } else {
    const src = book.raw_text;
    const { text, report } = M.normalizeMarkdownForMobile(src);
    console.log(
      `  · 《${book.title}》 切块 ${report.blocks} / 转卡片 ${report.tablesConverted} / 插入 <br> ${report.brInserted}`
    );
    ok("三项自检全绿", Object.values(report.checks).every(Boolean), JSON.stringify(report.checks));
    ok("无 warnings", report.warnings.length === 0, report.warnings.join("；"));
    ok("答案行零误拆", M.badAnswerLines(text).length === 0, M.badAnswerLines(text)[0] ?? "");
    // 字符守恒：无表格转换时必须逐字相等；有转换时表格部分由「内容守恒」
    // （每个单元格文本必须完整出现）保证，不能按全文比 —— `#### ` / `**表头**：`
    // 这些结构标记本来就会新增字数。
    if (report.tablesConverted === 0) {
      ok("全篇字符守恒", norm(src) === norm(text));
    } else {
      ok("表格外文本守恒", report.checks.inlineConserved && report.checks.tablesConserved);
    }

    // 代码块逐字未动
    const fences = M.splitBlocks(src).filter((b) => b.kind === "code");
    ok(
      "代码块全部保留",
      fences.every((b) => text.includes(b.text)),
      `${fences.length} 块`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
