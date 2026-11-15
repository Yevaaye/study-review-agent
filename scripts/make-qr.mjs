// 生成一个可在电脑屏幕上直接扫的二维码页面（SVG 方块，像素级精确）
//   npm run qr                         # 局域网地址（配合 npm run lan 的 80 端口转发）
//   npm run qr:tunnel -- <url>          # 公网隧道地址
//   node scripts/make-qr.mjs --url=https://xxx.trycloudflare.com --out=qr-tunnel.html
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const ECL_M = 0; // qrcode.js 的 ErrorCorrectLevel.M

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(process.env.LAN_PORT ?? 80);
const EXPLICIT_URL = argValue("url", "");
const OUT = argValue("out", "qr-access.html");

// 排除虚拟网卡（VMware / VirtualBox / Hyper-V / WSL），它们不是手机能连的真实局域网
const VIRTUAL = /vmware|virtualbox|hyper-v|vethernet|loopback|docker|wsl|tap|tun/i;
const candidates = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const a of list ?? []) {
    if (a.family === "IPv4" && !a.internal) {
      candidates.push({ name, ip: a.address, virtual: VIRTUAL.test(name) });
    }
  }
}
const rank = (c) => (c.virtual ? 10 : 0) + (c.ip.startsWith("192.168.") ? 0 : c.ip.startsWith("10.") ? 1 : 2);
candidates.sort((a, b) => rank(a) - rank(b));

if (candidates.length === 0 && !EXPLICIT_URL) {
  console.error("没有找到局域网网卡");
  process.exit(1);
}
const LAN_IP = candidates[0]?.ip ?? "127.0.0.1";
const isTunnel = EXPLICIT_URL.startsWith("https://");
const url = EXPLICIT_URL || `http://${LAN_IP}${PORT === 80 ? "" : ":" + PORT}`;

const qr = new QRCode(-1, ECL_M);
qr.addData(url);
qr.make();
const n = qr.getModuleCount();

const QUIET = 4; // 标准静默区（模块数），扫码成功率靠它
// 自适应：整图控制在 330px 左右，URL 越长二维码版本越高、格子相应变小
const CELL = Math.max(6, Math.floor(330 / (n + QUIET * 2)));
const total = (n + QUIET * 2) * CELL;

let rects = "";
for (let y = 0; y < n; y++) {
  for (let x = 0; x < n; x++) {
    if (!qr.modules[y][x]) continue;
    rects += `<rect x="${(x + QUIET) * CELL}" y="${(y + QUIET) * CELL}" width="${CELL}" height="${CELL}"/>`;
  }
}
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
  `<rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
const svgDataUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

// 备选地址（虚拟网卡之外的真实网卡，避免多网卡选错）
const others = candidates.slice(1).filter((c) => !c.virtual);

const title = isTunnel ? "手机扫码（任何网络都能开）" : "用手机扫这个码";
const sub = isTunnel ? "走公网隧道，不需要连同一个 WiFi" : "电脑和手机连同一个 WiFi，扫完直接打开";

const steps = isTunnel
  ? `<li>直接用手机<strong>相机 / 微信扫一扫</strong>这个码</li>
     <li>4G、5G、别的 WiFi 都能打开，不限网络</li>
     <li>扫不开就手动输入 <strong>${url}</strong></li>
     <li>打不开时访问 <strong>${url}/api/health</strong>，能出文字说明隧道是通的</li>`
  : `<li>手机先<strong>连上和电脑同一个 WiFi</strong></li>
     <li>手机顶部要出现 <strong>WiFi 图标</strong>，而不是 5G / 4G</li>
     <li>扫码，或手动输入 <strong>${url}</strong></li>
     <li>仍打不开，访问 <strong>${url}/api/health</strong>，能出文字就说明网络是通的</li>`;

const note = isTunnel
  ? `<b>这是临时公网链接：</b>每次重启 cloudflared 都会换一个域名，届时重新生成二维码即可。链接在公网可访问，<b>别随手转发给别人</b>。`
  : `<b>常见原因：</b>手机顶部显示 <b>5G</b> 而没连 WiFi 时，访问 <b>192.168.x.x</b> 这种内网地址一定打不开——数据走的是移动网络，到不了你电脑。`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f5f5f7; color: #1d1d1f; padding: 24px;
    font-family: -apple-system, "SF Pro SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    background: #fff; border-radius: 26px; padding: 36px 34px 32px;
    box-shadow: 0 14px 50px rgba(0,0,0,.10), 0 1px 3px rgba(0,0,0,.04);
    text-align: center; max-width: 580px;
  }
  h1 { font-size: 21px; font-weight: 600; margin: 0 0 6px; letter-spacing: -.2px; }
  .sub { font-size: 13.5px; color: #86868b; margin: 0 0 20px; }
  .qr { display: inline-block; padding: 14px; background: #fff; border: 1px solid #e8e8ed; border-radius: 16px; }
  .qr img { display: block; width: ${total}px; height: ${total}px; image-rendering: pixelated; }
  .url { margin: 18px 0 16px; font-size: ${url.length > 45 ? 12.5 : 20}px; font-weight: 600; letter-spacing: 0; word-break: break-all; user-select: all; }
  ol { text-align: left; margin: 0; padding: 18px 0 0 22px; border-top: 1px solid #f0f0f2; font-size: 13.5px; line-height: 1.9; color: #3a3a3c; }
  ol li strong { font-weight: 600; color: #1d1d1f; }
  .warn { margin-top: 16px; padding: 13px 15px; background: #fff8e6; border-radius: 11px; font-size: 12.5px; line-height: 1.75; color: #8a6100; text-align: left; }
  .warn b { color: #6b4b00; }
  .alt { margin-top: 10px; font-size: 12px; color: #a1a1a6; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
    <div class="qr"><img src="${svgDataUri}" alt="二维码 ${url}"></div>
    <p class="url">${url}</p>
    <ol>${steps}</ol>
    <div class="warn">${note}</div>
    ${!isTunnel && others.length ? `<p class="alt">如果这个地址不通，可试：${others.map((c) => c.ip).join("、")}</p>` : ""}
  </div>
</body>
</html>`;

const out = `F:/projects/study-review-agent/${OUT}`;
fs.writeFileSync(out, html, "utf8");
console.log("URL:", url);
console.log("页面:", out);
console.log("矩阵:", n + "×" + n, "| 格子:", CELL + "px", "| 输出:", total + "px");
