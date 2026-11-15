// 存量「多选」回填 —— node scripts/backfill-multi.mjs [--dry]
//
// 背景：旧版本把「答案：①②③」整串存进 answer，复习页按「整串等于某个选项」比对，
// 于是三个正确项一个都不高亮、判题必然错。新版本支持多选后，
// 存量卡需要按新规则重算一遍 answers / answer / is_multi。
//
// 只处理「能解析出 ≥2 个正确项」的卡：
//   · 单选卡不动（解析结果可能与旧标注不一致，贸然改会把对的改错）；
//   · 解析不出来的卡也不动，交给复习页「错误 → 标注正确答案」人工处理。
//
// 走 HTTP 而不是直接改 db.json：服务在跑时直接改文件会和内存副本打架，
// 而且用接口能把「改了哪张、改成了什么」留在同一条链路上。
//
// 用法：node scripts/backfill-multi.mjs          # 真跑
//       node scripts/backfill-multi.mjs --dry    # 只看会改哪些

import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 落回原路径 */
      }
    }
    return next(specifier, context);
  },
});

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DRY = process.argv.includes("--dry");
const K = await import(
  pathToFileURL("F:/projects/study-review-agent/src/lib/cards/answer-keys.ts").href
);

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

const health = await jsonOf(await fetch(`${BASE}/api/health`));
if (health.ok !== true) {
  console.error(`服务不可达：${BASE}`);
  process.exitCode = 1;
  process.exit(0);
}

const all = await jsonOf(await fetch(`${BASE}/api/cards?status=all`));
const cards = all.cards ?? [];
const choice = cards.filter((c) => Array.isArray(c.options) && c.options.length >= 2);

let changed = 0;
let skipped = 0;
let failed = 0;

for (const c of choice) {
  const parsed = K.parseAnswerKeys(c.answer, c.options);
  const alreadyMulti = c.is_multi === true && Array.isArray(c.answers) && c.answers.length > 1;
  if (parsed.keys.length < 2) {
    skipped++;
    continue;
  }
  if (alreadyMulti) {
    skipped++;
    continue;
  }
  const labels = K.answerLabels(parsed.keys);
  if (DRY) {
    console.log(`[dry] ${c.id}  ${c.front.slice(0, 34)}  ${c.answer} → ${labels}`);
    changed++;
    continue;
  }
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(c.id)}/answer-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // backfill=true：这类是「旧版本没解析出来」，不是用户纠错，不写错误台账
    body: JSON.stringify({ keys: parsed.keys, backfill: true }),
  });
  const out = await jsonOf(res);
  if (res.ok && out.ok === true) {
    changed++;
    console.log(`✓ ${c.front.slice(0, 34)}  → ${out.answer}`);
  } else {
    failed++;
    console.log(`✗ ${c.id}  ${JSON.stringify(out).slice(0, 120)}`);
  }
}

console.log(
  `\n共 ${choice.length} 张选择题：${DRY ? "待改" : "已改"} ${changed}，跳过 ${skipped}，失败 ${failed}`
);
process.exitCode = failed === 0 ? 0 : 1;
