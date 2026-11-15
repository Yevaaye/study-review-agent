// 答案保鲜的端到端契约（需要服务在跑，默认 http://127.0.0.1:3000）
//
// 守的是这次的需求：
//   让 AI 补全答案后，**回到这道题必须看到补全后的答案**，而不是建会话
//   那一刻冻结的旧答案；同时题干与选项不许被顺手换掉。
//
// 判据全部走真实 HTTP + 真实文件：
//   1. 导入一本书 → 卡片进复习池 → 建一轮复习；
//   2. 记下会话卡快照里的旧答案；
//   3. 通过 action=edit 改写答案（content_revision 自增）；
//   4. 重新 GET /api/review/current → 快照答案应为新答案，题干不变；
//   5. 磁盘上的会话快照仍是旧值（只影响响应，不改写历史）；
//   6. 没编辑过的卡，快照保持不变。
//
// 用法：npm run check:reviewfreshhttp（可用 BASE=... / DATA_DIR=... 指向隔离实例）

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

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
// 每次跑都必须是一个**内容不同**的答案。用固定字符串时，第二次跑等于「把答案
// 改成它现在的值」，内容没变 → 保鲜逻辑判定无需刷新（这是对的），
// 但断言「版本号跟进」就永远红（2026-11-08 实测：served=4 vs live=5）。
const NEW_ANSWER = `补全后的完整答案（${stamp}）：先检索，再重排，最后交给模型生成。`;
const title = `答案保鲜验证-${stamp}`;
const md = `# ${title}

## 检索

问题：RAG 的检索流程是什么？
答案：先检索。

问题：为什么要重排？
答案：提升相关性。

问题：分块大小怎么定？
答案：256-512 tokens。
`;

const touched = [];
/** 本次临时材料的 id：用来把复习范围**限定在这本书**，并在收尾时删掉 */
let textbookId = "";

