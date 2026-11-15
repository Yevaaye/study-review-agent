#!/usr/bin/env node
/**
 * 一键公网隧道：把本机 3000 端口映射成一个 https 地址，手机用 4G/5G 也能打开。
 *
 *   npm run tunnel
 *
 * 为什么需要它：家里/公司的路由器常开「客户端隔离」，同一 WiFi 下手机也连不到电脑的
 * 192.168.x.x。走 Cloudflare 快速隧道后，手机访问的是公网域名，局域网那层限制就绕过去了。
 *
 * 注意：
 * - 链接是临时的，每次重启都会换域名。
 * - 链接在公网可访问，任何人拿到都能打开。别随手转发。
 * - 隧道断开后链接立刻失效。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const exe = path.join(root, "tools", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
const PORT = Number(process.env.PORT ?? 3000);

if (!fs.existsSync(exe)) {
  console.error(`找不到 ${exe}\n先运行：npm run tunnel:install`);
  process.exit(1);
}

console.log(`正在建立隧道 → http://127.0.0.1:${PORT} …`);

const child = spawn(
  exe,
  ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate", "--protocol", "http2"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let buf = "";
let url = "";
let announced = false;

function scan(text) {
  buf += text;
  if (buf.length > 8000) buf = buf.slice(-8000); // 防止无限增长
  const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !url) url = m[0];
  if (url && !announced) {
    announced = true;
    console.log("\n" + "=".repeat(70));
    console.log("  手机访问地址（任何网络都行，不用连同一个 WiFi）:");
    console.log("  " + url);
    console.log("=".repeat(70));
    // 顺手生成扫码页，电脑上打开即可扫
    const r = spawn(process.execPath, [path.join(root, "scripts", "make-qr.mjs"), `--url=${url}`, "--out=qr-tunnel.html"], {
      cwd: root,
      stdio: "inherit",
    });
    r.on("exit", () => {
      console.log(`\n打开 ${path.join(root, "qr-tunnel.html")} 用手机扫码。`);
      console.log("隧道保持运行中，关闭本窗口或 Ctrl+C 即断开。\n");
    });
  }
}

child.stdout.on("data", (d) => scan(d.toString()));
child.stderr.on("data", (d) => scan(d.toString()));

child.on("error", (e) => {
  console.error("启动 cloudflared 失败：", e.message);
  process.exit(1);
});
child.on("exit", (code) => {
  console.log(`\n隧道已退出（code ${code}）。`);
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill();
    process.exit(0);
  });
}
