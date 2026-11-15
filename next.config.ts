import type { NextConfig } from "next";

// dev 与 build 必须分开目录，但**方向必须是「dev 占默认 .next，build 让路」**。
//
// 2026-11-05 两次事故的完整结论：
// 1) 两者共用 `.next` 时，`next build` 会覆写 dev 的 Turbopack 缓存，watcher 把自己
//    写入的 `.next/dev/logs`、`cache/*.sst` 当成源码变化，不停 reloadPage。
// 2) 于是把 dev 迁到自定义 `.next-dev` —— 反而更糟：Turbopack 的 watch 忽略名单只
//    认 `.next`，自定义目录**不被忽略**，它自己写的编译产物和日志持续触发重编译，
//    实测 73 秒整页重载 200 次（约 0.36s 一次），浏览器完全无法使用。
// 3) 最终方案：dev 用默认 `.next`（Turbopack 天然忽略），build / start 输出到
//    `.next-prod`。两者互不覆盖，watcher 也不再监视自己的产物。
// NEXT_DIST_DIR 可覆盖（smoke 回退 dev 时用独立目录，避免和主 dev 抢 `.next`）。
const distDirOverride = process.env.NEXT_DIST_DIR?.trim();
// next build / next start 都以 NODE_ENV=production 运行；next dev 是 development。
const isProductionPhase = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  ...(distDirOverride || isProductionPhase
    ? { distDir: distDirOverride || ".next-prod" }
    : {}),
  /**
   * 容器部署时设 NEXT_OUTPUT=standalone，产物自带最小 node_modules。
   * 不设时保持默认输出 —— 因为 `next start` 与 standalone 输出互斥，
   * 而本机双实例（npm run serve:share）用的是 `next start`。
   */
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // 关闭 cacheComponents / partialPrefetching：本项目的数据接口需实时查库，
  // 不能被预渲染成静态快照（否则会返回过期的空数据）。
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  /**
   * 允许用局域网地址访问 dev server（手机 / 别的电脑）。
   *
   * 不配的话，Next 16 会拦掉来自非 localhost 的 /_next/* dev 资源（403），
   * 控制台打 "Blocked cross-origin request to Next.js dev resource"，
   * 表现是页面 HTML 出来了、左侧导航也在，但客户端 JS 永远不 hydrate，
   * 所有需要 fetch 的部分一直停在「加载中…」——手机上看就是这个症状。
   *
   * 放开的是私有网段通配：192.168（家用/办公 Wi-Fi）、10（大内网）、
   * 172（含 iOS 个人热点 172.20.10.x、安卓热点 192.168.43.x 已在 192.168 内）。
   * 仅对 dev 生效，不影响 next build / 生产运行。
   */
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.*.*",
    "10.*.*.*",
    "172.*.*.*",
    "*.local",
  ],
  /**
   * 关掉开发模式左下角/右上角那个悬浮的 "N" 小圆点。
   * 它不属于产品界面，截图和演示时会被误认为是页面元素。
   */
  devIndicators: false,
};

export default nextConfig;
