#!/usr/bin/env node
/**
 * 一键双实例 + 公网隧道（方案 3）。
 *
 *   node scripts/serve-share.mjs            # 两个实例 + 两条 trycloudflare 链接
 *   node scripts/serve-share.mjs --no-tunnel # 只在本机跑，不起隧道
 *   node scripts/serve-share.mjs --common-db # 两个实例共用一份数据（不推荐）
 *
 * 设计要点：
 * - 两个实例共享同一份 .next-prod 构建产物，只是 DATA_DIR / PORT 不同 → 数据天然隔离。
 * - 用 `next start` 而不是 dev：dev 会各自编译一遍，16G 内存的机器扛不住两份。
 * - quick tunnel 的域名每次重启都变，只适合临时给朋友用几天。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const MY_PORT = Number(flagValue("--port", 3000));
const FRIEND_PORT = Number(flagValue("--friend-port", 3001));
const NO_TUNNEL = hasFlag("--no-tunnel");
const COMMON_DB = hasFlag("--common-db");

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
const log = (...a) => console.log(...a);
const warn = (...a) => console.log(C.yellow, ...a, C.reset);
const fail = (...a) => {
  console.error(C.red, ...a, C.reset);
  process.exitCode = 1;
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 前置检查
const envFile = path.join(root, ".env.local");
const localEnv = loadEnvFile(envFile);

if (!fs.existsSync(path.join(root, ".next-prod", "BUILD_ID"))) {
  fail("没有找到 .next-prod/BUILD_ID —— 先跑一次 npm run build，再运行本脚本。");
  process.exit(1);
}

const password = (localEnv.APP_PASSWORD ?? "").trim();
if (!NO_TUNNEL && password === "") {
  fail(
    [
      "",
      "拒绝启动：APP_PASSWORD 为空，而你要把服务挂到公网。",
      "任何人都能打开链接、删掉你的书和复习记录。",
      "",
      "解决：在 .env.local 里加一行（换成一个别人猜不到的口令）：",
      "",
      `    APP_PASSWORD=${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`,
      "",
      "只想本机试用、不挂公网的话，加 --no-tunnel 参数即可。",
    ].join("\n"),
  );
  process.exit(1);
}

if (!NO_TUNNEL && password.length < 8) {
  warn(`⚠ APP_PASSWORD 只有 ${password.length} 位，公网环境下建议 12 位以上。`);
}

const cloudflaredBin = (() => {
  const candidates = [
    path.join(root, "tools", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  ];
  for (const c of candidates) {
    if (c.includes(path.sep) && fs.existsSync(c)) return c;
    if (!c.includes(path.sep)) return c; // 交给 PATH，spawn 失败再报
  }
  return null;
})();

if (!NO_TUNNEL && !cloudflaredBin) {
  fail("缺少 cloudflared。运行 npm run tunnel:install 下载，或手动装一份放到 tools/ 目录。");
  process.exit(1);
}

// ---------------------------------------------------------------- 启动实例
const children = [];
function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

function startInstance(name, port, dataDir, extraEnv = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    ...localEnv,
    ...extraEnv,
    PORT: String(port),
    DATA_DIR: dataDir,
    NODE_ENV: "production",
  };
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) warn(`[${name}] 退出，code=${code}`);
  });
  children.push(child);
  return child;
}

const myDataDir = path.join(root, "data");
const friendDataDir = COMMON_DB ? myDataDir : path.join(root, "data-friend");

/** 端口被占时 next start 只会打一行报错然后挂着，先在脚本层挡住。 */
function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

for (const [label, port] of [
  ["我的", MY_PORT],
  ["朋友的", FRIEND_PORT],
]) {
  if (!(await probePort(port))) {
    fail(`端口 ${port}（${label}实例）已被占用。先关掉占用的进程，或用 --port/--friend-port 换端口。`);
    process.exit(1);
  }
}
// 朋友的实例可以整套换成他自己的凭证：口令、AI key、模型都支持 FRIEND_* 前缀覆盖。
const FRIEND_OVERRIDES = {
  APP_PASSWORD: "FRIEND_APP_PASSWORD",
  OPENAI_API_KEY: "FRIEND_OPENAI_API_KEY",
  OPENAI_BASE_URL: "FRIEND_OPENAI_BASE_URL",
  OPENAI_MODEL: "FRIEND_OPENAI_MODEL",
  LLM_PROVIDER: "FRIEND_LLM_PROVIDER",
  DEEPSEEK_API_KEY: "FRIEND_DEEPSEEK_API_KEY",
};
const friendEnv = {};
for (const [target, source] of Object.entries(FRIEND_OVERRIDES)) {
  const v = (localEnv[source] ?? "").trim();
  if (v !== "") friendEnv[target] = v;
}

