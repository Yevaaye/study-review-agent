#!/usr/bin/env node
/**
 * v3 端到端冒烟。
 *
 * 默认：打一个已经在跑的服务（SMOKE_BASE_URL，缺省 127.0.0.1:3000）。
 *   只做只读检查 + 「建书 → 删书」这种能自清理的写操作 + 入参校验，
 *   不会往你的复习记录里写任何东西。
 *
 * --isolated（npm run smoke:full）：自己起一个独立实例，
 *   DATA_DIR 指向临时目录、APP_PASSWORD 置空，跑完整写链路
 *   （审核 → 开会话 → 同一张卡连续评分两次 → 完成会话），跑完连临时目录一起删掉。
 *   这个模式专门用来验证「Again 重练能落库」这类幂等语义，且完全不碰真实数据。
 *
 * 旧版 smoke.mjs ~ smoke4.mjs 打的是 v2 的 /api/chapters、/api/quiz、
 * /api/training 等早已删除的路由，npm run smoke 必然全红，已整体替换。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const ISOLATED = process.argv.includes("--isolated");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
let cookie = "";
let child = null;
let tmpDir = null;
let childLog = "";
let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  " + extra : ""}`);
  }
}

const jsonHeaders = { "content-type": "application/json" };
async function req(pathname, init = {}) {
  const headers = { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) };
  return fetch(base + pathname, { ...init, headers, redirect: "manual" });
}
const post = (p, body) =>
  req(p, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });

async function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
  });
}

async function waitHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`实例提前退出（code=${child.exitCode}）\n${childLog.slice(-800)}`);
    }
    try {
      const r = await fetch(base + "/api/health", { redirect: "manual" });
      if (r.status === 200 || r.status === 401 || r.status === 503) return;
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  throw new Error(`等待 health 超时\n${childLog.slice(-800)}`);
}

/**
 * build / start 的产物目录（next.config.ts 里 production 阶段用 .next-prod，
 * dev 占默认 .next —— 详见该文件的注释，别改错方向否则 dev 会无限重载）。
 */
const BUILD_DIR = path.join(root, ".next-prod");

/** 构建产物是否比源码新：陈旧产物会让冒烟测到「修复前的代码」，必须回退 dev */
function newestMtime(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) max = Math.max(max, newestMtime(p));
    else max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}
function buildIsFresh() {
  const id = path.join(BUILD_DIR, "BUILD_ID");
  if (!existsSync(id)) return false;
  const built = statSync(id).mtimeMs;
  return newestMtime(path.join(root, "src")) < built &&
    statSync(path.join(root, "package.json")).mtimeMs < built;
}

async function startIsolated() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "sr-smoke-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const hasBuild = buildIsFresh();
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const args = hasBuild
    ? [nextBin, "start", "-p", String(port)]
    : [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)];

  child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: tmpDir,
      APP_PASSWORD: "", // 隔离实例不开口令门
      PORT: String(port),
      // 回退 dev 时给独立编译目录：否则会和正在跑的主 dev 抢 `.next`，
      // 两边互相重编译（这正是「页面自己一直刷新」的老病根）。
      ...(hasBuild ? {} : { NEXT_DIST_DIR: ".next-smoke" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (d) => {
    childLog += d.toString();
    if (childLog.length > 4000) childLog = childLog.slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  console.log(`隔离实例：${hasBuild ? "next start" : "next dev"} @ ${base}，DATA_DIR=${tmpDir}`);
  await waitHealth();
}

async function loginIfNeeded() {
  const r = await fetch(base + "/api/health", { redirect: "manual" });
  if (r.status !== 401) return;
  const pw = process.env.SMOKE_APP_PASSWORD ?? "";
  if (!pw) throw new Error("目标服务开了口令门，请设置 SMOKE_APP_PASSWORD 后重试");
  const l = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password: pw }),
  });
  const setCookie = l.headers.get("set-cookie");
  if (!l.ok || !setCookie) throw new Error(`登录失败：${l.status}`);
  cookie = setCookie.split(";")[0];
}

