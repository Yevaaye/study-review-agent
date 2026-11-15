// 「答案按分号断行」回归：npm run check:textbreak
//
// 这条规则只管显示，但一旦写错就会**悄悄吃掉字符**，所以必须守住：
//   1. 拆出来的每一行拼回去 === 原文（一个字都不许丢、不许改）
//   2. 分号留在上一行末尾（不是被扔掉，也不是跑到下一行开头）
//   3. 没有分号的行原样返回（不该顺手换行）
//   4. 原有换行保留；分号紧挨换行不会产生空行
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { splitAtSemicolons, splitAnswerLines } = await import(
  pathToFileURL(path.join(root, "src/lib/text/linebreak.ts")).href
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

const join = (lines) => lines.join("");

// 1. 中文分号：三个分句断成三行，分号留在行尾
{
  const src = "先做背景梳理；再做能力举证；最后对齐岗位。";
  const lines = splitAtSemicolons(src);
  ok("中文分号断成 3 行", lines.length === 3, `got ${lines.length}`);
  ok("分号留在行尾", lines[0].endsWith("；") && lines[1].endsWith("；"));
  ok("拼回等于原文", join(lines) === src, JSON.stringify(lines));
}

// 2. 英文分号同等对待
{
  const src = "结论先行; 框架其次; 证据最后";
  const lines = splitAtSemicolons(src);
  ok("英文分号也断行", lines.length === 3, `got ${lines.length}`);
  // 分号后的空格被吞掉（否则每行开头会多一个缩进），可见字符必须全在
  ok(
    "英文分行可见字符守恒",
    join(lines).replace(/\s/g, "") === src.replace(/\s/g, "")
  );
  ok("英文分行不带前导空格", lines.every((l) => l === l.trimStart()), JSON.stringify(lines));
}

// 3. 没有分号 → 原样返回（不能顺手改写）
{
  const src = "有结论、有框架、有取舍、有验证。";
  const lines = splitAtSemicolons(src);
  ok("无分号不换行", lines.length === 1 && lines[0] === src);
}

// 4. 分号在行尾 + 已有换行：不产生空行、不重复断
{
  const src = "第一句；\n第二句";
  const lines = splitAnswerLines(src);
  ok("分号后紧跟换行不产生空行", lines.length === 2, JSON.stringify(lines));
  ok("原有换行内容守恒", join(lines).replace(/\n/g, "") === src.replace(/\n/g, ""));
}

// 5. 脏数据：连续分号不许丢字符，也不许留孤立行
{
  const src = "甲；；乙";
  const lines = splitAtSemicolons(src);
  ok("连续分号不丢字符", join(lines) === src, JSON.stringify(lines));
  ok("连续分号无空行", lines.every((l) => l.trim() !== ""), JSON.stringify(lines));
}

// 6. 真材料抽样：一段典型 AI 答案，行数应显著减少阅读难度（≥3 行）且完全守恒
{
  const src =
    "自我介绍按「背景—核心能力—项目证据—岗位匹配」展开，突出与岗位相关的成果；" +
    "日常用 AI 做资料检索、方案生成和代码辅助，并通过事实核验、交叉验证和复盘保证质量；" +
    "量化结果优先说清「做了什么、带来什么变化」。";
  const lines = splitAtSemicolons(src);
  ok("长答案断成 3 行", lines.length === 3, `got ${lines.length}`);
  ok("长答案逐字守恒", join(lines) === src);
  ok("每行都不为空且不以分号开头", lines.every((l) => l.trim() && !l.startsWith("；")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