// 朋友的实例默认空书库（不给别人看我的示例书）；想看样例就加 --seed-friend。
const friendDbExists = fs.existsSync(path.join(friendDataDir, "db.json"));
if (!hasFlag("--seed-friend") && !friendDbExists) {
  friendEnv.SKIP_SEED = "1";
}

log("");
log(C.bold + "启动实例" + C.reset);
log(`  我     : http://localhost:${MY_PORT}   DATA_DIR=${myDataDir}`);
log(`  朋友   : http://localhost:${FRIEND_PORT}   DATA_DIR=${friendDataDir}`);
if (COMMON_DB) warn("  ⚠ --common-db 已开启：两个链接共用同一份书库，两边改动会互相看见。");
log("");

startInstance("me", MY_PORT, myDataDir);
startInstance("friend", FRIEND_PORT, friendDataDir, friendEnv);

// ---------------------------------------------------------------- 隧道
const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** 起一条 quick tunnel，解析出公网地址。失败/超时则 reject，交给外层重试。 */
function startTunnel(name, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cloudflaredBin,
      [
        "tunnel",
        "--no-autoupdate",
        // QUIC 走 UDP 443，境内常被 QoS 限速，表现为「打开要等十秒甚至超时」。
        // HTTP/2 走 TCP 443，慢一点但更稳，分享给国内的人用这个更合适。
        "--protocol",
        "http2",
        "--url",
        `http://localhost:${port}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);

    const tail = [];
    let settled = false;
    const finish = (err, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // 失败时把最后几行吐出来，否则只能看到一个 code=1
        tail.slice(-6).forEach((line) => warn(`  [${name}] ${line}`));
        child.kill("SIGTERM");
        reject(err);
      } else {
        resolve(url);
      }
    };

    const scan = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        tail.push(line.trim());
        if (tail.length > 40) tail.shift();
      }
      const m = text.match(URL_RE);
      if (m) finish(null, m[0]);
    };

    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`cloudflared 退出 code=${code}`));
    });

    // 申请 quick tunnel 一般 5~10 秒，30 秒还没吐地址就是真卡住了
    const timer = setTimeout(() => finish(new Error("30 秒内没拿到地址")), 30000);
  });
}

/** 连续申请两条会被 cloudflare 限流，所以串行 + 最多重试 3 次。 */
async function ensureTunnel(name, port) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const url = await startTunnel(name, port);
      log(C.green + `✔ ${name} 隧道建立：${url}` + C.reset);
      return url;
    } catch (err) {
      warn(`  ${name} 第 ${attempt} 次申请失败：${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return null;
}

if (NO_TUNNEL) {
  log(C.dim + "（未启用隧道，仅本机可访问）" + C.reset);
  log("");
} else {
  log(C.dim + "正在建立 cloudflare 隧道（两条串行，约 15~25 秒）…" + C.reset);

  const meUrl = await ensureTunnel("me", MY_PORT);
  const friendUrl = await ensureTunnel("friend", FRIEND_PORT);

  if (!myUrlSafe(meUrl) || !myUrlSafe(friendUrl)) {
    fail("隧道没有全部建立成功。可先试 --no-tunnel 在本机确认服务本身正常。");
  } else {
    printSummary(meUrl, friendUrl);
  }
}

function myUrlSafe(u) {
  return typeof u === "string" && u.startsWith("https://");
}

function printSummary(meUrl, friendUrl) {
  const friendPwd = localEnv.FRIEND_APP_PASSWORD
    ? "口令为 FRIEND_APP_PASSWORD"
    : "口令与我的相同";
  log("");
  log(C.bold + "========== 分享链接 ==========" + C.reset);
  log(`  我的    ${C.cyan}${meUrl}${C.reset}    口令为 APP_PASSWORD`);
  log(`  朋友的  ${C.cyan}${friendUrl}${C.reset}    ${friendPwd}`);
  log("");
  log(C.dim + "· 两个链接的数据完全隔离，各写各的 DATA_DIR" + C.reset);
  log(C.dim + "· 关掉这个窗口链接就失效，重开会换新域名" + C.reset);
  log(C.dim + "· 两个实例共用 .env.local 里的 AI key（朋友生成卡片花你的额度）" + C.reset);
  log("");
}
