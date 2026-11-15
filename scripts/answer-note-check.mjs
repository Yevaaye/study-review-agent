// 「答案来源标注」文案与视觉层级回归：npm run check:note
//
// 守的是产品规则，不是像素：
//   1. origin 与 grounded 是两个维度：`origin=ai` 只说明文字是 AI 写的，
//      **不能**据此断言「原文未给出」（库里 271 张 ai+grounded=true 曾全被误标）
//   2. 金色档只说事实（原文未给出），不写「建议核对」这类劝导语
//   3. 有据档（grounded=true）必须交代「AI 整理」+「依据原文」，且绝不出现「原文未给出」
//   4. 未核对档（null）不断言原文有没有，也不转金色
//   5. 越危险越短：金色文案不得长于其余两档
//   6. 题干/答案的分区靠结构（.question-stem / .answer-block / .block-cap），
//      这三个类必须在 CSS 里定义，且旧的 .source-note-sub 已清掉
//   7. 两个页面都真的用上了这些类，并且真的把 grounded 传给了标注组件
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { answerNoteText, answerNoteHint, answerNoteIsWarn } = await import(
  pathToFileURL(path.join(root, "src/lib/ui/answer-note.ts")).href
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

const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
const cardsPage = fs.readFileSync(path.join(root, "src/app/cards/page.tsx"), "utf8");
const reviewPage = fs.readFileSync(path.join(root, "src/app/review/page.tsx"), "utf8");

// ---- 文案：三档各司其职 ----
const noBasis = answerNoteText(false); // 原文没有 → 金色
const grounded = answerNoteText(true); // 原文有据 → 灰色
const unknown = answerNoteText(null); // 未核对 → 灰色

ok("无据档只说「原文未给出」", noBasis === "原文未给出", noBasis);
ok("无据档不含劝导语「建议核对」", !/建议核对|请核对/.test(noBasis), noBasis);
ok("有据档绝不出现「原文未给出」", !/原文未给出|原文没|原文没有/.test(grounded), grounded);
ok("有据档交代「AI 整理」", /AI/.test(grounded) && /整理/.test(grounded), grounded);
ok("有据档交代依据来自原文", /原文/.test(grounded), grounded);
ok("未核对档不断言原文有无", !/原文未给出|原文没|依据原文/.test(unknown), unknown);
ok(
  "三档文案互不相同",
  new Set([noBasis, grounded, unknown]).size === 3,
  [noBasis, grounded, unknown].join(" | ")
);
ok(
  "越危险越短：金色最短",
  [...noBasis].length < [...grounded].length && [...noBasis].length <= [...unknown].length,
  `${noBasis}(${[...noBasis].length}) vs ${grounded}(${[...grounded].length}) vs ${unknown}(${[...unknown].length})`
);
ok(
  "只有 grounded=false 转金色",
  answerNoteIsWarn(false) === true && answerNoteIsWarn(true) === false && answerNoteIsWarn(null) === false
);
ok(
  "文案里不出现「建议/请」类劝导",
  !/建议|请/.test(noBasis + grounded + unknown),
  [noBasis, grounded, unknown].join(" / ")
);
ok(
  "劝导语只留在无据档的悬停解释里",
  /建议核对/.test(answerNoteHint(false)) && !/建议/.test(answerNoteHint(true))
);
ok(
  "悬停解释分三档且互不相同",
  new Set([answerNoteHint(false), answerNoteHint(true), answerNoteHint(null)]).size === 3
);
ok("有据档悬停不把「原文没有」说出口", !/原文没有/.test(answerNoteHint(true)), answerNoteHint(true));
ok("文案无首尾空白", (noBasis + grounded + unknown).trim() === noBasis + grounded + unknown);

// ---- 结构类 ----
ok("CSS 定义了 .question-stem", /\.question-stem\s*\{/.test(css));
ok("CSS 定义了 .answer-block（左侧竖线）", /\.answer-block\s*\{[^}]*border-left/.test(css));
ok("CSS 定义了 .block-cap", /\.block-cap\s*\{/.test(css));
ok("旧的 .source-note-sub 已移除", !/\.source-note-sub/.test(css));
ok("题干 17px 高于答案 15px", /\.question-stem\s*\{[^}]*1\.0625rem/.test(css));

// ---- 页面真的用上了 ----
ok("审核页题干用 .question-stem", /className="question-stem/.test(cardsPage));
ok("审核页答案包在 .answer-block 里", /className="answer-block/.test(cardsPage));
ok("审核页答案有「参考答案」小标题", /block-cap">参考答案/.test(cardsPage));
ok("审核页页脚有 hairline 分隔", /border-t border-border\/50 pt-2\.5 micro/.test(cardsPage));
ok("复习页题干贴「题目」标签", /block-cap">题目/.test(reviewPage));
ok("复习页答案贴「参考答案」标签", /block-cap">参考答案/.test(reviewPage));
ok("两页都通过组件渲染标注（不手写文案）", !/答案由 AI 提供/.test(cardsPage + reviewPage));

// ---- 关键：grounded 必须真的被传下去 ----
// 只传 origin 的话，组件永远拿不到 true，有据档就永远走不到。
const cardsPassGrounded = /<AnswerSourceNote[\s\S]{0,200}?grounded=\{c\.answer_grounded\}/.test(cardsPage);
const reviewPassGrounded = /<AnswerSourceNote[\s\S]{0,200}?grounded=\{card\.answer_grounded\}/.test(reviewPage);
ok("审核页把 grounded 传给标注组件", cardsPassGrounded);
ok("复习页把 grounded 传给标注组件", reviewPassGrounded);
ok(
  "没有把 origin=ai 直接映射成「原文未给出」的旧写法",
  !/origin\s*===\s*["']ai["'][^\n]*["']原文未给出["']/.test(cardsPage + reviewPage)
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
