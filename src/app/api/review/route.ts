import { resolveCardOrigins } from "@/lib/cards/origin";
import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import { normalizeScope, type ReviewScopeKey } from "@/lib/review/progress";
import { loadSessionCardsWithProgress } from "@/lib/review/session";

export const dynamic = "force-dynamic";

/**
 * 续接一轮没刷完的会话。
 *
 * 为什么要有这个分支：复习页是纯客户端状态机，用户一旦「去原文 → 卡片 → 复习」
 * 这样绕着回来，组件重挂就会 POST 一个全新会话，进度从 1/N 重新数 ——
 * 用户看到的是「我已经答了 5 题，怎么又要从头答」。
 *
 * 续接的真相只认服务端：review_session_cards.rated 是唯一可靠的「答过没答过」，
 * 客户端快照只用来还原「刚才停在哪一题」这种体验细节。
 */
async function resumeSession(store: Awaited<ReturnType<typeof getStore>>, scope: ReviewScopeKey) {
  const existing = await store.findInProgressSession(scope);
  if (!existing) return null;
  // 与「真实作答事实」对齐：别的会话里答过的题不再推给用户
  const rows = await loadSessionCardsWithProgress(store, existing);
  if (rows.length === 0) {
    await store.abandonReviewSession(existing.id);
    return null;
  }
  let origins: Record<string, unknown> = {};
  try {
    origins = await resolveCardOrigins(
      store,
      rows.map((r) => r.card_id),
      scope.textbook_id
    );
  } catch {
    origins = {};
  }
  return Response.json({
    session: existing,
    cards: rows,
    total: rows.length,
    matched: rows.length,
    origins,
    resumed: true,
  });
}

