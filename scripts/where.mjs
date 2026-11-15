#!/usr/bin/env node
/**
 * 现场查询：当前这台电脑在这个网络下，别人该用哪个地址访问。
 *
 * 用途：换了 Wi-Fi（家里 / 公司 / 手机热点）之后 IP 一定会变，
 * 跑这个脚本就知道新地址，不用敲 ipconfig 再自己比对。
 *
 *   npm run where
 */
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";

const PORT = Number(process.env.PORT || 3000);

// 这些网卡是虚拟的，手机连不上，排在最后只作参考
const VIRTUAL = /vmware|virtualbox|hyper-?v|vethernet|loopback|tap|wsl|docker|tailscale|zerotier/i;
// 这些最可能是真实的上网网卡
const LIKELY = /wlan|wi-?fi|wireless|以太网|ethernet|en\d|eth\d/i;

/**
 * 问系统「默认从哪个本机地址出网」。
 *
 * 原理：给 UDP socket 设定一个远端地址并 connect —— 这一步不发包，
 * 只是让内核查路由表、选好出口网卡，然后 address() 就把那块网卡的本机 IP 告诉我们。
 * 比解析 ipconfig 可靠得多：不受中文编码影响，也不会被 VMware 之类的虚拟网卡骗到
 * （虚拟网卡没有默认路由，永远不会被选中）。
 */
function defaultRouteIP() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* 已关闭 */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(""), 1500);
    sock.once("error", () => {
      clearTimeout(timer);
      finish("");
    });
    try {
      sock.connect(53, "223.5.5.5", () => {
        clearTimeout(timer);
        try {
          finish(sock.address().address);
        } catch {
          finish("");
        }
      });
    } catch {
      clearTimeout(timer);
      finish("");
    }
  });
}

function listAddrs(defaultIP) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== "IPv4" || i.internal) continue;
      // 169.254.x.x 是没拿到 DHCP 时的自分配地址，不可用
      if (i.address.startsWith("169.254.")) continue;
      out.push({
        name,
        address: i.address,
        isDefault: i.address === defaultIP,
        virtual: VIRTUAL.test(name),
        likely: LIKELY.test(name),
      });
    }
  }
  return out.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    if (a.likely !== b.likely) return a.likely ? -1 : 1;
    return 0;
  });
}

function probe(host) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: PORT });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1200);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function printQR(text) {
  try {
    const m = await import("qrcode-terminal");
    const mod = m.default ?? m;
    await new Promise((res) =>
      mod.generate(text, { small: true }, (s) => {
        console.log(s);
        res();
      })
    );
    return true;
  } catch {
    return false;
  }
}

const defaultIP = await defaultRouteIP();
const addrs = listAddrs(defaultIP);
const listening = await probe("127.0.0.1");
const primary = addrs.find((a) => a.isDefault) || addrs.find((a) => !a.virtual);

console.log("");
console.log("============ 这台电脑当前的可访问地址 ============");
console.log("");

if (!listening) {
  console.log(`  [提示] ${PORT} 端口没有服务在跑。`);
  console.log("         先另开一个终端跑  npm run dev  ，再回来执行本命令。");
  console.log("");
}

if (addrs.length === 0) {
  console.log("  没找到任何局域网地址 —— 这台电脑现在没连网络。");
  console.log("  解法：连上 Wi-Fi，或者用手机开热点让电脑连。");
  console.log("");
} else {
  for (const a of addrs) {
    const url = `http://${a.address}:${PORT}`;
    let tag = "";
    if (a.isDefault) tag = "  ← 用这个（系统默认出口）";
    else if (a.virtual) tag = "（虚拟网卡，手机连不上）";
    else tag = "（没有默认路由，手机多半连不上）";
    console.log(`  ${url}${tag}`);
    console.log(`     网卡：${a.name}`);
    console.log("");
  }
}

if (primary && listening) {
  const url = `http://${primary.address}:${PORT}`;
  const ok = await printQR(url);
  console.log(
    ok
      ? "  手机相机扫上面这个码，直接打开"
      : "  （装了 qrcode-terminal 就能出二维码：npm i -D qrcode-terminal）"
  );
  console.log("");
}

console.log("------------------------------------------------");
console.log(`  · 手机必须和电脑连同一个 Wi-Fi（或同一个热点）`);
console.log(`  · 本机自测地址：http://localhost:${PORT}`);
console.log("  · 换个网络地址就会变，到新地方重跑一次 npm run where");
console.log("  · 连不上优先怀疑：公司 Wi-Fi 开了设备隔离 / 连的是访客网络");
console.log("------------------------------------------------");
console.log("");
