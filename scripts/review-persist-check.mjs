// 复习断点的纯函数契约：进度汇总 / 续接文案 / 按书挑轮次
//
// 守的是用户这次的需求：
//   在 A 书复习到一半 → 跳去别的页面 → 回来要能**接上**，而且要看得清
//   「已完成多少、还剩多少、下一张是第几张」。
//
// 这些都是纯函数，不需要起服务：
//   summarizeProgress  —— 已完成 / 待复习 / 下一张 / 百分比
//   resumeHintText     —— 「已回到上次的中断处 · 第 9 张 / 共 30 张（前面 8 张已复习）」
//   progressLabel      —— 页头的「已完成 8 · 待复习 22」
//   latestPerScope     —— 同一范围只留最新一轮（避免选书页出现三行同一本书）
//   pickSessionForBook —— 从书详情进来时只认这本书的轮次
//
// 用法：npm run check:reviewpersist

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

const P = await import(
  pathToFileURL("F:/projects/study-review-agent/src/lib/review/resume.ts").href
);

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

// ---- summarizeProgress ----
const empty = P.summarizeProgress([]);
chk("空队列：总数为 0", empty.total === 0 && empty.rated === 0 && empty.remaining === 0);
chk("空队列：下一张 -1（不假装有第 0 张）", empty.nextIndex === -1);
chk("空队列：百分比 0（不出现 NaN）", empty.percent === 0, String(empty.percent));

const part = P.summarizeProgress([
  { rated: true },
  { rated: true },
  { rated: true },
  { rated: false },
  { rated: false },
]);
chk("部分作答：总数 5 / 已答 3 / 未答 2", part.total === 5 && part.rated === 3 && part.remaining === 2);
chk("部分作答：下一张是第 4 张（下标 3）", part.nextIndex === 3, String(part.nextIndex));
chk("部分作答：百分比 60", part.percent === 60, String(part.percent));

const gaps = P.summarizeProgress([{ rated: true }, { rated: false }, { rated: true }]);
chk(
  "中间有空档：下一张指向最靠前的未答（下标 1，而不是跳到末尾）",
  gaps.nextIndex === 1,
  String(gaps.nextIndex)
);

const all = P.summarizeProgress([{ rated: true }, { rated: true }]);
chk("全答完：下一张 -1", all.nextIndex === -1);
chk("全答完：待复习 0 / 百分比 100", all.remaining === 0 && all.percent === 100);

// ---- 文案 ----
chk(
  "首次开始：说明从第 1 张起，不谎称「回到中断处」",
  P.resumeHintText({ total: 5, rated: 0, remaining: 5, nextIndex: 0, percent: 0 }) ===
    "从第 1 张开始 · 共 5 张",
  P.resumeHintText({ total: 5, rated: 0, remaining: 5, nextIndex: 0, percent: 0 })
);

const midText = P.resumeHintText(part);
chk("中途续接：写明第几张、共几张、前面答了几张", /第 4 张 \/ 共 5 张/.test(midText) && /前面 3 张已复习/.test(midText), midText);
chk("中途续接：不出现「无到期」「进度丢失」这类误导措辞", !/无到期|未开始|没有记录/.test(midText), midText);

chk(
  "全答完：说「已全部复习完」而不是给出第 0 张",
  P.resumeHintText(all) === "这一轮 2 张已全部复习完",
  P.resumeHintText(all)
);
chk("空队列：文案为空（不渲染空提示条）", P.resumeHintText(empty) === "");

chk("页头对照文案：已完成 3 · 待复习 2", P.progressLabel(part) === "已完成 3 · 待复习 2", P.progressLabel(part));
chk("空队列不输出页头文案", P.progressLabel({ rated: 0, remaining: 0 }) === "");
chk("断点徽标：已答 3/5", P.resumeBadgeText(part) === "已答 3/5", P.resumeBadgeText(part));
chk("空队列不输出徽标", P.resumeBadgeText({ total: 0, rated: 0 }) === "");

// ---- latestPerScope ----
const mk = (id, book, started, rated, total, mode = "due", group = null) => ({
  session_id: id,
  scope: { mode, group, textbook_id: book },
  total,
  rated,
  remaining: total - rated,
  next_index: rated,
  started_at: started,
  textbook_title: book ? `书-${book}` : null,
});

const raw = [
  mk("s-old", "A", "2026-11-08T09:00:00.000Z", 1, 10),
  mk("s-new", "A", "2026-11-08T10:00:00.000Z", 4, 10),
  mk("s-b", "B", "2026-11-08T09:30:00.000Z", 2, 8),
  mk("s-all", "A", "2026-11-08T09:45:00.000Z", 0, 20, "all"),
];
const deduped = P.latestPerScope(raw);
chk("同范围只留最新一轮（A 的旧轮次被折叠）", !deduped.some((x) => x.session_id === "s-old"));
chk("A 书 due 轮次取最新那条", deduped.find((x) => x.session_id === "s-new")?.rated === 4);
chk("跨书并行：B 的轮次保留（去 B 看一眼不该抹掉 A，反之亦然）", deduped.some((x) => x.session_id === "s-b"));
chk("同书不同范围（all）单独一行，不被 due 覆盖", deduped.some((x) => x.session_id === "s-all"));
chk("按开始时间倒序（最新在最上）", deduped[0]?.session_id === "s-new", deduped.map((x) => x.session_id).join(","));
chk("去重后共 3 条", deduped.length === 3, String(deduped.length));

// ---- pickSessionForBook ----
chk("按书挑轮次：命中 A", P.pickSessionForBook(raw, "A")?.scope.textbook_id === "A");
chk("按书挑轮次：命中 B", P.pickSessionForBook(raw, "B")?.session_id === "s-b");
chk("按书挑轮次：没有该书的轮次 → null（不硬塞别的书）", P.pickSessionForBook(raw, "C") === null);
chk("按书挑轮次：空 id → null", P.pickSessionForBook(raw, "") === null && P.pickSessionForBook(raw, null) === null);
chk(
  "同一本书有多轮时给出「第一条」（items 已按时间倒序）",
  P.pickSessionForBook(
    [mk("n1", "A", "2026-11-08T11:00:00.000Z", 5, 10), mk("n2", "A", "2026-11-08T08:00:00.000Z", 1, 10)],
    "A"
  )?.session_id === "n1"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
