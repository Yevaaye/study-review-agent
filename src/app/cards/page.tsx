"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EnumeratedText } from "@/components/enumerated-text";
import { AnswerText } from "@/components/answer-text";
import { AnswerSourceNote } from "@/components/source-note";
import { useSearchParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { startAiJob, useJobs, JobProgress } from "@/components/job-center";
import { AiProgress } from "@/components/ai-progress";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { isCorrectOption } from "@/lib/cards/option-match";

type Source = { id: string; locator: string; content: string; textbook_id?: string };
type Card = {
  id: string;
  front: string;
  back: string;
  kind: string;
  options: string[] | null;
  answer: string | null;
  is_choice: boolean;
  /** 真实题型：choice / qa / cloze / judge。老数据没有这个字段，靠 kind 兜底 */
  card_type?: string | null;
  status: string;
  content_revision: number;
  /** 原文没给答案：卡照建，答案留空 */
  needs_answer?: boolean;
  /** 答案出处：source = 原文自带；ai = AI 依据知识点补的 */
  answer_origin?: string | null;
  /** AI 答案是否有原文依据（false = 原文没写，AI 用专业知识补的） */
  answer_grounded?: boolean | null;
  /** 保真核对：题干/选项/答案能否在原文逐字找到（null = 未校验） */
  fidelity_status?: "exact" | "partial" | "missing" | null;
  fidelity_note?: string | null;
  sources: Source[];
  /** 复习进度（后端随卡片一起返回） */
  review?: {
    reps: number;
    lapses: number;
    state: number;
    schedule_status: string;
    last_review_at: string | null;
    due_at: string | null;
  };
};

/** 题型标签：审核时一眼分清选择 / 问答 / 填空 / 判断 / 对比，不看内容也能挑 */
const TYPE_LABEL: Record<string, string> = {
  choice: "选择题",
  qa: "问答",
  cloze: "填空",
  judge: "判断",
  contrast: "对比",
};

type Counts = { draft: number; active: number; mastered: number; invalid: number; total: number };

type Toast = {
  text: string;
  href?: string;
  linkLabel?: string;
  /** 次要链接（比如拒绝后除了「去复习」还想给「看原文」） */
  alt?: { href: string; label: string };
};

const EMPTY_COUNTS: Counts = { draft: 0, active: 0, mastered: 0, invalid: 0, total: 0 };

/**
 * 待确认的破坏性操作。
 *
 * 以前用 window.confirm，手机上（微信内置浏览器 / 部分省电内核）会被静默吞掉，
 * 点了「删除」页面毫无反应。改成应用内弹层后，点击一定有可见结果。
 */
type PendingAction =
  | { kind: "delete"; id: string; front: string }
  | { kind: "batch"; action: string; ids: string[] };

/** 判定动作的落点状态：通过 → 已掌握，拒绝 → 复习中，内容错误 → 作废，恢复 → 待审核 */
const TARGET_STATUS: Record<string, string> = {
  approve: "mastered",
  reject: "active",
  invalidate: "invalid",
  restore: "draft",
};

/** 卡片是否复习过（复习轮次 > 0） */
function isReviewed(c: Card): boolean {
  return (c.review?.reps ?? 0) > 0;
}

/**
 * 这张卡有没有可用答案。
 * 原文自带的答案和 AI 补的答案都算「有」——区别靠 answer_origin 上的标识说明。
 */
function hasAnswer(c: Card): boolean {
  return !!(c.back ?? "").trim();
}

/**
 * 「AI 出题」提交后的结果条：显示进度，完成后显示新增数量并刷新列表。
 * 组件内部拿 job 状态，done 时触发一次列表刷新（router.refresh + 让父组件 load）。
 */
function GenerateResult({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const jobs = useJobs();
  const router = useRouter();
  const job = jobs.find((j) => j.id === jobId);
  const doneRef = useRef(false);

  useEffect(() => {
    if (job?.status === "done" && !doneRef.current) {
      doneRef.current = true;
      router.refresh();
      onDone();
    }
  }, [job?.status, router, onDone]);

  if (!job) return null;

  if (job.status === "done") {
    // 「AI 补答案」任务的结果字段是 filled，文案与出题任务不同
    const filledRaw = job.result?.filled;
    if (typeof filledRaw === "number") {
      const skipped =
        Number(job.result?.insufficient ?? 0) + Number(job.result?.no_material ?? 0);
      return (
        <div className="text-[11px] text-success">
          已补上 {filledRaw} 条 AI 答案
          {skipped > 0 ? ` · ${skipped} 张材料不足已跳过（没有编造答案）` : ""}
        </div>
      );
    }
    const added = Number(job.result?.added ?? 0);
    return (
      <div className="text-[11px] text-success">
        {added > 0 ? `新增 ${added} 张，进入待审核` : "没有新增：范围已覆盖（去重生效）"}
      </div>
    );
  }
  if (job.status === "error") {
    return <div className="text-[11px] text-danger">{job.error ?? "失败，请重试"}</div>;
  }
  return (
    <div className="w-full max-w-xs">
      <JobProgress job={job} />
    </div>
  );
}

/** 卡片状态 → 标签文案与配色（右上角 chip 用） */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "待审核", cls: "bg-surface-2" },
  active: { label: "复习中", cls: "bg-success/15 text-success" },
  mastered: { label: "已掌握", cls: "bg-accent/15 text-accent" },
  invalid: { label: "内容错误", cls: "bg-warning/15 text-warning" },
  rejected: { label: "已拒绝", cls: "bg-danger/15 text-danger" },
};

