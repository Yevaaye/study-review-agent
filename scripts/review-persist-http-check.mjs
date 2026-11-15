// 复习进度持久化：跨书、跨页面的端到端契约（需要服务在跑）
//
// 用户这次报的是「在 A 书复习到一半，跳去别的页面看别的，回来要能接上」。
// 上一版修了「同一本书的续接」，但续接时会把**其它所有**进行中会话作废，
// 于是「A 书刷一半 → 去 B 书看一眼 → 回 A 书」这条真实路径上进度还是丢。
//
// 这里用两本书把那条路径走一遍：
//   1. A 开一轮、答 1 张 → /api/review/inprogress 给出 A 的断点（总数/已答/下一张）；
//   2. B 也开一轮、答 1 张 → A 的断点**仍然在**（跨书并行保留）；
//   3. current?book=A 回到 A 的同一轮，已答那张 rated=true；
//   4. current（无参）回到最近一轮 B —— 不会串书；
//   5. A 续接沿用同一 session（不新建、不从第 1 张重来）；
//   6. A 全部答完 → 断点列表里 A 消失（不再是「没刷完」）；
//   7. 不存在的书 → session=null，不硬塞别的书。
//
// 用法：BASE=http://127.0.0.1:3100 npm run check:reviewpersisthttp

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
const created = [];

async function importBook(tag) {
  const title = `进度持久化-${tag}-${stamp}`;
  const md = `# ${title}

## 基础

问题：${tag} 的第一题是什么？
答案：${tag} 的第一个答案。

问题：${tag} 的第二题是什么？
答案：${tag} 的第二个答案。

问题：${tag} 的第三题是什么？
答案：${tag} 的第三个答案。
`;
  const submit = await jsonOf(
    await fetch(`${BASE}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: md }),
    })
  );
  let result = null;
  for (let i = 0; i < 150 && submit.job_id; i++) {
    const list = await jsonOf(await fetch(`${BASE}/api/jobs`));
    const cur = (list.jobs ?? []).find((j) => j.id === submit.job_id);
    if (cur && cur.status !== "running") {
      result = cur.result ?? null;
      break;
    }
    await new Promise((s) => setTimeout(s, 400));
  }
  const id = result?.textbook_id ?? null;
  if (id) created.push(id);
  return id;
}

async function pushToReviewQueue(textbookId) {
  const listed = await jsonOf(
    await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(textbookId)}`)
  );
  const cards = listed.cards ?? [];
  for (const c of cards) {
    await fetch(`${BASE}/api/cards/${encodeURIComponent(c.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
  }
  return cards;
}

async function openSession(textbookId) {
  return jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textbookId, resume: true }),
    })
  );
}

async function rateCard(sessionId, row, key) {
  return fetch(`${BASE}/api/review/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card_id: row.card_id,
      rating: 3,
      session_id: sessionId,
      session_card_id: row.id,
      idempotency_key: key,
    }),
  });
}

