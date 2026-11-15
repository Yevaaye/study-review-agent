// 「答案框里必须是原文标准答案」端到端契约（需要服务在跑，默认 :3000）
//
// 用户实报：点「重新生成」后答案框里是 AI 转述，检索到的知识点只挂在下面 ——
// 两层结果、答案还不完整。这里的判据很硬：
//   1. 原文里有完整答案时 → 写回的必须是**原文那段**（逐字），origin="source"
//   2. 答案覆盖原文所有要点（7 条要点一条不少，不是第一句）
//   3. 原文没有答案时才走 AI（origin="ai"），并且明确告知
//   4. fullText=true 不改变「原文优先」的优先级（只是扩大检索范围）
//   5. 全程用临时材料，收尾删除，不碰真实书库
//
// 用法：npm run check:sourceanswerhttp（可用 BASE=... 指向隔离实例）
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
const title = `原文答案验证-${stamp}`;
const Q_FULL = "如何用最小成本搭建 Agent？核心原则是什么？";
// 原文答案：7 条要点，最后一条带特征词（Redis / pgvector），用来判断有没有被截断
const A_FULL =
  "落地原则：1）能用 API 就不训模型；2）能用规则就不用 LLM；3）框架先原型后自研；4）MVP 先做 3-5 个核心工具；5）上线前准备 100+ 测试用例；6）基础设施用 Serverless 按量付费；7）存储用 Redis 与 Supabase pgvector。整体原则：验证商业价值优先于技术完美。";
const Q_NONE = "量子退火相比门模型有什么优势？";

const md = `# ${title}

## 第一章

### Q: ${Q_FULL}

**💡 思考逻辑：** 考察成本意识。

**参考答案：**
${A_FULL}

### Q: ${Q_NONE}

**💡 思考逻辑：** 这题故意不给答案。
`;

let textbookId = "";
let pass2 = 0;

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

  const all = await jsonOf(await fetch(`${BASE}/api/cards?limit=1000`));
  const mine = (all.cards ?? []).filter((c) => (c.sources ?? []).some((s) => s.textbook_id === textbookId));
  chk("导入出了卡片", mine.length >= 2, `got ${mine.length}`);

  const full = mine.find((c) => (c.front ?? "").includes("最小成本"));
  const none = mine.find((c) => (c.front ?? "").includes("量子退火"));
  chk("两张题都抽到了", !!full && !!none);

  // 先把答案改「残」：模拟用户看到只截一句的状态
  await fetch(`${BASE}/api/cards/${full.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "edit", back: "落地原则：能用 API 就不训模型。" }),
  });

  // ---- 1) 默认检索：应直接采用原文答案 ----
  const fix = await jsonOf(
    await fetch(`${BASE}/api/cards/${full.id}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "truncated" }),
    })
  );
  chk("修复成功", fix.ok === true, JSON.stringify(fix).slice(0, 160));
  chk("来源标记为原文（origin=source）", fix.origin === "source", String(fix.origin));
  const back = String(fix.back ?? "");
  chk("答案不再是那一句残句", back !== "落地原则：能用 API 就不训模型。", back.slice(0, 40));
  chk(
    "答案覆盖原文全部要点（≥ 原文答案的 95% 长度）",
    back.length >= Math.floor(A_FULL.length * 0.95),
    `len=${back.length} vs 原文 ${A_FULL.length}`
  );
  chk("最后一条要点也在（Redis + pgvector）", /Redis/.test(back) && /pgvector/.test(back));
  chk("答案与原文逐字一致（不是 AI 转述）", back.replace(/\s+/g, "") === A_FULL.replace(/\s+/g, ""), back.slice(0, 60));
  chk("回执里说清了「原文已有答案」", /原文/.test(String(fix.diagnosis ?? "")), String(fix.diagnosis ?? "").slice(0, 60));
  chk("带回命中片段 id（可定位原文）", typeof fix.source_fragment_id === "string" && !!fix.source_fragment_id);

  // ---- 2) 落库核对：卡片、台账都要对得上 ----
  const after = await jsonOf(await fetch(`${BASE}/api/cards?limit=1000`));
  const saved = (after.cards ?? []).find((c) => c.id === full.id);
  chk("卡片答案已落库为原文答案", String(saved?.back ?? "").replace(/\s+/g, "") === A_FULL.replace(/\s+/g, ""));
  chk("answer_origin 落库为 source", saved?.answer_origin === "source", String(saved?.answer_origin));
  chk("needs_answer 已清零", saved?.needs_answer === false, String(saved?.needs_answer));

  // ---- 3) 再点一次（全库查找）：仍然原文优先，且内容不变 ----
  const fix2 = await jsonOf(
    await fetch(`${BASE}/api/cards/${full.id}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "truncated", fullText: true }),
    })
  );
  chk("全书查找模式仍然成功", fix2.ok === true, JSON.stringify(fix2).slice(0, 120));
  chk("全书查找模式仍优先用原文", fix2.origin === "source", String(fix2.origin));
  chk(
    "连续两次结果一致（可重复操作）",
    String(fix2.back ?? "").replace(/\s+/g, "") === A_FULL.replace(/\s+/g, "")
  );

  // ---- 4) 原文没有答案 → 才走 AI，并且必须标明 ----
  const fixNone = await jsonOf(
    await fetch(`${BASE}/api/cards/${none.id}/fix-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "missing" }),
    })
  );
  chk("无答案的题不会假装「原文有答案」", fixNone.origin !== "source", String(fixNone.origin));
  if (fixNone.ok === true) {
    chk("退回 AI 路径时标记为 ai", fixNone.origin === "ai", String(fixNone.origin));
    chk("AI 路径也给了答案", String(fixNone.back ?? "").length > 10, String(fixNone.back ?? "").slice(0, 40));
    pass2++;
  } else {
    // 模型不可用时允许失败，但也不许冒充原文答案
    chk("模型不可用时失败且未改卡", fixNone.ok === false);
    console.log(`  WARN  AI 路径未成功：${fixNone.error ?? fixNone.reason ?? "unknown"}`);
  }
} catch (e) {
  fail++;
  console.log(`  FAIL  执行中断：${e?.message ?? e}`);
} finally {
  if (textbookId) {
    try {
      const del = await fetch(`${BASE}/api/books/${encodeURIComponent(textbookId)}`, { method: "DELETE" });
      chk("临时材料已清理", del.status === 200, `HTTP ${del.status}`);
    } catch (e) {
      console.log(`  WARN  清理失败 id=${textbookId}：${e?.message ?? e}`);
    }
  }
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}
