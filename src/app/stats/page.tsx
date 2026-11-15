import Link from "next/link";
import { getStore } from "@/lib/db/store";
import { computeFragmentStats, summarizeHot } from "@/lib/stats/fragment-stats";
import { typeSummary } from "@/lib/stats/card-types";
import { RefreshButton } from "@/components/refresh-button";
import { PageHeader } from "@/components/page-header";
import { REVIEWED_LABEL } from "@/lib/review/labels";

export const dynamic = "force-dynamic";

/** 指标单元格：数字 + 标签永远成对出现，手机上也不会出现看不懂的裸数字 */
function Metric({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={`metric text-[26px] md:text-[30px] ${tone ?? ""}`}>{value}</span>
      <span className="micro">{label}</span>
    </div>
  );
}

export default async function StatsPage() {
  const store = await getStore();
  const [cards, reviews, stats, textbooks, dueCards, sources] = await Promise.all([
    store.listCards(),
    // 统计要的是全量复习事件，不能有隐藏上限（slice(0, Infinity) 等价于不截断）
    store.listReviews(undefined, Number.POSITIVE_INFINITY),
    store.getTodayStats(),
    store.listTextbooks(),
    store.listDueCards(10000),
    store.listAllCardSources(),
  ]);

  // 卡 → 书 的归属（card_sources 只挂片段，经片段中转到书）。
  // 供下方「按书籍拆分」板块使用。
  const bookByCard = new Map<string, string>();
  {
    const bookByFrag = new Map<string, string>();
    for (const t of textbooks) {
      for (const f of await store.listFragments(t.id)) bookByFrag.set(f.id, t.id);
    }
    for (const cs of sources) {
      const b = bookByFrag.get(cs.source_fragment_id);
      if (b) bookByCard.set(cs.card_id, b);
    }
  }
  const dueCardIds = new Set(dueCards.map((d) => d.card_id));

  const active = cards.filter((c) => c.status === "active").length;
  const mastered = cards.filter((c) => c.status === "mastered").length;
  /** 内容错误（AI 误抽取）作废数：既不通过也不复习，单独统计便于评估抽取质量 */
  const invalid = cards.filter((c) => c.status === "invalid").length;

  // 题型分布走统一口径（见 lib/stats/card-types.ts）。
  // 以前按 is_choice 二分，判断、填空全被算进「选择题」，
  // 于是「64 张卡（选择题 48）」和审核台里的题型完全对不上。
  const typeText = typeSummary(cards);

  // 评分分布
  const ratingCount = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of reviews) {
    if (r.rating in ratingCount) ratingCount[r.rating as 1 | 2 | 3 | 4]++;
  }
  const ratingLabel = { 1: "没想起来", 2: "想起但费力", 3: "正常想起", 4: "轻松想起" };

  // 平均单卡耗时
  const elapsed = reviews.filter((r) => r.elapsed_ms != null).map((r) => r.elapsed_ms!);
  const avgMs = elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : null;

  // 高频知识点（跨材料）
  const fragmentsWithBook = (
    await Promise.all(
      textbooks.map(async (t) => {
        const frags = await store.listFragments(t.id);
        return frags.map((f) => ({ ...f, bookTitle: t.title }));
      })
    )
  ).flat();
  const fragStats = await computeFragmentStats(store);
  const { hotCount, watchCount, top } = summarizeHot(fragmentsWithBook, fragStats);

  // 按书籍拆分：每本书的卡量 / 待复习 / 复习次数 / 错误率
  const bookRows = textbooks.map((t) => {
    const bookCards = cards.filter((c) => bookByCard.get(c.id) === t.id);
    const cardIds = new Set(bookCards.map((c) => c.id));
    const bookReviews = reviews.filter((r) => cardIds.has(r.card_id));
    const again = bookReviews.filter((r) => r.rating === 1).length;
    return {
      id: t.id,
      title: t.title,
      total: bookCards.length,
      active: bookCards.filter((c) => c.status === "active").length,
      mastered: bookCards.filter((c) => c.status === "mastered").length,
      draft: bookCards.filter((c) => c.status === "draft").length,
      invalid: bookCards.filter((c) => c.status === "invalid").length,
      due: bookCards.filter((c) => dueCardIds.has(c.id)).length,
      reviews: bookReviews.length,
      againRate: bookReviews.length ? Math.round((again / bookReviews.length) * 100) : null,
    };
  });

  return (
    <>
      <PageHeader
        title="学习统计"
        sub={
          <>
            {textbooks.length} 份材料 · {cards.length} 张卡
            {/* 题型分布另起一行：和总数挤在一句里，手机上会折成三行 */}
            {typeText ? <span className="mt-0.5 block text-muted/70">{typeText}</span> : null}
            {invalid > 0 && (
              <Link href="/cards?status=invalid" className="mt-0.5 block text-warning hover:underline">
                内容错误 {invalid} 张 · AI 误抽取已作废（不通过也不复习）
              </Link>
            )}
          </>
        }
        actions={
          <>
            <RefreshButton />
            <Link href="/api/export" className="btn-ghost btn-sm px-3">
              导出
            </Link>
          </>
        }
      />

      {/*
       * 原来这里是两排共 8 个等权重盒子（累计复习 / 在复习 / 待复习 / 耗时 /
       * 高频 / 关注 / 待审核 / 已掌握），每个都长得一样，眼睛不知道该先看哪个。
       * 现在只留 4 个核心数字，放在同一张卡里；高频与关注归到它们所属的板块标题旁。
       */}
      <section className="card grid grid-cols-2 gap-y-6 p-5 md:grid-cols-4 md:gap-y-0">
        <Metric value={reviews.length} label="累计复习次数" />
        <Metric value={stats.due_count} label="当前待复习" tone={stats.due_count > 0 ? "text-warning" : ""} />
        <Metric value={avgMs ? `${(avgMs / 1000).toFixed(1)}s` : "—"} label="平均单卡耗时" />
        <Metric value={mastered} label="已掌握（不复习）" />
      </section>

      {/* 按书籍拆分 */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="section-label">按书籍拆分</h2>
          <span className="micro">复习中 {active} 张</span>
        </div>

        {bookRows.length === 0 ? (
          <div className="text-sm text-muted">还没有导入材料。</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {bookRows.map((b) => (
              <Link
                key={b.id}
                href={`/read/${b.id}`}
                className="flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-surface-2/50 px-3.5 py-3 transition hover:bg-surface-2"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.title}</span>
                  {b.due > 0 ? (
                    <span className="chip bg-warning/15 text-warning">待复习 {b.due}</span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted">{REVIEWED_LABEL}</span>
                  )}
                </div>
                {/*
                 * 关键改动：手机上原来是一张 6 列的表格，列头被 hidden 掉，
                 * 剩下 4 / 0 / 0 / 1 / 8 / 13% 六组裸数字完全无法解读。
                 * 现在每个数字自带标签，换行也读得懂。
                 */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                  <span>
                    复习中 <span className="tabular-nums text-fg/80">{b.active}</span>
                  </span>
                  <span>
                    已掌握 <span className="tabular-nums text-fg/80">{b.mastered}</span>
                  </span>
                  <span>
                    待审核 <span className="tabular-nums text-fg/80">{b.draft}</span>
                  </span>
                  {b.invalid > 0 && (
                    <span>
                      内容错误 <span className="tabular-nums text-warning">{b.invalid}</span>
                    </span>
                  )}
                  <span>
                    累计复习 <span className="tabular-nums text-fg/80">{b.reviews}</span>
                  </span>
                  <span>
                    错误率{" "}
                    {b.againRate == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span
                        className={
                          b.againRate >= 30
                            ? "tabular-nums text-danger"
                            : b.againRate >= 15
                              ? "tabular-nums text-warning"
                              : "tabular-nums text-success"
                        }
                      >
                        {b.againRate}%
                      </span>
                    )}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 高频知识点：点进去直接定位到原文那一段 */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="section-label">
            高频知识点
            <span className="ml-2 font-normal normal-case tracking-normal text-danger">
              高频 {hotCount}
            </span>
            <span className="ml-2 font-normal normal-case tracking-normal text-warning">
              关注 {watchCount}
            </span>
          </h2>
          <Link href="/library" className="micro text-accent">
            资料库 →
          </Link>
        </div>

        {top.length === 0 ? (
          <div className="text-sm text-muted">还没有需要重点复习的知识点。继续复习吧。</div>
        ) : (
          <ul className="flex flex-col">
            {top.slice(0, 8).map(({ frag, stat }) => {
              const book = (frag as { bookTitle?: string }).bookTitle;
              return (
                <li key={frag.id}>
                  {/*
                   * 手机上原来是一行 flex：定位文字 + 错/复习 + 书名三列并排，
                   * 书名很长又不能断行，把定位文字挤成两三个字的窄条。
                   * 现在手机端固定两行（第一行出处、第二行数据 + 书名），
                   * md 以上才回到一行。
                   */}
                  <Link
                    href={`/read/${frag.textbook_id}#frag-${frag.id}`}
                    className="block border-b border-white/[0.06] py-2.5 transition last:border-0 hover:opacity-90 md:flex md:items-baseline md:gap-3"
                  >
                    <span
                      className={`mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle md:hidden ${
                        stat.hot === 2 ? "bg-danger" : "bg-warning"
                      }`}
                    />
                    <span
                      className={`hidden md:mt-0.5 md:block md:h-1.5 md:w-1.5 md:shrink-0 md:rounded-full ${
                        stat.hot === 2 ? "bg-danger" : "bg-warning"
                      }`}
                      title={stat.hot === 2 ? "高频" : "关注"}
                    />
                    <span className="text-[13px] leading-relaxed text-fg/85 md:min-w-0 md:flex-1">
                      {frag.locator}
                    </span>
                    <span className="mt-1 flex items-center gap-3 text-[11px] text-muted md:mt-0 md:shrink-0">
                      <span className="shrink-0 tabular-nums">
                        {stat.review_count === 0
                          ? "未复习"
                          : `错 ${stat.again_count} / ${stat.review_count}`}
                      </span>
                      <span className="min-w-0 truncate">{book}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="section-label">评分分布</h2>
        <div className="flex flex-col gap-2.5">
          {([1, 2, 3, 4] as const).map((r) => {
            const total = reviews.length || 1;
            const pct = Math.round((ratingCount[r] / total) * 100);
            return (
              <div key={r} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-muted">{ratingLabel[r]}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent/60" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg/80">
                  {ratingCount[r]}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
