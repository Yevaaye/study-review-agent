"use client";

// 章节页的交互件：整章补题 / 单个知识点补题 / 未关联原题手动归属。
//
// 为什么单独成客户端组件：章节页本身是 RSC（要读库、算统计），
// 但「点一下出题」必须拿进度与结果提示，不能整页刷新。
//
// 出题接口现在是异步的：POST 立刻返回 job_id，进度从全局任务表里读。
// 这样按钮上能看到「已用 8s · 还需约 6s」，用户不会以为点不动。

import { useState } from "react";
import { useRouter } from "next/navigation";

import { JobProgress, startAiJob, useJobs } from "./job-center";

type KpOption = { id: string; statement: string };

/** 整章补题：不传 kpIds，由服务端用本章全部知识点 */
export function ChapterGenerateButton({
  chapterId,
  hasKps,
}: {
  chapterId: string;
  hasKps: boolean;
}) {
  const router = useRouter();
  const jobs = useJobs();
  const [jobId, setJobId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const busy = job?.status === "running";
  const added = job?.status === "done" ? Number(job.result?.added ?? 0) : null;

  async function run() {
    setMsg(null);
    setErr(null);
    setJobId(null);
    try {
      const data = await startAiJob(`/api/chapters/${chapterId}/generate`, { mode: "deep" });
      // 没有 job_id = 服务端秒回（例如指定的知识点已不存在），直接展示原因
      if (!data.job_id) {
        setMsg(
          Number(data.added ?? 0) > 0
            ? `新增 ${data.added} 张，已进入待审核`
            : (data.message as string) || "没有新增：与已有题目重复"
        );
        router.refresh();
        return;
      }
      setJobId(String(data.job_id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-1.5 md:w-56 md:items-end">
      <button className="btn-ghost btn-sm px-3" onClick={run} disabled={busy}>
        {busy ? "出题中…" : hasKps ? "整章补充出题" : "生成知识点与题目"}
      </button>
      {job && <JobProgress job={job} />}
      {added !== null && (
        <span className="text-[11px] text-success">
          {added > 0 ? `新增 ${added} 张，已进入待审核` : "没有新增：与已有题目重复（去重生效）"}
        </span>
      )}
      {job?.status === "error" && (
        <span className="text-[11px] text-danger">{job.error ?? "失败，请重试"}</span>
      )}
      {!job && msg && <span className="text-[11px] text-success">{msg}</span>}
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </div>
  );
}

/** 单个知识点补题：只围绕这一条出卡 */
export function KpGenerateButton({ chapterId, kpId }: { chapterId: string; kpId: string }) {
  const router = useRouter();
  const jobs = useJobs();
  const [jobId, setJobId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "ok" | "dup" | "err">("idle");

  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const busy = job?.status === "running";

  // 结果全部由 job 推导，不在渲染里写 state
  const doneAdded = job?.status === "done" ? Number(job.result?.added ?? 0) : null;
  const failed = state === "err" || job?.status === "error";
  const label = busy
    ? `${job.percent}%`
    : doneAdded !== null
      ? doneAdded > 0
        ? "已加"
        : "无新增"
      : state === "ok"
        ? "已加"
        : state === "dup"
          ? "无新增"
          : "出题";

  async function run() {
    setState("idle");
    setJobId(null);
    try {
      const data = await startAiJob(`/api/chapters/${chapterId}/generate`, {
        mode: "deep",
        kpIds: [kpId],
      });
      if (!data.job_id) {
        setState(Number(data.added ?? 0) > 0 ? "ok" : "dup");
        router.refresh();
        return;
      }
      setJobId(String(data.job_id));
    } catch {
      setState("err");
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button className="btn-ghost btn-sm px-2 tabular-nums" onClick={run} disabled={busy}>
        {label}
      </button>
      {failed && <span className="text-[11px] text-danger">失败</span>}
    </span>
  );
}

/** 未关联原题的归属下拉：选中即写入 kp_id */
export function KpBinder({
  cardId,
  kps,
  current,
}: {
  cardId: string;
  kps: KpOption[];
  current: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);

  async function bind(next: string) {
    setBusy(true);
    setValue(next);
    try {
      await fetch(`/api/cards/${cardId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bindKp", kp_id: next || null }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      className="input h-8 w-full max-w-[260px] py-0 text-xs"
      value={value}
      disabled={busy}
      onChange={(e) => bind(e.target.value)}
    >
      <option value="">未关联 · 选择知识点</option>
      {kps.map((k, i) => (
        <option key={k.id} value={k.id}>
          {i + 1}. {k.statement.slice(0, 40)}
        </option>
      ))}
    </select>
  );
}
