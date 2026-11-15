// 存量卡片保真回填 —— 给历史导入的原题卡补上 fidelity_status。
//
// 为什么需要单独一步：保真核对是后加的，494 张存量卡没有这个字段。
// 不补的话，章节页对老材料永远显示「未做保真核对」——「可核对」就成了空话。
//
// 用法：
//   node scripts/backfill-fidelity.mjs           # 只统计，不写盘
//   node scripts/backfill-fidelity.mjs --write   # 写回 data/db.json
//   node scripts/backfill-fidelity.mjs --write --force  # 已算过的也重算
//
// 判据与运行时完全一致（同一个 checkFidelity），haystack 取「该卡所属材料的全部正文片段」。
// 不用单个片段：片段关联在导入时是启发式的（找不到就退化为本章第一个片段），
// 用单片段会把正常题误判成 missing。

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* fallback */
      }
    }
    return next(specifier, context);
  },
});

const here = path.dirname(pathToFileURL(process.argv[1] ?? import.meta.url).pathname.replace(/^\//, ""));
const root = path.resolve(here, "..");
const dbPath = path.join(root, "data/db.json");

const { checkFidelity } = await import(
  pathToFileURL(path.join(root, "src/lib/import/fidelity.ts")).href
);

const write = process.argv.includes("--write");
const force = process.argv.includes("--force");

const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const cards = db.cards ?? [];
const frags = db.source_fragments ?? [];
const links = db.card_sources ?? [];

const fragById = new Map(frags.map((f) => [f.id, f]));
const fragTextByBook = new Map();
for (const f of frags) {
  if (f.deleted_at) continue;
  const arr = fragTextByBook.get(f.textbook_id) ?? [];
  arr.push(f.content ?? "");
  fragTextByBook.set(f.textbook_id, arr);
}
const hayByBook = new Map(
  [...fragTextByBook.entries()].map(([id, arr]) => [id, arr.join("\n")])
);
const allHay = frags.map((f) => f.content ?? "").join("\n");

// 卡 → 材料
const bookByCard = new Map();
for (const l of links) {
  const f = fragById.get(l.source_fragment_id);
  if (f && !bookByCard.has(l.card_id)) bookByCard.set(l.card_id, f.textbook_id);
}

const stats = { exact: 0, partial: 0, missing: 0, skipped: 0, total: 0 };
const samples = { partial: [], missing: [] };
let changed = 0;

for (const c of cards) {
  if (c.deleted_at) continue;
  if (c.source === "ai_generated") {
    stats.skipped++; // AI 卡由 evidence 闸门把关，不适用字面回查
    continue;
  }
  if (c.fidelity_status && !force) {
    stats[c.fidelity_status] = (stats[c.fidelity_status] ?? 0) + 1;
    continue;
  }
  stats.total++;

  const bookId = bookByCard.get(c.id);
  const hay = (bookId && hayByBook.get(bookId)) || allHay;

  const r = checkFidelity(
    {
      question_text: c.front ?? "",
      options: c.options ?? null,
      answer: c.answer ?? c.back ?? null,
    },
    hay
  );

  stats[r.status]++;
  if (r.status !== "exact" && samples[r.status].length < 8) {
    samples[r.status].push({
      no: c.question_no ?? null,
      front: String(c.front ?? "").slice(0, 70),
      note: r.note,
    });
  }
  if (write) {
    c.fidelity_status = r.status;
    c.fidelity_note = r.note || null;
    changed++;
  }
}

console.log(`原题卡 ${stats.total} 张（AI 卡跳过 ${stats.skipped}）`);
console.log(`  原文逐字 ${stats.exact}`);
console.log(`  部分匹配 ${stats.partial}`);
console.log(`  原文未找到 ${stats.missing}`);

for (const [k, list] of Object.entries(samples)) {
  if (list.length === 0) continue;
  console.log(`\n${k} 样例：`);
  for (const s of list) console.log(`  [${s.no ?? "-"}] ${s.front}\n      ${s.note}`);
}

if (write) {
  if (changed > 0) {
    const backup = `${dbPath}.pre-fidelity-${Date.now()}`;
    fs.copyFileSync(dbPath, backup);
    fs.writeFileSync(dbPath, JSON.stringify(db));
    console.log(`\n已写入 ${changed} 张，备份：${path.basename(backup)}`);
  } else {
    console.log("\n没有需要写入的卡");
  }
} else {
  console.log("\n（预览模式，未写盘。加 --write 生效）");
}
