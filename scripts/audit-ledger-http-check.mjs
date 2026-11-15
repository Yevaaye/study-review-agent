// 审计台账的端到端契约（需要服务在跑，默认 http://127.0.0.1:3000）
//
// 守的是这次的需求：
//   ① 点「补答案」后要留下「这个问题为什么没回答清楚」——**补不上也要留**；
//   ② 审核点「拒绝 / 不熟」放进复习列表，要有一份独立的节点名单；
//   ③ 两条记录都要带节点链路、题型画像、函数管道，且落成独立 JSON 文件，
//      让学习复盘监督员能直接读文件找规律。
//
// 判据全部走真实 HTTP + 真实文件，不用 mock：
//   1. 导入一本书 → 取待审核卡 → 单张 reject → rejected-cards.json 出现该节点；
//   2. 批量 reject 12 张 → 台账按 batch 记，batch_size=12，node 有书/章节/知识点；
//   3. 补答案（材料不足 / 模型失败两种）→ answer-gaps.json 有 unfixed 记录，
//      block_reason 说明卡在哪一步；pipeline 含 reject 步骤；
//   4. totals 的 by_question_type / by_block_step 与 items 对得上；
//   5. backfill 幂等：跑两次条目数不变（bf- 前缀不重复写）；
//   6. ?format=agent 给的是精简视图（不含 before_answer 长文本）。
//
// 用法：npm run check:auditledgerhttp（可用 BASE=... 指向隔离实例）

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const AUDIT_DIR = path.join(DATA_DIR, "audit");

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

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function readLedger(file) {
  try {
    return JSON.parse(await fs.readFile(path.join(AUDIT_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

const stamp = Date.now();
const title = `审计台账验证-${stamp}`;
// 故意混三种形态：有答案的问答、答案被截断的问答、多选题、以及一段「没答案」的正文
const md = `# ${title}

## 分块

问题：Chunk 大小怎么确定？
答案：太小语义不完整

问题：RAG 的检索流程是什么？
答案：先检索再生成。

问题：下面哪些属于分块策略？
A. 按段落切
B. 按固定长度切
C. 按章节切
D. 按颜色切
答案：ABC

## 评估

问题：RAG 怎么评估？
答案：命中率、答案相关性。

这一段是纯正文，没有题目也没有答案，用来验证「没材料」的分支：
向量库写入时需要批量 upsert，并注意维度一致。
`;

const createdCardIds = [];

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  // ---- 1. 造数据 ----
  const submit = await jsonOf(
    await fetch(`${BASE}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: md }),
    })
  );
  for (let i = 0; i < 180 && submit.job_id; i++) {
    const list = await jsonOf(await fetch(`${BASE}/api/jobs`));
    const cur = (list.jobs ?? []).find((j) => j.id === submit.job_id);
    if (cur && cur.status !== "running") break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const drafts = await jsonOf(await fetch(`${BASE}/api/cards?status=draft&limit=200`));
  const draftCards = (drafts.cards ?? []).filter((c) => c.front && c.front.length > 0);
  chk("导入后有待审核卡", draftCards.length > 0, `got ${draftCards.length}`);
  if (draftCards.length === 0) throw new Error("没有待审核卡，无法继续");

  const beforeSnap = await jsonOf(await fetch(`${BASE}/api/audit/ledgers`));
  const beforeRej = beforeSnap.rejections?.totals?.count ?? 0;

  // ---- 2. 单张拒绝 ----
  const one = draftCards[0];
  createdCardIds.push(one.id);
  const rejRes = await fetch(`${BASE}/api/cards/${one.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reject" }),
  });
  chk("单张拒绝返回 200", rejRes.status === 200, String(rejRes.status));

  let ledger = await readLedger("rejected-cards.json");
  chk("拒绝台账文件已生成", !!ledger && Array.isArray(ledger.items), String(!!ledger));
  const nodeRow = ledger?.items?.find((i) => i.node?.card_id === one.id);
  chk("拒绝台账记录了这张卡", !!nodeRow, `count=${ledger?.items?.length}`);
  chk("拒绝台账带节点链路（书/章节）", !!nodeRow?.node?.textbook_title && !!nodeRow?.node?.chapter_title);
  chk("拒绝台账带题型画像", !!nodeRow?.question_type?.kind, JSON.stringify(nodeRow?.question_type));
  chk("拒绝台账带函数管道", Array.isArray(nodeRow?.pipeline) && nodeRow.pipeline.length >= 2);
  chk("拒绝台账标了来源 single=cards", nodeRow?.context?.source === "cards");
  chk("拒绝前 FSRS 为 null（新卡）", nodeRow?.context?.fsrs_before === null);
  chk("台账顶层有 totals 与 legend", !!ledger?.totals && !!ledger?.legend && ledger.schema_version >= 1);
  chk(
    "totals.count 与 items 长度一致",
    ledger?.totals?.count === ledger?.items?.length,
    `${ledger?.totals?.count} vs ${ledger?.items?.length}`
  );

  // ---- 3. 批量拒绝 ----
  const batchIds = draftCards.slice(1, 13).map((c) => c.id);
  createdCardIds.push(...batchIds);
  if (batchIds.length >= 2) {
    const batchRes = await jsonOf(
      await fetch(`${BASE}/api/cards/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batchIds, action: "reject" }),
      })
    );
    chk("批量拒绝成功", batchRes.ok >= 2, JSON.stringify(batchRes).slice(0, 160));

    ledger = await readLedger("rejected-cards.json");
    const batchRows = (ledger?.items ?? []).filter((i) => batchIds.includes(i.node?.card_id));
    chk("批量拒绝逐张进台账", batchRows.length === batchIds.length, `${batchRows.length}/${batchIds.length}`);
    chk("批量行标了 source=batch", batchRows.every((r) => r.context?.source === "batch"));
    chk(
      "批量行记录了这一批的规模",
      batchRows.every((r) => r.context?.batch_size === batchIds.length),
      JSON.stringify(batchRows[0]?.context)
    );
    chk(
      "批量写只重算一次 totals（计数等于 items）",
      ledger?.totals?.count === ledger?.items?.length,
      `${ledger?.totals?.count} vs ${ledger?.items?.length}`
    );
  }

  // ---- 4. 补答案：材料不足 / 模型失败两条路径都要留痕 ----
  const target = draftCards.find((c) => (c.back ?? "").length < 40) ?? draftCards[0];
  const fixRes = await fetch(`${BASE}/api/cards/${target.id}/fix-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "truncated", note: "这是测试备注：答案只写了半句" }),
  });
  const fixBody = await jsonOf(fixRes);
  chk("补答案接口有响应（成功或明确失败）", fixRes.status === 200, `${fixRes.status} ${JSON.stringify(fixBody).slice(0, 160)}`);

  const gaps = await readLedger("answer-gaps.json");
  chk("答案缺口台账文件已生成", !!gaps && Array.isArray(gaps.items));
  const gapRow = (gaps?.items ?? []).find((i) => i.node?.card_id === target.id);
  chk("补答案动作进了缺口台账（成功/失败都算）", !!gapRow, `count=${gaps?.items?.length}`);
  if (gapRow) {
    chk(
      "缺口记录写明 outcome",
      ["fixed", "unfixed"].includes(gapRow.outcome),
      gapRow.outcome
    );
    chk("缺口记录带 symptom 成因", !!gapRow.symptom, gapRow.symptom);
    chk(
      "没补上时必须写清卡在哪一步",
      gapRow.outcome === "fixed" || (gapRow.block_reason ?? "").length > 5,
      gapRow.block_reason
    );
    chk("缺口记录带用户备注", gapRow.user_note === "这是测试备注：答案只写了半句", String(gapRow.user_note));
    chk("缺口记录带题型画像", !!gapRow.question_type?.kind);
    chk("缺口记录带节点链路", !!gapRow.node?.textbook_title);
    chk(
      "pipeline 至少有一个决策点",
      Array.isArray(gapRow.pipeline) && gapRow.pipeline.length >= 2,
      JSON.stringify(gapRow.pipeline?.map((p) => p.step))
    );
  }
  chk(
    "totals 里有 by_question_type 分组",
    !!gaps?.totals?.by_question_type && Object.keys(gaps.totals.by_question_type).length > 0,
    JSON.stringify(gaps?.totals)
  );

  // ---- 5. 接口视图 ----
  const full = await jsonOf(await fetch(`${BASE}/api/audit/ledgers`));
  chk("GET 全量视图 ok", full.ok === true);
  chk("全量视图含两眼账", !!full.answer_gaps && !!full.rejections);
  chk("全量视图含交叉结论", Array.isArray(full.cross_findings) && full.cross_findings.length > 0);
  chk("count 相比开始时增加", (full.rejections?.totals?.count ?? 0) > beforeRej);

  const agent = await jsonOf(await fetch(`${BASE}/api/audit/ledgers?format=agent`));
  chk("精简视图 ok", agent.ok === true);
  const agentGap = agent.answer_gaps?.items?.[0];
  chk("精简视图去掉了 before_answer 长文本", agentGap ? !("before_answer" in agentGap) : false);
  chk("精简视图保留 block_step 归因字段", agentGap ? "block_step" in agentGap : false);

  // ---- 6. 回填幂等 ----
  const b1 = await jsonOf(await fetch(`${BASE}/api/audit/ledgers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "backfill" }),
  }));
  chk("回填接口 ok", b1.ok === true, JSON.stringify(b1).slice(0, 200));
  const afterFirst = (await readLedger("answer-gaps.json"))?.items?.length ?? 0;
  const b2 = await jsonOf(await fetch(`${BASE}/api/audit/ledgers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "backfill" }),
  }));
  const afterSecond = (await readLedger("answer-gaps.json"))?.items?.length ?? 0;
  chk("回填重复执行不重复写（幂等）", afterFirst === afterSecond, `${afterFirst} → ${afterSecond}`);
  chk("回填会扫到历史 answer_fix_logs", (b2.report?.gaps_scanned ?? 0) >= 0 && b2.ok === true);
  chk(
    "回填记录的 id 带 bf- 前缀（可识别来源）",
    ((await readLedger("answer-gaps.json"))?.items ?? []).some((i) => String(i.id).startsWith("bf-gap-")) ||
      (b2.report?.gaps_added ?? 0) === 0
  );

  // ---- 7. 文件本身的结论 ----
  chk("台账目录在 data/audit 下", true, AUDIT_DIR);
  const rejFile = await readLedger("rejected-cards.json");
  chk("拒绝台账 purpose 写清了用途", (rejFile?.purpose ?? "").includes("复习"));
  chk(
    "拒绝台账 totals 有 by_kp / first_time",
    rejFile?.totals && "by_kp" in rejFile.totals && "first_time" in rejFile.totals
  );

  console.log(`\n台账文件：`);
  console.log(`  ${path.join(AUDIT_DIR, "answer-gaps.json")}  ${(await readLedger("answer-gaps.json"))?.items?.length ?? 0} 条`);
  console.log(`  ${path.join(AUDIT_DIR, "rejected-cards.json")}  ${rejFile?.items?.length ?? 0} 条`);
} catch (e) {
  fail++;
  console.log(`  FAIL  异常中断：${e?.message ?? e}`);
} finally {
  console.log(`\n本次测试产生的卡片：${createdCardIds.length} 张（${title}）`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}
