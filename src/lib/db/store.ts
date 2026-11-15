// 数据访问统一接口：本地 JSON 仓库实现。
// 业务层（API 路由 / 页面）只依赖此接口，不关心底层存储细节。
// v3 重构后只保留「卡片复习」域，旧测验域已彻底移除。

import type {
  AnswerFixLog,
  Card,
  CardErrorReport,
  CardFsrsState,
  CardReview,
  Chapter,
  DueCard,
  ID,
  ImportJob,
  KnowledgePoint,
  ReviewSession,
  ReviewSessionCard,
  SourceFragment,
  Textbook,
  TodayStats,
} from "./types";
// 「同一轮复习」的判据（范围三字段）由纯函数模块提供，避免 store 与路由各写一份
import type { ReviewScopeKey } from "@/lib/review/progress";

export interface CardStore {
  ensureSeeded(): Promise<void>;

  // ---- 材料 / 章节 / 知识点 / 片段 ----
  listTextbooks(): Promise<Textbook[]>;
  getTextbook(id: ID): Promise<Textbook | null>;
  createTextbook(t: Omit<Textbook, "id" | "created_at">): Promise<Textbook>;
  /** 删除材料并级联清理章节/片段/卡片/FSRS 状态/复习记录 */
  deleteTextbook(id: ID): Promise<{
    ok: boolean;
    chapters: number;
    fragments: number;
    cards: number;
    reviews: number;
  }>;
  listChapters(textbookId?: ID): Promise<Chapter[]>;
  getChapter(id: ID): Promise<Chapter | null>;
  createChapter(c: Omit<Chapter, "id">): Promise<Chapter>;
  updateChapter(id: ID, patch: Partial<Omit<Chapter, "id">>): Promise<Chapter | null>;
  deleteChapter(id: ID): Promise<boolean>; // 软删除
  listKnowledgePoints(filters?: { chapterId?: ID; textbookId?: ID }): Promise<KnowledgePoint[]>;
  getKnowledgePoint(id: ID): Promise<KnowledgePoint | null>;
  createKnowledgePoint(kp: Omit<KnowledgePoint, "id">): Promise<KnowledgePoint>;
  /** 批量插入知识点，按 id 幂等（已存在跳过，不覆盖） */
  bulkInsertKnowledgePoints(
    rows: Array<Omit<KnowledgePoint, "id"> & { id: ID }>
  ): Promise<{ inserted: number; skipped: number; points: KnowledgePoint[] }>;
  /** 批量标记知识点「已补过一轮题」，返回受影响条数 */
  markKpsGenerated(ids: ID[]): Promise<number>;
  updateKnowledgePoint(id: ID, patch: Partial<Omit<KnowledgePoint, "id">>): Promise<KnowledgePoint | null>;
  deleteKnowledgePoint(id: ID): Promise<boolean>; // 软删除
  listFragments(textbookId?: ID, chapterId?: ID): Promise<SourceFragment[]>;
  createFragment(f: Omit<SourceFragment, "id">): Promise<SourceFragment>;
  /**
   * 批量落片段，只写一次盘。
   * 逐条 createFragment 在 2500 个片段的大材料上要 80 秒（每次全量序列化 + 备份 + rename），
   * 用户会以为导入卡死。
   */
  bulkInsertFragments(rows: Array<Omit<SourceFragment, "id">>): Promise<SourceFragment[]>;

  // ---- 导入任务 ----
  /**
   * id 可指定：导入任务在导入接口里就必须和「内存任务表」用同一个 id，
   * 否则进程重启后前端拿着 jobId 回查数据库查不到，只能判「进度丢了」——
   * 明明 import_jobs 里有 finished_at 与 result_summary。
   */
  createImportJob(
    t: Omit<ImportJob, "id" | "created_at" | "updated_at"> & { id?: ID }
  ): Promise<ImportJob>;
  getImportJob(id: ID): Promise<ImportJob | null>;
  updateImportJob(id: ID, patch: Partial<Omit<ImportJob, "id">>): Promise<ImportJob | null>;
  listImportJobs(textbookId?: ID): Promise<ImportJob[]>;

