// 导入 = 后台任务 的端到端契约（需要服务在跑）。
//
// 锁三件在纯函数测试里覆盖不到的事：
//   1. POST /api/import 立刻回 202 + job_id（不再同步等模型），
//      前端据此才能「提交完就走」；
//   2. /api/jobs 能查到进度与最终结果，且进度走到 100（切页回来靠它恢复状态）；
//   3. 同一份材料重复导入，题数必须一致 —— 2026-11 实测过不稳定：
//      模型时而在 6s 内响应、时而超时，响应的那几次把 6 道名词短语题判掉 4 道，
//      同一份材料一会儿 2 题一会儿 6 题。规则层现在带 section_question 标记，
//      模型只能标待审、不能删，这条断言就是那个修复的守门人。
//
// 会真的写库，所以每条导入都在结束时连同材料一起删掉（DELETE /api/books/:id
// 会级联删除章节、片段、卡片与复习记录）。
//
// 用法：npm run check:importjob（默认打 http://127.0.0.1:3000，
// 可用 BASE=http://127.0.0.1:3100 指向隔离实例）

const BASE = process.env.BASE || "http://127.0.0.1:3000";

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

const md = (stamp) => `# 导入任务校验 ${stamp}

## 面试问题清单（6 道）

1. Agent 项目背景
2. RAG 系统流程
3. 演示 Agent 项目实现细节
4. 你如何做上下文工程？
5. 什么是 Function Calling？
6. 项目中 AI 贡献的代码占比

## 参考要点

- 这一节是总结，不应被抽成题
`;

/** 提交一次导入，等任务终态，返回 { job, textbookId } */
async function importOnce(stamp) {
  const res = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `导入任务校验 ${stamp}`, markdown: md(stamp) }),
  });

  if (res.status !== 202) {
    return { error: `提交返回 ${res.status}` };
  }
  const submitted = await res.json().catch(() => ({}));
  if (!submitted.job_id) return { error: "没拿到 job_id" };

  let sawRunning = false;
  let job = null;
  for (let i = 0; i < 200; i++) {
    const list = await (await fetch(`${BASE}/api/jobs`)).json().catch(() => []);
    const arr = Array.isArray(list) ? list : (list.jobs ?? []);
    const cur = arr.find((j) => j.id === submitted.job_id);
    if (cur) {
      if (cur.status === "running") sawRunning = true;
      if (cur.status !== "running") {
        job = cur;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { submitted, job, sawRunning };
}

async function main() {
  console.log(`\n目标：${BASE}`);
  const stamp = Date.now();
  const created = [];

  const first = await importOnce(stamp);
  if (first.error) {
    chk("提交导入", false, first.error);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  chk("提交返回 202（不再同步等模型）", true);
  chk("返回 async:true", first.submitted.async === true);
  chk("返回 started_at（前端据此认领本次导入）", typeof first.submitted.started_at === "number");
  chk("能查到该任务的 running 态", first.sawRunning);
  chk("任务走到终态", Boolean(first.job), "轮询期间任务消失");
  chk("终态为 done", first.job?.status === "done", `实际 ${first.job?.status}`);
  chk("进度到 100", first.job?.percent === 100, `实际 ${first.job?.percent}`);
  chk("抽出 6 道编号题", first.job?.result?.question_count === 6, `实得 ${first.job?.result?.question_count}`);
  chk(
    "返回材料 id（可清理）",
    typeof first.job?.result?.textbook_id === "string",
    JSON.stringify(first.job?.result ?? null).slice(0, 120)
  );
  if (first.job?.result?.textbook_id) created.push(first.job.result.textbook_id);

  // 数据库回查：内存任务表 90 秒后就清、进程重启更是全空，
  // 前端拿 jobId 回不到内存时必须能回落到 import_jobs。
  // 锁两件事：① 两边 id 是同一个（否则前端永远查不到库）；
  // ② 回查能还原出与内存任务一致的最终结果。
  const persisted = await (await fetch(`${BASE}/api/import?job_id=${first.submitted.job_id}`))
    .json()
    .catch(() => ({}));
  chk(
    "能按 job_id 回查数据库（import_jobs 主键 = 内存任务 id）",
    persisted.found === true && persisted.id === first.submitted.job_id,
    JSON.stringify(persisted).slice(0, 160)
  );
  chk(
    "回查状态为 done 且题数与内存任务一致",
    persisted.status === "done" &&
      persisted.result?.original_card_count === first.job?.result?.original_card_count,
    `status=${persisted.status} cards=${persisted.result?.original_card_count}`
  );
  chk(
    "回查带教材标题（前端可还原「已保存 · N 章 · N 道」）",
    typeof persisted.result?.textbook_title === "string" &&
      persisted.result.textbook_title.length > 0
  );
  const ghost = await fetch(`${BASE}/api/import?job_id=not-a-real-job`);
  chk(
    "不存在的 job_id 返回 404 + found:false（不假装在跑）",
    ghost.status === 404 && (await ghost.json().catch(() => ({}))).found === false
  );

  // 同一结构再导一次：题数必须一致（锁住「模型裁决导致结果漂移」）
  const second = await importOnce(stamp + 1);
  chk(
    "同一材料重复导入，题数一致（不随模型响应与否漂移）",
    second.job?.result?.question_count === first.job?.result?.question_count,
    `第一次 ${first.job?.result?.question_count} / 第二次 ${second.job?.result?.question_count}`
  );
  if (second.job?.result?.textbook_id) created.push(second.job.result.textbook_id);

  // 清理：连材料带章节、片段、卡片一起删
  for (const id of created) {
    const r = await fetch(`${BASE}/api/books/${id}`, { method: "DELETE" });
    chk(`清理测试材料 ${id.slice(0, 8)}`, r.status === 200, `status=${r.status}`);
  }
  const after = await (await fetch(`${BASE}/api/books`)).json().catch(() => ({}));
  const left = (after.textbooks ?? []).filter((t) => created.includes(t.id));
  chk("测试材料已清理干净", left.length === 0, `残留 ${left.length}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`  FAIL  脚本异常  ← ${e instanceof Error ? e.message : String(e)}`);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
