import Link from "next/link";
import { getStore } from "@/lib/db/store";
import { listJobs } from "@/lib/jobs";
import { computeFragmentStats, summarizeHot } from "@/lib/stats/fragment-stats";
import { bookImportState, importingTitles } from "@/lib/import/job-status";
import { countByType, TYPE_ORDER } from "@/lib/stats/card-types";
import { BookGenerateButton } from "@/components/book-generate-button";
import { DeleteBookButton } from "@/components/delete-book-button";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const store = await getStore();
  const textbooks = await store.listTextbooks();

  // 一次算全量片段统计，多本书共用（片段 id 全局唯一）
  const statsMap = await computeFragmentStats(store);

  // 后台生成任务只活在进程内存里。服务一重启（改代码热更新也算），
  // 库里的导入任务会永远停在 stage=generating，卡片 0 张 —— 用户看到的就是
  // 「11 章 · 0 张卡」，像是根本没识别出内容。这里拿内存任务表做交叉验证：
  // 数据库说"生成中"、内存里却没有对应任务，那就是被打断了，得给个续跑入口。
  const liveJobs = listJobs();
  const runningTitles = new Set(liveJobs.filter((j) => j.status === "running").map((j) => j.title));
  // 解析阶段没有「runningTitles.has(书名)」可用（任务标题是「导入《书名》」），
  // 所以单独算一遍，判据见 lib/import/job-status.ts。
  const importing = importingTitles(liveJobs);

  const books = await Promise.all(
    textbooks.map(async (t) => {
      const chapters = await store.listChapters(t.id);
      const cards = await store.listCards({ textbookId: t.id });
      const fragments = await store.listFragments(t.id);
      const kps = await store.listKnowledgePoints({ textbookId: t.id });
      const importJobs = await store.listImportJobs(t.id);
      const lastJob = importJobs
        .slice()
        .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
        .at(-1);
      const genInterrupted =
        !!lastJob && lastJob.stage === "generating" && !runningTitles.has(t.title);
      /**
       * 「还在解析」不能只看 finished_at 为空 —— 那样进程一崩就永远显示正在解析。
       * 必须同时满足「库里没写完」与「内存里还有这本书的导入任务在跑」。
       * 两个都为真：确实在处理；否则：上次被打断了，得告诉用户并给出口。
       */
      const importState = bookImportState(lastJob, importing, t.title);
      const processing = importState === "processing";
      const parseInterrupted = importState === "interrupted";

      // 题型按 card_type 分账。旧实现按 is_choice 二分，把填空、判断全算进
      // 「问答」，于是 17 道选择能被显示成 48 道 —— 和统计页对不上。
      const typeCount = countByType(cards);

      const { hotCount, watchCount, reviewCount } = summarizeHot(fragments, statsMap);

      // 每章的卡片数 + 复习次数 + 是否有高频卡点
      // 先建一次「卡片 → 来源片段」索引：旧实现把 listCardSources 放在
      // 「章 × 卡」双层循环里（每章都把全部卡查一遍），10 章 300 张卡就是 3000 次查询，
      // 每次还都要走一遍 store 代理的磁盘同步 —— 资料库页会随书变多越开越慢。
      const cardFragIndex = new Map<string, Set<string>>();
      for (const c of cards) {
        const srcs = await store.listCardSources(c.id);
        cardFragIndex.set(c.id, new Set(srcs.map((s) => s.id)));
      }

      const chaptersWithCards = await Promise.all(
        chapters.map(async (ch) => {
          const frags = fragments.filter((f) => f.chapter_id === ch.id);
          const fragIds = new Set(frags.map((f) => f.id));
          const chCards = cards.filter((c) => {
            const owned = cardFragIndex.get(c.id);
            if (!owned) return false;
            for (const fid of owned) if (fragIds.has(fid)) return true;
            return false;
          });
          let chReviews = 0;
          let chHot = 0;
          for (const f of frags) {
            const s = statsMap.get(f.id);
            if (!s) continue;
            chReviews += s.review_count;
            if (s.hot === 2) chHot++;
          }
          return {
            ...ch,
            cardCount: chCards.length,
            reviewCount: chReviews,
            hotCount: chHot,
          };
        })
      );

      return {
        ...t,
        chapters: chaptersWithCards,
        cardCount: cards.length,
        kpCount: kps.length,
        importJobId: lastJob?.id ?? null,
        genInterrupted,
        processing,
        parseInterrupted,
        draftCount: cards.filter((c) => c.status === "draft").length,
        activeCount: cards.filter((c) => c.status === "active").length,
        masteredCount: cards.filter((c) => c.status === "mastered").length,
        typeCount,
        reviewCount,
        hotCount,
        watchCount,
      };
    })
  );

  const totalCards = books.reduce((a, b) => a + b.cardCount, 0);

  return (
    <>
      <PageHeader
        title="资料库"
        sub={`${books.length} 份材料 · ${totalCards} 张卡`}
        actions={
          <Link href="/import" className="btn-ghost btn-sm px-3">
            导入
          </Link>
        }
      />

      {books.length === 0 && (
        <div className="card px-6 py-12 text-center text-sm text-muted">
          还没有材料。去「
          <Link href="/import" className="text-accent">
            导入材料
          </Link>
          」开始吧。
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/*
         * 每本书原来是一张巨大的卡：标题行 + 元信息行 + 高频区 + 两张类型面板
         * （每张还带 4 条卡片预览）+ 章节列表 —— 一本书占满一屏还多，
         * 五本书要滚很久才能看完。现在：
         *   · 类型面板的预览列表整块删掉（点进去就有列表，没必要在这里重列一遍）
         *   · 状态数字压成一行带标签的文字
         *   · 章节行去掉「2 张卡（0 选择）」这类复合说明
         */}
        {books.map((b) => (
          <div key={b.id} className="card px-4 py-4 md:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium">{b.title}</div>
                <div className="micro mt-1">
                  {b.chapters.length} 章 · {b.cardCount} 张卡 · 累计复习 {b.reviewCount} 次
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link href={`/read/${b.id}`} className="btn-ghost btn-sm">
                  全文
                </Link>
                <DeleteBookButton
                  bookId={b.id}
                  title={b.title}
                  counts={{ chapters: b.chapters.length, cards: b.cardCount }}
                />
              </div>
            </div>

            {/*
             * 全为零的指标不再显示。原来每本书底下都挂着
             * 「待审核 0　复习中 0」，五本书就是一整片零，读起来比不写还累。
             * 只在值得注意时才出现：有待审核就用警示色，有在复习才报数。
             */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] text-muted">
              {TYPE_ORDER.filter(([k]) => b.typeCount.get(k)).map(([k, label]) => (
                <span key={k}>
                  {label} <span className="tabular-nums text-fg/80">{b.typeCount.get(k)}</span>
                </span>
              ))}
              {b.draftCount > 0 && (
                <span className="text-warning">
                  待审核 <span className="tabular-nums">{b.draftCount}</span>
                </span>
              )}
              {b.activeCount > 0 && (
                <span>
                  复习中 <span className="tabular-nums text-fg/80">{b.activeCount}</span>
                </span>
              )}
              {/*
               * 已掌握 = 连过两轮、已出队。这里必须出现一次，否则用户在资料库里
               * 找不到「我到底掌握了多少」，只能进章节一条条数。
               */}
              {b.masteredCount > 0 && (
                <span className="text-accent">
                  已掌握 <span className="tabular-nums">{b.masteredCount}</span>
                </span>
              )}
              {b.hotCount > 0 && (
                <span className="chip bg-danger/15 text-[10px] text-danger">高频 {b.hotCount}</span>
              )}
              {b.watchCount > 0 && (
                <span className="chip bg-warning/15 text-[10px] text-warning">关注 {b.watchCount}</span>
              )}
            </div>

            {/*
             * 0 张卡要说清「为什么」，不能只是一片空白。
             * 纯知识点文档（没有选择题/填空题/判断题可收）导进来必然是 0 张原题，
             * 卡片只能靠 AI 按知识点现出；而这一步是后台异步跑的，
             * 服务重启就会半路断掉 —— 这两件事都得摆在页面上，
             * 再配一个续跑按钮，否则用户看到的就是「11 章 · 0 张卡」然后一头雾水。
             */}
            {b.cardCount === 0 && (
              <div className="mt-3 rounded-xl border border-warning/30 bg-warning/[0.06] px-3 py-2.5">
                <p className="text-[11.5px] leading-relaxed text-fg/85">
                  {b.processing ? (
                    <>
                      <span className="text-accent">正在解析这份材料…</span>
                      已切好 {b.chapters.length} 章，题目正在逐条收录。
                      完成后刷新本页即可看到卡片 —— 现在显示 0 张是还没写完，不是没识别出来。
                    </>
                  ) : b.genInterrupted ? (
                    <>
                      <span className="text-warning">上次的 AI 生成被中断了。</span>
                      材料已入库、{b.kpCount} 条知识点都在，只是卡片还没生成完。
                    </>
                  ) : b.parseInterrupted ? (
                    <>
                      <span className="text-warning">上次的解析被中断了</span>
                      （服务重启或进程退出）。材料已入库、{b.kpCount} 条知识点在，
                      但原文片段与原题可能没收全 —— 这张卡一直显示「正在解析」就是因为它永远等不到结束。
                      {b.kpCount === 0 && "建议删掉这份材料后重新导入一次。"}
                    </>
                  ) : (
                    <>
                      这份材料是知识点正文，
                      <span className="text-fg">没有选择题 / 填空题 / 判断题可收录</span>
                      ，因此原题为 0。卡片需要 AI 按已提炼的 {b.kpCount} 条知识点现出。
                    </>
                  )}
                </p>
                {b.importJobId && !b.processing ? (
                  <div className="mt-2">
                    <BookGenerateButton
                      importJobId={b.importJobId}
                      label={b.genInterrupted ? "继续生成卡片" : `生成卡片（${b.kpCount} 条知识点）`}
                    />
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted">
                    没有生成记录，可从下方章节进到「整章补充出题」。
                  </p>
                )}
              </div>
            )}

            {b.parseInterrupted && b.cardCount > 0 && (
              <p className="mt-3 text-[11px] leading-relaxed text-warning">
                上次解析被中断了，下面这 {b.cardCount} 张只是中断前写进去的一部分。
                缺的题不会自己补回来 —— 需要完整内容请删掉这份材料后重新导入。
              </p>
            )}

            {b.chapters.length > 1 && (
              /*
               * 章节默认折叠。一本 12 章的书展开后是 12 行，
               * 五本书就是六十多行 —— 想看"有哪些书"要滚很久。
               * 章节少于等于 4 章的书直接展开，那种情况下折叠反而多一次点击。
               * 只有 1 章的书不显示这一块：那一章就是整篇，上面的「全文」按钮已经够了。
               * 用原生 <details>，不需要 JS，刷新后状态也不会和服务端冲突。
               */
              <details className="mt-3 border-t border-border pt-1" open={b.chapters.length <= 4}>
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-[11px] text-muted transition hover:text-fg">
                  按章节查看（{b.chapters.length}）
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width={12}
                    height={12}
                    className="chev"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </summary>
                <div className="flex flex-col">
                  {b.chapters.map((ch) => (
                    <Link
                      key={ch.id}
                      href={`/chapter/${ch.id}`}
                      className={`row text-sm transition hover:text-accent ${
                        ch.cardCount === 0 ? "opacity-45" : ""
                      }`}
                    >
                      {/*
                       * 手机上这一行只有 358px，右边两个数字列（N 张 / 复习 N）
                       * 吃掉了 120px，章节标题被截成「三、2026 年经济工…」，
                       * 一排看下去全是一样的开头。
                       * 手机只留卡片数，标题允许两行；桌面恢复单行 + 两列数字。
                       */}
                      <span className="line-clamp-2 min-w-0 flex-1 leading-snug sm:line-clamp-1">
                        {ch.title}
                      </span>
                      {ch.hotCount > 0 && (
                        <span className="chip shrink-0 bg-danger/15 text-[10px] text-danger">
                          高频
                        </span>
                      )}
                      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted">
                        {ch.cardCount} 张
                      </span>
                      <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-muted/60 sm:inline-block">
                        复习 {ch.reviewCount}
                      </span>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
