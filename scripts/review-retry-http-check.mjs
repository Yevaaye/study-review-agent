// 「答错当天必须能重做」端到端契约（需要服务在跑，默认 :3114 隔离实例）
//
// 用户实报三件事：
//   1) 答错后点复习没生效，当天不再出现这道题
//   2) 页面写着「当天会再复习」，但实际刷不到该题
//   3) 退出后直接显示「已复习」，还顺手跳到下一本书
//
// 根因（探针实测）：Again 之后 FSRS 把到期压到 now+10min，而「今日到期」池只认
// due_at <= now —— 10 分钟内它哪儿都不在；同时今日统计只看 due，于是选书页算不出
// 「还有错题没做」，直接显示已复习。
//
// 这里的判据是「答错 ≠ 结束」：
//   A. 答错后今日统计立刻出现错题数（stats.retry_count / books[].retry）
//   B. scope=retry 立刻能拉到该卡（不等 10 分钟）
//   C. 答对后立刻从错题口径里消失；池空时给出「都答对了」而不是报错
//   D. 反复「答错 → 重做 → 答对」不重复、不残留
//   E. 只把「今天最后一次评分=1」的卡算错题：从没答过的卡不能混进来
//   F. 全程用临时材料，收尾删除，不碰真实书库
//
// 用法：npm run check:reviewretry（BASE=... 指向隔离实例）
const BASE = process.env.BASE || "http://127.0.0.1:3114";

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
const title = `错题重做验证-${stamp}`;
const md = `# ${title}

## 第一章

### Q: 为什么缓存要设置过期时间？

**参考答案：** 防止数据长期不更新导致脏读；也给内存回收一个上限。

### Q: 分布式锁为什么不能只靠 SETNX？

**参考答案：** 缺少过期时间会让死锁永久化；缺少持有者标识会让误删别人的锁。
`;

const created = [];
let textbookId = "";

async function importBook() {
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
    await new Promise((r) => setTimeout(r, 800));
  }
  const books = await jsonOf(await fetch(`${BASE}/api/books`));
  return String((books.textbooks ?? []).find((t) => t.title === title)?.id ?? "");
}

/** 导入的卡是 draft，reject 动作 = 加入复习（active） */
async function pushToReview(id) {
  const before = jsonOf(await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(id)}`));
  const draft = (await before).cards ?? [];
  for (const c of draft) {
    await fetch(`${BASE}/api/cards/${encodeURIComponent(c.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
  }
  // 重新取一次：reject 之前的快照 status 还是 draft，拿它断言等于拿旧数据自证
  const after = await jsonOf(
    await fetch(`${BASE}/api/cards?status=all&textbookId=${encodeURIComponent(id)}`)
  );
  return after.cards ?? [];
}

async function todayOf(bookId) {
  const data = await jsonOf(await fetch(`${BASE}/api/today`));
  const book = (data.books ?? []).find((b) => b.id === bookId) ?? null;
  return {
    retry_count: data.stats?.retry_count ?? 0,
    due_count: data.stats?.due_count ?? 0,
    book_due: book?.due ?? null,
    book_retry: book?.retry ?? null,
    raw: data,
  };
}

async function openRetry(bookId) {
  return jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "retry", textbookId: bookId, resume: false }),
    })
  );
}

