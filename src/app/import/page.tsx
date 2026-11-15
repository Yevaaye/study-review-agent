"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { JobProgress, useJobs } from "@/components/job-center";
import { AiProgress } from "@/components/ai-progress";
import {
  clearImportError,
  loseImportSession,
  resetImportSession,
  resumeFromServer,
  startImport,
  syncSessionFromJob,
  updateDraft,
  useImportSession,
} from "@/lib/import/import-session";
import { missingJobVerdict, shouldSyncFromJob, type ImportMode } from "@/lib/import/session-state";

const MODES = [
  {
    key: "off" as const,
    label: "只收录",
    hint: "不调用 AI，只把材料里已有的题目逐字收录成卡。最快、零花费，适合题库类资料。",
  },
  {
    key: "smart" as const,
    label: "智能补充",
    hint: "收录原题 + 按知识点补新题，每章约「知识点数 × 1.5」张。日常推荐。",
  },
  {
    key: "deep" as const,
    label: "深度补充",
    hint: "补得更密（× 2.5）、题型更全，耗时与花费也更高。适合要精读的重点章节。",
  },
];

/**
 * 导入材料。
 *
 * 这一页的关键不是表单，而是「等待」：解析 + 抽原题要调模型，几十秒起步。
 * 所以状态不放在组件里 —— 放在 lib/import/import-session.ts（模块级 + sessionStorage），
 * 真正的进度从 /api/jobs 里的任务读。效果是：
 *   · 提交后可以立刻切走，任务在服务端继续跑；
 *   · 切回来时页面明确显示「还在导入（已用 23s）」或「已完成 · 38 道原题」；
 *   · 刷新也不丢（jobId 存在 sessionStorage，服务端任务还在表里）；
 *   · 只有任务真的查不到了，才明说「这次没拿到结果」，而不是假装在跑或回空表单。
 */
