import Link from "next/link";
import { getStore } from "@/lib/db/store";
import { computeFragmentStats, summarizeHot } from "@/lib/stats/fragment-stats";
import { HighlightTarget } from "@/components/highlight-target";
import { FragmentBody, MarkdownInline, hasVisibleText } from "@/components/fragment-body";
import { FragmentAudit } from "@/components/fragment-audit";
import { segmentRaw, type RawBlock } from "@/lib/read/segment";

export const dynamic = "force-dynamic";

/** 标题行识别（只用于排版，不影响数据）：Markdown 标题 / 数字编号 / 中文章号 */
function headingLevel(line: string): number {
  const t = line.trim();
  if (!t) return 0;
  const md = t.match(/^(#{1,6})\s+/);
  if (md) return md[1].length;
  if (/^第[一二三四五六七八九十百\d]+[章节篇]/.test(t)) return 2;
  const num = t.match(/^(\d+(?:\.\d+)*)[.、]?\s+\S/);
  if (num) return num[1].split(".").length === 1 ? 2 : 3;
  return 0;
}

const normalize = (s: string) => s.replace(/[\s.、#]/g, "");

export default async function ReadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    chapter?: string;
    fragment?: string;
    /** from=review 表示从复习页「去原文查依据」跳来，要显示返回复习的按钮 */
    from?: string;
    /** 刚才那道题的卡 id，用来在返回条上显示题干，方便对照原文 */
    card?: string;
  }>;
}) {
  const { id } = await params;
  const { chapter: chapterParam, fragment: fragmentParam, from, card: cardParam } =
    await searchParams;
  const fromReview = from === "review";
  const store = await getStore();
  const textbook = await store.getTextbook(id);

  if (!textbook) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="page-title">材料不存在</h1>
        <Link href="/library" className="text-accent">
          ← 返回资料库
        </Link>
      </div>
    );
  }

  const [chapters, fragments, cards, statsMap, reviewingCard] = await Promise.all([
    store.listChapters(id),
    store.listFragments(id),
    store.listCards({ textbookId: id }),
    computeFragmentStats(store, id),
    cardParam ? store.getCard(cardParam) : Promise.resolve(null),
  ]);

  const { hotCount, watchCount, reviewCount } = summarizeHot(fragments, statsMap);

  // 原文：新导入的直接用 raw_text；老数据没有原文，就用「章节标题 + 片段」拼出近似全文，
  // 保证页面不空白，并在顶部明确提示建议重新导入。
  const hasRaw = !!textbook.raw_text && textbook.raw_text.trim().length > 0;
  const raw = hasRaw
    ? textbook.raw_text!.replace(/\r\n/g, "\n")
    : chapters
        .map((ch) => {
          const body = fragments
            .filter((f) => f.chapter_id === ch.id)
            .map((f) => f.content)
            .join("\n\n");
          return `${ch.title}\n${body}`;
        })
        .join("\n\n");

  const fragsInOrder = fragments.slice().sort((a, b) => a.fragment_index - b.fragment_index);
  /*
   * 丢掉「只有一条 ---」的片段。
   *
   * 这类片段渲染出来是一条几乎看不见的线，但它仍然是一个 flex 子项 ——
   * article 上的 gap-4 会为它前后各留 16px，页面上就是一块没有内容的空洞。
   * 渲染时用 h-0 藏起来也不够（占位没了，间距还在），只能在分块阶段就剔掉。
   */
  const blocks: RawBlock[] = segmentRaw(raw, fragsInOrder).filter((b) =>
    // text 块常只是片段之间残留的一个 `\n`：没有可见内容，却在 flex 布局里
    // 占一个子项（还会被 gap 放大成一块空洞），直接丢掉；
    // frag 块则连只有 `---` 的也要丢（它渲染出来是一条几乎看不见的线，却带前后间距）。
    b.kind === "text" ? b.text.trim() !== "" : hasVisibleText(b.text)
  );

  // 章节锚点：章标题在原文里可能写成 "8. 系统与网络安全"，库里存的是 "8 系统与网络安全"，
  // 去掉空格/点号后比对。
  const anchorByTitle = new Map<string, string>();
  for (const ch of chapters) anchorByTitle.set(normalize(ch.title), ch.id);

  // 每章第一个片段：章标题行在原文里没匹配到锚点时，退而定位到该章开头
  const chapterFirstFragment: Record<string, string> = {};
  for (const f of fragsInOrder) {
    if (f.chapter_id && !chapterFirstFragment[f.chapter_id]) chapterFirstFragment[f.chapter_id] = f.id;
  }

  return (
    <div className={`flex flex-col gap-6 ${fromReview ? "pb-28" : ""}`}>
      <HighlightTarget
        chapterId={chapterParam}
        fragmentId={fragmentParam}
        chapterFallback={chapterFirstFragment}
      />
      <header className="flex flex-col gap-3">
        {/* 返回类链接用原生 <a>：dev 阶段 Next 重编译后客户端路由的旧 chunk 会静默失效，
            原生跳转对路由状态免疫（代价只是整页加载，对「返回」场景无感）。
            从复习跳来时主返回目标是「刚才那道题」，资料库退成次要链接。 */}
        {fromReview ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a href="/review?resume=1" className="text-sm text-accent hover:underline">
              ← 返回刚才的复习题
            </a>
            <a href="/library" className="text-xs text-muted hover:text-fg">
              资料库
            </a>
          </div>
        ) : (
          <a href="/library" className="text-sm text-muted hover:text-accent">
            ← 返回资料库
          </a>
        )}
        <h1 className="page-title mt-1">{textbook.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
          <span>{chapters.length} 章</span>
          <span>{cards.length} 张卡</span>
          <span>累计复习 {reviewCount} 次</span>
          {hotCount > 0 && (
            <span className="chip bg-danger/15 text-[10px] text-danger">高频 {hotCount}</span>
          )}
          {watchCount > 0 && (
            <span className="chip bg-warning/15 text-[10px] text-warning">关注 {watchCount}</span>
          )}
          {/* 手机上这一行已经有 5 项，导入日期是次要信息，桌面再显示 */}
          <span className="ml-auto hidden text-muted/60 sm:inline">
            {textbook.imported_at
              ? new Date(textbook.imported_at).toLocaleDateString("zh-CN")
              : "—"}
          </span>
        </div>
      </header>

      {fromReview && (
        <div className="rounded-xl bg-accent/[0.06] px-4 py-3 text-xs leading-relaxed text-muted">
          {fragmentParam
            ? "已从复习跳到原文，下面高亮的段落就是这道题的出处。"
            : "已从复习跳到这本书的原文，可用上方章节导航找对应内容。"}
          看完点底部「返回刚才的复习题」，会回到刚才那一题（选项和翻面状态都保留）。
        </div>
      )}

      {!hasRaw && (
        <div className="rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">
          这份材料是旧版本导入的，<strong>原文没有完整保存</strong>，下面只能显示已解析出的{" "}
          {fragments.length} 个知识点片段。重新导入一次即可完整保留原文（卡片与复习记录不受影响）。
        </div>
      )}

      {/* 章节导航：手机上是一条可横向滑动的小标签带（13 章平铺会占掉半屏，
          让人以为正文在很下面）；md 以上恢复成换行平铺，一眼看全。 */}
      {chapters.length > 0 && (
        <nav className="chip-scroll">
          {chapters.map((ch) => (
            <a
              key={ch.id}
              href={`#ch-${ch.id}`}
              className="chip bg-surface-2 text-[11px] text-muted hover:text-fg"
            >
              {ch.title}
            </a>
          ))}
        </nav>
      )}

      {/* 全文 */}
      <article className="card flex flex-col gap-4 p-4 md:p-6">
        {blocks.length === 0 && (
          <div className="text-sm text-muted">这份材料还没有内容。去「导入材料」重新上传看看。</div>
        )}

        {blocks.map((b, bi) => {
          if (b.kind === "text") {
            return (
              <div key={`t-${bi}`} className="flex flex-col gap-3">
                {b.text.split("\n").map((line, li) => {
                  // 标题行去掉 `#` 前缀再显示：`# 2025 年…` 原样渲染时，
                  // 页面上会真的出现一个井号，看着像漏渲染的源码。
                  const bare = line.replace(/^#{1,6}\s*/, "");
                  const inChapter = anchorByTitle.get(normalize(bare));
                  if (inChapter) {
                    return (
                      <h2
                        key={li}
                        id={`ch-${inChapter}`}
                        className="serif mt-6 scroll-mt-24 text-xl font-semibold tracking-tight first:mt-0"
                      >
                        <MarkdownInline text={bare} />
                      </h2>
                    );
                  }
                  const lv = headingLevel(line);
                  if (lv === 1) {
                    return (
                      <div key={li} className="serif mt-4 text-lg font-semibold">
                        <MarkdownInline text={bare} />
                      </div>
                    );
                  }
                  if (lv >= 2) {
                    return (
                      <div key={li} className="mt-4 text-sm font-medium text-fg/90">
                        <MarkdownInline text={bare} />
                      </div>
                    );
                  }
                  // 空行不再单独占位：容器 gap-3 已经给相邻段落留出间距，
                  // 再渲染一个 h-2 只会叠加成空洞（尤其 text 块首尾常有残留 \n）。
                  if (line.trim() === "") return null;
                  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
                    return <hr key={li} className="frag-hr" />;
                  }
                  // 引用块（> 依据……）：去掉尖括号，用左侧细线表示引用
                  if (/^>\s?/.test(line.trim())) {
                    return (
                      <p
                        key={li}
                        className="frag-quote text-sm leading-relaxed text-fg/80"
                      >
                        <MarkdownInline text={line.trim().replace(/^>\s?/, "")} />
                      </p>
                    );
                  }
                  return (
                    <p key={li} className="text-sm leading-relaxed text-fg/80">
                      <MarkdownInline text={line} />
                    </p>
                  );
                })}
              </div>
            );
          }

          const s = statsMap.get(b.frag.id);
          const hot = s?.hot ?? 0;
          // 只有一条 `---` 的片段：留锚点（从审核台定位过来还能跳），但不占高度
          const empty = !hasVisibleText(b.text);
          /*
           * 这排标签只在「这段有卡片」或「这段确实像一道题」时出现。
           * 原来每个片段都挂一枚「暂无卡片」，全书 2300 多枚 —— 既吵，
           * 又会被读成旁边那一段的结论：用户看到 1.1 明明是完整的一问一答，
           * 上面却写着「暂无卡片」，于是以为题目没被识别出来。
           */
          const hasCards = (s?.card_count ?? 0) > 0;
          const looksLikeQuestion =
            /(^|\n)\s*问题\s*[:：]/.test(b.text) ||
            /(^|\n)#{2,4}\s+\d+(?:\.\d+)+\s/.test(b.text);
          const showStats = !empty && (hasCards || looksLikeQuestion);
          return (
            <div
              key={`f-${b.frag.id}`}
              id={`frag-${b.frag.id}`}
              className={
                empty
                  ? "scroll-mt-24"
                  : `scroll-mt-24 rounded-xl border-l-2 pl-3 ${
                      hot === 2
                        ? "border-danger/60 bg-danger/[0.04]"
                        : hot === 1
                          ? "border-warning/50 bg-warning/[0.03]"
                          : "border-transparent"
                    }`
              }
            >
              {empty ? null : <FragmentBody text={b.text} />}

              {showStats ? (
              /* 统计标签与正文之间给一条极浅的分隔线：挤在正文末尾时，
                 用户会把「3 张卡 复习 1 次」当成最后一句话读进去。 */
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5">
                {hasCards && s ? (
                  <>
                    <span className="chip bg-surface-2 text-[11px] text-muted">
                      {s.card_count} 张卡
                    </span>
                    <span className="chip bg-surface-2 text-[11px] text-muted">
                      复习 {s.review_count} 次
                    </span>
                    {s.again_count > 0 && (
                      <span className="chip bg-danger/15 text-[11px] text-danger">
                        没想起来 {s.again_count} 次
                      </span>
                    )}
                    {s.relearn_count > 0 && (
                      <span className="chip bg-warning/15 text-[11px] text-warning">
                        标记重学 {s.relearn_count}
                      </span>
                    )}
                    {hot === 2 && (
                      <span className="chip bg-danger/20 text-[11px] text-danger">高频复习</span>
                    )}
                    {hot === 1 && (
                      <span className="chip bg-warning/15 text-[11px] text-warning">需关注</span>
                    )}
                    <Link
                      href={`/cards?status=all&fragmentId=${b.frag.id}&textbookId=${id}`}
                      className="text-[11px] text-accent opacity-70 hover:opacity-100"
                    >
                      查看这段的卡片 →
                    </Link>
                  </>
                ) : (
                  <Link
                    href={`/cards?status=all&fragmentId=${b.frag.id}&textbookId=${id}`}
                    className="chip bg-warning/10 text-[11px] text-warning"
                  >
                    这段有题 · 还没出卡
                  </Link>
                )}
              </div>
              ) : null}

              {/*
               * 识别核对：只有「这段有卡」或「这段确实像题」才挂。
               * 全文 2000 多个片段全部挂上去，页面会变成一堵按钮墙；
               * 这里用和统计标签同一套判据，保证「看得到标签的地方就能核对」。
               */}
              {showStats && <FragmentAudit fragmentId={b.frag.id} cardCount={s?.card_count ?? 0} />}
            </div>
          );
        })}
      </article>

      <footer className="flex flex-wrap gap-3 pb-4">
        <Link href={`/cards?status=all&textbookId=${id}`} className="btn-ghost px-4 py-2 text-sm">
          审核这本的卡片
        </Link>
        <Link
          href={fromReview ? "/review?resume=1" : "/review"}
          className="btn-primary px-4 py-2 text-sm"
        >
          去复习
        </Link>
        <a href="/library" className="btn-ghost px-4 py-2 text-sm">
          返回资料库
        </a>
      </footer>

      {/*
       * 从复习跳来时的常驻返回键。
       * 全文往往很长，把返回只放在页头/页脚，用户滚到中间就找不到了；
       * 固定在底栏上方，看多久都能一键回到刚才那道题。
       * 用原生 <a> 走整页加载：复习页 mount 时读 ?resume=1 还原快照。
       */}
      {fromReview && (
        <a href="/review?resume=1" className="review-return-bar">
          <span className="block text-sm font-medium text-fg">← 返回刚才的复习题</span>
          {reviewingCard?.front && (
            <span className="mt-0.5 block truncate text-[11px] text-muted">
              刚才那道：{reviewingCard.front}
            </span>
          )}
        </a>
      )}
    </div>
  );
}
