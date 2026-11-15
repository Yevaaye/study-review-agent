import Link from "next/link";
import { getStore } from "@/lib/db/store";
import { computeFragmentStats } from "@/lib/stats/fragment-stats";
import { FragmentBody, hasVisibleText } from "@/components/fragment-body";
import { AnswerText } from "@/components/answer-text";
import { describeKp } from "@/lib/knowledge/display";
import {
  ChapterGenerateButton,
  KpBinder,
  KpGenerateButton,
} from "@/components/chapter-kit";
import { isCorrectOption } from "@/lib/cards/option-match";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  choice: "选择",
  qa: "问答",
  cloze: "填空",
  judge: "判断",
  contrast: "对比",
};

export default async function ChapterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await getStore();
  const chapter = await store.getChapter(id);
  if (!chapter) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="page-title">章节不存在</h1>
        <Link href="/library" className="text-accent">
          ← 返回资料库
        </Link>
      </div>
    );
  }

  const textbook = await store.getTextbook(chapter.textbook_id);
  const fragments = await store.listFragments(chapter.textbook_id, chapter.id);
  const allCards = await store.listCards({ textbookId: chapter.textbook_id });
  const statsMap = await computeFragmentStats(store, chapter.textbook_id);
  const kps = await store.listKnowledgePoints({ chapterId: chapter.id });

  // 找到挂载在本章的卡片
  const fragIds = new Set(fragments.map((f) => f.id));
  const cards: Array<Awaited<ReturnType<typeof store.getCard>> & {
    fsrs: Awaited<ReturnType<typeof store.getFsrsState>>;
  }> = [];
  for (const c of allCards) {
    const srcs = await store.listCardSources(c.id);
    if (srcs.some((s) => fragIds.has(s.id))) {
      const fsrs = await store.getFsrsState(c.id);
      cards.push({ ...c, fsrs });
    }
  }

  // 未关联的原题：题在，但没绑上知识点。单独列一区，允许手动归属（题不丢）
  const kpOptions = kps.map((k) => ({
    id: k.id,
    statement: k.statement ?? k.title,
  }));
  const unbound = cards.filter(
    (c) => c.source === "original" && !c.kp_id && c.status === "draft"
  );

  const activeCount = cards.filter((c) => c.status === "active").length;
  const draftCount = cards.filter((c) => c.status === "draft").length;
  const masteredCount = cards.filter((c) => c.status === "mastered").length;
  const reviewTotal = fragments.reduce((a, f) => a + (statsMap.get(f.id)?.review_count ?? 0), 0);

  /*
   * 保真核对统计：这一章的题，有多少字面来自原文、多少对不上。
   *
   * 数字放在知识点区顶部，是因为「抽取精确」这件事必须一眼可见 ——
   * 如果只有出问题时才提示，用户永远不知道自己看到的是全部都对，还是有 3 张被改写。
   */
  const aiCards = cards.filter((c) => c.source === "ai_generated");
  const originalCount = cards.length - aiCards.length;
  const fidExact = cards.filter((c) => c.fidelity_status === "exact").length;
  const fidPartial = cards.filter((c) => c.fidelity_status === "partial").length;
  const fidMissing = cards.filter((c) => c.fidelity_status === "missing").length;
  const hasFidelity = fidExact + fidPartial + fidMissing > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link href="/library" className="text-sm text-muted hover:text-accent">
            ← 返回资料库
          </Link>
          <h1 className="page-title">{chapter.title}</h1>
          <p className="text-muted">
            {textbook?.title ?? "未知材料"} · 第 {chapter.sort_order + 1} 章 · 累计复习 {reviewTotal} 次
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 核对要能离开屏幕做：导出成 Markdown，按章节 → 知识点 → 题目摊平 */}
          <a
            href={`/api/outline?chapterId=${chapter.id}`}
            className="btn-ghost shrink-0 px-4 py-2 text-sm"
            title="导出「章节 → 知识点 → 题目」清单，含原文依据与保真状态"
          >
            导出核对清单
          </a>
          <Link
            href={`/read/${chapter.textbook_id}?chapter=${chapter.id}`}
            className="btn-ghost shrink-0 px-4 py-2 text-sm"
          >
            在全文里看 →
          </Link>
        </div>
      </header>

      {/*
       * 知识点清单：这一章到底要记住几件事。
       * 它是「出题」的锚点 —— 每条都能单独补题，补出来的卡挂在这条知识点上。
       * evidence 是模型从原文摘的短语，用来核对这条陈述有没有原文依据。
       */}
      <section className="flex flex-col gap-2">
        {/* 手机上标题与按钮各占一行：并排时按钮会把「知识点（4 条）· 共 11 张卡」挤成两行 */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
          <h2 className="text-sm font-medium text-muted">
            知识点（{kps.length} 条）
            {cards.length > 0 && (
              <span className="ml-2 text-xs text-muted/70">
                共 {cards.length} 张卡
              </span>
            )}
          </h2>
          <ChapterGenerateButton chapterId={chapter.id} hasKps={kps.length > 0} />
        </div>

        {/* 核对条：原文逐字 / 部分匹配 / 未找到 / AI 生成。没有这行，
            「这一章的题到底可不可信」就只能靠逐张点开猜。 */}
        {cards.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5 text-muted">
            {originalCount > 0 &&
              (hasFidelity ? (
                <>
                  <span title="题干、选项、答案均可在原文逐字找到">
                    原文逐字 <span className="tabular-nums text-fg/75">{fidExact}</span>
                  </span>
                  {fidPartial > 0 && (
                    <span className="text-warning" title="部分内容在原文里查不到，多为多行拼接或排版差异">
                      部分匹配 <span className="tabular-nums">{fidPartial}</span>
                    </span>
                  )}
                  {fidMissing > 0 && (
                    <span className="text-danger" title="大面积在原文里查不到，疑似被改写，需重点核对">
                      原文未找到 <span className="tabular-nums">{fidMissing}</span>
                    </span>
                  )}
                </>
              ) : (
                <span title="这些题是早期导入的，没做过保真核对">未做保真核对</span>
              ))}
            {aiCards.length > 0 && (
              <span title="按知识点由 AI 生成，依据已回原文校验才允许入库">
                AI 生成 <span className="tabular-nums text-fg/75">{aiCards.length}</span>
              </span>
            )}
          </div>
        )}

        {kps.length === 0 ? (
          <div className="card px-4 py-5 text-sm leading-relaxed text-muted">
            本章没有提炼出知识点 —— 通常是这一章只有题目、没有可归纳的正文。
            导入时知识点按小节标题自动提炼（不花钱、不依赖模型）；
            如果这一章确实有正文却被判空了，点右上角「生成知识点与题目」让 AI 从原文再提炼一遍。
          </div>
        ) : (
          <div className="flex flex-col">
            {kps.map((k, i) => {
              const boundCards = cards.filter((c) => c.kp_id === k.id);
              const bound = boundCards.length;
              /*
               * 有些知识点是从表格行 / 题组表头提炼出来的，陈述里混着
               * `# / 题目 / 难度 / 状态：1 / ⭐⭐ / ✅ 完整` 这类字段。
               * 原样铺成一行是「一坨字」，这里拆成主句、键值对、元信息标签三层。
               */
              const view = describeKp(k.statement ?? k.title, k.evidence);
              return (
                <div key={k.id} className="row items-start gap-3 py-3">
                  <span className="mt-0.5 w-5 shrink-0 text-[11px] tabular-nums text-muted/70">
                    {i + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {view.main && (
                      <div
                        className={
                          view.dim
                            ? "text-[12px] leading-relaxed text-muted"
                            : "text-sm leading-relaxed text-fg/90"
                        }
                      >
                        {view.main}
                      </div>
                    )}

                    {view.fields.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {view.fields.map((f) => (
                          <div key={`${f.label}-${f.value}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="shrink-0 text-[11px] leading-5 text-muted">
                              {f.label}
                            </span>
                            <span className="min-w-0 text-[13px] leading-relaxed text-fg/85">
                              {f.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {view.meta.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {view.meta.map((m) => (
                          <span key={`${m.label}-${m.value}`} className="chip bg-surface-2 text-[10px] text-muted">
                            {m.label} {m.value}
                          </span>
                        ))}
                      </div>
                    )}

                    {view.evidence && (
                      /* 手机上原文依据一行只能放 20 来个字，等于没给。
                         放开两行，短句完整显示，长句也能看出在讲什么。 */
                      <div className="line-clamp-2 text-[11px] leading-relaxed text-muted/80">
                        原文：{view.evidence}
                      </div>
                    )}

                    {/*
                     * 题目清单：把「这条知识点下面到底有哪些题」摊开。
                     * 原来只显示「N 张」，用户没法核对「这个知识点的题是不是都对着它出的」——
                     * 而「题目必须与所属知识点一致、范围对应」正是要靠这一步人工确认的。
                     * 默认折叠：知识点多的时候全展开是一堵墙。
                     */}
                    {bound > 0 && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-[11px] leading-5 text-muted hover:text-accent">
                          题目清单（{bound} 道）
                        </summary>
                        <ol className="mt-1.5 flex flex-col gap-1.5 border-l border-line/60 pl-2.5">
                          {boundCards.map((c) => (
                            <li key={c.id} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                              <span className="shrink-0 text-[11px] tabular-nums text-muted/70">
                                {c.question_no != null ? `${c.question_no}.` : "·"}
                              </span>
                              <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-fg/80">
                                {c.front.length > 72 ? `${c.front.slice(0, 72)}…` : c.front}
                              </span>
                              <span className="chip bg-surface-2 text-[10px] text-muted">
                                {TYPE_LABEL[c.card_type ?? (c.kind === "choice" ? "choice" : "qa")] ??
                                  "问答"}
                              </span>
                              {c.source === "ai_generated" && (
                                <span className="chip bg-accent/10 text-[10px] text-accent">AI</span>
                              )}
                              {c.fidelity_status === "missing" && (
                                <span className="chip bg-danger/15 text-[10px] text-danger">
                                  原文未找到
                                </span>
                              )}
                              {c.fidelity_status === "partial" && (
                                <span className="chip bg-warning/15 text-[10px] text-warning">
                                  部分匹配
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                  <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted">
                    {bound > 0 ? `${bound} 张` : "—"}
                  </span>
                  <KpGenerateButton chapterId={chapter.id} kpId={k.id} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/*
       * 未关联池：原题没能绑上知识点的，题不丢，这里手动归属。
       * 只列 draft —— 已经审核过的卡不该再被改动归属。
       * 没有任何知识点时不显示：没有可归属的目标，这一区只会变成一堵墙。
       */}
      {unbound.length > 0 && kpOptions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-warning">
            未关联知识点（{unbound.length} 题）
          </h2>
          <p className="micro">这些题原文里有，但没能自动对应到知识点。选一个归属即可，题本身不会丢。</p>
          <div className="flex flex-col gap-2">
            {unbound.map((c) => (
              <div key={c.id} className="card flex flex-wrap items-center gap-3 p-3">
                <span className="min-w-0 flex-1 text-sm leading-relaxed">
                  {c.question_no ? (
                    <span className="mr-2 tabular-nums text-muted">{c.question_no}.</span>
                  ) : null}
                  {c.front}
                </span>
                <KpBinder cardId={c.id} kps={kpOptions} current={c.kp_id ?? null} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 知识点片段（原文）+ 复习标注 */}
      {fragments.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted">知识点（原文片段）</h2>
          {/* 只有一条 `---` 的片段会渲染成一张空卡，直接不列 */}
          {fragments.filter((f) => hasVisibleText(f.content)).map((f) => {
            const s = statsMap.get(f.id);
            const hot = s?.hot ?? 0;
            return (
              <div
                key={f.id}
                className={`card p-4 ${
                  hot === 2
                    ? "border-danger/40"
                    : hot === 1
                      ? "border-warning/30"
                      : ""
                }`}
              >
                {/* 头部拆三行：出处（一行，过长省略）、统计标签（一行）、正文。
                    原来 locator 与「N 张卡 / 复习 N 次 / 定位原文」挤在同一行 flex-wrap 里，
                    手机上一换行就变成三层错位的碎片，看着很乱。 */}
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted/80">
                    {f.locator}
                  </span>
                  <Link
                    href={`/read/${chapter.textbook_id}#frag-${f.id}`}
                    className="shrink-0 text-[11px] text-accent hover:underline"
                  >
                    定位原文 →
                  </Link>
                </div>
                {s && s.card_count > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="chip bg-surface-2 text-[11px]">{s.card_count} 张卡</span>
                    <span className="chip bg-surface-2 text-[11px]">复习 {s.review_count} 次</span>
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
                  </div>
                )}
                <FragmentBody text={f.content} className="mt-3" />
              </div>
            );
          })}
        </section>
      )}

      {/* 复习题卡片 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">
            复习题（{cards.length} 张 · {activeCount} 在复习
            {masteredCount > 0 && ` · ${masteredCount} 已掌握`}
            {draftCount > 0 && ` · ${draftCount} 待审核`}）
          </h2>
          <Link
            href={`/cards?status=all&chapterId=${chapter.id}&textbookId=${chapter.textbook_id}`}
            className="text-xs text-accent"
          >
            去审核 →
          </Link>
        </div>

        {cards.length === 0 && (
          <div className="card p-6 text-center text-sm text-muted">
            本章还没有复习题。去「<Link href="/import" className="text-accent">导入材料</Link>」生成，或在审核台审核草稿。
          </div>
        )}

        {cards.map((c) => {
          const isChoice = c.is_choice;
          return (
            <div key={c.id} className="card flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`chip ${isChoice ? "bg-accent/15 text-accent" : "bg-surface-2"}`}>
                      {TYPE_LABEL[c.card_type ?? (isChoice ? "choice" : "qa")] ??
                        (isChoice ? "选择题" : "问答")}
                    </span>
                    {c.source === "original" && (
                      <span className="chip bg-surface-2 text-[11px] text-muted">原题</span>
                    )}
                    {c.needs_answer && (
                      <span className="chip bg-warning/15 text-[11px] text-warning">缺答案</span>
                    )}
                    <span className="font-medium">{c.front}</span>
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    <AnswerText text={c.back ?? ""} />
                  </div>
                  {isChoice && c.options && c.options.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1 text-xs">
                      {c.options.map((opt, i) => {
                        const isAnswer = isCorrectOption(
                          opt,
                          c.answer,
                          i,
                          c.options?.length ?? 0,
                          c.options
                        );
                        return (
                          <li
                            key={i}
                            className={`flex gap-2 rounded px-2 py-1 ${
                              isAnswer ? "bg-success/10 text-success" : "text-muted"
                            }`}
                          >
                            <span className="font-mono">{String.fromCharCode(65 + i)}</span>
                            <span>{opt}</span>
                            {isAnswer && <span className="ml-auto text-[11px]">正确答案</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <span
                  className={`chip shrink-0 ${
                    c.status === "active"
                      ? "bg-success/15 text-success"
                      : c.status === "mastered"
                        ? "bg-accent/15 text-accent"
                        : c.status === "invalid"
                          ? "bg-warning/15 text-warning"
                          : c.status === "rejected"
                            ? "bg-danger/15 text-danger"
                            : "bg-surface-2"
                  }`}
                >
                  {c.status === "active"
                    ? "复习中"
                    : c.status === "mastered"
                      ? "已掌握"
                      : c.status === "invalid"
                        ? "内容错误"
                        : c.status === "rejected"
                          ? "已拒绝"
                          : "待审核"}
                </span>
              </div>
              {c.fsrs && (
                <div className="text-[11px] text-muted">
                  已复习 {c.fsrs.reps} 次 · 遗忘 {c.fsrs.lapses} 次 · 难度{" "}
                  {c.fsrs.difficulty.toFixed(1)} ·{" "}
                  {/*
                   * 已掌握的卡已经出队，再报一个「下次 X 月 X 日」会让人以为它还会
                   * 回来复习。这里直接说明它不再排期，日期只在「复习中」时才显示。
                   */}
                  {c.status === "mastered"
                    ? "已掌握，不再排期"
                    : c.status === "invalid"
                      ? "内容错误，已作废不排期"
                      : `下次 ${new Date(c.fsrs.due_at).toLocaleDateString("zh-CN")}`}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
