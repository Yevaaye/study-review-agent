// 「答案不全」端到端契约（需要服务在跑，默认 http://127.0.0.1:3000）。
//
// 纯函数测试覆盖不到的事，这里用真实 HTTP 走一遍：
//   1. 导入「答案：摘要句 + 下一段完整答案」的材料，卡片 back 必须含第二个答案；
//   2. 规则层自动补齐会写进 answer_fix_logs（trigger=rule，带原因/前后文本/诊断）；
//   3. POST /api/cards/:id/fix-answer 参数校验（非法 reason 400 / 不存在的卡 404）；
//   4. 用户点「答案不全」→ AI 检索知识点 → 新答案写回并持久化（trigger=user 台账）；
//   5. 结束后删除临时材料，不污染书库（台账记录保留，作为可追踪样本）。
//
// 用法：npm run check:answerfixhttp（可用 BASE=... 指向隔离实例）

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

const SUM =
  "过拟合指模型在训练数据上表现很好，但在测试数据上表现不佳，因为模型过于复杂，学习了噪声。";
const FULL = SUM + "欠拟合指模型无法捕获数据中的复杂模式，因为模型太简单或特征不足。";
const stamp = Date.now();
const title = `答案完整性验证-${stamp}`;
const md = `# ${title}

## 基础

问题：什么是过拟合和欠拟合？
答案：${SUM}

${FULL}

问题：请解释什么是神经网络。
答案：神经网络是一种受人脑结构启发的计算模型。

神经网络是一种受人脑结构启发的计算模型。每个神经元接收输入并应用权重，然后将结果传递给下一层。
`;

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

