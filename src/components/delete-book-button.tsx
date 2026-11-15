"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * 删除一份材料（连同它的章节 / 片段 / 卡片 / 复习记录）。
 * 二次确认，避免误删 —— 这里的删除是硬删除，不可从界面恢复。
 *
 * 确认框不再用 window.confirm：手机浏览器里它会被静默吞掉，
 * 用户点完「删除」页面毫无反应，只能以为按钮坏了。
 */
export function DeleteBookButton({
  bookId,
  title,
  counts,
}: {
  bookId: string;
  title: string;
  counts: { chapters: number; cards: number };
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/books/${bookId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `删除失败（HTTP ${res.status}）`);
      setAsking(false);
      router.refresh();
    } catch (e) {
      // 失败时留在弹层里把原因写清楚，而不是弹一个可能同样被吞掉的 alert
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        /*
         * 删除是破坏性操作，不该和「全文」长得一样重。
         * 去掉描边与底色，只在 hover 时显红：平时几乎看不见，
         * 想点的时候仍然找得到，但不会在右侧排成一列红按钮抢注意力。
         */
        className="shrink-0 px-2 py-1 text-[11px] text-muted/70 transition hover:text-danger disabled:opacity-50"
        onClick={() => {
          setError("");
          setAsking(true);
        }}
        disabled={busy}
        title="删除这份材料及它生成的全部卡片"
      >
        {busy ? "删除中…" : "删除"}
      </button>

      <ConfirmDialog
        open={asking}
        title={`删除《${title}》？`}
        message={
          `将一并删除：${counts.chapters} 个章节、约 ${counts.cards} 张卡片，` +
          `以及这些卡片的复习进度与记录。\n\n此操作不可撤销。` +
          (error ? `\n\n删除失败：${error}` : "")
        }
        confirmLabel="删除"
        busy={busy}
        onCancel={() => {
          if (!busy) setAsking(false);
        }}
        onConfirm={handleDelete}
      />
    </>
  );
}