export default function ImportPage() {
  const router = useRouter();
  const jobs = useJobs();
  const session = useImportSession();

  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("smart");
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitAt, setSubmitAt] = useState<number | null>(null);
  const [askAnswered, setAskAnswered] = useState(false);
  const [genJobId, setGenJobId] = useState<string | null>(null);

  const seeded = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phase = session.phase;
  const running = phase === "running";
  const result = session.result;
  const job = session.jobId ? jobs.find((j) => j.id === session.jobId) : undefined;
  const genJob = genJobId ? jobs.find((j) => j.id === genJobId) : undefined;
  const generating = genJob?.status === "running";
  /** 纯知识点材料：导入成功、但原文里一道题都没有 */
  const pureKnowledge = !!result && result.original_card_count === 0 && mode !== "off";

  // 回到本页时把上次的表单快照种回来（只在第一次 hydrate 之后做一次）
  useEffect(() => {
    if (seeded.current || phase === "idle") return;
    seeded.current = true;
    setTitle(session.title);
    setMarkdown(session.markdown);
    setFileName(session.fileName);
    setMode(session.mode);
  }, [phase, session.title, session.markdown, session.fileName, session.mode]);

  // 草稿防抖写回会话：切走再回来输入框不会是空的（打字过程不逐键写 storage）
  useEffect(() => {
    if (!seeded.current || running) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => updateDraft({ title, markdown, fileName, mode }), 600);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [title, markdown, fileName, mode, running]);

  // 服务端任务 → 会话状态。
  // 注意 lost 也要对账：判丢之后任务又出现了（重启后重跑、或只是轮询慢了一拍），
  // 页面必须能自己回到 running / done，而不是把「查不到了」永远挂在屏幕上。
  useEffect(() => {
    if (shouldSyncFromJob(phase) && job) syncSessionFromJob(job);
  }, [phase, job]);

  /**
   * 任务查不到时的判定，分三级：内存任务表 → 数据库 import_jobs → 才判丢。
   *
   * 不能一挂载就判「丢了」：/api/jobs 的第一轮轮询还没回来时，列表本来就是空的。
   * 计时基准用会话里的 startedAt（落 sessionStorage），而不是组件 state 的 submitAt ——
   * 后者切页回来就是 null，会让宽限期直接失效、秒判丢。
   */
  useEffect(() => {
    if (!shouldSyncFromJob(phase)) return;
    // 已经判过丢了：不再重复判。任务若重新出现，上面的同步 effect 会把它救回来。
    if (phase === "lost") return;
    if (job) return;

    let stopped = false;
    const decide = async () => {
      const verdict = missingJobVerdict({
        hasJob: false,
        phase,
        startedAt: session.startedAt,
        submitAt,
        now: Date.now(),
      });
      if (verdict !== "lost") return;
      // 内存里没有，先回数据库问一次：import_jobs 里可能已经写着
      // 「review_required / 100% / 收录原题 38 道」——那就不用吓用户。
      const recovered = await resumeFromServer();
      if (stopped || recovered) return;
      loseImportSession();
    };
    const timer = setInterval(decide, 1500);
    void decide();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [phase, job, session.startedAt, submitAt]);

  // 后台生成结束 → 自动跳到审核台看结果
  useEffect(() => {
    if (!genJob || genJob.status !== "done") return;
    router.refresh();
    router.push("/cards?status=draft");
  }, [genJob, router]);

  /** 选一个本地 .md 文件直接读进文本框：省掉「打开文件 → 全选 → 复制 → 粘贴」。 */
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setLocalError("文件超过 8 MB，请拆分后再导入");
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        setLocalError("这个文件是空的");
        return;
      }
      setMarkdown(text);
      setFileName(file.name);
      setLocalError("");
      if (!title.trim()) {
        setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
      }
    } catch {
      setLocalError("读取文件失败，请改用粘贴");
    }
  }

  async function onImport() {
    if (!title.trim() || !markdown.trim()) {
      setLocalError("请填写材料标题与 Markdown 内容");
      return;
    }
    setLocalError("");
    setBusy(true);
    setSubmitAt(Date.now());
    try {
      // 提交后立刻返回（202 + job_id）；不等导入跑完 —— 这就是「不必干等」。
      await startImport({ title, markdown, fileName, mode });
    } catch (e) {
      setLocalError((e as Error).message || "提交失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    if (!result) return;
    setLocalError("");
    try {
      const res = await fetch(`/api/import/${result.import_job_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "生成失败");
      // 202 = 任务已在后台开跑。进度条留在页面上，跑完再跳审核台。
      if (data.job_id) {
        setGenJobId(String(data.job_id));
        return;
      }
      router.refresh();
      router.push("/cards?status=draft");
    } catch (e) {
      // 材料本身已经入库了，AI 生成失败不影响资料库
      setLocalError(`${(e as Error).message}（材料已保存到资料库，可稍后在审核台重试生成）`);
    }
  }

  function onImportAnother() {
    setAskAnswered(false);
    setGenJobId(null);
    setLocalError("");
    setTitle("");
    setMarkdown("");
    setFileName(null);
    // 表单已经清空，草稿同步保持开启（否则之后打的字再也进不了会话）
    seeded.current = true;
    resetImportSession();
    // 下一轮从干净的 idle 开始；模式沿用上一次（resetSession 里保留）
    setMode(session.mode);
  }

  const error = localError || session.error;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="导入材料" sub="Markdown → 章节与原题 → 知识点与卡片" />

      {/* ---------- 等待中：进度条 + 已用时间 + 可以走 ---------- */}
      {running && (
        <div className="card flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="text-[13px] font-medium">正在导入《{session.title || title}》</span>
          </div>
          <AiProgress
            startedAt={session.startedAt ?? submitAt}
            // 有任务时用服务端给的预估与百分比（与右下角浮层完全同源）；
            // 刚提交、任务还没出现在列表里的那一两秒，退化为不确定进度条
            etaMs={job?.eta_ms}
            percent={job?.percent ?? null}
            phase={job?.phase ?? "提交中"}
            note="这一步要调模型抽出原文里的题目，通常 10~40 秒。"
          />
          {job?.message && <p className="micro">{job.message}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
            <span className="text-fg/80">可以先去做别的，导入在后台继续。</span>
            <span>切到任何页面再回来，这里仍然会显示「在导入」或「已完成」。</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/library" className="btn-ghost btn-sm">
              去资料库看看 →
            </Link>
            <Link href="/review" className="btn-ghost btn-sm">
              去复习
            </Link>
          </div>
        </div>
      )}

      {/* ---------- 提交瞬间：POST 往返（解析结构）----------
          很短，但如果材料大，也要让用户看到「在做事」而不是按钮卡住。 */}
      {busy && !running && (
        <div className="card p-5">
          <AiProgress startedAt={submitAt} percent={null} phase="正在提交并解析章节结构" />
        </div>
      )}

      {/* ---------- 完成：结果 + 「还要再导入一份吗」---------- */}
      {phase === "done" && result && (
        <div className="card flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="min-w-0 flex-1 text-sm">
              <span className="chip mr-2 bg-success/15 text-success">已保存</span>
              解析出 {result.chapter_count} 章
              {/* 纯知识点文档里没有可收录的题目，这时「0 道原题」不是失败，
                  但也必须当场说清楚，否则用户会以为抽取坏了。 */}
              {result.original_card_count === 0 && (
                <span className="ml-2 text-warning">· 无原题（纯知识点）</span>
              )}
              {result.original_card_count > 0 && (
                <span className="ml-2 text-muted">
                  · 已收录原题 {result.original_card_count} 道
                  {result.by_type && (
                    <span className="ml-1 opacity-70">
                      （
                      {[
                        result.by_type.choice ? `选择 ${result.by_type.choice}` : "",
                        result.by_type.qa ? `问答 ${result.by_type.qa}` : "",
                        result.by_type.cloze ? `填空 ${result.by_type.cloze}` : "",
                        result.by_type.judge ? `判断 ${result.by_type.judge}` : "",
                      ]
                        .filter(Boolean)
                        .join(" / ")}
                      ）
                    </span>
                  )}
                </span>
              )}
              {result.needs_answer > 0 && (
                <span className="ml-2 text-warning">（{result.needs_answer} 道缺答案）</span>
              )}
              <Link href="/library" className="ml-2 whitespace-nowrap text-accent hover:underline">
                去资料库 →
              </Link>
            </div>

            {/* 完成态也要给出用时：用户刚等了几十秒，这是唯一能判断「值不值」的线索 */}
            <AiProgress
              startedAt={session.startedAt}
              endedAt={session.finishedAt}
              percent={100}
              phase="导入完成"
              status="done"
              className="w-full shrink-0 sm:w-56"
            />
          </div>

          {mode === "off" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/cards?status=draft" className="btn-ghost btn-sm px-4">
                去审核原题 →
              </Link>
              <button className="btn-primary btn-sm" onClick={onImportAnother}>
                再导入一份
              </button>
            </div>
          ) : pureKnowledge && !askAnswered ? null : (
            <div className="flex flex-col gap-1.5 sm:w-60">
              <button
                className="btn-primary btn-sm"
                onClick={onGenerate}
                disabled={busy || generating}
              >
                {generating
                  ? "AI 正在生成…"
                  : `生成卡片草稿（${mode === "deep" ? "深度" : "智能"}）`}
              </button>
              {genJob && <JobProgress job={genJob} />}
              {genJob?.status === "error" && (
                <span className="text-[11px] text-danger">{genJob.error}</span>
              )}
              {generating && (
                <span className="micro">可以先去做别的，任务在后台继续，跑完会自动跳到审核台。</span>
              )}
            </div>
          )}

          {/* 纯知识点材料的专用提问。
              「0 道原题」对这类材料是正常的（讲义、手册里本来就没有题），
              但用户不知道，第一反应是「抽取坏了」。所以这里明确问一句。 */}
          {pureKnowledge && !askAnswered && (
            <div className="w-full rounded-xl border border-warning/30 bg-warning/[0.06] px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-fg/85">
                <span className="text-warning">这份材料里没有现成的题目。</span>
                选择题、填空题、判断题都是 0，原文是纯知识点正文 ——
                这属于正常情况，不是抽取失败。
                {result.knowledge_point_count > 0 && (
                  <>已按原文结构提炼出 {result.knowledge_point_count} 条知识点。</>
                )}
                <br />
                要现在让 AI 按这些知识点出题吗？
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  className="btn-primary btn-sm"
                  onClick={onGenerate}
                  disabled={busy || generating}
                >
                  {generating ? "AI 正在生成…" : `AI 生成（${mode === "deep" ? "深度" : "智能"}）`}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  type="button"
                  onClick={() => setMode(mode === "deep" ? "smart" : "deep")}
                  disabled={busy || generating}
                >
                  换{mode === "deep" ? "智能" : "深度"}
                </button>
                <button className="btn-ghost btn-sm opacity-70" onClick={() => setAskAnswered(true)}>
                  先不生成
                </button>
              </div>
              {genJob && (
                <div className="mt-2">
                  <JobProgress job={genJob} />
                </div>
              )}
            </div>
          )}

          {pureKnowledge && askAnswered && (
            <div className="flex w-full flex-wrap items-center gap-2 text-[11px] text-muted">
              <span>已跳过 AI 出题。之后可以在资料库点「生成卡片」，或进章节页补题。</span>
              <button className="text-accent hover:underline" onClick={onGenerate}>
                现在生成 →
              </button>
            </div>
          )}

          {/* 完成后的下一步。用户原话：「完成后要问要不要再导入别的数据」 */}
          {!(pureKnowledge && !askAnswered) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
              <span className="text-[11px] text-muted">还要再导入别的材料吗？</span>
              <button className="btn-ghost btn-sm" onClick={onImportAnother}>
                继续导入下一份
              </button>
              <Link href="/cards?status=draft" className="btn-ghost btn-sm">
                去审核台
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ---------- 出错 / 丢进度：说清楚 + 给下一步 ---------- */}
      {error && (
        <div className="rounded-xl bg-danger/10 px-4 py-3">
          <p className="text-sm text-danger">{error}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {(phase === "error" || phase === "lost") && (
              <Link href="/library" className="text-accent hover:underline">
                去资料库确认是否已导入 →
              </Link>
            )}
            <button
              className="text-muted hover:text-fg"
              onClick={() => {
                setLocalError("");
                clearImportError();
              }}
            >
              知道了
            </button>
          </div>
        </div>
      )}

      {/* ---------- 表单：进行中隐藏（避免改了也和提交的快照不一致）---------- */}
      {!running && (
        <div className="flex flex-col gap-3">
          <input
            className="input"
            placeholder="材料标题（如：HTTP 协议简明讲义）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-ghost btn-sm cursor-pointer">
              选择 .md 文件
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="hidden"
                onChange={onPickFile}
              />
            </label>
            {fileName && <span className="micro">已选：{fileName}</span>}
            <span className="micro">或直接粘贴到下面</span>
          </div>

          <textarea
            className="input min-h-[260px] font-mono text-[13px] leading-relaxed"
            placeholder={"# 第一章 标题\n\n正文段落……\n\n## 1.1 小节\n\n更多正文……"}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
          <p className="micro">材料内容会发送给外部 AI 服务用于生成卡片，敏感内容请勿粘贴。</p>

          {/* 导入模式：决定「解析完之后要不要调模型补题」。
              三个选项不是「效果强弱」而是「要不要花钱」—— off 完全零调用。 */}
          <div className="flex flex-col gap-2">
            <div className="seg w-fit">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  className="seg-item"
                  data-active={mode === m.key}
                  onClick={() => setMode(m.key)}
                  disabled={busy}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="micro">{MODES.find((m) => m.key === mode)?.hint}</p>
          </div>

          <button className="btn-primary btn-lg" onClick={onImport} disabled={busy}>
            {busy ? "提交中…" : mode === "off" ? "导入并收录 →" : "导入并解析 →"}
          </button>
        </div>
      )}
    </div>
  );
}