let sessionSeq = 0;
async function openSession(bookId, scope) {
  const body = { textbookId: bookId, resume: false };
  if (scope) body.scope = scope;
  return jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function rate(sessionId, row, rating) {
  const res = await fetch(`${BASE}/api/review/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card_id: row.card_id,
      rating,
      session_id: sessionId,
      session_card_id: row.id,
      // 每轮作答一个新键：同一张卡可以反复评分，不能被幂等挡掉
      idempotency_key: `qa-retry-${stamp}-${++sessionSeq}`,
    }),
  });
  return { status: res.status, data: await jsonOf(res) };
}

async function complete(sessionId) {
  return jsonOf(
    await fetch(`${BASE}/api/review/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    })
  );
}

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 100));
  chk(
    "跑在隔离实例上（不是真实书库）",
    /:(3114|3113|3112|3115)$/.test(BASE),
    `BASE=${BASE}，真实库请用 BASE 指隔离实例再跑`
  );

  textbookId = await importBook();
  if (textbookId) created.push(textbookId);
  chk("临时材料已入库", !!textbookId, title);
  if (!textbookId) throw new Error("没有临时材料");

  const cards = await pushToReview(textbookId);
  chk("导入出了两张卡", cards.length === 2, `got ${cards.length}`);
  const cardA = cards.find((c) => String(c.front ?? "").includes("缓存"));
  const cardB = cards.find((c) => String(c.front ?? "").includes("SETNX"));
  chk("两张题都拿到了", !!cardA && !!cardB);
  chk("卡片已进入复习状态", cards.every((c) => c.status === "active"), cards.map((c) => c.status).join(","));

  // ---- 0) 从未答过：错题口径必须干净 ----
  const t0 = await todayOf(textbookId);
  chk("开跑前今日错题为 0", t0.retry_count === 0, String(t0.retry_count));
  chk("开跑前这本书错题为 0", t0.book_retry === 0, String(t0.book_retry));
  const r0 = await openRetry(textbookId);
  chk("没答错时错题池是空的（不会把新卡混进来）", r0.empty === true && (r0.cards ?? []).length === 0, JSON.stringify(r0).slice(0, 120));
  chk("空池文案说明「都答对了」", String(r0.message ?? "").includes("都答对"), String(r0.message ?? ""));

  // ---- 1) 开一轮正常复习，第一题答错 ----
  const s1 = await openSession(textbookId);
  chk("默认复习能开到两张卡", (s1.cards ?? []).length === 2, `got ${(s1.cards ?? []).length}`);
  const rowA = (s1.cards ?? []).find((r) => r.card_id === cardA.id);
  chk("会话里有目标卡", !!rowA);
  const rateA1 = await rate(s1.session.id, rowA, 1);
  chk("答错（rating=1）提交成功", rateA1.status === 201 || rateA1.status === 200, `HTTP ${rateA1.status}`);
  const nextDue = Date.parse(String(rateA1.data.next_due ?? ""));
  chk(
    "答错后 FSRS 把下次到期压到 10 分后（所以它不在「到期」池）",
    Number.isFinite(nextDue) && nextDue > Date.now(),
    String(rateA1.data.next_due)
  );

  // ---- 2) 今日统计必须立刻反映「有道错题没重做」----
  const t1 = await todayOf(textbookId);
  chk("今日错题数立刻 +1", t1.retry_count === 1, String(t1.retry_count));
  chk("这本书错题数立刻 +1（选书页要显示）", t1.book_retry === 1, String(t1.book_retry));
  chk("答错的卡没有混进「今日到期」", (t1.raw.due ?? []).every((d) => d.card_id !== cardA.id));

  // ---- 3) 立刻能重做（不等 10 分钟）----
  const r1 = await openRetry(textbookId);
  chk("错题池不为空（当天可重做）", r1.empty !== true, JSON.stringify(r1).slice(0, 140));
  const retryIds1 = (r1.cards ?? []).map((c) => c.card_id);
  chk("错题池里就是刚答错的那张", retryIds1.length === 1 && retryIds1[0] === cardA.id, retryIds1.join(","));
  chk("错题池不重复", new Set(retryIds1).size === retryIds1.length);
  chk("没答过的卡不会被塞进错题池", !retryIds1.includes(cardB.id));
  chk("「重做」是一个全新的会话", r1.session?.id && r1.session.id !== s1.session.id);

  // ---- 4) 重做时答对 → 错题口径归零 ----
  const rowA2 = (r1.cards ?? []).find((c) => c.card_id === cardA.id);
  const rateA2 = await rate(r1.session.id, rowA2, 3);
  chk("重做答对提交成功", rateA2.status === 201 || rateA2.status === 200, `HTTP ${rateA2.status}`);
  await complete(r1.session.id);
  const t2 = await todayOf(textbookId);
  chk("答对后今日错题数归零", t2.retry_count === 0, String(t2.retry_count));
  chk("答对后这本书错题数归零", t2.book_retry === 0, String(t2.book_retry));
  const r2 = await openRetry(textbookId);
  chk("答对后错题池变空", r2.empty === true, JSON.stringify(r2).slice(0, 120));
  chk("空池仍是正常状态（200 + empty，不是红色报错）", String(r2.message ?? "").includes("都答对"), String(r2.message ?? ""));

  // ---- 5) 连续操作：再答错 → 再重做 → 再答对 ----
  const s3 = await openSession(textbookId, "all");
  const rowA3 = (s3.cards ?? []).find((c) => c.card_id === cardA.id);
  chk("还能再开一轮拿到这张卡", !!rowA3, `cards=${(s3.cards ?? []).length}`);
  await rate(s3.session.id, rowA3, 1);
  const t3 = await todayOf(textbookId);
  chk("第二次答错，错题数回到 1", t3.retry_count === 1, String(t3.retry_count));
  const r3 = await openRetry(textbookId);
  const retryIds3 = (r3.cards ?? []).map((c) => c.card_id);
  chk("第二次也能立刻重做", retryIds3.length === 1 && retryIds3[0] === cardA.id, retryIds3.join(","));
  const rowA3b = (r3.cards ?? [])[0];
  await rate(r3.session.id, rowA3b, 3);
  await complete(r3.session.id);
  const t4 = await todayOf(textbookId);
  chk("第二次答对后又归零（可反复）", t4.retry_count === 0, String(t4.retry_count));

  // ---- 6) 边界：两题都答错 → 两条都进池，互不覆盖 ----
  const s5 = await openSession(textbookId, "all");
  const rows5 = s5.cards ?? [];
  for (const row of rows5) await rate(s5.session.id, row, 1);
  await complete(s5.session.id);
  const t5 = await todayOf(textbookId);
  chk("两题都答错 → 错题数 2", t5.retry_count === 2, String(t5.retry_count));
  chk("这本书也显示 2 道待重做", t5.book_retry === 2, String(t5.book_retry));
  const r5 = await openRetry(textbookId);
  const ids5 = (r5.cards ?? []).map((c) => c.card_id).sort();
  chk("错题池两条都在", ids5.length === 2, `got ${ids5.length}`);
  chk("错题池无重复", new Set(ids5).size === 2);
  // 只答对一条，另一条仍要留在池里 —— 否则「逐条消错题」会漏
  const onlyA = (r5.cards ?? []).find((c) => c.card_id === cardA.id);
  await rate(r5.session.id, onlyA, 3);
  await complete(r5.session.id);
  const t6 = await todayOf(textbookId);
  chk("只答对一道 → 剩余 1 道", t6.retry_count === 1, String(t6.retry_count));
  const r6 = await openRetry(textbookId);
  const ids6 = (r6.cards ?? []).map((c) => c.card_id);
  chk("剩下的是另一道", ids6.length === 1 && ids6[0] === cardB.id, ids6.join(","));
  await rate(r6.session.id, (r6.cards ?? [])[0], 3);
  await complete(r6.session.id);
  const t7 = await todayOf(textbookId);
  chk("全部答对后归零", t7.retry_count === 0, String(t7.retry_count));

  // ---- 7) 边界：书被删掉后，错题池不能挂着不存在的卡 ----
  const s7 = await openSession(textbookId, "all");
  for (const row of s7.cards ?? []) await rate(s7.session.id, row, 1);
  await complete(s7.session.id);
  const t8 = await todayOf(textbookId);
  chk("删除前错题数 2", t8.retry_count === 2, String(t8.retry_count));
  const del = await fetch(`${BASE}/api/books/${encodeURIComponent(textbookId)}`, { method: "DELETE" });
  chk("临时材料删除成功", del.status === 200, `HTTP ${del.status}`);
  if (del.status === 200) {
    created.length = 0;
    const r7 = await openRetry(textbookId);
    chk("书删了以后错题池不再返回它", r7.empty === true || (r7.cards ?? []).length === 0, JSON.stringify(r7).slice(0, 140));
    const t9 = await todayOf(textbookId);
    chk("书删了以后今日错题数归零", t9.retry_count === 0, String(t9.retry_count));
  }
} catch (e) {
  fail++;
  console.log(`  FAIL  执行中断：${e?.message ?? e}`);
} finally {
  for (const id of created) {
    try {
      const del = await fetch(`${BASE}/api/books/${encodeURIComponent(id)}`, { method: "DELETE" });
      chk("临时材料已清理", del.status === 200, `HTTP ${del.status}`);
    } catch (e) {
      console.log(`  WARN  清理失败 id=${id}：${e?.message ?? e}`);
    }
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}