try {
  const health = await jsonOf(await fetch(`${BASE}/api/health`));
  chk("服务在线", health.ok === true, JSON.stringify(health).slice(0, 120));

  // ---- 1. 造数据并放进复习池 ----
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

  // 用标题找回这次导入的书 id：卡片列表接口不带 textbook_id，
  // 只有 sources[].textbook_id 有；而「按 title 精确匹配」最稳。
  const books = await jsonOf(await fetch(`${BASE}/api/books`));
  const myBook = (books.textbooks ?? []).find((t) => t.title === title);
  textbookId = String(myBook?.id ?? "");
  chk("临时材料已入库", !!textbookId, `title=${title} books=${(books.textbooks ?? []).length}`);
  if (!textbookId) throw new Error("找不到本次导入的材料，无法继续");

  // 只拿这本书的卡：绝不回退到「随便一张草稿卡」——那会改写用户真实书库，
  // 而这条测试本身会改答案，等于拿真数据做实验（2026-11-08 踩过）。
  const all = await jsonOf(await fetch(`${BASE}/api/cards?limit=1000`));
  const pool = (all.cards ?? []).filter((c) =>
    (c.sources ?? []).some((s) => s.textbook_id === textbookId)
  );
  chk("导入后有卡片（且都属于本次临时材料）", pool.length > 0, `got ${pool.length}`);
  if (pool.length === 0) throw new Error("没有本次临时材料的卡片，无法继续");

  // reject = 进复习池（approve 是 mastered 出队，测不出复习）
  for (const c of pool.slice(0, 6)) {
    await fetch(`${BASE}/api/cards/${c.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    touched.push(c.id);
  }

  // ---- 2. 建一轮复习 ----
  const started = await jsonOf(
    await fetch(`${BASE}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 范围锁定到临时材料：既不会续接到用户正在复习的那一轮，
      // 也不会把别人的卡拉进来当靶子
      body: JSON.stringify({ textbookId, scope: "all", resume: true }),
    })
  );
  const cards = started.cards ?? [];
  chk("复习会话已建立且带卡片", cards.length > 0, `cards=${cards.length}`);
  if (cards.length === 0) throw new Error("没有会话卡，无法继续");

  const target = cards.find((c) => (c.card_snapshot?.back ?? "").trim().length > 0) ?? cards[0];
  const cardId = target.card_id;
  const oldBack = String(target.card_snapshot?.back ?? "");
  const oldFront = String(target.card_snapshot?.front ?? "");
  const oldRev = Number(target.card_snapshot?.content_revision ?? 0);
  const sessionId = started.session?.id;

  chk("目标卡有旧答案", oldBack.length > 0, `back="${oldBack.slice(0, 30)}"`);

  // 再挑一张不做任何修改的卡，用于验证「没编辑就不动」
  const control = cards.find((c) => c.card_id !== cardId);
  const controlBack = String(control?.card_snapshot?.back ?? "");

  // ---- 3. 改写答案 ----
  const editRes = await jsonOf(
    await fetch(`${BASE}/api/cards/${cardId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", back: NEW_ANSWER }),
    })
  );
  chk("改写答案成功", editRes.card?.back === NEW_ANSWER, JSON.stringify(editRes).slice(0, 160));
  chk(
    "content_revision 自增",
    Number(editRes.card?.content_revision ?? 0) > oldRev,
    `${editRes.card?.content_revision} vs ${oldRev}`
  );

  // ---- 4. 回到这道题 ----
  const back = await jsonOf(
    await fetch(`${BASE}/api/review/current?book=${encodeURIComponent(textbookId)}`)
  );
  const after = (back.cards ?? []).find((c) => c.card_id === cardId);
  chk("同一轮会话仍可续接", back.session?.id === sessionId, `${back.session?.id} vs ${sessionId}`);
  chk(
    "回到这道题看到的是补全后的答案",
    String(after?.card_snapshot?.back ?? "") === NEW_ANSWER,
    `got="${String(after?.card_snapshot?.back ?? "").slice(0, 40)}"`
  );
  chk(
    "题干没有被顺手换掉",
    String(after?.card_snapshot?.front ?? "") === oldFront,
    `got="${String(after?.card_snapshot?.front ?? "").slice(0, 40)}"`
  );
  chk(
    "快照版本号跟进到新版本",
    Number(after?.card_snapshot?.content_revision ?? 0) > oldRev,
    `served=${after?.card_snapshot?.content_revision} vs old=${oldRev} / live=${editRes.card?.content_revision} / back="${String(after?.card_snapshot?.back ?? "").slice(0, 20)}"`
  );

  const afterControl = (back.cards ?? []).find((c) => c.card_id === control?.card_id);
  chk(
    "没编辑过的卡，答案保持原样",
    String(afterControl?.card_snapshot?.back ?? "") === controlBack,
    `got="${String(afterControl?.card_snapshot?.back ?? "").slice(0, 40)}"`
  );

  // ---- 5. 磁盘上的历史快照不该被改写 ----
  const db = JSON.parse(await fs.readFile(path.join(DATA_DIR, "db.json"), "utf8"));
  const row = (db.review_session_cards ?? []).find(
    (r) => r.session_id === sessionId && r.card_id === cardId
  );
  chk("会话卡仍存在于磁盘", !!row);
  chk(
    "磁盘快照保留当时的旧答案（只改响应，不改历史）",
    String(row?.card_snapshot?.back ?? "") === oldBack,
    `disk="${String(row?.card_snapshot?.back ?? "").slice(0, 40)}"`
  );

  // ---- 6. 新会话直接拿到新答案（不是靠刷新旧快照） ----
  await fetch(`${BASE}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ textbookId, scope: "all", resume: false }),
  });
  const fresh = await jsonOf(
    await fetch(`${BASE}/api/review/current?book=${encodeURIComponent(textbookId)}`)
  );
  const freshCard = (fresh.cards ?? []).find((c) => c.card_id === cardId);
  chk(
    "新会话的答案就是补全后的版本",
    String(freshCard?.card_snapshot?.back ?? "") === NEW_ANSWER,
    `got="${String(freshCard?.card_snapshot?.back ?? "").slice(0, 40)}"`
  );
} catch (e) {
  fail++;
  console.log(`  FAIL  执行中断：${e?.message ?? e}`);
} finally {
  // 收尾：删掉本次临时材料（连带其卡片），避免在书库里越积越多。
  // 失败也要删 —— 留着的后果是用户「资料」页里出现一堆「答案保鲜验证-xxx」。
  if (textbookId) {
    try {
      const del = await fetch(`${BASE}/api/books/${encodeURIComponent(textbookId)}`, {
        method: "DELETE",
      });
      chk("临时材料已清理", del.status === 200, `HTTP ${del.status}`);
    } catch (e) {
      console.log(`  WARN  临时材料清理失败，id=${textbookId}：${e?.message ?? e}`);
    }
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}