let textbookId = null;

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  // ---- 1) 导入 ----
  const r = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, markdown: md }),
  });
  const submit = await jsonOf(r);
  chk("导入返回 202 + job_id", r.status === 202 && !!submit.job_id, JSON.stringify(submit).slice(0, 120));

  let result = null;
  for (let i = 0; i < 90 && submit.job_id; i++) {
    const list = await jsonOf(await fetch(`${BASE}/api/jobs`));
    const cur = (list.jobs ?? []).find((j) => j.id === submit.job_id);
    if (cur && cur.status !== "running") {
      result = cur.result ?? null;
      break;
    }
    await new Promise((s) => setTimeout(s, 400));
  }
  textbookId = result?.textbook_id ?? null;
  chk("导入任务完成且产出教材", !!textbookId, JSON.stringify(result).slice(0, 160));

  // ---- 2) 卡片答案完整 ----
  const cardsRes = await jsonOf(
    await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
  );
  const cards = cardsRes.cards ?? [];
  const target = cards.find((c) => (c.front ?? "").includes("过拟合"));
  chk("能查到过拟合那张卡", !!target, `共 ${cards.length} 张`);
  chk(
    "卡片 back 写入完整答案（含欠拟合）",
    !!target && (target.back ?? "").includes("欠拟合"),
    (target?.back ?? "").slice(0, 120)
  );

  // ---- 3) 规则层审计台账 ----
  const ruleLogs = await jsonOf(await fetch(`${BASE}/api/answer-fix-logs?trigger=rule&limit=500`));
  const rule = (ruleLogs.logs ?? []).find(
    (l) => l.textbook_id === textbookId && (l.question ?? "").includes("过拟合")
  );
  chk("规则层自动补齐已落台账", !!rule, `rule 共 ${ruleLogs.total ?? 0} 条`);
  chk(
    "台账含原因 multi_answer / 修正前后文本 / 诊断",
    !!rule &&
      rule.reason === "multi_answer" &&
      rule.trigger === "rule" &&
      rule.before === SUM &&
      rule.after.includes("欠拟合") &&
      !!rule.diagnosis
  );

  // ---- 4) 参数校验 ----
  const badReason = await fetch(
    `${BASE}/api/cards/${encodeURIComponent(target?.id ?? "x")}/fix-answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "whatever" }),
    }
  );
  chk("非法 reason 返回 400", badReason.status === 400);
  const notFound = await fetch(`${BASE}/api/cards/not-exist-card/fix-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "truncated" }),
  });
  chk("不存在的卡片返回 404", notFound.status === 404);

  // ---- 5) 用户点「答案不全」→ AI 修复 ----
  if (target?.id) {
    // 新导入的卡已经被规则层补全了；真实用户遇到的是「规则层修复之前导入的旧卡」，
    // 所以这里先把 back 还原成只有摘要句，模拟历史遗留的截断答案。
    const edit = await fetch(`${BASE}/api/cards/${encodeURIComponent(target.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", back: SUM }),
    });
    chk("模拟历史截断卡：back 改回摘要句", edit.status === 200);
    // 回归：/api/cards/:id 的 edit 会传 front: undefined，
    // updateCard 早期直接展开 patch，把题干抹成 undefined（一次答案编辑毁掉整张卡）。
    const afterEditList = await jsonOf(
      await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
    );
    const editedCard = (afterEditList.cards ?? []).find((c) => c.id === target.id);
    chk(
      "只改 back 不会抹掉题干（updateCard 过滤 undefined）",
      typeof editedCard?.front === "string" && editedCard.front.includes("过拟合"),
      String(editedCard?.front).slice(0, 60)
    );

    const fixRes = await fetch(`${BASE}/api/cards/${encodeURIComponent(target.id)}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "truncated", note: "漏了欠拟合那半句" }),
      signal: AbortSignal.timeout(90_000),
    });
    const fix = await jsonOf(fixRes);
    chk("AI 修复接口返回 ok=true", fixRes.status === 200 && fix.ok === true, JSON.stringify(fix).slice(0, 200));
    chk("AI 修复给出知识点与诊断", Array.isArray(fix.knowledge_points) && !!fix.diagnosis);
    chk("AI 修复生成了新答案", typeof fix.back === "string" && fix.back.length > 10);
    chk(
      "AI 修复确实补回了漏掉的第二个答案",
      typeof fix.back === "string" && fix.back.includes("欠拟合"),
      (fix.back ?? "").slice(0, 160)
    );

    const afterCards = await jsonOf(
      await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
    );
    const refreshed = (afterCards.cards ?? []).find((c) => c.id === target.id);
    chk(
      "新答案已持久化到卡片（重新查询读得到）",
      !!refreshed && refreshed.back === fix.back && refreshed.answer_origin === "ai",
      (refreshed?.back ?? "").slice(0, 100)
    );

    const userLogs = await jsonOf(
      await fetch(`${BASE}/api/answer-fix-logs?trigger=user&cardId=${encodeURIComponent(target.id)}`)
    );
    const ulog = (userLogs.logs ?? [])[0];
    chk("用户修复已落台账且原因可追溯", !!ulog && ulog.reason === "truncated" && !!ulog.diagnosis);
    chk("台账保存了修正前答案与备注", !!ulog && ulog.before === SUM && ulog.note === "漏了欠拟合那半句");
  }

  // ---- 6) 存量卡批量回填（不删库重导也能修正历史数据）----
  const second = cards.find((c) => (c.front ?? "").includes("神经网络"));
  const short = "神经网络是一种受人脑结构启发的计算模型。";
  if (second?.id) {
    const edit2 = await fetch(`${BASE}/api/cards/${encodeURIComponent(second.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", back: short }),
    });
    chk("构造历史截断卡（第二题）", edit2.status === 200);

    const dry = await jsonOf(
      await fetch(
        `${BASE}/api/cards/backfill-answers?dryRun=1&textbookId=${encodeURIComponent(textbookId ?? "")}`,
        { method: "POST" }
      )
    );
    chk("回填 dryRun 不写库且能预知改动数", dry.ok === true && dry.dryRun === true && dry.updated >= 1);

    const backfill = await jsonOf(
      await fetch(
        `${BASE}/api/cards/backfill-answers?textbookId=${encodeURIComponent(textbookId ?? "")}`,
        { method: "POST" }
      )
    );
    chk("批量回填执行成功", backfill.ok === true && backfill.updated >= 1);
    const afterBackfill = await jsonOf(
      await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
    );
    const restored = (afterBackfill.cards ?? []).find((c) => c.id === second.id);
    chk(
      "历史截断卡被补回完整答案",
      !!restored && (restored.back ?? "").includes("每个神经元"),
      (restored?.back ?? "").slice(0, 120)
    );

    const ruleAfter = await jsonOf(
      await fetch(`${BASE}/api/answer-fix-logs?trigger=rule&limit=500`)
    );
    chk(
      "批量回填也写入可追踪台账",
      (ruleAfter.logs ?? []).some(
        (l) => l.card_id === second.id && (l.after ?? "").includes("每个神经元")
      )
    );
  }
} catch (e) {
  fail++;
  console.log(`  FAIL  端到端异常 ← ${e?.message ?? e}`);
} finally {
  if (textbookId) {
    try {
      const del = await fetch(`${BASE}/api/books/${encodeURIComponent(textbookId)}`, {
        method: "DELETE",
      });
      chk("临时材料已清理", del.status === 200);
    } catch {
      console.log(`  WARN  临时材料清理失败，id=${textbookId}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
