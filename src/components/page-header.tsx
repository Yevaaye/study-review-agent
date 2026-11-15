import type { ReactNode } from "react";

/**
 * 所有页面共用的标题头。
 *
 * 之前每个页面各写一套：有的 `text-3xl`、有的 `text-4xl md:text-5xl`，
 * 有的带一段三行说明、有的带一排按钮 —— 换页时标题位置和大小都在跳，
 * 这是「页面看起来乱」的一大来源。统一到这里之后：
 *   标题位置固定、字号固定、说明最多一行、操作按钮永远在右上角。
 *
 * 结构上分成两层而不是一层 flex-wrap：
 * 旧写法把标题块和按钮放在同一个 wrap 行里，手机上副标题一长
 * （「2 份材料 · 64 张卡（选择 17 / 填空 13 / 判断 31…）」），
 * 按钮就被挤到第二行、单独占一行靠右，标题底下空出一大块。
 * 现在标题与按钮锁在同一行，副标题另起一层独占整宽，窄屏也不会散。
 */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="page-title min-w-0">{title}</h1>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>
        ) : null}
      </div>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </header>
  );
}
