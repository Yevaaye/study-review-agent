import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { RefreshOnFocus } from "@/components/refresh-button";

export const metadata: Metadata = {
  title: "自主复习台",
  description:
    "把 Markdown 教材变成能长期刷的复习卡 —— 题目取自原文、可提炼知识点、按记忆规律排期",
};

/**
 * viewportFit: "cover" 让「添加到主屏幕」后页面铺满全屏（否则上下会留白边）。
 * 铺满之后必须靠 safe-area 内边距把内容让开刘海，这一条在 app-shell 里处理。
 * themeColor 与背景同色，手机状态栏才不会出现一条突兀的白条。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#17181b",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full">
        <RefreshOnFocus />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
