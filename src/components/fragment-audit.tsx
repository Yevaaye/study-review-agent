"use client";

import { useCallback, useState } from "react";

/**
 * 原文片段的「题目识别核对」面板。
 *
 * 解决的问题：用户点「去原文查依据」只是来看这段话，但真正让他不放心的是
 * 「这段里的题到底都被认出来没有」。旧界面只给一个「N 张卡」标签，
 * 漏了的题永远不可见，误抽的题要等到复习时才撞见。
 *
 * 这里把一段原文按知识点切成块，逐块列出：
 *   已识别（有对应卡片） / 遗漏（像题但没卡） / 非题目（AI 判定是正文） / 待判定
 * 并给三条出口：再次识别（AI）、勾选后交 AI 判断、人工录入。
 *
 * 刻意做成「点开才请求」：一本书有上千个片段，全部预取会把页面拖死。
 */

type Row = {
  id: string;
  block: number;
  excerpt: string;
  signals: string[];
  kind: "choice" | "qa" | "judge";
  options: string[];
  answer: string;
  card_id: string | null;
  status: "identified" | "missing" | "rejected" | "pending";
  verdict: string;
  confidence: number;
};

type Block = { index: number; heading: string; text: string; start: number; end: number };

type Coverage = {
  total: number;
  identified: number;
  missing: number;
  rejected: number;
  pending: number;
  ratio: number;
};

const STATUS_STYLE: Record<Row["status"], { label: string; cls: string }> = {
  identified: { label: "已识别", cls: "bg-success/15 text-success" },
  missing: { label: "遗漏", cls: "bg-danger/15 text-danger" },
  rejected: { label: "非题目", cls: "bg-surface-2 text-muted" },
  pending: { label: "待判定", cls: "bg-warning/15 text-warning" },
};

const KIND_LABEL: Record<Row["kind"], string> = { choice: "选择", qa: "问答", judge: "判断" };

