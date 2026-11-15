// 「问答对排版」的原文答案端到端契约（需要服务在跑，默认 :3000）
//
// 用户实报：《Agent Harness 与编码代理测评》这本书原文里明明有答案，
// 而且就在「我划出来那张卡」的下一句，界面却标成「原文未给出」、答案也是 AI 写的。
//
// 这本书的写法是「题干独占一段 + 答案一段（引用块）」，两段之间**没有**
// 「答案：」这类标签 —— 靠排版表达「下面是答案」。分片又恰好按题目切开，
// 于是答案落在**下一个片段**里。以前只认标签，必然落空。
//
// 判据：
//   1. 题干与答案确实被分到两个片段（先验证前提，否则测的是别的东西）
//   2. 点「补全答案」写回的必须是下一段的**原文**（逐字），origin="source"
//   3. 原文里的特征词（DockerCommandLineCodeExecutor）不能丢 —— AI 版就丢过
//   4. 不许把下一道题吃进答案里
//   5. 连续点两次结果一致；落库 origin=source、grounded=true
//   6. 全程用临时材料，收尾删除，不碰真实书库
//
// 用法：npm run check:answeradjhttp（可用 BASE=... 指向隔离实例）
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
const title = `问答对排版验证-${stamp}`;

const Q_HIT = "AutoGen 的代码执行器为什么默认本地有风险？生产如何隔离？";
const A_HIT =
  "本地执行器直接以进程身份运行任意代码，等于把宿主机暴露给模型输出。生产应使用 `DockerCommandLineCodeExecutor` / Jupyter 等隔离执行环境，并配合网络与资源限制。";
const Q_NEXT = "长任务上下文放不下时有哪些手段？各自取舍？";
const A_NEXT = "截断、摘要、结构化检索、token budget、子代理隔离，选型看任务对细节还是语义更依赖。";

// 两个「题干段 + 答案段」，中间空行 —— 复刻真书的分片形态
const md = `# ${title}

## 第一章

**1. ${Q_HIT}**

> ${A_HIT}

**2. ${Q_NEXT}**

> ${A_NEXT}
`;

let textbookId = "";

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 80));

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

  const books = await jsonOf(await fetch(`${BASE}/api/books`));
  textbookId = String((books.textbooks ?? []).find((t) => t.title === title)?.id ?? "");
  chk("临时材料已入库", !!textbookId, title);
  if (!textbookId) throw new Error("没有临时材料");

  // ---- 取卡 ----
  const all = await jsonOf(await fetch(`${BASE}/api/cards?limit=1000`));
  const mine = (all.cards ?? []).filter((c) => (c.sources ?? []).some((s) => s.textbook_id === textbookId));
  chk("导入出了卡片", mine.length >= 1, `got ${mine.length}`);

  const card = mine.find((c) => String(c.front ?? "").includes("AutoGen"));
  chk("抽到了这道题", !!card, mine.map((c) => String(c.front).slice(0, 12)).join(" / "));
  if (!card) throw new Error("没抽到目标卡片");

  // ---- 前提验证：答案不在卡片绑定的那一片里，且原文没有任何「答案：」标签 ----
  const ownText = (card.sources ?? []).map((s) => String(s.content ?? "")).join("\n");
  chk("卡片绑定的片段里只有题干，答案不在这一片", ownText.includes(Q_HIT) && !ownText.includes("DockerCommandLineCodeExecutor"), ownText.replace(/\n/g, " ").slice(0, 60));
  chk("这本书的答案确实没有任何「答案：」标签", !/(?:参考答案|标准答案|答案)\s*[:：]/.test(A_HIT));

  // 把答案改残：模拟用户看到「AI 转述 / 原文未给出」的状态
  await fetch(`${BASE}/api/cards/${card.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "edit", back: "本地执行可能泄露数据，应隔离。" }),
  });

  // ---- 1) 默认检索：应直接采用下一段原文 ----
  const fix = await jsonOf(
    await fetch(`${BASE}/api/cards/${card.id}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "truncated" }),
    })
  );
  chk("补全成功", fix.ok === true, JSON.stringify(fix).slice(0, 200));
  chk("来源标记为原文（origin=source）而不是 AI", fix.origin === "source", String(fix.origin));

  const back = String(fix.back ?? "");
  chk("不再是无标签时兜底的那句残句", back !== "本地执行可能泄露数据，应隔离。", back.slice(0, 40));
  chk("答案与原文逐字一致（是原文而不是 AI 转述）", back.replace(/\s+/g, "") === A_HIT.replace(/\s+/g, ""), back.slice(0, 70));
  chk("原文特征词没丢（DockerCommandLineCodeExecutor）", /DockerCommandLineCodeExecutor/.test(back), back.slice(0, 70));
  chk("没把引用符 > 带进来", !/^>/.test(back), back.slice(0, 12));
  chk("没把下一道题吃进答案", !/长任务上下文|截断、摘要/.test(back), back.slice(-40));
  chk("检索范围就算在自己绑定的片段上（scope=card）", fix.scope === "card", String(fix.scope));
  chk("带回命中片段 id（可定位到答案那一段）", typeof fix.source_fragment_id === "string" && !!fix.source_fragment_id);

  // ---- 2) 落库核对 ----
  const after = await jsonOf(await fetch(`${BASE}/api/cards?limit=1000`));
  const saved = (after.cards ?? []).find((c) => c.id === card.id);
  chk("答案已落库为原文", String(saved?.back ?? "").replace(/\s+/g, "") === A_HIT.replace(/\s+/g, ""));
  chk("answer_origin 落库为 source", saved?.answer_origin === "source", String(saved?.answer_origin));
  chk("answer_grounded 落库为 true", saved?.answer_grounded === true, String(saved?.answer_grounded));
  chk("needs_answer 已清零", saved?.needs_answer === false, String(saved?.needs_answer));

  // ---- 3) 再点一次（含全书查找）结果必须一致 ----
  const fix2 = await jsonOf(
    await fetch(`${BASE}/api/cards/${card.id}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "truncated", fullText: true }),
    })
  );
  chk("全书查找模式仍然成功", fix2.ok === true, JSON.stringify(fix2).slice(0, 120));
  chk("全书查找模式仍优先用原文", fix2.origin === "source", String(fix2.origin));
  chk("连续两次结果一致", String(fix2.back ?? "").replace(/\s+/g, "") === A_HIT.replace(/\s+/g, ""));

  // ---- 4) 另一道题也要能各自对上自己的答案（不串题） ----
  const card2 = mine.find((c) => String(c.front ?? "").includes("长任务上下文"));
  chk("抽到了第二道题", !!card2);
  if (card2) {
    const fix3 = await jsonOf(
      await fetch(`${BASE}/api/cards/${card2.id}/fix-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "missing" }),
      })
    );
    const back3 = String(fix3.back ?? "");
    chk("第二道题走原文", fix3.origin === "source", String(fix3.origin));
    chk("第二道题拿到的是自己的答案（没串到上一题）", /子代理隔离|token budget/.test(back3) && !/DockerCommandLineCodeExecutor/.test(back3), back3.slice(0, 60));
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  异常中断  ← ${String(err?.message ?? err)}`);
} finally {
  if (textbookId) {
    const del = await fetch(`${BASE}/api/books/${textbookId}`, { method: "DELETE" });
    console.log(`\n  清理临时材料 ${title}: HTTP ${del.status}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
