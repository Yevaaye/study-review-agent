"use client";

import { useEffect } from "react";

/**
 * 跳转定位高亮。
 *
 * 为什么不用 CSS `:target` 就够了：从审核台/章节页点「看原文」是 Next 客户端软导航，
 * App Router 对 hash 的滚动处理在异步渲染页面里经常不生效 —— URL 变了但页面不滚动。
 * 这个组件在 hydration 后主动滚动到目标，并加上 flash 高亮（不依赖 :target）。
 *
 * 支持三种目标（优先级从高到低）：
 *   1. ?fragment=<片段id>  → #frag-<id>
 *   2. ?chapter=<章节id>   → #ch-<id>（章标题没匹配到原文行时，退到该章第一个片段）
 *   3. location.hash       → 兼容所有旧的 #frag-xxx 深链
 */
export function HighlightTarget({
  chapterId,
  fragmentId,
  chapterFallback,
}: {
  chapterId?: string;
  fragmentId?: string;
  chapterFallback?: Record<string, string>;
}) {
  // chapterFallback 是服务端算好的普通对象，随 props 进入 effect 依赖即可
  useEffect(() => {
    let targetId: string | null = null;
    if (fragmentId) targetId = `frag-${fragmentId}`;
    else if (chapterId) targetId = `ch-${chapterId}`;
    else if (typeof window !== "undefined" && window.location.hash.length > 1) {
      targetId = window.location.hash.slice(1);
    }
    if (!targetId) return;

    let el = document.getElementById(targetId);
    // 章标题行在原文里没匹配到（排版被改过）→ 退到该章第一个片段
    if (!el && chapterId) {
      const fb = chapterFallback?.[chapterId];
      if (fb) el = document.getElementById(`frag-${fb}`);
    }
    if (!el) return;

    // 等一拍再滚：首屏布局（图片/字体）稳定后滚动位置才准
    const scrollTimer = setTimeout(() => {
      el!.scrollIntoView({ behavior: "smooth", block: "start" });
      el!.classList.add("flash-target");
    }, 400);
    const clearTimer = setTimeout(() => el!.classList.remove("flash-target"), 5000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [chapterId, fragmentId, chapterFallback]);

  return null;
}
