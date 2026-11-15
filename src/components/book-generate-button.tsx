"use client";

// 资料库里的「整本生成卡片」按钮。
//
// 为什么需要它：导入时 AI 生成是**后台异步**跑的，服务一旦重启
// （改代码热更新也算），那个后台任务就没了 —— 库里的导入任务永远停在
// stage=generating，卡片 0 张，界面上只显示「11 章 · 0 张卡」，
// 看起来像"没识别出题目"。这个按钮就是那个断点的续跑入口：
// 复用同一个 /api/import/{id} 接口，从任何阶段都能重新跑一遍，
// 已生成的卡按确定性 id 去重，不会翻倍。

import { useState } from "react";
import { useRouter } from "next/navigation";

import { JobProgress, startAiJob, useJobs } from "./job-center";

export function BookGenerateButton({
  importJobId,
  label = "生成卡片",
  className = "btn-primary btn-sm",
}: {
  importJobId: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const jobs = useJobs();
  const [jobId, setJobId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const busy = job?.status === "running";

  async function run() {
    setMsg(null);
    setErr(null);
    setJobId(null);
    try {
      const data = await startAiJob(`/api/import/${importJobId}`, { mode: "smart" });
      // 没有 job_id = 服务端秒回（例如没有可提炼正文），直接展示原因
      if (!data.job_id) {
        const n = Number(data.ai_card_count ?? data.added ?? 0);
        setMsg(n > 0 ? `已生成 ${n} 张` : "没有新增：这本材料的卡片已经齐了");
        router.refresh();
        return;
      }
      setJobId(String(data.job_id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <span className="flex flex-col items-stretch gap-1.5">
      <button className={className} onClick={run} disabled={busy}>
        {busy ? `生成中 ${job?.percent ?? 0}%` : label}
      </button>
      {job && <JobProgress job={job} />}
      {job?.status === "done" && (
        <span className="text-[11px] text-success">
          {Number(job.result?.ai_card_count ?? job.result?.added ?? 0) > 0
            ? `新增 ${Number(job.result?.ai_card_count ?? job.result?.added ?? 0)} 张，已进入待审核`
            : "没有新增"}
        </span>
      )}
      {job?.status === "error" && (
        <span className="text-[11px] text-danger">{job.error ?? "失败，请重试"}</span>
      )}
      {!job && msg && <span className="text-[11px] text-success">{msg}</span>}
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </span>
  );
}
