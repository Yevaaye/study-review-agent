"use client";

import { usePathname } from "next/navigation";

import { BottomNav, SideNav } from "./site-nav";
import { JobDock } from "./job-center";
import { AiChat } from "./ai-chat";

/**
 * 应用外壳：给登录页开一个「无导航」的裸布局。
 * 口令门打开后，登录页不该露出侧边栏 —— 那等于先告诉陌生人你有哪些书。
 */
/** 一屏一张卡、需要更宽正文的页面（见下方 main 的注释） */
const WIDE_ROUTES = ["/review", "/cards"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wide = WIDE_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (pathname === "/login") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        {children}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <SideNav />
      {/*
       * 顶部内边距用 max()，是因为「添加到主屏幕」后页面会顶到状态栏底下
       * （viewport-fit=cover），标题会和手机的时间/信号图标叠在一起。
       * 普通浏览器里 env() 为 0，退回 1.25rem，不受影响。
       */}
      {/*
       * 阅读类页面（全文）保持 4xl：一行 80~90 字已经是舒适上限，再宽眼睛会跳行。
       * 复习页 / 卡片审核页是「一屏一张卡」，行数少、每行都短，限制到 4xl 只会
       * 让左右各空出一大块，卡片里的正文被挤成窄条 —— 这两类页面放宽到 5xl，
       * 同时把左右内边距收窄一档，让内容真正吃满可用宽度。
       */}
      <main
        className={`min-w-0 flex-1 pb-24 pt-[max(1.25rem,env(safe-area-inset-top))] md:pb-12 md:pt-8 ${
          wide ? "px-3.5 md:px-6 lg:px-8" : "px-4 md:px-8 lg:px-10"
        }`}
      >
        <div
          className={`mx-auto flex w-full flex-col gap-7 md:gap-8 ${
            wide ? "max-w-5xl" : "max-w-4xl"
          }`}
        >
          {children}
        </div>
      </main>
      <BottomNav />
      {/* 后台 AI 任务浮层：生成期间切到任何页面都能看到进度 */}
      <JobDock />
      {/* AI 对话悬浮窗：登录页走上面的裸布局，不会出现 */}
      <AiChat />
    </div>
  );
}
