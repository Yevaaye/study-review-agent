"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function IconChart({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 4v16h16" />
      <path d="M8 20v-5M12.5 20V9M17 20V6" />
    </svg>
  );
}

function IconImport({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 17v3h16v-3" />
    </svg>
  );
}

function IconCards({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3.5L16 3.5" />
    </svg>
  );
}

function IconPlay({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconHome({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

function IconLibrary({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 5h4v14H4z" />
      <path d="M10 5h4v14h-4z" />
      <path d="M16 5h4v14h-4z" />
      <path d="M2 5h18" />
    </svg>
  );
}

const NAV = [
  { href: "/", short: "今日", full: "今日任务", Icon: IconHome },
  { href: "/review", short: "复习", full: "开始复习", Icon: IconPlay },
  { href: "/import", short: "导入", full: "导入材料", Icon: IconImport },
  { href: "/cards", short: "卡片", full: "卡片审核", Icon: IconCards },
  { href: "/library", short: "资料", full: "资料库", Icon: IconLibrary },
  { href: "/stats", short: "统计", full: "学习统计", Icon: IconChart },
];

// 桌面 / 平板侧边栏：md 显示（图标栏 64px），lg 展开（256px）
export function SideNav() {
  const path = usePathname();
  return (
    <aside className="glass sticky top-0 hidden h-screen w-16 shrink-0 flex-col gap-2 px-2 py-6 md:flex lg:w-64 lg:px-5 lg:py-7">
      <div className="mb-6 px-1 lg:mb-8 lg:px-2">
        <div className="hidden lg:block">
          <div className="text-lg font-semibold tracking-tight">
            自主<span className="text-accent">复习台</span>
          </div>
          <div className="mt-1 text-xs text-muted">本地优先 · 原文出题</div>
        </div>
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-sm font-semibold text-accent lg:hidden">
          复
        </div>
      </div>

      <nav className="flex flex-col gap-1.5">
        {NAV.map(({ href, full, Icon }) => {
          const active = path === href || path.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              prefetch={false}
              title={full}
              className={`flex items-center gap-3 rounded-xl px-2 py-2.5 transition lg:px-3 ${
                active ? "bg-surface-2" : "hover:bg-surface-2"
              }`}
            >
              <Icon
                className={`h-5 w-5 shrink-0 ${active ? "text-accent" : "text-muted"}`}
              />
              <span
                className={`hidden text-sm font-medium lg:block ${
                  active ? "text-fg" : "text-fg/85"
                }`}
              >
                {full}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto hidden px-2 text-[11px] leading-relaxed text-muted/60 lg:block">
        FSRS 间隔复习
      </div>
    </aside>
  );
}

// 手机底部导航：< md 显示
export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="nav-bar fixed inset-x-0 bottom-0 z-50 flex justify-around px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 md:hidden">
      {NAV.map(({ href, short, Icon }) => {
        const active = path === href || path.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center gap-1 rounded-lg py-1 transition ${
              active ? "text-accent" : "text-muted"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className={`text-[11px] ${active ? "font-semibold" : "font-medium"}`}>
              {short}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
