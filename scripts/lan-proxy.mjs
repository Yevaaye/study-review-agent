#!/usr/bin/env node
/**
 * 局域网 80 端口转发器。
 *
 * 为什么需要它：手机用户只会输入 `192.168.31.178`，浏览器默认走 80 端口。
 * 应用实际监听在 3000，于是手机上是「白屏 / 打不开」。
 * 这个脚本把 80 的请求原样转发到 127.0.0.1:3000，用户就不必记住端口号。
 *
 * 用法：
 *   npm run lan              # 默认 80 → 3000
 *   LAN_PORT=8080 npm run lan
 *
 * 注意：绑 80 端口在 Windows 上通常需要管理员权限。绑不上时会打印原因并退出，
 * 不影响 3000 端口的正常服务。
 */
import http from "node:http";

const LAN_PORT = Number(process.env.LAN_PORT ?? 80);
const TARGET_HOST = process.env.TARGET_HOST ?? "127.0.0.1";
const TARGET_PORT = Number(process.env.TARGET_PORT ?? 3000);
// 一次导入可能要十几秒，超时给足，别把长请求掐断
const TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 300_000);

/** RFC 7230 规定不转发的逐跳首部 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function log(...args) {
  console.log(`[lan:${LAN_PORT}]`, ...args);
}

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  // 保留原始 Host（192.168.31.178），Next 生成绝对 URL 时才会是对的地址
  headers["x-forwarded-host"] = headers.host ?? "";
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, out);
      // 直接 pipe，不缓冲：RSC 流式响应和静态资源都能正常走
      up.pipe(res);
    },
  );

  upstream.setTimeout(TIMEOUT_MS, () => {
    upstream.destroy(new Error(`上游 ${TIMEOUT_MS}ms 无响应`));
  });

  upstream.on("error", (err) => {
    log("转发失败", req.method, req.url, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `上游服务不可用：${TARGET_HOST}:${TARGET_PORT}\n${err.message}\n\n` +
          `请确认应用已启动（npm start）。\n`,
      );
    } else {
      res.destroy();
    }
  });

  // 客户端提前断开时释放上游连接，避免泄漏
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
});

server.on("error", (err) => {
  if (err.code === "EACCES") {
    log(`无法绑定 ${LAN_PORT} 端口：权限不足。请用管理员权限运行，或改用 LAN_PORT=8080 npm run lan`);
  } else if (err.code === "EADDRINUSE") {
    log(`${LAN_PORT} 端口已被占用。换个端口：LAN_PORT=8080 npm run lan`);
  } else {
    log("启动失败：", err.message);
  }
  process.exit(1);
});

server.listen(LAN_PORT, "0.0.0.0", () => {
  log(`已启动：http://<本机局域网 IP>:${LAN_PORT}  →  ${TARGET_HOST}:${TARGET_PORT}`);
  log("手机直接输入 IP 即可，不用带 :3000");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("正在关闭…");
    server.close(() => process.exit(0));
  });
}
