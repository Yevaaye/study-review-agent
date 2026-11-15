"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/** SSR 阶段没有 document；用 useSyncExternalStore 拿到「是否已在浏览器」且不触发额外渲染。 */
const noopSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;

/**
 * 应用内二次确认。
 *
 * 为什么不用 window.confirm：
 *   1. 手机上（微信内置浏览器、部分省电模式的国产内核）原生 confirm 会被直接吞掉，
 *      表现为「点了删除，什么都没发生」——用户以为按钮坏了，其实是对话框没弹出来；
 *   2. 原生弹窗只有一行纯文本，放不下「会删掉多少章节 / 卡片」这种说明；
 *   3. 样式和整站完全不一致。
 *
 * 这里用固定定位的遮罩 + 卡片，手机上贴着底栏上方的位置弹出，
 * 点遮罩 / 取消 / Esc 都能退出，确认按钮在处理中禁用，避免连点重复提交。
 *
 * ⚠️ 必须用 Portal 挂到 body：
 *   资料库/审核台的卡片容器 `.card` 带 `backdrop-filter: blur(14px)`。
 *   backdrop-filter（和 filter / transform 一样）会让元素成为
 *   **fixed 定位的 containing block** —— 弹层的 `position: fixed` 不再是
 *   相对视口，而是相对那张卡片。表现就是「点了删除，卡片暗了一下，
 *   但没有弹窗」，或者弹窗被裁在卡片里点不到确认按钮。
 *   挂到 body 才能跳出这个陷阱。SSR 阶段没有 document，用 mounted 守卫。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认删除",
  cancelLabel = "取消",
  danger = true,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const mounted = useSyncExternalStore(noopSubscribe, isClient, isServer);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="confirm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="text-base font-medium leading-snug">{title}</div>
        {message && (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{message}</p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className="btn-ghost flex-1 py-2.5 text-sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`flex-1 py-2.5 text-sm ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
