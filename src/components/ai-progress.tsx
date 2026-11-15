"use client";

// 全站唯一的「等 AI」进度条。
//
// 任何要等模型回答的地方都必须用它，不要再各自写一根 div：
//   · 后台任务（JobProgress 就是它的薄包装）
//   · 导入材料（解析 + 抽题）
//   · 卡片页单张「AI 补答案」
//   · 右上角对话窗
//
// 两种形态：
//   percent 给了数字 → 确定性进度条（任务/导入）
//   percent 为 null  → 不确定进度条（对话在等首字、无法预估的调用），仍带已用时间
// 两者版式完全一致，只有内部那条的实现不同 —— 这样用户不会觉得换了套界面。

import { useEffect, useState } from "react";

import {
  clampPercent,
  elapsedText,
  estimatePercent,
  formatDuration,
  remainLabel,
} from "@/lib/ui/progress";

export type ProgressStatus = "running" | "done" | "error";

/** 每 500ms 报一次时，用于「已用 X 秒」与「还需约 Y 秒」 */
export function useElapsed(
  startedAt: number | null | undefined,
  active: boolean,
  tickMs = 500
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    // 不在 effect 里同步 setNow（会触发级联渲染，且首帧 already 是 Date.now()）；
    // 半秒后第一次 tick 就把时间对齐了。
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [active, startedAt, tickMs]);
  return startedAt ? Math.max(0, now - startedAt) : 0;
}

export function AiProgress({
  startedAt,
  etaMs,
  percent,
  phase,
  status = "running",
  endedAt,
  note,
  className = "",
}: {
  /** 开始时刻（Date.now()）。缺失时只显示阶段名，不显示计时。 */
  startedAt?: number | null;
  /** 预估总时长；给了才会算「还需约 X 秒」 */
  etaMs?: number;
  /** 0~100；传 null 表示「无法预估」，渲染为不确定进度条 */
  percent?: number | null;
  /** 阶段名，如「解析章节」「请求模型」 */
  phase?: string;
  status?: ProgressStatus;
  /** 结束时刻：完成/失败后用它冻结用时，否则会继续走 */
  endedAt?: number | null;
  /** 进度条下方的一行补充说明（可选，11px） */
  note?: string;
  className?: string;
}) {
  const running = status === "running";
  const elapsed = useElapsed(startedAt, running);
  const span = startedAt ? Math.max(0, (endedAt ?? startedAt + elapsed) - startedAt) : 0;

  // 完成/失败后按真实结束时间冻结；运行中才走估算
  const pct =
    status === "done"
      ? 100
      : percent == null
        ? null
        : status === "error"
          ? clampPercent(percent, 4, 100)
          : etaMs && startedAt
            ? Math.max(clampPercent(percent, 0, 100), estimatePercent(elapsed, etaMs))
            : clampPercent(percent, 4, 100);

  const barTone =
    status === "error" ? "bg-danger" : status === "done" ? "bg-success" : "bg-accent";

  const right =
    status === "done"
      ? `已完成${startedAt ? ` · 用时 ${formatDuration(span)}` : ""}`
      : status === "error"
        ? `失败${startedAt ? ` · 用时 ${formatDuration(span)}` : ""}`
        : startedAt
          ? `${elapsedText(elapsed)}${etaMs ? ` · ${remainLabel(elapsed, etaMs)}` : ""}`
          : "";

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div
        className={`ai-bar${pct === null && running ? " ai-bar-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-label={phase ?? "处理进度"}
      >
        <div className={barTone} style={pct === null ? undefined : { width: `${Math.max(4, pct)}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className={`min-w-0 truncate ${status === "error" ? "text-danger" : "text-fg/75"}`}>
          {status === "error" ? "出错" : (phase ?? "")}
        </span>
        <span className="shrink-0 tabular-nums text-muted">{right}</span>
      </div>
      {note && <p className="micro">{note}</p>}
    </div>
  );
}
