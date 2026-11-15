// 进度与计时的纯函数。
//
// 为什么单独抽出来：这个项目里有 5 处「等 AI」的界面（任务浮层、导入页、
// 章节页、卡片页补答案、对话窗）。它们各自实现一遍，就会出现「这个页面写
// 还需约 12 秒、那个页面只有一根不动的条」——用户会觉得是两套东西。
// 这里只放算术与文案，服务端推进器与客户端组件都调它，保证口径一致。

/** 把任意数值收敛到 [min, max]，并对 NaN / Infinity 兜底 */
export function clampPercent(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 「大概到哪了」的估算进度。
 *
 * 模型不给流式进度，只能按时长逼近；两条规则沿用任务浮层已验证的行为：
 *   · 到 1×预估时长之前走到 `to`（默认 92%）—— 拿到结果前不该显示 100%；
 *   · 超过预估时长后继续以极慢速度往 96% 爬。
 *     早期版本直接停在 92%，任务真跑 70 秒时进度条 60 秒不动，看起来像卡死。
 */
export function estimatePercent(elapsedMs: number, etaMs: number, from = 8, to = 92): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return clampPercent(from, 0, 100);
  const eta = Number.isFinite(etaMs) && etaMs > 0 ? etaMs : 1;
  const ratio = elapsedMs / eta;
  const p = ratio <= 1 ? from + (to - from) * ratio : to + Math.min(4, (ratio - 1) * 1.2);
  return clampPercent(p, clampPercent(from, 0, 100), 96);
}

/** 时长 → 人能扫一眼的写法：7s / 1:05 / 12:03 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 「已用 12s」 */
export function elapsedText(ms: number): string {
  return `已用 ${formatDuration(ms)}`;
}

/** 预估剩余秒数（不会为负） */
export function remainSeconds(elapsedMs: number, etaMs: number): number {
  const eta = Number.isFinite(etaMs) ? etaMs : 0;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  return Math.max(0, Math.ceil(eta / 1000) - Math.floor(elapsed / 1000));
}

/**
 * 右侧那句「还需约 Xs」。
 * 超过 1.5 倍预估还没完，就不该继续报一个越来越假的倒计时 —— 直接承认慢。
 */
export function remainLabel(elapsedMs: number, etaMs: number): string {
  const remain = remainSeconds(elapsedMs, etaMs);
  if (remain > 0) return `还需约 ${remain}s`;
  if (elapsedMs > etaMs * 1.5) return "模型响应较慢";
  return "快好了";
}
