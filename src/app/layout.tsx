import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { RefreshOnFocus } from "@/components/refresh-button";

export const metadata: Metadata = {
  title: "学习复盘 Agent",
  description:
    "个人间隔复习助手 —— 导入材料 → AI 生成问答卡片 → 审核 → FSRS 复习排期",
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
