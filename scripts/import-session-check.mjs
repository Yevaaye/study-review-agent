// 导入会话状态机单测。
//
// 锁的是用户提的那条硬要求：「切页返回后要明确显示仍在导入 / 已完成，
// 不得状态丢失」。这里不测 React，只测状态迁移 —— 只要迁移是对的，
// 页面渲染就只是照着 phase 画。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* fallthrough */
      }
    }
    return next(specifier, context);
  },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import(
  pathToFileURL(path.join(here, "../src/lib/import/session-state.ts")).href
);

let pass = 0;
let fail = 0;
const chk = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

const doneJob = (result) => ({
  id: "job-1",
  status: "done",
  started_at: 1000,
  finished_at: 9000,
  result,
});

console.log("— 导入会话状态机 —");

// 1
const started = S.beginImport(S.EMPTY_SESSION, {
  jobId: "job-1",
  startedAt: 1000,
  title: "HTTP 讲义",
  markdown: "# 一\n正文",
  mode: "smart",
});
chk(
  "idle → running 且记下 jobId/开始时间",
  started.phase === "running" && started.jobId === "job-1" && started.startedAt === 1000
);

// 2
const again = S.beginImport(started, {
  jobId: "job-2",
  title: "另一份",
  markdown: "x",
  mode: "deep",
});
chk("进行中重复提交被忽略（不产生第二个任务）", again === started && again.jobId === "job-1");

// 3
chk(
  "提交时保留表单快照（切页回来输入框不空）",
  started.title === "HTTP 讲义" && started.markdown === "# 一\n正文" && started.mode === "smart"
);

// 4
const stillRunning = S.applyJob(started, { id: "job-1", status: "running" });
chk("running 任务重复同步不抖动（返回原对象）", stillRunning === started);

// 5
const done = S.applyJob(
  started,
  doneJob({
    import_job_id: "ij-9",
    chapter_count: 6,
    original_card_count: 38,
    needs_answer: 2,
    knowledge_point_count: 11,
    by_type: { choice: 10, qa: 24, cloze: 3, judge: 1 },
    textbook_id: "tb-1",
    textbook_title: "字节面经",
  })
);
chk(
  "running → done 且题数逐项对上",
  done.phase === "done" &&
    done.result?.chapter_count === 6 &&
    done.result?.original_card_count === 38 &&
    done.result?.needs_answer === 2 &&
    done.result?.by_type?.qa === 24 &&
    done.result?.textbook_title === "字节面经",
  JSON.stringify(done.result)
);

// 6
const zero = S.fromJobResult(undefined);
chk(
  "结果缺字段归零（界面上不会出现 NaN）",
  zero.chapter_count === 0 &&
    zero.original_card_count === 0 &&
    zero.by_type.choice === 0 &&
    Number.isFinite(zero.needs_answer)
);

// 7
const failed = S.applyJob(started, { id: "job-1", status: "error", error: "模型超时" });
chk("running → error 带上原因", failed.phase === "error" && failed.error === "模型超时");

// 8
const sticky = S.applyJob(done, { id: "job-1", status: "running" });
chk("已完成不会被滞后的 running 覆盖", sticky === done);

// 9
const other = S.applyJob(started, { id: "job-999", status: "done", result: { chapter_count: 99 } });
chk("不认别人的 jobId", other === started);

// 10
const lost = S.markLost(started);
chk(
  "任务查不到 → lost，且给出可行动说明",
  lost.phase === "lost" && typeof lost.error === "string" && lost.error.length > 10
);
chk("已完成的任务不会被标成 lost", S.markLost(done) === done);

// 11
const reset = S.resetSession(done);
chk(
  "重置：清结果/任务，保留上次选的模式",
  reset.phase === "idle" &&
    reset.jobId === null &&
    reset.result === null &&
    reset.title === "" &&
    reset.mode === "smart"
);

// 12
chk(
  "脏数据还原为 idle（不会把页面卡在假的 running）",
  S.reviveSession({ phase: "weird" }).phase === "idle" &&
    S.reviveSession("oops").phase === "idle" &&
    S.reviveSession(null).phase === "idle"
);

// 13
const revived = S.reviveSession(JSON.parse(JSON.stringify(done)));
chk(
  "合法会话可原样还原（刷新后靠它接上服务端任务）",
  revived.phase === "done" && revived.jobId === "job-1" && revived.result?.original_card_count === 38
);

// 14
const submitFail = S.failSession(S.EMPTY_SESSION, "这份材料已经导入过了");
chk(
  "提交阶段失败也进 error（不假装在跑）",
  submitFail.phase === "error" && submitFail.error === "这份材料已经导入过了"
);

// 15
chk(
  "running / lost 都要继续跟服务端对账（否则判丢后永远不能自愈）",
  S.shouldSyncFromJob("running") === true &&
    S.shouldSyncFromJob("lost") === true &&
    S.shouldSyncFromJob("done") === false &&
    S.shouldSyncFromJob("error") === false &&
    S.shouldSyncFromJob("idle") === false
);

// 16 —— 判丢之后任务又出现（重启后重跑 / 轮询迟一拍），必须能回到 done
const lostAgain = S.markLost({ ...S.EMPTY_SESSION, phase: "running", jobId: "job-1", startedAt: 1000 });
const healed = S.applyJob(lostAgain, doneJob({ chapter_count: 7, original_card_count: 38 }));
chk(
  "lost → 任务回来能自愈成 done（不再永久挂在「查不到」）",
  lostAgain.phase === "lost" && healed.phase === "done" && healed.result?.original_card_count === 38
);

// 17
chk(
  "刚提交 1.5 秒：任务还没进列表也要等，不能判丢",
  S.missingJobVerdict({
    hasJob: false,
    phase: "running",
    startedAt: 10_000,
    submitAt: null,
    now: 11_500,
  }) === "wait"
);

// 18 —— 旧实现用组件 state 的 submitAt，切页回来是 null，`now - 0` 恒过期 → 秒判丢
chk(
  "切页回来（submitAt 丢失）仍按 startedAt 计时，不秒判丢",
  S.missingJobVerdict({
    hasJob: false,
    phase: "running",
    startedAt: 10_000,
    submitAt: null,
    now: 12_000,
  }) === "wait"
);

// 19
chk(
  "过了宽限期仍查不到任务才判丢",
  S.missingJobVerdict({
    hasJob: false,
    phase: "running",
    startedAt: 10_000,
    submitAt: null,
    now: 10_000 + S.LOST_GRACE_MS + 1,
  }) === "lost"
);

// 20
chk(
  "任务在列表里就直接对账（不再走丢失判定）",
  S.missingJobVerdict({
    hasJob: true,
    phase: "running",
    startedAt: 10_000,
    submitAt: null,
    now: 99_999,
  }) === "sync"
);

console.log(`\n${pass} passed, ${fail} failed`);
// 不用 process.exit：Windows 上带着未关闭的 async handle 强退会触发 libuv 断言
process.exitCode = fail === 0 ? 0 : 1;
