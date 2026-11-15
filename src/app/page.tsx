import Link from "next/link";
import { getStore } from "@/lib/db/store";

export const dynamic = "force-dynamic";

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 题型缩写：列表行尾只有两个字的位置 */
const TYPE_SHORT: Record<string, string> = {
  choice: "选",
  qa: "问",
  cloze: "填",
  judge: "判",
  contrast: "比",
};

export default async function Home() {
  const store = await getStore();
  const stats = await store.getTodayStats();
  const due = await store.listDueCards(8);
  const cards = await store.listCards();

  const activeCount = cards.filter((c) => c.status === "active").length;
  const masteredCount = cards.filter((c) => c.status === "mastered").length;

  // 今日队列拆成两组，回答「这 68 张是哪来的」：
  //   到期复习 = 学过（reps > 0）→ 按 FSRS 排期今天该回来的
  //   新卡     = reps = 0      → 今天导入 / 刚审核通过、第一次进队列
  // 两者相加恒等于 due_count，所以只有「都有」时才需要展示拆解。
  const dueReview = stats.review_count + stats.relearn_count;
  const bothGroups = dueReview > 0 && stats.new_count > 0;

  const now = new Date();
  const today = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAY[now.getDay()]}`;

  return (
    <>
      {/* 标题区只保留日期 + 页面名。原来上面还挂了一条「导入 → 生成卡片 → 审核 → FSRS 复习」
          的流程 chip，那是产品介绍不是今日信息，每天都看到一次，属于纯噪音。 */}
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="micro">{today}</div>
          <h1 className="page-title mt-1.5">今日复习</h1>
        </div>
      </header>

      {/* 唯一主视觉：还剩多少张 + 一个主按钮。其余信息全部降级到下面两行小字。 */}
      <section className="card p-6 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2.5">
              <span className="metric text-[56px] md:text-[68px]">{stats.due_count}</span>
              <span className="text-sm text-muted">张待复习</span>
            </div>

            {/*
             * 拆解行：主数字是总数，这一行说明它由哪两部分组成。
             * 只展示非零的一组，避免「到期 0 · 新卡 63」这种半截信息。
             * 数字用 tabular-nums 对齐，读起来是「到期复习 5 · 新卡 63」一句话。
             */}
            {bothGroups ? (
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                <span className="text-fg/80">
                  到期复习 <span className="metric text-[15px] tabular-nums">{dueReview}</span>
                </span>
                {/* 分隔点用 opacity-40（和上一行同一档），opacity-30 在深色背景上几乎不可见，
                    两个数字会粘成「5新卡 63」 */}
                <span className="opacity-40">·</span>
                <span className="text-fg/80">
                  新卡 <span className="metric text-[15px] tabular-nums">{stats.new_count}</span>
                </span>
              </div>
            ) : (
              <div className="text-[13px] text-fg/80">
                {dueReview > 0 ? "全部是按排期到期的复习卡" : "全部是今天新生成、还没学过的卡"}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
              <span>预计 {stats.estimated_minutes} 分钟</span>
              <span className="opacity-40">·</span>
              <span>今天已完成 {stats.completed_today} 张</span>
            </div>
          </div>

          <div className="md:pb-1">
            {stats.due_count > 0 ? (
              <Link
                href="/review"
                className="btn-primary btn-lg w-full md:w-auto md:px-7"
              >
                开始复习 →
              </Link>
            ) : (
              <Link href="/import" className="btn-ghost btn-lg w-full md:w-auto md:px-7">
                今天已复习 · 去导入材料
              </Link>
            )}
          </div>
        </div>
      </section>

      {/*
       * 两组都有时给出分开刷的入口。只在需要选的时候出现 ——
       * 只有一类卡时，上面那句「全部是……」已经把话说完了，
       * 再放两个按钮等于让人在只有一个选项里做选择。
       * 文案不回写数字：5 和 63 刚在上面出现过一次，重复只会让这一行更吵。
       */}
      {bothGroups && (
        <div className="flex flex-wrap items-center gap-y-2 text-xs">
          {/* 间距写成内联 margin：gap-x-6 这类首次出现的工具类在 dev 下
              不会立刻编译出来，两个链接会粘成一句「只刷到期复习 →只学新卡 →」 */}
          <Link
            href="/review?group=due"
            style={{ marginRight: "1.5rem" }}
            className="text-muted transition hover:text-fg"
          >
            只刷到期复习 →
          </Link>
          <Link href="/review?group=new" className="text-muted transition hover:text-fg">
            只学新卡 →
          </Link>
        </div>
      )}

      {/* 待审核只在与零不同的时候出现。原来无论有没有都占一行，还带一句解释。 */}
      {stats.pending_draft > 0 && (
        <Link
          href="/cards?status=draft"
          className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-warning/25 bg-warning/[0.06] px-4 py-3 text-sm transition hover:bg-warning/[0.1]"
        >
          <span className="text-warning">{stats.pending_draft} 张卡片待审核</span>
          <span className="shrink-0 text-xs text-warning">去审核 →</span>
        </Link>
      )}

      {/* 原来这里有「待审核 / 在复习 / 已掌握 / 全部」四个等权重的盒子，
          和上面的主数字抢注意力。现在压成一行文字，需要细节的去统计页。 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          复习中 {activeCount} 张 · 已掌握 {masteredCount} 张 · 共 {cards.length} 张
        </span>
        <Link href="/stats" className="text-accent hover:underline">
          查看统计 →
        </Link>
      </div>

      {due.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="section-label mb-1">今日待复习</h2>
          <ul className="flex flex-col">
            {due.map((d, i) => (
              <li key={d.card_id} className="row items-start">
                <span className="mt-0.5 w-4 shrink-0 text-[11px] tabular-nums text-muted/70">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-relaxed text-fg/85">{d.front}</span>
                {/*
                 * 原来这里还有一枚「上次没想起来」的红点。实测 8 行里 8 行都是红的——
                 * 当一条标记恒亮，它就不再传递信息，只是噪音。要判断哪些卡不熟，
                 * 去看统计页的「高频知识点」，那里才是这个问题的答案。
                 */}
                {/* 按真实题型标一个字：判断题以前被存成「二选一」，
                    这里会显示成「选」，和复习时看到的不一致。
                    10px 的灰字贴着右边缘几乎看不见，改成小方签，有底才有形状。 */}
                <span className="mt-0.5 shrink-0 rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10px] leading-none text-muted">
                  {TYPE_SHORT[d.card_type ?? (d.is_choice ? "choice" : "qa")] ?? "问"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