// 开始复习：创建会话 + 拉入卡片。
// 默认只拉「今日到期」卡；scope=all 时拉所有 active 卡（用于「再复习一轮」）。
// body.textbookId 可限定只复习某一本书的卡（今日复习页的书籍选择器）。
// body.resume=true 时优先续接同范围、当天、未完成的会话（不新建）。
export async function POST(req: Request) {
  try {
    let scope: Record<string, unknown> | null = null;
    let body: Record<string, unknown> = {};
    try {
      body = (await readJSON(req)) as Record<string, unknown>;
    } catch {
      // 无 body 时按默认处理
    }

    const store = await getStore();
    const wantAll = body.scope === "all";
    /**
     * scope="retry" = 今天答错、还没答对的题。
     *
     * 不并进 due：答错后 FSRS 把到期压到 10 分钟后，这段时间它不在到期池里，
     * 用户点「重做今天答错的题」必须立刻能拿到，不能等 10 分钟。
     */
    const wantRetry = body.scope === "retry";
    /**
     * 分组筛选（可选）：今日队列里混着两类卡 ——
     *   "due"  只复习「学过、按排期今天到期」的（reps > 0）
     *   "new"  只学「从没学过」的新卡（reps = 0）
     * 首页两个入口用它把两类拆开刷；不传则沿用原来的一整轮。
     */
    const group = body.group === "due" || body.group === "new" ? body.group : null;
    const textbookId =
      typeof body.textbookId === "string" && body.textbookId.trim() ? body.textbookId.trim() : null;

    const scopeKey: ReviewScopeKey = normalizeScope({
      mode: wantRetry ? "retry" : wantAll ? "all" : "due",
      group,
      textbook_id: textbookId,
    });

    // 续接优先于新建：只有明确要「再来一轮」的调用方才不传 resume
    if (body.resume === true) {
      const resumed = await resumeSession(store, scopeKey);
      if (resumed) return resumed;
    }

    // 候选池：今日到期（默认）或全部 active（再复习一轮）。
    //
    // 上限只是防病态数据（几千张卡一次拉入会撑大响应体与 review_session_cards）。
    // 原来写 200 太小：把整本书推入队列后今日到期 494 张，「全部材料」只拉进
    // 200 张，剩下 294 张无论怎么点都轮不到，且各书分布还显示「无到期」。
    const REVIEW_POOL_LIMIT = 1000;
    // 扫描上限：过滤必须作用在全量上，否则 group / 按书筛选会作用在已截断的
    // 前 N 条上 —— 例如「只看新卡」时前 200 条全是老卡，就会直接返回空。
    const SCAN_LIMIT = 20000;

    // 按书复习时先取该书卡号集，避免被全局候选池上限截断
    const bookCardIds = textbookId
      ? new Set((await store.listCards({ textbookId })).map((c) => c.id))
      : null;

    let pool: { id: string }[];
    let matched = 0;
    if (wantRetry) {
      let cards = await store.listTodayRetryCards(SCAN_LIMIT);
      if (bookCardIds) cards = cards.filter((c) => bookCardIds.has(c.id));
      matched = cards.length;
      pool = cards.slice(0, REVIEW_POOL_LIMIT).map((c) => ({ id: c.id }));
    } else if (wantAll) {
      let cards = await store.listCards({ status: "active" });
      if (bookCardIds) cards = cards.filter((c) => bookCardIds.has(c.id));
      matched = cards.length;
      pool = cards.slice(0, REVIEW_POOL_LIMIT).map((c) => ({ id: c.id }));
    } else {
      let candidates = await store.listDueCards(SCAN_LIMIT);
      if (group) {
        candidates = candidates.filter((d) => (group === "new" ? d.reps === 0 : d.reps > 0));
      }
      if (bookCardIds) {
        candidates = candidates.filter((d) => bookCardIds.has(d.card_id));
      }
      matched = candidates.length;
      pool = candidates.slice(0, REVIEW_POOL_LIMIT).map((d) => ({ id: d.card_id }));
    }
    const cardIds = pool.map((c) => c.id);

    if (cardIds.length === 0) {
      /**
       * 池子空 = 今天已经复习过，不是错误。
       *
       * 原来这里抛 400，前端把它当失败渲染成红色告警「今天没有到期复习的卡片」，
       * 用户刚刷完一轮、切回来又被判红，读起来像「我的进度出问题了」。
       * 现在回 200 + empty 标记，前端按正常状态展示（书籍列表 + 已复习）。
       */
      const message = wantRetry
        ? "今天答错的题都答对了"
        : textbookId && (bookCardIds?.size ?? 0) === 0
          ? "这本书还没有卡片"
          : wantAll
            ? "还没有可复习的卡片"
            : group === "new"
              ? "新卡都学过了"
              : "今天已复习";
      return Response.json({
        empty: true,
        message,
        session: null,
        cards: [],
        total: 0,
        matched: 0,
        origins: {},
      });
    }

    scope = { ...scopeKey };
    // 同一范围若还挂着旧会话（换过书 / 上一轮点了「再复习一轮」但没刷完），
    // 先收尾再开新的：否则库里会堆一串 in_progress，续接时永远命中最早那条。
    const stale = await store.findInProgressSession(scopeKey);
    if (stale) await store.abandonReviewSession(stale.id);
    const session = await store.createReviewSession(scope);
    const sessionCards = await store.addSessionCards(session.id, cardIds);
    /**
     * 顺带解析每张卡在原文里的落点，供复习页「去原文查依据」用。
     * 放在开始会话时一次算完，翻卡时不再发请求；按书复习时把该书的 id
     * 传下去作兜底，让没有来源关联的老卡至少也能打开这本书的全文。
     * 解析失败不影响开会话本身（origins 为空时前端只是不显示按钮）。
     */
    let origins: Record<string, unknown> = {};
    try {
      origins = await resolveCardOrigins(store, cardIds, textbookId);
    } catch {
      origins = {};
    }
    return Response.json(
      {
        session,
        cards: sessionCards,
        total: cardIds.length,
        // matched = 符合条件的总数；只有它大于 total 才说明被 REVIEW_POOL_LIMIT 截断
        matched,
        origins,
        resumed: false,
      },
      { status: 201 }
    );
  } catch (e) {
    return errorResponse(e, "开始复习失败");
  }
}
