#!/usr/bin/env node
// ============================================================================
//  部署前置自检 preflight
//
//  v3 只有 LocalStore（JSON 文件）一个后端。部署前真正要确认的是：
//  种子文件在、DATA_DIR 可写、服务 health 正常、LLM 配置可用。
//  ⚠️ 下方的 checkSupabase() 是 v2 历史遗留，本版不会调用它；
//     DATA_BACKEND / SUPABASE_* 不再是有效配置，Vercel 只读 FS 也不能直接用
//     （写盘失败会直接 500，不存在「降级为内存态」）。
//
//  用法：
//    npm run preflight                 # 检查本地后端
//    npm run preflight -- --with-llm  # 额外真发一次 LLM 请求
//
//  凭据读取顺序与 Next 一致：真实环境变量 > .env.local
//  脚本不会打印任何密钥内容。
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const withLLM = process.argv.includes("--with-llm");

// ---------------------------------------------------------------- 环境变量 ----
function loadEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return false;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    // 与 Next 的优先级一致：已存在的真实环境变量优先，不被文件覆盖
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = val;
  }
  return true;
}

// ---------------------------------------------------------------- 输出格式 ----
let failures = 0;
let warnings = 0;
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const pass = (msg, extra = "") =>
  console.log(`  ${c(32, "PASS")}  ${msg}${extra ? c(90, `  ${extra}`) : ""}`);
const fail = (msg, hint = "") => {
  failures++;
  console.log(`  ${c(31, "FAIL")}  ${msg}`);
  if (hint) console.log(`        ${c(90, "→ " + hint)}`);
};
const warn = (msg, hint = "") => {
  warnings++;
  console.log(`  ${c(33, "WARN")}  ${msg}`);
  if (hint) console.log(`        ${c(90, "→ " + hint)}`);
};
const section = (t) => console.log(`\n${c(1, t)}`);

// ---------------------------------------------------------------- HTTP 辅助 ----
function restBase(url) {
  return url.replace(/\/+$/, "") + "/rest/v1";
}