async function inprogress() {
  const data = await jsonOf(await fetch(`${BASE}/api/review/inprogress`));
  return data.items ?? [];
}

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  // ---- 准备两本书 ----
  const bookA = await importBook("A");
  const bookB = await importBook("B");
  chk("两本书都导入成功", !!bookA && !!bookB, `${bookA} / ${bookB}`);
  const cardsA = await pushToReviewQueue(bookA);
  const cardsB = await pushToReviewQueue(bookB);
  chk("两本书各有 3 张卡", cardsA.length === 3 && cardsB.length === 3, `${cardsA.length}/${cardsB.length}`);

  // ---- 1) A 开一轮，答 1 张 ----
  const a1 = await openSession(bookA);
  chk("A 开会话成功", !!a1.session?.id && (a1.cards ?? []).length === 3, JSON.stringify(a1).slice(0, 140));
  await rateCard(a1.session.id, a1.cards[0], `persist-${stamp}-a1`);

  const p1 = (await inprogress()).find((it) => it.scope?.textbook_id === bookA);
  chk("断点列表出现 A", !!p1, JSON.stringify(await inprogress()).slice(0, 200));
  chk("A 断点：总数 3 / 已答 1 / 剩 2", p1?.total === 3 && p1?.rated === 1 && p1?.remaining === 2, JSON.stringify(p1));
  chk("A 断点：下一张是第 2 张（next_index=1）", p1?.next_index === 1, String(p1?.next_index));
  chk("A 断点带书名（选书页要显示在哪本书上继续）", typeof p1?.textbook_title === "string" && p1.textbook_title.length > 0, String(p1?.textbook_title));

  // ---- 2) 切到 B 书，答 1 张；A 的断点必须还在 ----
  const b1 = await openSession(bookB);
  chk("B 开会话成功", !!b1.session?.id && (b1.cards ?? []).length === 3);
  await rateCard(b1.session.id, b1.cards[0], `persist-${stamp}-b1`);

  const items2 = await inprogress();
  const aStill = items2.find((it) => it.scope?.textbook_id === bookA);
  const bNow = items2.find((it) => it.scope?.textbook_id === bookB);
  chk("跨书并行：A 的断点没有被 B 顶掉", !!aStill, JSON.stringify(items2.map((x) => x.scope?.textbook_id)));
  chk("A 断点的已答数仍是 1（不被清空）", aStill?.rated === 1, String(aStill?.rated));
  chk("B 也出现在断点列表里", !!bNow && bNow.rated === 1, JSON.stringify(bNow));

  // ---- 3) current?book=A 精确回到 A ----
  const curA = await jsonOf(await fetch(`${BASE}/api/review/current?book=${encodeURIComponent(bookA)}`));
  chk("current?book=A 命中 A 的会话", curA.session?.id === a1.session.id, `${curA.session?.id} vs ${a1.session.id}`);
  chk("current?book=A 带回全部 3 张（未答的也在）", (curA.cards ?? []).length === 3);
  chk(
    "current?book=A 保留「哪张答过」",
    (curA.cards ?? []).filter((c) => c.rated === true).length === 1 &&
      (curA.cards ?? []).find((c) => c.card_id === a1.cards[0].card_id)?.rated === true,
    JSON.stringify((curA.cards ?? []).map((c) => c.rated))
  );

  // ---- 4) current 无参 → 最近一轮（B），不串书 ----
  const curLast = await jsonOf(await fetch(`${BASE}/api/review/current`));
  chk("current 无参命中最近一轮 B", curLast.session?.id === b1.session.id, String(curLast.session?.id));

  // ---- 5) A 续接：同一会话，不从第 1 张重来 ----
  const a2 = await openSession(bookA);
  chk("A 续接沿用同一 session id", a2.session?.id === a1.session.id, `${a2.session?.id} vs ${a1.session.id}`);
  chk("A 续接标记 resumed=true", a2.resumed === true);
  chk("A 续接已答位仍在（不会重新推第 1 题）", (a2.cards ?? []).filter((c) => c.rated).length === 1);
  const firstUnrated = (a2.cards ?? []).find((c) => !c.rated);
  chk("A 续接的下一张确实是未答的那张", !!firstUnrated && firstUnrated.card_id !== a1.cards[0].card_id);

  // ---- 6) A 全部答完 → 断点列表里消失 ----
  for (const row of (a2.cards ?? []).filter((c) => !c.rated)) {
    await rateCard(a2.session.id, row, `persist-${stamp}-a-${row.card_id.slice(0, 6)}`);
  }
  const items3 = await inprogress();
  chk(
    "A 全答完后不再算「没刷完」（断点列表里消失）",
    !items3.some((it) => it.scope?.textbook_id === bookA),
    JSON.stringify(items3.map((x) => x.scope?.textbook_id))
  );
  chk("B 的断点不受影响，仍在列表里", items3.some((it) => it.scope?.textbook_id === bookB));

  // ---- 7) 不存在的书：回空，不硬塞别的书 ----
  const ghost = await jsonOf(await fetch(`${BASE}/api/review/current?book=ghost-${stamp}`));
  chk("current?book=不存在的书 → session=null（不硬塞别的书）", ghost.session === null, JSON.stringify(ghost).slice(0, 120));
  chk("current?book=不存在的书 → cards 为空数组", Array.isArray(ghost.cards) && ghost.cards.length === 0);
} catch (e) {
  fail++;
  console.log(`  FAIL  端到端异常 ← ${e?.message ?? e}`);
} finally {
  for (const id of created) {
    try {
      await fetch(`${BASE}/api/books/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      console.log(`  WARN  临时材料清理失败，id=${id}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