/** 「复习过没有 / 复习了几次」的一行说明 */
function reviewLine(c: Card): string {
  const reps = c.review?.reps ?? 0;
  const lapses = c.review?.lapses ?? 0;
  if (c.status === "invalid") return "已作废 · 不参与复习";
  if (c.status === "draft") return reps > 0 ? `已复习 ${reps} 次` : "尚未审核";
  if (reps === 0) return "未复习过";
  return lapses > 0 ? `已复习 ${reps} 次 · 忘 ${lapses} 次` : `已复习 ${reps} 次`;
}

function CardsInner() {
  const search = useSearchParams();
  const router = useRouter();

  /*
   * 审核台默认只看「待审核」。
   *
   * 老版本默认 status="" 拉全部卡片，于是已经在复习队列里的卡也摆在审核台上，
   * 还配了一个「拒绝（进复习）」按钮 —— 这些卡本来就在队列里，点了状态不变，
   * 用户看到的就是「点了拒绝，什么都没发生」，自然会认为规则没生效。
   * 现在默认落在 draft：处理一张，它就从列表里消失并出现在对应分区。
   */
  const status = search.get("status") ?? "draft";
  const type = search.get("type") ?? "";
  const textbookId = search.get("textbookId") ?? "";
  // 从原文某一段（或某章）跳过来时，只显示那一段 / 那一章挂着的卡片
  const fragmentId = search.get("fragmentId") ?? "";
  const chapterId = search.get("chapterId") ?? "";
  const isScoped = !!(fragmentId || chapterId);

  const [cards, setCards] = useState<Card[]>([]);
  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 「AI 出题」：genFor = 正在确认出题的卡片 id；genJobId = 该卡片最近一次提交的 job
  const [genFor, setGenFor] = useState<string | null>(null);
  const [genJobId, setGenJobId] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  // 「AI 补答案」：answering = 正在生成答案的卡片；fillJobId = 批量补答案的任务
  const [answering, setAnswering] = useState<Set<string>>(new Set());
  /** 每张卡各自的开始时刻：单张补答案要等模型，界面上必须有进度条和已用时间 */
  const [answerAt, setAnswerAt] = useState<Record<string, number>>({});
  const [fillJobId, setFillJobId] = useState<string | null>(null);
  // 删除 / 批量操作统一走应用内确认弹层
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      qs.set("status", status);
      if (type) qs.set("type", type);
      if (textbookId) qs.set("textbookId", textbookId);
      if (fragmentId) qs.set("fragmentId", fragmentId);
      if (chapterId) qs.set("chapterId", chapterId);
      const res = await fetch(`/api/cards?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "加载失败");
      setCards(data.cards ?? []);
      setCounts(data.counts ?? EMPTY_COUNTS);
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, type, textbookId, fragmentId, chapterId]);

  // 进入页面 / 切换状态筛选时重新拉取。
  // load() 的第一句就是 setLoading(true)，所以这条规则会告警。
  // 首屏 loading 初值本来就是 true（React 对相同值直接 bail out），
  // 真正变化的只有「切筛选」那一刻 —— 属于 loading 状态机本身，不是多余级联渲染。
  // 数据获取型 effect 无法绕开这条规则，这里定向豁免。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // 提示条 8 秒后自动消失（留够时间点链接）
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  /** 卡片的来源片段 → 原文深链 */
  function sourceHref(c: Card): string | null {
    const s = c.sources[0];
    if (!s?.textbook_id) return null;
    return `/read/${s.textbook_id}?fragment=${s.id}`;
  }

  /**
   * 操作成功后把卡片从当前列表移除。
   *
   * 仅在「当前视图 != 全部」时移除：因为整个页面是按 status 过滤的，
   * 卡片落到了别的状态，就不该继续留在当前分区里。
   * 这一步是乐观更新 —— 先让视觉立刻反馈，再靠 load() 与服务端对齐。
   */
  function dropFromList(ids: string[], action: string) {
    if (status === "all") return;
    const target = TARGET_STATUS[action];
    if (!target || target === status) return;
    const gone = new Set(ids);
    setCards((prev) => prev.filter((c) => !gone.has(c.id)));
  }

  /**
   * 「AI 出题」：围绕某张卡的知识范围出题，数量按内容实际支撑量，不设上下限。
   * 走异步 job，进度由全局 JobDock 显示；这里只负责提交 + 反馈结果。
   */
  async function runGenerate(id: string) {
    setGenFor(null);
    setGenErr(null);
    setGenJobId(null);
    try {
      const data = await startAiJob(`/api/cards/${id}/generate`, { mode: "deep" });
      // 没有 job_id = 服务端秒回（例如知识点已满 / 无正文），直接展示原因
      if (!data.job_id) {
        const added = Number(data.added ?? 0);
        if (added > 0) {
          setToast({ text: `已新增 ${added} 张题，进入待审核`, href: "/cards?status=draft", linkLabel: "去审核 →" });
        } else {
          setToast({ text: (data.message as string) || "没有新增：范围已覆盖（去重生效）" });
        }
        await load();
        router.refresh();
        return;
      }
      setGenJobId(String(data.job_id));
      setGenFor(id); // 保留，等 job 完成后在按钮旁显示结果
    } catch (e) {
      setGenErr((e as Error).message);
    }
  }

  /**
   * 「AI 补答案」（单张）：原文没给答案时，让 AI 依据「知识点 + 章节正文」补一条。
   * 成功后落 answer_origin="ai" + answer_grounded，答案旁会显示「AI 整理，依据原文」或「原文未给出」，与原文答案区分开。
   */
  async function fillAnswer(id: string) {
    setAnswering((prev) => new Set(prev).add(id));
    setAnswerAt((prev) => ({ ...prev, [id]: Date.now() }));
    setToast(null);
    try {
      const res = await fetch(`/api/cards/${id}/answer`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error as string) || `生成失败（HTTP ${res.status}）`);
      const back = String(data.answer ?? "");
      setCards((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                back,
                // 选择题的 answer 也存选项文本，与导入链路的约定一致
                answer: (c.options?.length ?? 0) > 0 ? back : c.answer,
                answer_origin: "ai",
                answer_grounded: data.grounded === true,
                needs_answer: false,
              }
            : c
        )
      );
      // 生成完直接摊开答案，省掉一次「显示答案」
      setRevealed((prev) => new Set(prev).add(id));
      setToast({ text: "已生成 AI 答案 · 答案旁标了来源，核对后再决定通过与否" });
    } catch (e) {
      setToast({ text: `没有生成答案：${(e as Error).message}` });
    } finally {
      setAnswering((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setAnswerAt((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  /**
   * 「AI 补答案」（批量）：一次把当前视图里所有缺答案的卡交给后台任务。
   * 逐张调模型太慢，走 job；进度在右下角浮层里，完成后再刷列表。
   */
  async function fillAllAnswers() {
    setFillJobId(null);
    setError("");
    setToast(null);
    try {
      const data = await startAiJob("/api/cards/fill-answers", {
        textbookId: textbookId || undefined,
      });
      if (!data.job_id) {
        setToast({ text: (data.message as string) || "当前没有缺答案的卡片" });
        await load();
        return;
      }
      setFillJobId(String(data.job_id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function currentDueCount(): Promise<number | null> {
    try {
      const r = await fetch("/api/today");
      const j = await r.json();
      return typeof j?.stats?.due_count === "number" ? j.stats.due_count : null;
    } catch {
      return null;
    }
  }

  async function act(id: string, action: string) {
    setBusyId(id);
    setError("");
    setToast(null);
    try {
      const res = await fetch(`/api/cards/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "操作失败");
      }
      const card = cards.find((x) => x.id === id);
      const href = card ? sourceHref(card) ?? undefined : undefined;

      if (action === "invalidate") {
        setToast({
          text: "已作废 · 不通过也不复习",
          href: "/cards?status=invalid",
          linkLabel: "查看 / 恢复 →",
        });
      } else if (action === "restore") {
        setToast({ text: "已恢复为待审核，可重新判定" });
      } else if (action === "reject") {
        const due = await currentDueCount();
        setToast({
          text:
            due === null
              ? "已加入复习队列"
              : `已加入复习队列 · 当前待复习 ${due} 张`,
          href: "/review",
          linkLabel: "去复习 →",
          alt: href ? { href, label: "看原文" } : undefined,
        });
      } else {
        setToast({
          text: "已移出复习队列 · 标记为已掌握，不再安排复习",
          href: href,
          linkLabel: "去原文 →",
        });
      }

      dropFromList([id], action);
      await load();
      router.refresh(); // 首页 / 统计页的数字随之更新
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 删除卡片。
   * ask = true 时先弹确认（默认），确认后由弹层的 onConfirm 再调一次 ask=false。
   */
  async function del(id: string, ask = true) {
    const card = cards.find((x) => x.id === id);
    if (ask) {
      setPending({
        kind: "delete",
        id,
        front: (card?.front ?? "").replace(/\s+/g, " ").slice(0, 60),
      });
      return;
    }
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/cards/${id}`, { method: "DELETE" });
      // 旧实现不看响应：删失败（404 / 500）也照样把卡片从列表里抹掉，
      // 刷新后它又回来 —— 用户会以为「删了又复现」。
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `删除失败（HTTP ${res.status}）`);
      }
      setCards((prev) => prev.filter((c) => c.id !== id));
      setToast({ text: "已删除这张卡片" });
      await load();
    } catch (e) {
      // 提示条是 fixed 的，列表滚到哪都看得见；页面顶部的 error 条在手机上常常已经滚出视野
      setToast({ text: `删除失败：${(e as Error).message}` });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 批量操作（单请求，服务端一次事务处理）。
   *
   * 旧实现是前端 for 循环逐张 POST：60 张要 60 次往返 + 60 次写盘，耗时数秒，
   * 用户中途切页会把剩余请求 abort，结果只有第一张生效。
   * 现在整批发给 /api/cards/batch，一次写完，不存在中间态。
   */
  async function batchAct(action: string, ids: string[]) {
    if (ids.length === 0) {
      setError("当前分区没有可操作的卡片");
      return;
    }
    setError("");
    setToast(null);
    setBusyId("__batch__");

    try {
      const res = await fetch("/api/cards/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `批量操作失败（HTTP ${res.status}）`);

      const ok = Number(data.ok ?? 0);
      const skipped = Number(data.missing ?? 0) + Number(data.failed ?? 0);

      if (ok === 0) {
        setError(`没有卡片被处理${skipped ? `（跳过 ${skipped} 张）` : ""}，请确认这些卡仍然存在`);
      } else if (action === "reject") {
        setToast({
          text: `已把 ${ok} 张卡加入复习队列 · 当前待复习 ${data.due_count} 张`,
          href: "/review",
          linkLabel: "去复习 →",
          alt: textbookId ? { href: `/read/${textbookId}`, label: "看原文" } : undefined,
        });
      } else {
        setToast({
          text: `已将 ${ok} 张卡移出复习队列（标记为已掌握）`,
          href: textbookId ? `/read/${textbookId}` : undefined,
          linkLabel: textbookId ? "去原文查看 →" : undefined,
        });
      }

      dropFromList(ids, action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }

    await load();
    // 关键：清掉客户端路由缓存，否则回到首页/统计页仍会渲染操作前的快照
    router.refresh();
  }

  /** 批量入口：勾选了就用勾选的，没勾选就作用当前分区全部卡片 */
  function runBatch(action: string) {
    const ids = selected.size > 0 ? Array.from(selected) : cards.map((c) => c.id);
    if (ids.length === 0) {
      setError("当前分区没有可操作的卡片");
      return;
    }
    // 未勾选时作用于整区，影响面大，先确认一次（应用内弹层，不依赖 window.confirm）
    if (selected.size === 0 && ids.length > 5) {
      setPending({ kind: "batch", action, ids });
      return;
    }
    void batchAct(action, ids);
  }

  /** 弹层点「确认」后真正执行 */
  async function confirmPending() {
    const p = pending;
    if (!p) return;
    if (p.kind === "delete") await del(p.id, false);
    else await batchAct(p.action, p.ids);
    setPending(null);
  }

  const pendingBusy =
    pending?.kind === "delete" ? busyId === pending.id : busyId === "__batch__";

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === cards.length && cards.length > 0) setSelected(new Set());
    else setSelected(new Set(cards.map((c) => c.id)));
  }

  const tabs = [
    { key: "draft", label: "待审核", count: counts.draft },
    { key: "active", label: "复习中", count: counts.active },
    { key: "mastered", label: "已掌握", count: counts.mastered },
    { key: "invalid", label: "内容错误", count: counts.invalid },
    { key: "all", label: "全部", count: counts.total },
  ];

  const typeTabs = [
    { key: "", label: "全部" },
    { key: "choice", label: "选择题" },
    { key: "qa", label: "问答" },
    { key: "cloze", label: "填空" },
    { key: "judge", label: "判断" },
    { key: "contrast", label: "对比" },
  ];

  const reviewedCount = cards.filter(isReviewed).length;
  const totalReps = cards.reduce((a, c) => a + (c.review?.reps ?? 0), 0);
  /** 当前视图里还缺答案的张数 —— 决定要不要显示「AI 补全缺失答案」 */
  const missingCount = cards.filter((c) => !hasAnswer(c)).length;

  const batchDisabled = busyId === "__batch__" || cards.length === 0;

  const emptyHint = useMemo(() => {
    if (status === "draft") {
      return counts.total === 0
        ? "还没有卡片，去「导入材料」生成一批吧。"
        : "待审核队列已清空。卡片都在「复习中」或「已掌握」里，可以去复习了。";
    }
    if (status === "active") return "当前没有在复习队列里的卡片。";
    if (status === "mastered") return "还没有标记为已掌握的卡片。";
    if (status === "invalid")
      return "还没有作废的卡片。遇到 AI 误抽取的内容，点「内容错误」即可作废，之后可在这里恢复或删除。";
    return "还没有卡片，去「导入材料」生成一批吧。";
  }, [status, counts.total]);

  return (
    <div className="flex flex-col gap-6">
      {/*
       * 头部原来是一段三行说明（通过/拒绝的语义 + 卡片去向），占掉首屏 1/4。
       * 规则压成一行，够用；剩下那句话在第一次操作后的提示条里还会再讲一遍。
       */}
      <PageHeader
        title={isScoped ? "这一段的卡片" : "卡片审核"}
        sub={
          isScoped
            ? `只显示${fragmentId ? "当前这一段" : "当前这一章"}的卡片 · 徽标标明审核与复习状态`
            : "通过 = 已掌握　·　加入复习 = 进队列　·　内容错误 = 作废"
        }
      />

      {/*
       * 这里原本有三层重复：概览条（待审核/复习中/已掌握）、筛选标签（同样三个数）、
       * 以及标签里的计数。现在合并为一组：数字只出现在选中项所在的控件里。
       */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg seg-wrap">
            {tabs.map((t) => {
              const qs = new URLSearchParams();
              qs.set("status", t.key);
              if (type) qs.set("type", type);
              if (textbookId) qs.set("textbookId", textbookId);
              if (fragmentId) qs.set("fragmentId", fragmentId);
              if (chapterId) qs.set("chapterId", chapterId);
              return (
                <Link
                  key={t.key}
                  href={`/cards?${qs}`}
                  className="seg-item"
                  data-active={status === t.key}
                >
                  {t.label}
                  <span className="tabular-nums opacity-50">{t.count}</span>
                </Link>
              );
            })}
          </div>

          <div className="seg">
            {typeTabs.map((t) => {
              const qs = new URLSearchParams();
              qs.set("status", status);
              if (t.key) qs.set("type", t.key);
              if (textbookId) qs.set("textbookId", textbookId);
              if (fragmentId) qs.set("fragmentId", fragmentId);
              if (chapterId) qs.set("chapterId", chapterId);
              return (
                <Link
                  key={t.key || "alltype"}
                  href={`/cards?${qs}`}
                  className="seg-item"
                  data-active={type === t.key}
                >
                  {t.label}
                </Link>
              );
            })}
          </div>
        </div>

        <span className="micro hidden md:block">
          本页已复习 {reviewedCount} 张 · 累计 {totalReps} 次
        </span>
      </div>

      {(textbookId || isScoped) && (
        <div className="-mt-3">
          <Link
            href={textbookId ? (fragmentId ? `/read/${textbookId}?fragment=${fragmentId}` : `/read/${textbookId}`) : "/library"}
            className="micro text-accent hover:underline"
          >
            ← {fragmentId ? "回到这段原文" : textbookId ? "查看全文" : "回资料库"}
          </Link>
        </div>
      )}

      {error && <div className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
      {loading && <div className="text-sm text-muted">加载中…</div>}

      {/* 内容错误分区：只做单卡恢复 / 彻底删除，不提供批量动作。
          合并「删除」入口后这里要明确告诉用户去哪删，否则会以为按钮丢了。 */}
      {!loading && cards.length > 0 && status === "invalid" && (
        <div className="rounded-[var(--radius-md)] border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted">
          已作废，不通过也不复习。可「恢复为待审核」，或点「删除」彻底移除。
        </div>
      )}

      {/* 批量操作栏：只作用于当前分区，避免「一键拒绝」误伤别的状态。 */}
      {!loading && cards.length > 0 && status !== "invalid" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2">
          <button className="btn-ghost btn-sm" onClick={toggleAll}>
            {selected.size === cards.length && cards.length > 0
              ? "取消全选"
              : `全选 ${cards.length} 张`}
          </button>
          {selected.size > 0 && (
            <span className="micro">已选 {selected.size} 张</span>
          )}
          {/* 按钮随内容自适应宽度：手机上均分剩余空间（不留右侧空档），桌面保持靠右 */}
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            {missingCount > 0 && (
              <button
                className="btn-ghost btn-sm grow text-accent sm:grow-0"
                disabled={!!fillJobId}
                onClick={() => void fillAllAnswers()}
                title="原文没给答案的卡片，让 AI 依据知识点与章节正文补上，答案旁会标注来源"
              >
                {fillJobId ? "AI 补答案中…" : `AI 补全缺失答案（${missingCount}）`}
              </button>
            )}
            {status !== "mastered" && (
              <button
                className="btn-primary btn-sm grow sm:grow-0"
                disabled={batchDisabled}
                onClick={() => runBatch("approve")}
              >
                {busyId === "__batch__" ? "处理中…" : "全部通过"}
              </button>
            )}
            {status !== "active" && (
              <button
                className="btn-ghost btn-sm grow sm:grow-0"
                disabled={batchDisabled}
                onClick={() => runBatch("reject")}
              >
                {busyId === "__batch__" ? "处理中…" : "全部加入复习"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 批量补答案的进度与结果：跑完自动刷新列表，卡片上会出现「AI 整理，依据原文」/「原文未给出」 */}
      {fillJobId && (
        <GenerateResult
          jobId={fillJobId}
          onDone={() => {
            setFillJobId(null);
            void load();
          }}
        />
      )}

      {!loading && cards.length === 0 && (
        <div className="card flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted">
          <span>{emptyHint}</span>
          {status === "draft" && counts.active > 0 && (
            <Link href="/review" className="btn-primary btn-sm">
              去复习（{counts.active} 张）→
            </Link>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {cards.map((c) => {
          const show = revealed.has(c.id);
          // 题型以 card_type 为准。老数据没有这个字段，退回 kind —— 
          // 但早期判断题被存成「二选一」（kind=choice, options=[对,错]），
          // 不能当成选择题渲染，否则审核台会出现一堆假的选择题。
          const typeKey = c.card_type ?? (c.kind === "choice" ? "choice" : "qa");
          const isChoice = typeKey === "choice";
          const isJudge = typeKey === "judge";
          const checked = selected.has(c.id);
          const href = sourceHref(c);
          // 复习相关的一行说明。draft 且没复习过时 reviewLine 是「尚未审核」，
          // 和右上角的「待审核」标签重复，所以直接不显示。
          const dupWithChip = c.status === "draft" && (c.review?.reps ?? 0) === 0;
          const metaText = [
            dupWithChip ? "" : reviewLine(c),
            c.status === "active" && c.review?.due_at
              ? `下次 ${new Date(c.review.due_at).toLocaleDateString("zh-CN")}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              key={c.id}
              onClick={() => {
                if (!busyId) toggleSelect(c.id);
              }}
              /* 卡片内边距统一 16px：桌面原来 20px，正文区被两侧各吃掉 4px；
                 题干和选项是这个页面的全部内容，边距再大就只是空白。 */
              className={`card flex cursor-pointer flex-col gap-3 p-4 md:gap-3.5 ${
                checked ? "border-accent ring-1 ring-accent/40" : ""
              }`}
            >
              {/* 卡首行 = 复选框 + 正文列。右侧原本还有一个「状态」兄弟列（待审核 /
                  尚未审核 两行小字），它把整列正文永久挤窄（桌面 90px、手机近 1/5 宽），
                  题干和 A/B/C/D 选项都跟着变窄。现在状态并进上面这行标签，正文吃满。 */}
              <div className="flex min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* 复选框放在标签行里，不再作为正文列的兄弟节点。
                          否则它会和 12px 间距一起把题干/选项的左边距顶成
                          「内边距 + 28px」，而右边只有内边距 —— 左右不对称。 */}
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                        checked={checked}
                        onChange={() => toggleSelect(c.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span
                        className={`chip ${
                          isChoice ? "bg-accent/15 text-accent" : "bg-surface-2"
                        }`}
                      >
                        {TYPE_LABEL[typeKey] ?? "问答"}
                      </span>
                      {isJudge && show && (
                        <span
                          className={`chip ${
                            c.back === "对"
                              ? "bg-success/15 text-success"
                              : "bg-danger/15 text-danger"
                          }`}
                        >
                          {c.back === "对" ? "√ 对" : "× 错"}
                        </span>
                      )}
                      {/* 保真核对：把「这张卡的内容是否逐字来自原文」变成可见状态。
                          exact 不显示 —— 绝大多数卡都是 exact，全员打标等于不打标。 */}
                      {c.fidelity_status === "missing" && (
                        <span
                          className="chip bg-danger/15 text-danger"
                          title={c.fidelity_note ?? "题干/选项/答案在原文里找不到，疑似被改写"}
                        >
                          ⚠ 原文未找到
                        </span>
                      )}
                      {c.fidelity_status === "partial" && (
                        <span
                          className="chip bg-warning/15 text-warning"
                          title={c.fidelity_note ?? "部分内容在原文里找不到，可能是多行拼接"}
                        >
                          部分匹配原文
                        </span>
                      )}
                      {/* 状态贴在本行右端：位置和原来一样在右上角，但不再切走正文宽度 */}
                      <span
                        className={`chip ml-auto ${(STATUS_META[c.status] ?? STATUS_META.draft).cls}`}
                      >
                        {(STATUS_META[c.status] ?? STATUS_META.draft).label}
                      </span>
                    </div>
                    {/* 题干用 .question-stem（17px / 最亮 / 无框）单独成段：
                        它是这张卡的视觉锚点，答案则退到下面的竖线块里 */}
                    <div className="question-stem mt-3">
                      <EnumeratedText text={c.front} />
                    </div>

                    {isChoice ? (
                      /* 选项常显：让用户一眼看到考的是什么，不用先点「显示答案」 */
                      <div className="mt-3 flex flex-col gap-1.5">
                        {(c.options ?? []).map((opt, i) => {
                          const letter = String.fromCharCode(65 + i);
                          const isAnswer =
                            show &&
                            isCorrectOption(opt, c.answer, i, (c.options ?? []).length, c.options);
                          return (
                            <div
                              key={i}
                              className={`flex flex-wrap items-start gap-2.5 rounded-lg px-3 py-2 text-sm ${
                                isAnswer
                                  ? "bg-success/10 text-success"
                                  : "bg-surface-2/60 text-fg/80"
                              }`}
                            >
                              <span
                                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
                                  isAnswer ? "bg-success/20" : "bg-surface-2"
                                }`}
                              >
                                {letter}
                              </span>
                              <span className="min-w-0 flex-1 leading-relaxed break-words">{opt}</span>
                              {isAnswer && (
                                <span className="shrink-0 text-[11px] whitespace-nowrap">正确答案</span>
                              )}
                              {/* 窄屏上来源标注独占一行，落在正确选项文字下方，
                                  挤在选项右侧会把选项压成一字宽 */}
                              {isAnswer && c.answer_origin === "ai" && (
                                <span className="w-full pl-[30px]">
                                  <AnswerSourceNote
                                    origin={c.answer_origin}
                                    grounded={c.answer_grounded}
                                  />
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : show ? (
                      /* 答案：左侧竖线 + 「参考答案」小标题，跟题干彻底分成两块。
                         答案按分号断行；来源标注挂在最后一行末尾，
                         既不另起一行（避免误读成下一条内容），也不与答案抢焦点 */
                      <div className="answer-block mt-4">
                        <div className="block-cap">参考答案</div>
                        <div className="text-[15px] leading-[1.85] break-words text-fg/85">
                          <AnswerText
                            text={c.back ?? ""}
                            trailing={
                              <AnswerSourceNote
                                origin={c.answer_origin}
                                grounded={c.answer_grounded}
                                className="ml-1.5 align-[1px]"
                              />
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      /* 未展开：提示退到 .micro，把注意力留给「显示答案」按钮 */
                      <div className="micro mt-2.5">
                        {hasAnswer(c)
                          ? "点「显示答案」看参考答案"
                          : "原文没有给答案 · 可用 AI 依据知识点补一条"}
                      </div>
                    )}
                  </div>
                </div>

              {/* 页脚：一条 hairline 把「来源 / 定位原文 / 复习记录」从正文里切出去。
                  以前它紧跟答案、同色同距，读起来像答案的最后一句。 */}
              {(c.sources.length > 0 || metaText) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-2.5 micro">
                  {c.sources.length > 0 && (
                    <span>来源：{c.sources.map((s) => s.locator).join("；")}</span>
                  )}
                  {href && (
                    <Link
                      href={href}
                      className="text-accent hover:underline"
                      // 卡片整体是「点击切换选中」，链接必须拦住冒泡，
                      // 否则点「定位原文」会顺手把这张卡勾上，返回后选中态莫名残留。
                      onClick={(e) => e.stopPropagation()}
                    >
                      定位原文 →
                    </Link>
                  )}
                  {/* 复习次数 / 下次到期从原状态列搬到这里：信息不丢，但不再占正文宽度 */}
                  {metaText && <span className="ml-auto tabular-nums">{metaText}</span>}
                </div>
              )}

              {/* 按钮随状态变化：每个按钮点了都必须有可见结果，不留「点了没反应」的死按钮 */}
              <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                {hasAnswer(c) ? (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      const next = new Set(revealed);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      setRevealed(next);
                    }}
                  >
                    {show ? "收起答案" : "显示答案"}
                  </button>
                ) : c.status !== "invalid" ? (
                  /* 原文没给答案：把「显示答案」换成一个能真正产出内容的按钮 */
                  <button
                    className="btn-ghost btn-sm text-accent"
                    disabled={answering.has(c.id)}
                    onClick={() => void fillAnswer(c.id)}
                  >
                    {answering.has(c.id) ? "AI 生成中…" : "AI 补答案"}
                  </button>
                ) : null}

                {/* AI 补过的答案可以重来一次：材料没变但换种说法也常有更好的（作废卡跳过） */}
                {c.answer_origin === "ai" && c.status !== "invalid" && (
                  <button
                    className="btn-ghost btn-sm text-accent"
                    disabled={answering.has(c.id)}
                    onClick={() => void fillAnswer(c.id)}
                  >
                    {answering.has(c.id) ? "生成中…" : "重新生成"}
                  </button>
                )}

                {c.status === "draft" && (
                  <>
                    <button
                      className="btn-primary btn-sm"
                      disabled={busyId === c.id}
                      onClick={() => act(c.id, "approve")}
                    >
                      通过 · 不复习
                    </button>
                    <button
                      className="btn-ghost btn-sm"
                      disabled={busyId === c.id}
                      onClick={() => act(c.id, "reject")}
                    >
                      加入复习
                    </button>
                  </>
                )}

                {c.status === "active" && (
                  <button
                    className="btn-primary btn-sm"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "approve")}
                  >
                    已会 · 移出
                  </button>
                )}

                {c.status === "mastered" && (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "reject")}
                  >
                    移回复习
                  </button>
                )}

                {/*
                 * 内容错误：AI 把「不是题目」的内容误判成题（抽取误报）。
                 * 与「通过 / 加入复习」并列的第三态 —— 既不通过也不复习，
                 * 卡片从审核台与复习队列一并移出，数据保留在「内容错误」分区可恢复。
                 */}
                {c.status === "invalid" ? (
                  <button
                    className="btn-ghost btn-sm"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "restore")}
                  >
                    恢复为待审核
                  </button>
                ) : (
                  <button
                    className="btn-ghost btn-sm text-warning"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "invalidate")}
                    title="不是题目就作废 · 不复习 · 可恢复"
                  >
                    内容错误
                  </button>
                )}

                {/*
                 * 彻底删除只留在「内容错误」分区。
                 * 之前每张卡同时挂「内容错误」和「删除」，两者都能让卡片不通过不复习，
                 * 语义重复；合并后普通分区一个动作（作废，可撤销），误判卡进分区后
                 * 才提供不可恢复的删除，避免手滑把还能救的卡直接抹掉。
                 */}
                {c.status === "invalid" && (
                  <button
                    className="btn-ghost btn-sm text-danger"
                    disabled={busyId === c.id}
                    onClick={() => del(c.id)}
                  >
                    删除
                  </button>
                )}

                {/* AI 出题：围绕这张卡的知识范围出题，能出几张出几张（作废卡不再消耗模型） */}
                {c.status !== "invalid" && (
                  <button
                    className="btn-ghost btn-sm text-accent"
                    onClick={() => setGenFor(genFor === c.id ? null : c.id)}
                  >
                    AI 出题
                  </button>
                )}
              </div>

              {/* 单张补答案要等模型 10~30 秒：按钮上只有「生成中…」等于让用户干猜，
                  这里给和任务浮层同一根进度条 + 已用时间 */}
              {answering.has(c.id) && (
                <AiProgress
                  startedAt={answerAt[c.id]}
                  percent={null}
                  phase="AI 正在依据知识点补答案"
                  className="mt-2.5"
                />
              )}

              {/* 出题确认层：数量不设档位，按这条知识点的实际内容出（能出几张出几张）。
                  保留一次确认，是为了避免误点直接花掉一次模型调用。 */}
              {genFor === c.id && !genJobId && (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="micro">按这条知识点的实际内容出题，数量不设上下限</span>
                  <button className="btn-primary btn-sm" onClick={() => runGenerate(c.id)}>
                    开始出题
                  </button>
                  <button className="micro hover:text-fg" onClick={() => setGenFor(null)}>
                    取消
                  </button>
                </div>
              )}

              {/* 提交后的结果反馈（job 完成或失败时） */}
              {genFor === c.id && genJobId && (
                <GenerateResult
                  jobId={genJobId}
                  onDone={() => {
                    void load();
                  }}
                />
              )}
              {genFor === c.id && genErr && (
                <div className="text-[11px] text-danger" onClick={(e) => e.stopPropagation()}>
                  {genErr}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部浮动提示：明确告知卡片去了哪里，并给出直达链接 */}
      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-border bg-[#22242a] px-4 py-3 shadow-2xl md:left-auto md:right-8 md:mx-0">
          <span className="text-sm text-fg">{toast.text}</span>
          {toast.href && (
            <Link
              href={toast.href}
              className="btn-primary ml-auto shrink-0 px-3 py-1.5 text-xs"
              onClick={() => setToast(null)}
            >
              {toast.linkLabel ?? "查看 →"}
            </Link>
          )}
          {toast.alt && (
            <Link
              href={toast.alt.href}
              className="shrink-0 text-xs text-accent hover:underline"
              onClick={() => setToast(null)}
            >
              {toast.alt.label}
            </Link>
          )}
          <button className="shrink-0 text-xs text-muted hover:text-fg" onClick={() => setToast(null)}>
            关闭
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        busy={pendingBusy}
        title={
          pending?.kind === "batch"
            ? pending.action === "approve"
              ? `将 ${pending.ids.length} 张全部标记为已掌握？`
              : `将 ${pending.ids.length} 张全部加入复习？`
            : "彻底删除这张卡片？"
        }
        message={
          pending?.kind === "batch"
            ? "当前没有勾选任何卡片，操作会作用于这一分区的全部卡片。" +
              (pending.action === "approve"
                ? "\n\n这些卡会移出复习队列、标记为已掌握，不再安排复习。"
                : "\n\n这些卡会进入复习队列，按排期出现在复习里。")
            : pending?.kind === "delete"
              ? `「${pending.front}${pending.front.length >= 60 ? "…" : ""}」\n\n将从所有列表与统计中移除，界面上无法再看到或恢复（数据库仍保留记录）。\n\n若只是判错了，可先用「恢复为待审核」。`
              : ""
        }
        confirmLabel={pending?.kind === "batch" ? "确认执行" : "彻底删除"}
        danger={pending?.kind === "delete"}
        onCancel={() => {
          if (!pendingBusy) setPending(null);
        }}
        onConfirm={() => {
          void confirmPending();
        }}
      />
    </div>
  );
}

export default function CardsPage() {
  return (
    <Suspense fallback={<div className="text-muted">加载中…</div>}>
      <CardsInner />
    </Suspense>
  );
}
