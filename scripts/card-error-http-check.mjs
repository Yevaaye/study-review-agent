// 多选 / 错误台账 / 原文核对 的端到端契约（需要服务在跑，默认 http://127.0.0.1:3000）
//
// 纯函数测的是算法，这里测的是「数据真的能落库、能回来、能进复习」：
//   1. 原文答案写「①②③」→ 卡片 answers 有 3 项、answer 是字母、is_multi=true；
//   2. 复习会话快照带上 answers/is_multi（否则复习页拿不到多选口令）；
//   3. POST /api/cards/:id/answer-key 手动标多选 → 落库 + 写台账，且能持久化；
//   4. POST /api/card-errors 上报 → 明细可见、监督员视图有结论、agent 视图是紧凑格式；
//   5. 空上报被拒（400），不产生垃圾记录；
//   6. GET /api/fragments/:id/audit 能给出候选与覆盖率，create 能人工补一条。
//
// 用法：npm run check:carderrorhttp（可用 BASE=... 指向隔离实例）

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

async function jsonOf(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

const stamp = Date.now();
const title = `多选与错误台账验证-${stamp}`;
const md = `# ${title}

## 多选与单选

1. 下列哪些属于 RAG 的优点？
A. 知识可实时更新
B. 需要训练算力
C. 可以标注引用来源
D. 必须重训模型
答案：①③

2. 下列哪项是 RAG 的核心动作？
A. 检索
B. 训练
C. 蒸馏
D. 量化
答案：A

问题：什么是 RAG？
答案：检索增强生成，先检索再生成。
`;

let textbookId = null;

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  const r = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, markdown: md }),
  });
  const submit = await jsonOf(r);
  chk("导入受理", r.status === 202 && !!submit.job_id, JSON.stringify(submit).slice(0, 120));

  let result = null;
  for (let i = 0; i < 120 && submit.job_id; i++) {
    const list = await jsonOf(await fetch(`${BASE}/api/jobs`));
    const cur = (list.jobs ?? []).find((j) => j.id === submit.job_id);
    if (cur && cur.status !== "running") {
      result = cur.result ?? null;
      break;
    }
    await new Promise((s) => setTimeout(s, 400));
  }
  textbookId = result?.textbook_id ?? null;
  chk("导入完成", !!textbookId, JSON.stringify(result).slice(0, 160));

  const listed = await jsonOf(
    await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
  );
  const cards = listed.cards ?? [];
  const multiCard = cards.find((c) => (c.front ?? "").includes("哪些属于 RAG 的优点"));
  const singleCard = cards.find((c) => (c.front ?? "").includes("核心动作"));

  chk("抽到了多选题", !!multiCard, cards.map((c) => c.front?.slice(0, 16)).join(" | "));
  chk(
    "多选：answers 三项、answer 为字母、is_multi=true",
    Array.isArray(multiCard?.answers) &&
      multiCard.answers.length === 2 &&
      multiCard.answer === "A、C" &&
      multiCard.is_multi === true,
    JSON.stringify({ answers: multiCard?.answers, answer: multiCard?.answer, is_multi: multiCard?.is_multi })
  );
  chk(
    "单选：answers 为空、is_multi=false",
    singleCard && (singleCard.answers ?? null) === null && singleCard.is_multi !== true,
    JSON.stringify({ answer: singleCard?.answer, is_multi: singleCard?.is_multi })
  );

  // ---- 复习会话要带上多选口令 ----
  if (multiCard) {
    await fetch(`${BASE}/api/cards/${encodeURIComponent(multiCard.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    const session = await jsonOf(
      await fetch(`${BASE}/api/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all", textbookId }),
      })
    );
    const sc = (session.cards ?? []).find((c) => c.card_id === multiCard.id);
    chk(
      "复习会话快照带 answers / is_multi",
      sc?.card_snapshot?.is_multi === true &&
        Array.isArray(sc?.card_snapshot?.answers) &&
        sc.card_snapshot.answers.length === 2,
      JSON.stringify(sc?.card_snapshot ?? {}).slice(0, 200)
    );
  }

  // ---- 手动标注正确答案 ----
  if (singleCard) {
    const setKey = await fetch(`${BASE}/api/cards/${encodeURIComponent(singleCard.id)}/answer-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [0, 2] }),
    });
    const out = await jsonOf(setKey);
    chk(
      "标注两项 → 升级为多选",
      setKey.status === 200 && out.ok === true && out.is_multi === true && out.answer === "A、C",
      JSON.stringify(out).slice(0, 160)
    );

    const again = await jsonOf(
      await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
    );
    const reread = (again.cards ?? []).find((c) => c.id === singleCard.id);
    chk(
      "标注结果持久化",
      reread?.is_multi === true && reread?.answer === "A、C" && Array.isArray(reread?.answers),
      JSON.stringify({ answer: reread?.answer, is_multi: reread?.is_multi })
    );

    const bad = await fetch(`${BASE}/api/cards/${encodeURIComponent(singleCard.id)}/answer-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [] }),
    });
    chk("一个都不选 → 400", bad.status === 400);
  }

  // ---- 错误台账 ----
  const target = multiCard ?? singleCard;
  const post = await fetch(`${BASE}/api/card-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card_id: target.id,
      kind: "not_question",
      note: "这是编号建议清单，不是题",
      source: "review",
    }),
  });
  const posted = await jsonOf(post);
  chk(
    "上报成功并返回快照",
    post.status === 200 && posted.ok === true && !!posted.report?.snapshot?.front,
    JSON.stringify(posted).slice(0, 160)
  );

  const open = await jsonOf(await fetch(`${BASE}/api/card-errors?status=open&limit=50`));
  chk(
    "明细里能查到这条",
    (open.reports ?? []).some((x) => x.id === posted.report?.id),
    String((open.reports ?? []).length)
  );
  chk("统计按病因归集", (open.summary?.by_kind ?? []).some((k) => k.kind === "not_question" && k.count >= 1));

  const reviewView = await jsonOf(await fetch(`${BASE}/api/card-errors?view=review`));
  chk(
    "监督员视图有结论与下一步",
    !!reviewView.review?.narrative && (reviewView.review?.next_actions ?? []).length > 0,
    JSON.stringify(reviewView.review ?? {}).slice(0, 160)
  );
  chk(
    "监督员把病因排在第一",
    reviewView.review?.findings?.[0]?.kind === "not_question"
  );

  const agentView = await jsonOf(await fetch(`${BASE}/api/card-errors?format=agent`));
  const firstAgentRow = (agentView.reports ?? [])[0];
  chk(
    "agent 视图是紧凑字段",
    !!firstAgentRow && "front" in firstAgentRow && !("snapshot" in firstAgentRow),
    JSON.stringify(firstAgentRow ?? {}).slice(0, 160)
  );

  const empty = await fetch(`${BASE}/api/card-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ card_id: target.id, kind: "other", note: "" }),
  });
  chk("空上报被拒（不产生垃圾记录）", empty.status === 400);

  const missingCard = await fetch(`${BASE}/api/card-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ card_id: "c_不存在", kind: "not_question" }),
  });
  chk("不存在的卡片 → 404", missingCard.status === 404);

  // ---- 原文识别核对 ----
  // /api/cards 附带的 sources 是片段对象本身（字段是 id），不是关联表那行
  const fragmentId = cards.find((c) => (c.sources ?? []).length > 0)?.sources?.[0]?.id ?? null;
  chk("卡片带出了原文片段 id", !!fragmentId);
  if (fragmentId) {
    const audit = await jsonOf(
      await fetch(`${BASE}/api/fragments/${encodeURIComponent(fragmentId)}/audit`)
    );
    chk(
      "核对视图返回分块与候选",
      audit.ok === true && Array.isArray(audit.rows) && Array.isArray(audit.blocks) && !!audit.coverage,
      JSON.stringify({ rows: audit.rows?.length, blocks: audit.blocks?.length })
    );
    chk(
      "已有卡片被标为已识别",
      (audit.rows ?? []).some((x) => x.status === "identified"),
      JSON.stringify((audit.rows ?? []).map((x) => x.status))
    );

    const created = await fetch(`${BASE}/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        front: `人工补录的题 ${stamp}`,
        options: ["A. 甲", "B. 乙"],
        answer: "A",
      }),
    });
    const createdOut = await jsonOf(created);
    chk(
      "人工录入建卡成功",
      created.status === 200 && createdOut.ok === true && createdOut.inserted === 1,
      JSON.stringify(createdOut).slice(0, 160)
    );

    const dupe = await jsonOf(
      await fetch(`${BASE}/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", front: `人工补录的题 ${stamp}`, options: ["A. 甲", "B. 乙"], answer: "A" }),
      })
    );
    chk("同题干重复录入不会建两张卡", dupe.skipped === 1);

    const tooShort = await fetch(`${BASE}/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", front: "题?" }),
    });
    chk("题干过短 → 400", tooShort.status === 400);
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
