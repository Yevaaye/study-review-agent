// 统计聚合回归：computeFragmentStats 必须用批量接口
// （listAllCardSources / listAllFsrsStates），不得再逐卡发起 N 次查询
// （O(N²) 性能/健壮性隐患，见监督报告 F4）。
// 运行：npm run check:fragstats
//
// 做法：用 Proxy 包一个计数型假 store，断言修复后只调用批量接口各 1 次，
// 而逐卡的 listCardSources / getFsrsState 调用次数为 0。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ts = (name) => pathToFileURL(path.join(here, "../src/lib/stats", name)).href;

const { computeFragmentStats } = await import(ts("fragment-stats.ts"));

function makeStore(n) {
  const cards = [];
  for (let i = 0; i < n; i++) {
    cards.push({ id: `c${i}`, textbook_id: "t1", is_choice: i % 2 === 0, rejected_at: null });
  }
  const links = cards.map((c) => ({ card_id: c.id, source_fragment_id: "f1" }));
  const states = cards.map((c, i) => ({
    card_id: c.id,
    reps: i % 3,
    lapses: 0,
    last_review_at: null,
    due_at: null,
    stability: 1,
    difficulty: 5,
    state: 2,
    scheduled_days: 1,
    learning_step: 0,
    fsrs_version: "FSRS-7",
    scheduler_version: "ts-fsrs@6",
    params_version: "default-v2",
  }));
  const calls = { listCardSources: 0, getFsrsState: 0, listAllCardSources: 0, listAllFsrsStates: 0 };
  const impl = {
    listCards: async () => cards,
    listReviews: async () => [],
    listAllCardSources: async () => {
      calls.listAllCardSources++;
      return links;
    },
    listAllFsrsStates: async () => {
      calls.listAllFsrsStates++;
      return states;
    },
    // 以下两个在修复后不应被调用；保留为计数器以便断言其归零。
    listCardSources: async () => {
      calls.listCardSources++;
      return [];
    },
    getFsrsState: async () => {
      calls.getFsrsState++;
      return null;
    },
  };
  const store = new Proxy(impl, { get: (t, p) => (p in t ? t[p] : async () => []) });
  return { store, calls, cardCount: n };
}

let fail = 0;
const assert = (label, cond) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    fail++;
  }
};

const N = 60;
const { store, calls, cardCount } = makeStore(N);
const stats = await computeFragmentStats(store, "t1");

assert("listAllCardSources 只调用 1 次", calls.listAllCardSources === 1);
assert("不再逐卡调用 listCardSources（O(N²) 回归点）", calls.listCardSources === 0);
assert("listAllFsrsStates 只调用 1 次", calls.listAllFsrsStates === 1);
assert("不再逐卡调用 getFsrsState（O(N²) 回归点）", calls.getFsrsState === 0);
assert("f1 片段聚合到全部卡片", stats.get("f1")?.card_count === cardCount);
assert("聚合结果含选择题计数", stats.get("f1")?.choice_count === Math.ceil(cardCount / 2));

console.log(`\n${fail ? fail + " failed" : "0 failed"}`);
process.exit(fail ? 1 : 0);
