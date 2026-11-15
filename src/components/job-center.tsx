"use client";

// AI 任务的全局进度中心。
//
// 三件事必须同时成立，所以状态放在模块级而不是组件里：
//   1. 点了「出题」之后，按钮上要有进度 —— 用户知道没卡住
//   2. 切到别的页面，浮层还看得见进度 —— 「生成时其他功能不受影响」
//   3. 生成完，当前页的卡片列表要自动刷新 —— 不用手动再点一次
//
// 数据来自服务端 /api/jobs（内存表，只读，不碰数据库），按需轮询：
// 有任务在跑时 800ms 一次，空闲时 4 秒一次（确认「真的没有任务」）。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AiProgress } from "./ai-progress";

export interface Job {
  id: string;
  kind: string;
  title: string;
  href: string;
  status: "running" | "done" | "error";
  phase: string;
  message: string;
  percent: number;
  started_at: number;
  eta_ms: number;
  finished_at?: number;
  result?: Record<string, unknown>;
  error?: string;
}

const EMPTY: Job[] = [];
let snapshot: Job[] = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;

function emit(next: Job[]) {
  // 内容没变就不换引用，否则 useSyncExternalStore 会认为一直在变
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const l of listeners) l();
}

async function poll() {
  if (inflight) return;
  if (listeners.size === 0) {
    timer = null;
    return;
  }
  inflight = true;
  try {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { jobs?: Job[] };
      emit(data.jobs ?? []);
    }
  } catch {
    // 网络抖动忽略，下一轮再试
  } finally {
    inflight = false;
    const running = snapshot.some((j) => j.status === "running");
    timer = setTimeout(poll, running ? 800 : 4000);
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer && !inflight) void poll();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * 提交一次 AI 出题。接口返回的是 job_id 而不是结果，
 * 后续进度由 useJobs() 从全局轮询里拿。
 */
export async function startAiJob(
  url: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || "请求失败");
  // 立即拉一次，别让用户等到下一个轮询周期才看到进度
  void poll();
  return data;
}

/** 用当前时刻做节拍器：进度条的「已用 X 秒」和控制收起都要它 */
function useTick(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/**
 * 任务进度条。
 *
 * 从 2026-11 起它只是 <AiProgress> 的薄包装 —— 任务的「已用 / 还需约」
 * 与导入页、对话窗、单卡补答案共用同一套算术和版式。以前这里是
 * 一份独立实现，于是导入页的等待是一根不动的条、这里是带倒计时的，
 * 同一个「等 AI」在站内出现了两种长相。
 */
export function JobProgress({ job }: { job: Job }) {
  return (
    <AiProgress
      startedAt={job.started_at}
      endedAt={job.finished_at ?? null}
      etaMs={job.eta_ms}
      percent={job.percent}
      phase={job.phase}
      status={job.status}
    />
  );
}

/**
 * 悬浮任务条：任何页面都能看到后台 AI 在干什么。
 *
 * 位置压在底部导航之上（手机）／右下角（桌面）。只在真有任务时出现，
 * 完成后停留 8 秒自动收起。
 */
export function JobDock() {
  const jobs = useJobs();
  const router = useRouter();
  const pathname = usePathname();
  const refreshed = useRef<Set<string>>(new Set());
  const now = useTick(jobs.length > 0, 800);

  // 任务完成 → 当前页自动刷新（卡片列表直接长出来，不用手点）
  useEffect(() => {
    for (const j of jobs) {
      if (j.status === "running" || refreshed.current.has(j.id)) continue;
      refreshed.current.add(j.id);
      if (j.status === "done" && pathname === j.href) router.refresh();
    }
  }, [jobs, pathname, router]);

  // 结束的任务由服务端写 finished_at，8 秒后自动收起
  const visible = jobs.filter(
    (j) => j.status === "running" || !j.finished_at || now - j.finished_at < 8000
  );

  if (visible.length === 0) return null;

  return (
    <div className="job-dock">
      {visible.map((j) => (
        <div
          key={j.id}
          className="pointer-events-auto flex flex-col gap-2 rounded-[var(--radius-md)] border border-white/[0.12] bg-[#202127]/95 p-3 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        >
          <div className="flex items-start gap-2">
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                j.status === "running"
                  ? "animate-pulse bg-accent"
                  : j.status === "done"
                    ? "bg-success"
                    : "bg-danger"
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-fg">{j.title}</div>
              <div className="micro truncate">{j.message}</div>
            </div>
            {j.status !== "running" && (
              <button
                className="shrink-0 text-[11px] text-muted transition hover:text-fg"
                onClick={() => router.push(j.href)}
              >
                查看
              </button>
            )}
          </div>
          <JobProgress job={j} />
        </div>
      ))}
    </div>
  );
}