async function sb(method, table, query = "", body, key, url) {
  // 网络/DNS 失败时 fetch 会抛异常而不是返回状态码，统一收敛成 status:0，
  // 否则自检脚本会在第一个请求处直接崩溃，看不到后面的诊断信息。
  let res;
  try {
    res = await fetch(`${restBase(url)}/${table}${query}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, ok: false, data: null, text: `网络错误: ${e.message}` };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data, text };
}

// ---------------------------------------------------------------- 本地后端 ----
function checkLocal() {
  section("本地后端（LocalStore / JSON 文件）");

  const seedPath = path.join(root, "db", "seed-data.json");
  if (!existsSync(seedPath)) {
    fail("db/seed-data.json 不存在", "种子文件的唯一数据源，缺失则无法建库");
  } else {
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    pass(
      "种子文件可读",
      `教材 ${seed.textbooks?.length ?? 0} / 章节 ${seed.chapters?.length ?? 0} / ` +
        `知识点 ${seed.knowledgePoints?.length ?? 0} / 卡片 ${seed.cards?.length ?? 0}`
    );
  }

  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
  const dbPath = path.join(dataDir, "db.json");
  if (!existsSync(dbPath)) {
    warn("db.json 尚未生成", "首次请求时会从种子自动创建；也可 npm run dev 后访问任一接口触发");
  } else {
    const db = JSON.parse(readFileSync(dbPath, "utf8"));
    pass(
      "db.json 可读",
      `知识点 ${db.knowledgePoints?.length ?? 0} / 卡片 ${db.cards?.length ?? 0} / ` +
        `复习事件 ${db.card_reviews?.length ?? 0}`
    );
  }

  console.log(c(90, `\n  数据目录 ${dataDir}`));
  console.log(c(90, "  部署前提：单实例 + 可写持久磁盘。写盘失败会直接返回 500，不会静默降级。"));
  console.log(c(90, "  多实例之间无文件锁，后写会覆盖先写；Vercel 只读 FS 不能直接使用。"));
}

// ------------------------------------------------- 历史遗留（v3 不调用）----
// v2 的 Supabase 自检。supabaseStore.ts 已删除、config.ts 不读 SUPABASE_*，
// 这段代码仅为保留当时的排查思路，主流程不再进入（见下方 main）。
async function checkSupabase() {
  section("Supabase 后端（DATA_BACKEND=supabase）");

  const url = process.env.SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  const isService = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url) {
    fail("SUPABASE_URL 未配置", "Supabase → Project Settings → API → Project URL");
    return;
  }
  if (!key) {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY 均未配置",
      "取 Project Settings → API → service_role（仅服务端使用）"
    );
    return;
  }
  pass("环境变量齐全", `url=${url.replace(/\/+$/, "")}  密钥类型=${isService ? "service_role" : "anon"}`);
  if (!isService) {
    warn(
      "未使用 service_role key",
      "anon key 受 RLS 限制，若未建策略会全部读写失败；单人 Demo 建议用 service_role 放服务端"
    );
  }

  // 1) 连通性 + 密钥有效性
  const probe = await sb("GET", "textbooks", "?select=id&limit=1", undefined, key, url);
  if (probe.status === 401 || probe.status === 403) {
    fail(
      `密钥被拒绝（HTTP ${probe.status}）`,
      "确认用的是同一项目的 key；service_role 不会因 RLS 被拒，anon 需要 RLS 策略"
    );
    return;
  }
  if (!probe.ok) {
    if (probe.status === 0) {
      fail(
        "无法解析/连接 Supabase 域名",
        "检查 SUPABASE_URL 是否少写或多写了字符；也可能是本机 DNS 或代理问题"
      );
      return;
    }
    const paused = /paused|not found|ENOTFOUND|fetch failed/i.test(probe.text ?? "");
    fail(
      `无法访问 PostgREST（HTTP ${probe.status}）`,
      paused
        ? "项目可能被暂停（免费版闲置后会 pause）或 URL 拼错，去控制台恢复项目"
        : `响应：${String(probe.text).slice(0, 160)}`
    );
    return;
  }
  pass("网络连通、密钥可用");

  // 2) schema 是否导入（逐表清点）
  const tables = [
    "textbooks",
    "chapters",
    "knowledge_points",
    "questions",
    "quiz_sessions",
    "session_chapters",
    "quiz_answers",
    "mastery_records",
    "training_attempts",
  ];
  const counts = {};
  for (const t of tables) {
    const r = await sb("GET", t, "?select=*", undefined, key, url);
    if (!r.ok) {
      fail(`表 ${t} 不可读（HTTP ${r.status}）`, "先在 SQL Editor 执行 db/schema.sql");
      continue;
    }
    counts[t] = Array.isArray(r.data) ? r.data.length : 0;
    pass(`表 ${t} 可读`, `${counts[t]} 行`);
  }

  // 3) seed 是否导入（与本地种子对账）
  const seedPath = path.join(root, "db", "seed-data.json");
  if (existsSync(seedPath) && counts.textbooks !== undefined) {
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    const expect = {
      textbooks: seed.textbooks?.length ?? 0,
      chapters: seed.chapters?.length ?? 0,
      knowledge_points: seed.knowledgePoints?.length ?? 0,
      questions: seed.questions?.length ?? 0,
    };
    let seeded = true;
    for (const [t, want] of Object.entries(expect)) {
      if (counts[t] !== want) seeded = false;
    }
    if (!seeded) {
      warn(
        "云端数据与本地种子不一致",
        "执行 db/seed.sql 灌入种子（幂等：先 truncate 再插入）。" +
          `当前 ${JSON.stringify(counts)}，期望 ${JSON.stringify(expect)}`
      );
    } else {
      pass("种子数据已导入且数量一致", `${counts.questions} 题 / ${counts.knowledge_points} 知识点`);
    }
  }

  // 4) 视图（看板优先走视图聚合，缺失会回退但性能差）
  for (const v of ["v_learning_overview", "v_weak_points", "v_mastery_overview"]) {
    const r = await sb("GET", v, "?select=*&limit=1", undefined, key, url);
    if (!r.ok) {
      warn(`视图 ${v} 不可用（HTTP ${r.status}）`, "看板会回退到表查询；执行 db/schema.sql 可创建");
    } else {
      pass(`视图 ${v} 可用`);
    }
  }
  const rpc = await (async () => {
    try {
      return await fetch(`${restBase(url)}/rpc/pick_questions`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ chapter_ids: [], p_count: 0 }),
      });
    } catch {
      return { ok: false, status: 0 };
    }
  })();
  if (rpc.ok) pass("抽题函数 pick_questions 可用");
  else warn(`抽题函数 pick_questions 不可用（HTTP ${rpc.status}）`, "当前实现未使用，仅作 schema 完整性检查");

  // 5) 写入权限探测（建一道题再删掉，不影响业务数据）
  if (counts.knowledge_points > 0) {
    const kp = await sb("GET", "knowledge_points", "?select=id,chapter_id&limit=1", undefined, key, url);
    const row = Array.isArray(kp.data) ? kp.data[0] : null;
    if (!row) {
      warn("无知识点可用于写入探测", "先导入 seed.sql");
    } else {
      const marker = `[preflight-${Date.now()}]`;
      const ins = await sb(
        "POST",
        "questions",
        "",
        {
          kp_id: row.id,
          chapter_id: row.chapter_id,
          content: marker,
          options: [
            { key: "A", text: "A" },
            { key: "B", text: "B" },
          ],
          answer: "A",
          explanation: "preflight 探测数据",
          difficulty: 1,
          source: "bank",
        },
        key,
        url
      );
      if (!ins.ok) {
        fail(
          `写入失败（HTTP ${ins.status}）`,
          `响应：${String(ins.text).slice(0, 200)}` +
            (ins.status === 403 ? "（service_role 才能绕过 RLS）" : "")
        );
      } else {
        const id = Array.isArray(ins.data) ? ins.data[0]?.id : null;
        const del = await sb("DELETE", "questions", `?id=eq.${id}`, undefined, key, url);
        if (del.ok) pass("读写删除权限正常", "探测数据已清理");
        else {
          fail(`删除探测数据失败（HTTP ${del.status}）`, `请手动删除 content='${marker}' 的行`);
        }
      }
    }
  }

  // 6) 运行时服务是否已连上同一后端（可选）
  try {
    // 先问 /api/health：它直接回报服务进程实际生效的 DATA_BACKEND，
    // 比「数据看起来对不对」更硬 —— 内存态降级时数据也会"看起来对"。
    const h = await fetch("http://localhost:3000/api/health");
    if (h.ok) {
      const health = await h.json();
      if (health.backend === "supabase") {
        pass("运行中的服务已连 Supabase", `知识点 ${health.knowledgePoints} 个`);
      } else {
        warn(
          `运行中的服务用的是 ${health.backend} 后端`,
          "若为部署做验证，重启时需显式带上 DATA_BACKEND=supabase"
        );
      }
    } else {
      const body = await h.json().catch(() => ({}));
      fail("运行中的服务自检未通过", body.dbError ?? `HTTP ${h.status}`);
    }
  } catch {
    console.log(c(90, "  SKIP  本地未启动服务（不影响部署）"));
  }

  // 7) 数与云端对账（服务在跑时才做）
  try {
    const r = await fetch("http://localhost:3000/api/dashboard");
    if (r.ok) {
      const d = await r.json();
      pass(
        "本地运行的服务可访问",
        `知识点 ${d.total_kps} / 作答 ${d.total_answers} / 正确率 ${d.accuracy_pct}%`
      );
      if (d.total_kps !== counts.knowledge_points) {
        warn(
          "服务返回的数据与 Supabase 不一致",
          "服务可能仍以 DATA_BACKEND=local 运行，重启时需显式带上环境变量"
        );
      }
    }
  } catch {
    /* 上面已经报告过服务不可用 */
  }
}

// ---------------------------------------------------------------- LLM 探测 ----
async function checkLLM() {
  section("LLM（导入时提炼知识点 / 生成复习卡）");
  const key = process.env.OPENAI_API_KEY ?? "";
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL ?? "gpt-5.5";

  if (!key) {
    warn("OPENAI_API_KEY 未配置", "未配置时导入只保留规则抽出的原题，不会生成 AI 卡；其余流程不受影响");
    return;
  }
  console.log(c(90, `  key 已配置（长度 ${key.length}），模型 ${model}，端点 ${base}`));
  if (!withLLM) {
    console.log(c(90, "  加 --with-llm 可真实发一次请求验证额度与模型名"));
    return;
  }

  const isReasoning = /^(gpt-5|o[1-9])/i.test(model);
  const body = { model, messages: [{ role: "user", content: "回复 ok" }] };
  if (!isReasoning) body.temperature = 0;

  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    const ms = Date.now() - t0;
    if (res.ok) {
      pass("LLM 可用", `${ms}ms`);
      return;
    }
    const quota = /quota|额度|balance/i.test(txt);
    const noModel = /model_not_found|no available channel|不存在|not found/i.test(txt);
    fail(
      `LLM 调用失败（HTTP ${res.status}，${ms}ms）`,
      quota
        ? "账户额度不足，充值后重试；在此之前导入不会生成 AI 卡，原题仍可用"
        : noModel
          ? `模型名 ${model} 不在该端点支持的列表里，查 /v1/models 换一个`
          : String(txt).slice(0, 200)
    );
  } catch (e) {
    fail(`无法连接 LLM 端点（${e.message}）`, "检查 OPENAI_BASE_URL 与网络代理");
  }
}

// ---------------------------------------------------------------- 主流程 ----
(async () => {
  const loaded = loadEnvLocal();
  const legacyBackend = process.env.DATA_BACKEND;

  console.log(c(1, "study-review-agent — 部署前置自检"));
  console.log(
    c(90, `  工作目录 ${root}\n  数据后端 local（LocalStore）   .env.local ${loaded ? "已加载" : "不存在（用宿主环境变量）"}`)
  );

  try {
    if (legacyBackend && legacyBackend !== "local") {
      fail(
        `DATA_BACKEND=${legacyBackend} 已失效`,
        "v3 只有 LocalStore；请从 .env.local / 部署环境里删除该变量"
      );
    }
    checkLocal();

    await checkLLM();
  } catch (e) {
    // 自检脚本本身出错时也要给出可读结论，而不是甩一段堆栈
    fail(`自检中断：${e.message}`);
  }

  section("结论");
  if (failures === 0) {
    console.log(`  ${c(32, "全部通过")}${warnings ? c(33, `（${warnings} 条提醒）`) : ""}`);
    console.log(c(90, "  可以进入部署：npm run build && npm start，或 docker run 挂载可写卷（单实例）"));
  } else {
    console.log(`  ${c(31, `${failures} 项失败`)}${warnings ? c(33, `，${warnings} 条提醒`) : ""}`);
    console.log(c(90, "  按上面 → 提示逐条修复后重跑 npm run preflight"));
  }
  process.exit(failures === 0 ? 0 : 1);
})();