/** 段落首行当摘要：候选全文可能很长，列表里只给一眼能认出的那行 */
function excerptLine(r: Row): string {
  const first = r.excerpt.split("\n").map((l) => l.trim()).find(Boolean) ?? r.excerpt;
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

export function FragmentAudit({
  fragmentId,
  cardCount,
}: {
  fragmentId: string;
  /** 这段已有多少张卡：折叠状态也能给出「值不值得点开」的提示 */
  cardCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [msg, setMsg] = useState("");
  const [aiFailed, setAiFailed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  /** 人工录入表单：prefill 来自「补录这一条」 */
  const [manualOpen, setManualOpen] = useState(false);
  const [mFront, setMFront] = useState("");
  const [mOptions, setMOptions] = useState("");
  const [mAnswer, setMAnswer] = useState("");
  const [mBack, setMBack] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    try {
      const res = await fetch(`/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
        cache: "no-store",
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok || json.ok !== true) {
        setMsg(String(json.error ?? "读取失败"));
        return;
      }
      setRows((json.rows as Row[]) ?? []);
      setBlocks((json.blocks as Block[]) ?? []);
      setCov((json.coverage as Coverage) ?? null);
    } catch {
      setMsg("网络异常，未能读取识别情况");
    } finally {
      setLoading(false);
    }
  }, [fragmentId]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && rows.length === 0 && !loading) await load();
  }

  /** 只判勾选的几条：这是人工复核最省力的路径（AI 只答你关心的） */
  async function judgeSelected() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "judge", ai: true, ids: picked }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok || json.ok !== true) {
        setMsg(String(json.error ?? "AI 判定失败"));
        return;
      }
      if (json.ai_failed) {
        setAiFailed(true);
        setMsg(String(json.note ?? "AI 未能判定，请人工确认"));
        return;
      }
      // 用返回结果覆盖对应行，保留未参与判定的行
      const updated = (json.rows as Row[]) ?? [];
      const byId = new Map(updated.map((r) => [r.id, r]));
      setRows((prev) => prev.map((r) => byId.get(r.id) ?? r));
      setCov((json.coverage as Coverage) ?? cov);
      setPicked([]);
      setMsg(`AI 判定完成：${updated.length} 条`);
    } catch {
      setMsg("网络异常，AI 判定未完成");
    } finally {
      setBusy(false);
    }
  }

  /** 再次识别整个知识点块：先规则重扫，再让 AI 判这一块里还没答案的候选 */
  async function reidentify(blockIndex: number) {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      const ids = rows
        .filter((r) => r.block === blockIndex && !r.card_id)
        .map((r) => r.id);
      const res = await fetch(`/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: aiFailed || ids.length === 0 ? "scan" : "judge", ai: true, ids }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok || json.ok !== true) {
        setMsg(String(json.error ?? "再次识别失败"));
        return;
      }
      if (json.ai_failed) {
        setAiFailed(true);
        setMsg("AI 还是没能识别这一块，请用下面的「人工录入」补题");
        return;
      }
      const updated = (json.rows as Row[]) ?? [];
      const byId = new Map(updated.map((r) => [r.id, r]));
      setRows((prev) => prev.map((r) => byId.get(r.id) ?? r));
      setCov((json.coverage as Coverage) ?? cov);
      setMsg(json.ai ? `这一块重新识别完成（AI 判定 ${updated.length} 条）` : "规则已重扫");
    } catch {
      setMsg("网络异常，未能重新识别");
    } finally {
      setBusy(false);
    }
  }

  async function createCard() {
    if (busy) return;
    if (mFront.trim().length < 4) {
      setMsg("题干太短，至少要写清楚问的是什么");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/fragments/${encodeURIComponent(fragmentId)}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          front: mFront.trim(),
          options: mOptions
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
          answer: mAnswer.trim(),
          back: mBack.trim(),
        }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok || json.ok !== true) {
        setMsg(String(json.error ?? "录入失败"));
        return;
      }
      const skipped = Number(json.skipped ?? 0) > 0;
      setMsg(skipped ? "这张题已经在库里了（同题干不会重复建卡）" : "已录入，进入待审核队列");
      setManualOpen(false);
      setMFront("");
      setMOptions("");
      setMAnswer("");
      setMBack("");
      await load();
    } catch {
      setMsg("网络异常，未录入");
    } finally {
      setBusy(false);
    }
  }

  const blocksWithRows = blocks
    .map((b) => ({ block: b, list: rows.filter((r) => r.block === b.index) }))
    .filter((x) => x.list.length > 0);

  return (
    <div className="mt-2.5 border-t border-border/50 pt-2.5">
      <button
        type="button"
        onClick={() => void toggle()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted transition hover:bg-surface-2 hover:text-fg"
      >
        识别核对
        <span className="text-muted/60">
          {cardCount > 0 ? `· 已有 ${cardCount} 张卡` : "· 这段还没有卡"}
        </span>
        <span className="text-muted/50">{open ? "收起" : "展开"}</span>
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-line/60 bg-surface-2/20 p-3">
          {loading && <div className="text-[12px] text-muted">正在按知识点分块扫描…</div>}
          {msg && <div className="mb-2 text-[12px] text-accent">{msg}</div>}

          {cov && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="chip bg-surface-2 text-muted">候选 {cov.total}</span>
              <span className="chip bg-success/15 text-success">已识别 {cov.identified}</span>
              <span className="chip bg-danger/15 text-danger">遗漏 {cov.missing}</span>
              <span className="chip bg-surface-2 text-muted">非题目 {cov.rejected}</span>
              <span className="chip bg-warning/15 text-warning">待判定 {cov.pending}</span>
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="text-[12px] text-muted">
              这段没扫到像题目的段落。如果确实有题被漏掉，直接用下面的「人工录入」补一条。
            </div>
          )}

          <div className="flex flex-col gap-3">
            {blocksWithRows.map(({ block, list }) => (
              <div key={block.index} className="rounded-lg border border-line/50 bg-surface/40 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium">{block.heading}</div>
                    <div className="micro mt-0.5">
                      {list.filter((r) => r.status === "identified").length} 已识别 ·{" "}
                      {list.filter((r) => r.status === "missing").length} 遗漏 ·{" "}
                      {list.filter((r) => r.status === "pending").length} 待判定
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reidentify(block.index)}
                    className="shrink-0 rounded-lg border border-accent/40 px-2.5 py-1 text-[11px] text-accent transition hover:bg-accent/10 disabled:opacity-50"
                  >
                    再次识别
                  </button>
                </div>

                <div className="mt-2 flex flex-col gap-1.5">
                  {list.map((r) => {
                    const st = STATUS_STYLE[r.status];
                    const canPick = !r.card_id;
                    return (
                      <div
                        key={r.id}
                        className="flex items-start gap-2 rounded-lg bg-surface-2/40 px-2 py-1.5"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                          checked={picked.includes(r.id)}
                          disabled={!canPick}
                          onChange={(e) =>
                            setPicked((prev) =>
                              e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id)
                            )
                          }
                          title={canPick ? "勾选后交给 AI 判断" : "已有对应卡片"}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] leading-snug text-fg/85">
                            {excerptLine(r)}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className={`chip text-[10px] ${st.cls}`}>{st.label}</span>
                            <span className="chip bg-surface-2 text-[10px] text-muted">
                              {KIND_LABEL[r.kind]}
                              {r.options.length >= 2 ? ` · ${r.options.length} 项` : ""}
                            </span>
                            {r.verdict && (
                              <span className="text-[10px] text-muted/70">{r.verdict}</span>
                            )}
                          </div>
                        </div>
                        {r.status === "missing" && (
                          <button
                            type="button"
                            onClick={() => {
                              setManualOpen(true);
                              setMFront(excerptLine(r));
                              setMOptions(r.options.join("\n"));
                              setMAnswer(r.answer);
                              setMBack(r.answer);
                            }}
                            className="shrink-0 rounded-lg border border-danger/40 px-2 py-1 text-[11px] text-danger transition hover:bg-danger/10"
                          >
                            补录
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || picked.length === 0}
              onClick={() => void judgeSelected()}
              className="rounded-lg bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? "判定中…" : `让 AI 判断勾选的 ${picked.length} 条`}
            </button>
            <button
              type="button"
              onClick={() => setManualOpen((v) => !v)}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted transition hover:bg-surface-2"
            >
              人工录入题目
            </button>
            {aiFailed && (
              <span className="text-[11px] text-warning">
                AI 判定不可用，建议直接人工录入
              </span>
            )}
          </div>

          {manualOpen && (
            <div className="mt-3 rounded-lg border border-line/70 bg-surface/60 p-3">
              <div className="micro mb-1.5">题干（照原文抄，别改写）</div>
              <textarea
                value={mFront}
                onChange={(e) => setMFront(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg outline-none"
                placeholder="例：RAG 与微调该怎么选？"
              />
              <div className="micro mt-2 mb-1.5">选项（每行一个，留空则为问答题）</div>
              <textarea
                value={mOptions}
                onChange={(e) => setMOptions(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg outline-none"
                placeholder={"A. 知识更新频率\nB. 维护成本\nC. 引用来源要求"}
              />
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <div className="micro mb-1.5">正确答案（字母/多选字母）</div>
                  <input
                    value={mAnswer}
                    onChange={(e) => setMAnswer(e.target.value)}
                    className="w-full rounded-lg border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg outline-none"
                    placeholder="A 或 A、C"
                  />
                </div>
                <div>
                  <div className="micro mb-1.5">参考答案（问答题用）</div>
                  <input
                    value={mBack}
                    onChange={(e) => setMBack(e.target.value)}
                    className="w-full rounded-lg border border-line bg-transparent px-2.5 py-2 text-[12px] text-fg outline-none"
                    placeholder="留空则标记为待补答案"
                  />
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createCard()}
                  className="rounded-lg bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/25 disabled:opacity-50"
                >
                  {busy ? "保存中…" : "保存并加入待审核"}
                </button>
                <button
                  type="button"
                  onClick={() => setManualOpen(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-surface-2"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
