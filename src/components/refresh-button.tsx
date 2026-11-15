"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** 手动刷新：重新拉取服务端数据（绕过 Next 的客户端路由缓存） */
export function RefreshButton({ label = "刷新数据" }: { label?: string }) {
  const router = useRouter();
  return (
    <button className="btn-ghost px-4 py-2" onClick={() => router.refresh()}>
      {label}
    </button>
  );
}

/**
 * 页面重新获得焦点 / 标签页切回来时自动刷新。
 * 场景：在复习页答完题，切回首页或统计页，数字必须是新的而不是缓存快照。
 */
export function RefreshOnFocus() {
  const router = useRouter();
  const mountedAt = useRef(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    mountedAt.current = Date.now();
    const refresh = () => {
      const now = Date.now();
      // 页面加载时浏览器会派发一次 focus，那不是「切回来」；
      // 异常情况下 focus 也可能被高频触发，节流避免变成 RSC 请求风暴
      // （dev 的 watcher 自激时，无节流的 focus→refresh 会明显放大循环）。
      if (now - mountedAt.current < 1000 || now - lastRefresh.current < 2000) return;
      lastRefresh.current = now;
      router.refresh();
    };
    const onVisible = () => {
      if (!document.hidden) refresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