  // ---- 答案修正审计 ----
  createAnswerFixLogs(
    logs: Array<Omit<AnswerFixLog, "id" | "created_at">>
  ): Promise<AnswerFixLog[]>;
  listAnswerFixLogs(filters?: {
    cardId?: ID;
    trigger?: "user" | "rule";
    limit?: number;
  }): Promise<AnswerFixLog[]>;

  // ---- 出题错误台账 ----
  createCardErrorReports(
    rows: Array<Omit<CardErrorReport, "id" | "created_at" | "status"> & {
      status?: CardErrorReport["status"];
    }>
  ): Promise<CardErrorReport[]>;
  listCardErrorReports(filters?: {
    cardId?: ID;
    textbookId?: ID;
    status?: CardErrorReport["status"];
    kind?: CardErrorReport["kind"];
    limit?: number;
  }): Promise<CardErrorReport[]>;
  updateCardErrorReport(
    id: ID,
    patch: Partial<Omit<CardErrorReport, "id" | "created_at">>
  ): Promise<CardErrorReport | null>;

  // ---- 卡片 ----
  /** 列出卡片，可按状态 / 材料 / 片段 / 章节过滤 */
  listCards(filters?: {
    status?: Card["status"];
    textbookId?: ID;
    fragmentId?: ID;
    chapterId?: ID;
  }): Promise<Card[]>;
  getCard(id: ID): Promise<Card | null>;
  // is_choice 由 options 派生，调用方无需（也可）传
  createCard(
    c: Omit<Card, "id" | "created_at" | "updated_at" | "is_choice"> & { is_choice?: boolean }
  ): Promise<Card>;
  /**
   * 批量幂等插入：id 由调用方按规则算出（材料 + 章节路径 + 题干哈希），
   * 已存在的 id 原样跳过（不覆盖已审核/已复习的卡），只写一次盘。
   */
  bulkInsertCards(
    rows: Array<
      Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: ID; is_choice?: boolean }
    >
  ): Promise<{ inserted: number; skipped: number; cards: Card[] }>;
  /** 只更新元信息（kp_id / needs_answer），不碰状态机字段 */
  patchCardMeta(id: ID, patch: Partial<Pick<Card, "kp_id" | "needs_answer">>): Promise<boolean>;
  updateCard(id: ID, patch: Partial<Omit<Card, "id">>): Promise<Card | null>;
  /**
   * 批量写入 AI 补出来的答案。
   *
   * 为什么不复用 updateCard 循环：每次 updateCard 都会整库落盘（约 5MB JSON +
   * 备份 + rename）。300 张卡就是 300 次全量写，实测能拖到几十秒。这里内存里
   * 一次改完，只落一次盘。返回实际写入张数。
   */
  bulkFillCardAnswers(
    items: Array<{
      id: ID;
      back: string;
      answer: string | null;
      explanation?: string | null;
      /** 答案是否能在原文找到依据 */
      grounded?: boolean;
    }>
  ): Promise<number>;
  /** 审核通过：→ mastered（移出复习队列、不再排期）。缺 FSRS 状态时补一条，已有则原样保留 */
  approveCard(id: ID): Promise<{ card: Card; fsrs: CardFsrsState } | null>;
  /** 审核拒绝：→ active 且 due_at = now（立刻进入今日队列）；缺 FSRS 状态时补一条 */
  rejectCard(id: ID): Promise<{ card: Card; fsrs: CardFsrsState } | null>;
  /**
   * 内容错误：AI 把非题目内容误判成题 → status = invalid。
   * 既不通过也不复习：不是 active，因此 listDueCards / /api/review 都不会拉到它。
   * 数据保留（不软删），便于统计误报率、必要时恢复。
   */
  invalidateCard(id: ID): Promise<Card | null>;
  /** 撤销「内容错误」：invalid → draft，重新回到待审核队列 */
  restoreCard(id: ID): Promise<Card | null>;
  /**
   * 复习毕业：这张卡已连续答对（3 天间隔那一轮也过了）→ status = mastered。
   * 只改卡片状态，不动 FSRS 进度：due_at / stability 原样保留，
   * 卡片因此从 listDueCards、scope=all 里彻底出队，但资料库里仍能看到并标「已掌握」。
   */
  masterCard(id: ID): Promise<boolean>;
  /**
   * 批量审核：一次事务处理 N 张，只写一次盘。
   * 替代前端逐张 POST —— 后者在用户切页时会因 fetch 被 abort 而只生效一部分。
   */
  batchReview(
    ids: ID[],
    action: "approve" | "reject"
  ): Promise<{ ok: number; missing: number; failed: number; due_count: number }>;
  /** 软删除（归档） */
  deleteCard(id: ID): Promise<boolean>;
  listCardSources(cardId: ID): Promise<SourceFragment[]>;
  /** 全部「卡 ↔ 片段」关联，一次拿全（按书聚合用，避免逐卡 N 次查询） */
  listAllCardSources(): Promise<{ card_id: ID; source_fragment_id: ID }[]>;
  linkCardSource(cardId: ID, fragmentId: ID, role?: string): Promise<void>;
  /** 批量关联卡↔片段，只写一次盘 */
  bulkLinkCardSources(
    pairs: Array<{ card_id: ID; source_fragment_id: ID; role?: string }>
  ): Promise<number>;

  // ---- FSRS 状态 ----
  getFsrsState(cardId: ID): Promise<CardFsrsState | null>;
  /** 全部 FSRS 状态，一次拿全（统计/复习聚合用，避免逐卡 N 次查询） */
  listAllFsrsStates(): Promise<CardFsrsState[]>;
  upsertFsrsState(s: CardFsrsState): Promise<void>;

  // ---- 复习会话 ----
  createReviewSession(scope?: Record<string, unknown>): Promise<ReviewSession>;
  getReviewSession(id: ID): Promise<ReviewSession | null>;
  completeReviewSession(id: ID): Promise<void>;
  /**
   * 找「同一范围、还没刷完」的会话，用于跨页面/跨入口续接。
   * 没有则返回 null —— 调用方再开新会话，而不是凭空造一轮空队列。
   */
  findInProgressSession(match: ReviewScopeKey): Promise<ReviewSession | null>;
  /** 最近一轮「当天、未完成」的会话（不分范围）—— 复习页重挂时用它续接 */
  latestInProgressSession(): Promise<ReviewSession | null>;
  /**
   * 当天所有「进行中」的会话，按开始时间倒序。
   *
   * 跨书并行是常态：A 书刷到一半去看 B 书，两轮都该各自留着 —— 选书页要能
   * 一本一本列出「已复习 x/y，继续」，而不是只有最近那一轮。
   */
  listInProgressSessions(): Promise<ReviewSession[]>;
  /** 作废会话（跨天残留 / 被同范围的新会话顶掉），保留数据但不再被续接 */
  abandonReviewSession(id: ID): Promise<void>;
  /**
   * 收尾「同一范围」的其它进行中会话，返回作废条数。
   *
   * 早期这里不区分范围，凡是别的 in_progress 一律作废 —— 于是「A 书刷到第 5 张
   * → 去 B 书看一眼 → 回 A 书」时 A 那轮已被作废，进度凭空消失。
   * 现在只收尾**同范围**的重复轮次（同一本书同一分组的历史残留 / 双标签页），
   * 跨书、跨分组的轮次各自保留，续接时按选中的书取对应那一轮。
   * 数据不删（status=abandoned），只是不再被续接。
   */
  abandonOtherInProgress(keepId: ID, match?: ReviewScopeKey): Promise<number>;
  addSessionCards(sessionId: ID, cardIds: ID[]): Promise<ReviewSessionCard[]>;
  listSessionCards(sessionId: ID): Promise<ReviewSessionCard[]>;
  markSessionCardRated(sessionCardId: ID, reviewId: ID): Promise<void>;

  // ---- 复习事件（追加式）----
  /**
   * 幂等提交：idempotency_key 已存在则返回已有事件，不重复记账。
   * nextState 由调用方传入时直接落库（避免重复排期），不传则在内部补算。
   */
  recordReview(
    r: Omit<CardReview, "id" | "reviewed_at">,
    nextState?: CardFsrsState
  ): Promise<CardReview>;
  getReviewByKey(idempotencyKey: ID): Promise<CardReview | null>;
  /** 会话卡已评过分则返回对应复习事件（服务端幂等第二道护栏） */
  findReviewBySessionCard(sessionCardId: ID): Promise<CardReview | null>;
  listReviews(cardId?: ID, limit?: number): Promise<CardReview[]>;
  /**
   * 某时刻之后的全部复习事件（续接会话时判断「这一轮开始之后这张题答过没」）。
   * 不用 listReviews(cardId) 逐卡查：一轮几百张卡会变成几百次读。
   */
  listReviewsAfter(iso: string): Promise<CardReview[]>;

  // ---- 今日任务 / 统计 ----
  listDueCards(limit?: number): Promise<DueCard[]>;
  /**
   * 今天答错、还没答对的卡（当天可反复重做）。
   *
   * 判据：今天（本地日）这张卡的**最后一次**评分是 1（没想起来）。
   * 不看 due_at —— 答错后到期被压到 10 分钟后，这段时间里它不在到期池里，
   * 但用户明确期待「当天还能再考一次」。
   */
  listTodayRetryCards(limit?: number): Promise<Card[]>;
  getTodayStats(): Promise<TodayStats>;
}

