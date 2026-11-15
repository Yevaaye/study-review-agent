// 全文收录页「片段定位」回归：验证每个片段都能在原文里被切出来。
// 运行：npm run check:anchor
//
// 起因（2026-11-05 用户反馈「明明有题目为什么检测不到」）：
// 导入时每行都被 trim 过（`   ↓` → `↓`、Markdown 硬换行去掉行尾两空格），
// 而全文页拿片段内容直接去原文里 indexOf —— 带题目/卡片的片段恰好都有这些行，
// 于是全书的题都定位失败，统计标签整块消失，只剩上一段那句「暂无卡片」。
// 2501 个片段里 148 个失败时，23 张卡一张都没显示出来，肉眼完全看不出来是定位问题。
//
// 这个脚本守的就是这条不变量：**有卡片的片段必须能定位**。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { segmentRaw } = await import(
  pathToFileURL(path.join(root, "src/lib/read/segment.ts")).href
);

const db = JSON.parse(fs.readFileSync(path.join(root, "data/db.json"), "utf8"));

const withCards = new Set(db.card_sources.map((cs) => cs.source_fragment_id));
const frags = db.source_fragments;

let pass = 0;
let fail = 0;
const failLines = [];

console.log("片段定位回归\n");

for (const t of db.textbooks) {
  if (!t.raw_text || !t.raw_text.trim()) {
    console.log(`  · ${t.title}：没有保存原文，跳过`);
    continue;
  }
  const mine = frags
    .filter((f) => f.textbook_id === t.id)
    .sort((a, b) => a.fragment_index - b.fragment_index);
  if (mine.length === 0) continue;

  const raw = t.raw_text.replace(/\r\n/g, "\n");
  const anchored = new Set(
    segmentRaw(raw, mine)
      .filter((b) => b.kind === "frag")
      .map((b) => b.frag.id)
  );
  const missing = mine.filter((f) => !anchored.has(f.id));
  const missingCards = missing.filter((f) => withCards.has(f.id));

  const ok = missingCards.length === 0;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${t.title}\n` +
      `      片段 ${mine.length} / 已定位 ${anchored.size} / 未定位 ${missing.length}` +
      ` / 其中带卡片 ${missingCards.length}`
  );
  for (const f of missingCards.slice(0, 3)) {
    failLines.push(`${t.title} :: ${f.locator}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("\n这些片段带卡片却定位不到 —— 全文页会把它们渲染成纯文本，卡片标签全部丢失：");
  for (const l of failLines) console.log("  -", l);
  process.exit(1);
}
console.log("所有带卡片的片段都能在原文里定位到。");