async function readOnlyChecks() {
  const h = await req("/api/health");
  const health = await h.json().catch(() => ({}));
  check("health 200", h.status === 200, `status=${h.status}`);
  check("backend = local", health.backend === "local", String(health.backend));
  check("db ok（非空或非故障）", health.ok === true, `db=${health.db}`);

  for (const [name, p, field] of [
    ["today", "/api/today", "stats"],
    ["books", "/api/books", "textbooks"],
    ["cards", "/api/cards?status=all", "cards"],
    ["jobs", "/api/jobs", null],
    ["llm-status", "/api/llm-status", null],
    ["export", "/api/export", null],
  ]) {
    const r = await req(p);
    let body = null;
    if (field) body = await r.json().catch(() => null);
    check(
      `GET ${p}`,
      r.status === 200 && (!field || Array.isArray(body?.[field]) || body?.[field] != null),
      `status=${r.status}`
    );
  }

  for (const p of ["/", "/library", "/cards", "/review", "/stats", "/import"]) {
    const r = await req(p);
    check(`页面 ${p}`, [200, 302, 307].includes(r.status), `status=${r.status}`);
  }

  // 入参校验：这些请求在写库之前就会被 requireFields / rating 校验挡下
  const r1 = await post("/api/review/rate", { rating: 3 });
  check("评分缺 card_id → 400", r1.status === 400, `status=${r1.status}`);
  const r2 = await post("/api/review/rate", { card_id: "x", rating: 9 });
  check("评分非法 rating → 400", r2.status === 400, `status=${r2.status}`);
  const r3 = await post("/api/import", {});
  check("导入缺字段 → 400", r3.status === 400, `status=${r3.status}`);
}

async function bookRoundTrip() {
  const title = `__smoke_${Date.now()}__`;
  const c = await post("/api/books", { title, subject: "冒烟测试" });
  const created = await c.json().catch(() => ({}));
  const id = created.textbook?.id;
  check("建书 201", c.status === 201 && Boolean(id), `status=${c.status}`);
  check("subject 透传", created.textbook?.subject === "冒烟测试");

  if (id) {
    const list = await (await req("/api/books")).json().catch(() => ({}));
    check("书出现在列表", (list.textbooks ?? []).some((t) => t.id === id));
    const d = await req(`/api/books/${id}`, { method: "DELETE" });
    check("删书 200", d.status === 200, `status=${d.status}`);
    const after = await (await req("/api/books")).json().catch(() => ({}));
    check("测试书已清理", !(after.textbooks ?? []).some((t) => t.id === id));
  }
}

/** 只在 --isolated 下跑：会写复习记录，但写进刚创建的临时 DATA_DIR */
async function reviewWritePath() {
  const cardsRes = await req("/api/cards?status=all");
  const { cards } = await cardsRes.json();
  check("隔离实例有种子卡", Array.isArray(cards) && cards.length > 0, `${cards?.length ?? 0} 张`);
  if (!cards?.length) return;

  const cardId = cards[0].id;
  // 注意这个产品里 action=approve 是「已掌握，不进复习」(mastered)；
  // 要让卡进入复习队列必须用 reject（UI 文案是「拒绝 / 加入复习」）。
  const a = await post(`/api/cards/${cardId}`, { action: "reject" });
  check("加入复习 → active", a.status === 200, `status=${a.status}`);

  const s = await post("/api/review", { scope: "all" });
  const session = await s.json().catch(() => ({}));
  check("开复习会话 201", s.status === 201 && Boolean(session.session?.id), `status=${s.status}`);
  const sc = session.cards?.[0];
  if (!sc) {
    check("会话里有卡", false);
    return;
  }

  let keySeq = 0;
  const nextKey = () => `smoke-${process.pid}-${Date.now()}-${++keySeq}`;
  const rateBody = (key, rating) => ({
    card_id: sc.card_id,
    rating,
    session_id: session.session.id,
    session_card_id: sc.id,
    idempotency_key: key,
  });
  const r1 = await post("/api/review/rate", rateBody(nextKey(), 3));
  const j1 = await r1.json().catch(() => ({}));
  check("首次评分落库", r1.status === 201 && j1.deduped === false && Boolean(j1.next_due));

  // 关键回归：同一张会话卡、换一个新的幂等键再答一次（模拟 Again 重练）。
  // 旧版会被「同一 session_card_id 只允许一次评分」的护栏吞掉，返回 deduped:true。
  const r2 = await post("/api/review/rate", rateBody(nextKey(), 1));
  const j2 = await r2.json().catch(() => ({}));
  check("同卡再练也落库（幂等键修复）", r2.status === 201 && j2.deduped === false,
    `status=${r2.status} deduped=${j2.deduped}`);

  const comp = await post("/api/review/complete", { session_id: session.session.id });
  check("完成会话 200", comp.status === 200, `status=${comp.status}`);
}

async function main() {
  if (ISOLATED) await startIsolated();
  await waitHealth();
  await loginIfNeeded();

  console.log(`\n目标：${base}${ISOLATED ? "（隔离实例）" : ""}`);
  console.log("— 只读端点与页面 —");
  await readOnlyChecks();
  console.log("— 建书 / 删除（自动清理）—");
  await bookRoundTrip();
  if (ISOLATED) {
    console.log("— 复习写链路（仅隔离实例）—");
    await reviewWritePath();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error("SMOKE_FAIL", e.message);
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await sleep(500);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      console.warn(`临时目录未能删除：${tmpDir}`);
    }
  }
}
