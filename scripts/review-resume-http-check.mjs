// 复习进度续接的端到端契约（需要服务在跑，默认 http://127.0.0.1:3000）
//
// 这个脚本守的是用户实报的那个错乱：
//   复习到第 5 题 → 去原文 → 顺手点进别的页面 → 回复习页 → 又从第 1 题开始 / 又推到已答过的题。
//
// 判据（全部走真实 HTTP，不用 mock）：
//   1. 开会话 → 答一张 → GET /api/review/current 能拿回同一会话，且那张 rated=true；
//   2. 再 POST /api/review（resume=true）→ **同一个 session id**，不新建；
//   3. 不带 resume 才新建；新建的候选池已排除答过的卡（不会「重新复习」）；
//   4. 会话完成 → current 不再返回这一轮（不会把已结束的一轮又续上）；
//      注意断言只针对自己这一轮：真实库里用户可能有另一轮正在进行，那是合法的；
//   5. 刷新页面拿到的卡片顺序稳定（同一会话反复读，sort_order 不变）。
//
// 用法：npm run check:reviewresume（可用 BASE=... 指向隔离实例）

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
const title = `复习进度续接验证-${stamp}`;
const md = `# ${title}

## 基础

问题：什么是 RAG？
答案：检索增强生成，先检索再生成。

问题：什么是 Tokenizer？
答案：把文本切成模型可处理的 token 序列。

问题：过拟合是什么？
答案：模型在训练集表现好、在测试集表现差。
`;

