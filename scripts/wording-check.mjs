// 复习界面文案与版式护栏（纯文本 + 纯函数，不需要服务在跑）
//
// 为什么给「文案」也写测试：这句状态在三个页面各出现过一次，靠人工记住
// 显然不现实 —— 真实事故就是「书库里写着已复习，首页还写着没有到期」。
// 这里把两件事钉住：
//   1) 对外只说「已复习」，不再出现「无到期 / 没有到期 / 今日已复习完」；
//   2) 复习页与卡片审核页使用宽容器（max-w-5xl）+ 收窄的内边距，
//      防止以后复制粘贴别的页面时又退回 4xl 的窄条。
//
// 用法：npm run check:wording

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) {
      try {
        return next(`${spec}.ts`, ctx);
      } catch {
        /* 落回原样 */
      }
    }
    return next(spec, ctx);
  },
});

const ROOT = path.resolve(import.meta.dirname, "..");
const L = await import(pathToFileURL(path.join(ROOT, "src/lib/review/labels.ts")).href);

let pass = 0;
let fail = 0;
function chk(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}

// ---- 1) 标签函数 ----
chk("没有待复习 → 已复习", L.reviewedLabel(0) === "已复习", String(L.reviewedLabel(0)));
chk("有待复习 → 不抢数字的位置（返回 null）", L.reviewedLabel(7) === null);
chk("负数（脏数据）也按已复习处理", L.reviewedLabel(-1) === "已复习");
chk("对外常量就是「已复习」", L.REVIEWED_LABEL === "已复习");

// ---- 2) 界面里不许再出现易误读的说法 ----
const FORBIDDEN = ["无到期", "没有到期", "今日已复习完"];
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    // 只看 .tsx：用户能看到的字都在这里。.ts 里的历史注释会提到旧说法，
    // 那是解释为什么改，不是界面文案。
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
})(path.join(ROOT, "src"));

chk("扫到界面文件（防护栏本身没瞎跑）", files.length > 20, `got ${files.length}`);

for (const word of FORBIDDEN) {
  const hits = files
    .filter((f) => fs.readFileSync(f, "utf8").includes(word))
    .map((f) => path.relative(ROOT, f));
  chk(`界面里不再出现「${word}」`, hits.length === 0, hits.join(", "));
}

// 三个入口必须都走同一套标签，避免又有人手打一遍
for (const rel of ["src/app/review/page.tsx", "src/app/stats/page.tsx"]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  chk(`${rel} 用统一标签`, /REVIEWED_LABEL|reviewedLabel/.test(src));
}

// ---- 3) 版式：复习/审核页用宽容器 ----
const shell = fs.readFileSync(path.join(ROOT, "src/components/app-shell.tsx"), "utf8");
chk("复习页与审核页登记为宽版式", /WIDE_ROUTES[\s\S]{0,80}\/review[\s\S]{0,80}\/cards/.test(shell));
chk("宽版式用 max-w-5xl（阅读页仍是 4xl）", shell.includes("max-w-5xl") && shell.includes("max-w-4xl"));

const reviewPage = fs.readFileSync(path.join(ROOT, "src/app/review/page.tsx"), "utf8");
chk(
  "题干 / 参考答案卡不再用 p-7、p-8 的大内边距",
  !/card p-7/.test(reviewPage) && !/md:p-8/.test(reviewPage),
  "仍然存在大内边距"
);

const cardsPage = fs.readFileSync(path.join(ROOT, "src/app/cards/page.tsx"), "utf8");
chk("审核卡内边距不超过 16px（p-4）", /card[^`"]*p-4/.test(cardsPage));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