/**
 * 单例必须挂在 globalThis 上，不能用模块级变量。
 *
 * 原因：Next.js 会把页面（RSC）和每个 API 路由分别编译成独立的模块实例，
 * 同一个 Node 进程里 `store.ts` 会被求值多次，模块级 `let _store` 于是变成
 * 「每个模块一份」—— 各自持有一份 LocalStore、一份内存 db 副本。
 * 写接口改了 A 实例的内存，页面读的是 B 实例的旧快照，
 * 这就是用户看到的「数据不同步」。挂到 globalThis 后全进程只有一个实例。
 *
 * 同时记录 LocalStore 的构造器引用：dev 热更新会重新求值模块并产生新类，
 * 只比对构造器就能知道「缓存的是不是上一版代码的实例」，避免继续用旧对象
 * （否则改了 LocalStore 的新方法会报 xxx is not a function，必须手动重启）。
 */
type StoreCache = { ctor: unknown; store: Promise<CardStore> };

const globalForStore = globalThis as typeof globalThis & {
  __studyReviewStore?: StoreCache;
};

export async function getStore(): Promise<CardStore> {
  const { LocalStore } = await import("./localStore");

  const cached = globalForStore.__studyReviewStore;
  if (cached && cached.ctor === LocalStore) return cached.store;

  const store = (async () => {
    // v3 只做纯本地；保留 DATA_BACKEND 抽象以便未来加回云端实现。
    const raw = new LocalStore();
    await raw.ensureSeeded();

    return new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || prop === "syncFromDisk") return value;
        return async (...args: unknown[]) => {
          await target.syncFromDisk();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as CardStore;
  })();

  globalForStore.__studyReviewStore = { ctor: LocalStore, store };
  // 初始化失败（比如数据目录不可写）就清掉缓存，让下次请求能重试而不是永久卡死
  store.catch(() => {
    if (globalForStore.__studyReviewStore?.store === store) {
      globalForStore.__studyReviewStore = undefined;
    }
  });

  return store;
}