let textbookId = null;

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  const submit = await jsonOf(
    await fetch(`${BASE}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: md }),
    })
  );
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

  // 卡片默认是 draft；审核语义为「通过 = 已掌握（移出队列）/ 拒绝 = 加入今日队列」，
  // 所以这里要用 reject 才能把它们推进复习池。
  const listed = await jsonOf(
    await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId ?? "")}`)
  );
  const cards = listed.cards ?? [];
  chk("抽到 3 张卡", cards.length === 3, `got ${cards.length}`);
  for (const c of cards) {
    const r = await fetch(`${BASE}/api/cards/${encodeURIComponent(c.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    if (r.status !== 200) console.log(`  WARN  加入复习队列失败 ${c.id.slice(0, 8)} → ${r.status}`);
  }

  // ---- 1) 开会话（带 resume：首屏就是这么调的）----
  const s1 = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, resume: true }),
    })
  );
  chk("会话创建成功", !!s1.session?.id && (s1.cards ?? []).length === 3, JSON.stringify(s1).slice(0, 160));
  chk("初始没有已答的卡", (s1.cards ?? []).every((c) => c.rated === false));
  chk("首次不是续接", s1.resumed === false);

  const order1 = (s1.cards ?? []).map((c) => `${c.sort_order}:${c.card_id}`).join("|");

  // ---- 2) 答第一张 ----
  const first = s1.cards[0];
  const rated = await fetch(`${BASE}/api/review/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card_id: first.card_id,
      rating: 3,
      session_id: s1.session.id,
      session_card_id: first.id,
      idempotency_key: `resume-${stamp}-1`,
    }),
  });
  chk("评分落库", rated.status === 201);

  // ---- 3) 「回到复习页」：current 必须给出同一会话 + 已答位 ----
  const cur = await jsonOf(await fetch(`${BASE}/api/review/current`));
  chk("current 命中同一会话", cur.session?.id === s1.session.id, JSON.stringify(cur.session ?? {}).slice(0, 120));
  chk("current 带回全部 3 张（不丢未答的）", (cur.cards ?? []).length === 3);
  chk(
    "已答那张 rated=true，其余 false",
    (cur.cards ?? []).filter((c) => c.rated === true).length === 1 &&
      (cur.cards ?? []).find((c) => c.card_id === first.card_id)?.rated === true
  );
  const order2 = (cur.cards ?? []).map((c) => `${c.sort_order}:${c.card_id}`).join("|");
  chk("反复读取卡片顺序稳定（不会跳题）", order1 === order2, `${order1} vs ${order2}`);

  // ---- 4) 再走一次 resume：同一会话，不新建 ----
  const s1b = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, resume: true }),
    })
  );
  chk("resume 复用同一 session id", s1b.session?.id === s1.session.id, `${s1b.session?.id} vs ${s1.session.id}`);
  chk("resume 标记为 true", s1b.resumed === true);
  chk("resume 后已答位仍在", (s1b.cards ?? []).filter((c) => c.rated).length === 1);

  // ---- 5) 不带 resume 才新建；候选池已排除答过的卡 ----
  const s2 = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId }),
    })
  );
  chk("不传 resume → 新会话", s2.session?.id && s2.session.id !== s1.session.id);
  chk(
    "新会话不再包含已答过的卡（不会重新复习）",
    !(s2.cards ?? []).some((c) => c.card_id === first.card_id),
    (s2.cards ?? []).map((c) => c.card_id.slice(0, 8)).join(",")
  );
  chk("新会话只剩未答的 2 张", (s2.cards ?? []).length === 2, `got ${(s2.cards ?? []).length}`);

  // ---- 6) 完成 → current 不再续接 ----
  const done = await jsonOf(
    await fetch(`${BASE}/api/review/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: s2.session.id }),
    })
  );
  chk("完成接口返回统计", done.rated === 0 && done.unrated === 2, JSON.stringify(done).slice(0, 120));

  // 断言必须**只针对自己这一轮**：真实库里用户随时可能有一轮正在进行的复习，
  // 那时 current 合法地返回那一轮。旧写法要求 `session === null`，一旦用户在用
  // 就一定误报（2026-11-08 实测：用户 22:12 起的一轮让这条恒红）。
  const after = await jsonOf(await fetch(`${BASE}/api/review/current`));
  const resumedOwn = after.session && after.session.id === s2.session.id;
  chk(
    "完成后不会把自己那一轮又续上",
    !resumedOwn,
    `current=${after.session ? `${after.session.id}(status=${after.session.status})` : "null"}`
  );
  // 顺带守一条数据不变量：current 返回的绝不该是已结束的一轮
  const afterStatus = after.session ? String(after.session.status) : "null";
  chk("current 不会返回已结束的会话", afterStatus !== "completed", afterStatus);

  // ---- 7) 跨会话答过的题：换书/双标签页场景下也不能再推一遍 ----
  // s3 = 按这本书「今日到期」的一轮（剩 2 张未答）
  const s3 = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, resume: true }),
    })
  );
  chk("重新开一轮（已完成的不会续接）", !!s3.session?.id && (s3.cards ?? []).length === 2, JSON.stringify(s3).slice(0, 140));

  // s4 = scope=all 的另一轮，范围不同 → 不会顶掉 s3
  const s4 = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, scope: "all" }),
    })
  );
  chk("scope=all 另开一轮", !!s4.session?.id && s4.session.id !== s3.session?.id, JSON.stringify(s4).slice(0, 140));

  // 在 s4 里答掉一张「s3 也包含」的题
  const shared = (s4.cards ?? []).find((c) => (s3.cards ?? []).some((x) => x.card_id === c.card_id));
  if (shared) {
    await fetch(`${BASE}/api/review/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        card_id: shared.card_id,
        rating: 3,
        session_id: s4.session.id,
        session_card_id: shared.id,
        idempotency_key: `resume-${stamp}-2`,
      }),
    });
  }

  const s3b = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, resume: true }),
    })
  );
  chk("续接回 s3（范围相同）", s3b.session?.id === s3.session?.id, `${s3b.session?.id} vs ${s3.session?.id}`);
  chk(
    "别的会话里答过的题，续接时也算已答（不再推给用户）",
    !shared || (s3b.cards ?? []).find((c) => c.card_id === shared.card_id)?.rated === true,
    JSON.stringify((s3b.cards ?? []).map((c) => [c.card_id.slice(0, 6), c.rated]))
  );

  // 认领 s3 之后，s4 必须**活着**：两者范围不同（due vs all）。
  // 早期这里会把跨范围的会话一并作废，用户「A 书刷一半 → 去 B 书 → 回 A 书」
  // 就丢进度；现在的语义是「同范围只留一轮，跨范围各自保留」。
  const s4b = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, scope: "all", resume: true }),
    })
  );
  chk(
    "跨范围的另一轮不被顶掉（scope=all 仍可续接）",
    !!s4b.session?.id && s4b.session.id === s4.session?.id,
    `${s4b.session?.id} vs ${s4.session?.id}`
  );
  // ---- 8) 池子空不是错误：回 200 + empty ----
  // 原来这里抛 400，前端当失败渲染成红色告警「今天没有到期复习的卡片」，
  // 用户刚刷完切回来会以为进度坏了。现在按正常状态回，前端显示「已复习」。
  const ghostRes = await fetch(`${BASE}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ textbookId: `ghost-${stamp}`, resume: true }),
  });
  const ghost = await jsonOf(ghostRes);
  chk("没有卡的书不再报错（200 而不是 400）", ghostRes.status === 200, String(ghostRes.status));
  chk("空池带 empty 标记与说明", ghost.empty === true && typeof ghost.message === "string", JSON.stringify(ghost).slice(0, 120));
  chk("空池没有会话（不会建出一个空轮次）", ghost.session === null);
  chk("空池说明不含易误读措辞", !/无到期|没有到期/.test(ghost.message ?? ""), ghost.message);
} catch (e) {
  fail++;
  console.log(`  FAIL  端到端异常 ← ${e?.message ?? e}`);
} finally {
  if (textbookId) {
    try {
      const del = await fetch(`${BASE}/api/books/${encodeURIComponent(textbookId)}`, { method: "DELETE" });
      chk("临时材料已清理", del.status === 200);
    } catch {
      console.log(`  WARN  临时材料清理失败，id=${textbookId}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
