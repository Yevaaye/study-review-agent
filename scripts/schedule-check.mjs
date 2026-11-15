// 复习节奏回归：守「答错当天+次日都复习到、费力次日、正常走 FSRS 递增」这几条规则。
// 运行：npm run check:schedule
//
// 为什么单独有这个脚本：
//   排期规则改过一次（固定表 → FSRS 带增长封顶）。这类改动最容易出的问题是
//   「代码看起来对，但序列跑出来是 3 → 26 → 92」——只看一两次手动点击发现不了。
//   这里把整条曲线钉死成断言：3 → 7 → 16 → 38 → 91，以及答错后的 1 天兜底。
//
// 实现方式：把 src/lib/fsrs.ts 用 tsc 编到项目内的临时目录再 require。
// 不直接 import .ts 是因为它引用了 db/types.ts 里的 enum，Node 的类型擦除跑不了 enum；
// 编译产物必须留在项目目录里，否则 require("ts-fsrs") 找不到 node_modules。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = mkdtempSync(path.join(root, ".tmp-fsrs-check-"));

function compile() {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      path.join("src", "lib", "fsrs.ts"),
      "--outDir", outDir,
      "--module", "commonjs",
      "--target", "es2020",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  for (const p of [
    path.join(outDir, "fsrs.js"),
    path.join(outDir, "lib", "fsrs.js"),
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error(`编译产物没找到：${outDir}`);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
}

const compiled = compile();
const require = createRequire(import.meta.url);
const { newCardState, schedule, RELEARN_MINUTES, MASTER_INTERVAL_DAYS } = require(compiled);

const T0 = new Date("2026-11-05T02:00:00+08:00");
const iso = (d) => new Date(d).toISOString().slice(0, 16).replace("T", " ");
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

/** 拿一张新卡状态 */
const fresh = (id) => newCardState(id, T0);

console.log("复习节奏回归\n");

// ---- 1. 正常想起：3 → 7 → 16 → 38 → 91，并在 60 天以上毕业 ----
{
  let s = await fresh("c-good");
  const seq = [];
  const masteredAt = [];
  for (let i = 0; i < 5; i++) {
    // 按「到期那天才复习」推进：FSRS 的 stability 增益依赖真实流逝时间，
    // 同一天连点 5 次会得到刻意偏短的间隔，测不出真实曲线
    const at = i === 0 ? T0 : new Date(s.due_at);
    const r = await schedule(s, 3, at);
    seq.push(r.card.scheduled_days);
    if (r.mastered) masteredAt.push(i + 1);
    // 到期时间 = 作答时刻 + 间隔天数
    if (i === 0) {
      check(
        "正常想起首轮 = 3 天",
        r.card.scheduled_days === 3 && daysBetween(at.toISOString(), r.card.due_at) === 3,
        `${r.card.scheduled_days} 天 · due ${iso(r.card.due_at)}`
      );
    }
    s = r.card;
  }
  check(
    "正常想起递增 = 3/7/16/38/91",
    JSON.stringify(seq) === JSON.stringify([3, 7, 16, 38, 91]),
    seq.join(" → ")
  );
  check(
    `间隔达到 ${MASTER_INTERVAL_DAYS} 天毕业`,
    masteredAt.length === 1 && masteredAt[0] === 5,
    masteredAt.length ? `第 ${masteredAt[0]} 轮毕业` : "没有毕业"
  );
}

// ---- 2. 轻松想起：起点 5 天，增速更快 ----
{
  let s = await fresh("c-easy");
  const seq = [];
  for (let i = 0; i < 3; i++) {
    const r = await schedule(s, 4, i === 0 ? T0 : new Date(s.due_at));
    seq.push(r.card.scheduled_days);
    s = r.card;
  }
  check("轻松想起递增 = 5/17/59", JSON.stringify(seq) === JSON.stringify([5, 17, 59]), seq.join(" → "));
}

// ---- 3. 想起但费力：一律次日 ----
{
  let s = await fresh("c-hard");
  const seq = [];
  for (let i = 0; i < 3; i++) {
    const at = i === 0 ? T0 : new Date(s.due_at);
    const r = await schedule(s, 2, at);
    seq.push(r.card.scheduled_days);
    if (i === 0) {
      check(
        "费力 = 次日",
        r.card.scheduled_days === 1 && daysBetween(at.toISOString(), r.card.due_at) === 1,
        `${r.card.scheduled_days} 天 · due ${iso(r.card.due_at)}`
      );
    }
    s = r.card;
  }
  check("连续费力也不会被拉长", JSON.stringify(seq) === JSON.stringify([1, 1, 1]), seq.join(" → "));
}

// ---- 4. 没想起来：当天回到队列（10 分钟后），状态进重学 ----
{
  const s = await fresh("c-again");
  const r = await schedule(s, 1, T0);
  check(
    "答错 = 当天再出现（10 分钟后）",
    r.card.scheduled_days === 0 &&
      minutesBetween(T0.toISOString(), r.card.due_at) === RELEARN_MINUTES,
    `${minutesBetween(T0.toISOString(), r.card.due_at)} 分钟后 · state=${r.card.state}`
  );
  check("答错不进「已掌握」", r.mastered === false);
  check("答错记下 lapse 时刻", Boolean(r.card.last_lapse_at), String(r.card.last_lapse_at));
}

// ---- 5. 答错 → 当天补答对：只排 1 天（次日必须再验一次），不能跳回 3 天 ----
{
  let s = await fresh("c-lapse");
  const r1 = await schedule(s, 1, T0);
  s = r1.card;
  const at = new Date(T0.getTime() + 12 * 60_000); // 12 分钟后补答
  const r2 = await schedule(s, 3, at);
  check(
    "答错后当天答对 = 次日再考",
    r2.card.scheduled_days === 1 && daysBetween(at.toISOString(), r2.card.due_at) === 1,
    `${r2.card.scheduled_days} 天 · due ${iso(r2.card.due_at)}`
  );
  check("补答对不毕业", r2.mastered === false);

  // 再答对一次：从 1 天重新长回来（2 天），不会被 FSRS 一口拉到二十几天
  const r3 = await schedule(r2.card, 3, new Date(at.getTime() + 86_400_000));
  check(
    "答错后的重建间隔从 1 → 2 天缓慢回升",
    r3.card.scheduled_days === 2,
    `${r3.card.scheduled_days} 天`
  );
}

// ---- 6. 答错后第二天才补答对：同样只排 1 天 ----
{
  let s = await fresh("c-lapse-next");
  const r1 = await schedule(s, 1, T0);
  const nextDay = new Date(T0.getTime() + 86_400_000);
  const r2 = await schedule(r1.card, 3, nextDay);
  check(
    "隔天才补答对也只排 1 天",
    r2.card.scheduled_days === 1,
    `${r2.card.scheduled_days} 天 · due ${iso(r2.card.due_at)}`
  );
}

// ---- 7. 状态字段：答对进 Review、答错进重学 ----
{
  const s = await fresh("c-state");
  const good = await schedule(s, 3, T0);
  const again = await schedule(s, 1, T0);
  check("答对 state=2(Review)", good.card.state === 2, `state=${good.card.state}`);
  check(
    "答错 state=3(重学)",
    again.card.state === 3 && again.card.schedule_status === "relearning",
    `state=${again.card.state} status=${again.card.schedule_status}`
  );
}

try {
  rmSync(outDir, { recursive: true, force: true });
} catch {
  console.warn(`临时目录未能删除：${outDir}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
