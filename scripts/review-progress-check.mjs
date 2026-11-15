// 复习进度：跳号 / 范围判定 / 跨天判定（纯函数）
//
// 这三个逻辑支撑「答了 5 题回来还接着第 6 题」：
//   - firstUnratedIndex / nextUnratedIndex：以服务端 rated 为真相算下一张该答的题；
//   - sameScope：只有同范围（mode/group/textbook）才能续接，避免「换一本书」接错；
//   - isSameLocalDay：跨天的 in_progress 不复用（昨天的队列会挤掉今天的到期卡）。
//
// 用法：npm run check:reviewprogress

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
  pathToFileURL("F:/projects/study-review-agent/src/lib/review/progress.ts").href
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

const cards = (ratedList) => ratedList.map((r) => ({ rated: r }));

// ---- 起点：第一张没答过的题 ----
chk("一张都没答 → 第 0 题", P.firstUnratedIndex(cards([false, false, false])) === 0);
chk("答了 5 张 → 第 5 题（用户看到「6 / 8」）", P.firstUnratedIndex(cards([true, true, true, true, true, false, false, false])) === 5);
chk("已答的卡不在前缀而是在中间 → 仍取第一张未答", P.firstUnratedIndex(cards([true, false, true, false])) === 1);
chk("全部答完 → -1（走「本轮完成」而不是回到第 1 题）", P.firstUnratedIndex(cards([true, true, true])) === -1);
chk("空列表 → -1", P.firstUnratedIndex([]) === -1);
chk("rated 缺省视为未答", P.firstUnratedIndex([{}, { rated: undefined }, { rated: true }]) === 0);

// ---- 推进：从 idx+1 开始找 ----
chk("正常推进到下一张", P.nextUnratedIndex(cards([true, false, false]), 1) === 1);
chk("跳过已答的卡（回看时重答过）", P.nextUnratedIndex(cards([true, true, true, false]), 1) === 3);
chk("后面全答过 → -1", P.nextUnratedIndex(cards([true, true, true]), 2) === -1);
chk("from 越界 → -1", P.nextUnratedIndex(cards([true]), 5) === -1);
chk("from 为负 → 从 0 开始", P.nextUnratedIndex(cards([false, false]), -3) === 0);
chk("requeue 追加的副本（rated=false）能被推到", P.nextUnratedIndex([...cards([true, true]), { rated: false }], 1) === 2);

// ---- 已答计数（页面头部「· 已答 5」）----
chk("已答计数", P.ratedCount(cards([true, true, false])) === 2);
chk("空列表计数为 0", P.ratedCount([]) === 0);

// ---- 跨会话「已经答过」的补判 ----
const since = "2026-11-08T10:00:00.000Z";
const rows = [
  { id: "sc1", card_id: "c1", rated: false },
  { id: "sc2", card_id: "c2", rated: false },
  { id: "sc3", card_id: "c3", rated: true }, // 本轮里自己答过的，不该重复计
];
const reviews = [
  { id: "r1", card_id: "c1", reviewed_at: "2026-11-08T10:05:00.000Z" },
  { id: "r2", card_id: "c2", reviewed_at: "2026-11-08T09:00:00.000Z" }, // 本轮开始之前，不算
  { id: "r3", card_id: "c3", reviewed_at: "2026-11-08T10:06:00.000Z" },
];
const extra = P.findAnsweredSince(rows, reviews, since);
chk("本轮开始后答过的卡被补判为已答", extra.length === 1 && extra[0].index === 0 && extra[0].reviewId === "r1", JSON.stringify(extra));
chk("本轮开始前的答对不算（换轮次该重考）", !extra.some((e) => e.index === 1));
chk("本来就 rated 的不重复标记", !extra.some((e) => e.index === 2));
chk(
  "同卡多次作答取最近一次",
  P.findAnsweredSince(
    [{ card_id: "c9", rated: false }],
    [
      { id: "old", card_id: "c9", reviewed_at: "2026-11-08T10:01:00.000Z" },
      { id: "new", card_id: "c9", reviewed_at: "2026-11-08T10:09:00.000Z" },
    ],
    since
  )[0]?.reviewId === "new"
);
chk("非法 since → 不补判（宁可重考也不乱跳）", P.findAnsweredSince(rows, reviews, "bad").length === 0);
chk("没有任何复习事件 → 不补判", P.findAnsweredSince(rows, [], since).length === 0);

// ---- 范围判定 ----
const scopeA = { mode: "due", group: null, textbook_id: "book-1" };
chk("同范围判定为同一轮", P.sameScope(scopeA, { ...scopeA }));
chk("换了书 → 不是同一轮", !P.sameScope(scopeA, { ...scopeA, textbook_id: "book-2" }));
chk("group 不同 → 不是同一轮", !P.sameScope(scopeA, { ...scopeA, group: "new" }));
chk("mode 不同 → 不是同一轮", !P.sameScope(scopeA, { ...scopeA, mode: "all" }));
chk("undefined 与 null 等价", P.sameScope({ mode: "due", textbook_id: undefined }, { mode: "due", textbook_id: null }));
chk("脏 mode 归一成 due", P.normalizeScope({ mode: "weird" }).mode === "due");
chk("空白 bookId 归一成 null", P.normalizeScope({ textbook_id: "   " }).textbook_id === null);
chk("scope 为 null 也不炸", P.normalizeScope(null).mode === "due");

// ---- 跨天判定 ----
const now = new Date(2026, 10, 8, 18, 30, 0); // 本地时间 2026-11-08 18:30
chk("同一天 → 可续接", P.isSameLocalDay(new Date(2026, 10, 8, 1, 5, 0).toISOString(), now));
chk("昨天 → 不可续接", !P.isSameLocalDay(new Date(2026, 10, 7, 23, 50, 0).toISOString(), now));
chk("明天 → 不可续接", !P.isSameLocalDay(new Date(2026, 10, 9, 0, 10, 0).toISOString(), now));
chk("非法时间字符串 → false（不抛错）", P.isSameLocalDay("not-a-date", now) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
