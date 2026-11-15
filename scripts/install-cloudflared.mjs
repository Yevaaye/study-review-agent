#!/usr/bin/env node
/**
 * 下载 cloudflared 到 tools/ 目录（仅方案 3 需要）。
 *
 *   node scripts/install-cloudflared.mjs                    # 直连（github 慢的时候会很慢）
 *   node scripts/install-cloudflared.mjs --proxy http://127.0.0.1:7897   # 走本地代理，快很多
 *
 * 为什么优先用 curl：node 的 fetch 不读 HTTPS_PROXY 环境变量，本机直连 github 常年在 20 KB/s 上下；
 * 而 curl 加 -x 能借用本地 Clash，实测 270 KB/s。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const toolsDir = path.join(root, "tools");
const args = process.argv.slice(2);
const proxyIdx = args.indexOf("--proxy");
const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : "";

const TARGETS = {
  "win32-x64": {
    asset: "cloudflared-windows-amd64.exe",
    out: "cloudflared.exe",
    kind: "exe",
  },
  "linux-x64": { asset: "cloudflared-linux-amd64", out: "cloudflared", kind: "bin" },
  "linux-arm64": { asset: "cloudflared-linux-arm64", out: "cloudflared", kind: "bin" },
  "darwin-arm64": {
    asset: "cloudflared-darwin-arm64.tgz",
    out: "cloudflared.tgz",
    kind: "tgz",
  },
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`不支持的平台：${key}。请手动到 https://github.com/cloudflare/cloudflared/releases 下载。`);
  process.exit(1);
}

const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${target.asset}`;
fs.mkdirSync(toolsDir, { recursive: true });
const outPath = path.join(toolsDir, target.out);
const tmpPath = `${outPath}.part`;
const started = Date.now();

console.log(`下载 ${target.asset}${proxy ? `（经代理 ${proxy}）` : ""} …`);

if (proxy) {
  const res = spawnSync(
    "curl",
    ["-L", "--max-time", "900", "-x", proxy, "-sS", "-o", tmpPath, url],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error("curl 下载失败。去掉 --proxy 重试，或手动下载后放到 tools/ 目录。");
    process.exit(1);
  }
} else {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    console.error(`下载失败：HTTP ${response.status}`);
    process.exit(1);
  }
  const total = Number(response.headers.get("content-length") || 0);
  const out = fs.createWriteStream(tmpPath);
  const timer = setInterval(() => {
    const mb = (out.bytesWritten / 1048576).toFixed(1);
    const ratio = total
      ? ` / ${(total / 1048576).toFixed(1)} MB (${Math.round((out.bytesWritten / total) * 100)}%)`
      : " MB";
    const kbps = Math.round(out.bytesWritten / 1024 / ((Date.now() - started) / 1000));
    process.stdout.write(`\r  ${mb}${ratio}  ${kbps} KB/s   `);
  }, 2000);
  try {
    await pipeline(Readable.fromWeb(response.body), out);
  } catch (err) {
    clearInterval(timer);
    console.error(`\n下载中断：${err.message}`);
    process.exit(1);
  }
  clearInterval(timer);
  process.stdout.write("\r");
}

const size = fs.statSync(tmpPath).size;
if (size < 10 * 1024 * 1024) {
  console.error(`文件异常（${size} 字节），疑似下载到了错误页面。删掉 ${tmpPath} 重试。`);
  process.exit(1);
}
fs.renameSync(tmpPath, outPath);

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`✔ 已保存到 ${outPath}（${(size / 1048576).toFixed(1)} MB，${secs}s）`);

if (target.kind === "bin") {
  fs.chmodSync(outPath, 0o755);
} else if (target.kind === "tgz") {
  console.log("macOS 需要解包：tar -xzf tools/cloudflared.tgz -C tools && chmod +x tools/cloudflared");
}

console.log("现在可以运行：npm run serve:share");
