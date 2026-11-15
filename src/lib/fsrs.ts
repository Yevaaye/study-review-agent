// FSRS 调度层：封装 ts-fsrs v6（默认 FSRS-7）。
//
// 为什么单独抽一层，而不是让 store 直接 import ts-fsrs：
// 1) ts-fsrs 的 Card 状态对象字段是 camelCase（stabilityFast / dueAt / lastReviewAt /
//    scheduledDays / learningStep），而我们的数据库/类型用 snake_case（card_fsrs_states
//    表）。这一层负责两者互转，store 只认我们自己的 CardFsrsState 类型。
// 2) 版本锁定：scheduler 实例固定 FSRS-7 + 默认参数，避免 ts-fsrs 升级后历史卡片
//    状态语义漂移。升级 ts-fsrs 时必须同步 bump params_version 并做迁移。
// 3) 纯函数：schedule() 不读写任何 IO，便于单测「Again 缩短、Easy 拉长」这类断言。

import { DefaultScheduler, Rating, type DefaultSchedulerCard } from "ts-fsrs";
import type { CardFsrsState } from "./db/types";
import { FsrsState } from "./db/types";

// ts-fsrs 的 scheduleStatus 字面量收窄成 "new"|"learning"|"review"，但实际可能产生
// "relearning"。这里放宽为本模块内可用的字符串类型，避免字面量断言反复报错。
type ScheduleStatus = CardFsrsState["schedule_status"];

// 调度参数版本标识：当 ts-fsrs 版本或 FSRS 参数变化时更新此值，
// 使历史卡片的 card_fsrs_states.params_version 能追溯到当时的调度口径。
export const FSRS_VERSION = "FSRS-7";
export const SCHEDULER_VERSION = "ts-fsrs@6";
// v2：间隔重新交给 FSRS（带增长封顶），新增 lapse 后强制次日复查
export const PARAMS_VERSION = "default-v2";

// Rating 数值 → 可读名（对齐 db/types.ts 的 Rating 枚举）
export const RATING_LABEL: Record<number, string> = {
  [Rating.Again]: "没想起来",
  [Rating.Hard]: "想起但费力",
  [Rating.Good]: "正常想起",
  [Rating.Easy]: "轻松想起",
};

// state 数值 → 可读名（对齐 State 枚举 New=0 Learning=1 Review=2 Relearning=3）
export const STATE_LABEL: Record<number, string> = {
  0: "新卡",
  1: "学习中",
  2: "复习",
  3: "重学",
};

// ts-fsrs 的 Card → 我们的 CardFsrsState（去掉 cardId，补版本字段）。
// 入参用宽松结构类型：newCard/review 返回的 card 可能是联合类型的不同成员
// （FSRS-6 无 stabilityFast / FSRS-7 有），这里统一按可选字段读取。
type FsrsCardLike = {
  stability: number;
  stabilityFast?: number;
  difficulty: number;
  state: number;
  scheduleStatus: string;
  dueAt: Date | string;
  lastReviewAt: Date | string | null;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
};

export function toFsrsState(card: FsrsCardLike, cardId: string): CardFsrsState {
  return {
    card_id: cardId,
    stability: card.stability,
    stability_fast: card.stabilityFast ?? 0,
    difficulty: card.difficulty,
    state: card.state,
    schedule_status: card.scheduleStatus as ScheduleStatus,
    scheduled_days: card.scheduledDays,
    learning_step: card.learningStep,
    reps: card.reps,
    lapses: card.lapses,
    due_at: card.dueAt instanceof Date ? card.dueAt.toISOString() : String(card.dueAt),
    last_review_at:
      card.lastReviewAt == null
        ? null
        : card.lastReviewAt instanceof Date
          ? card.lastReviewAt.toISOString()
          : String(card.lastReviewAt),
    fsrs_version: FSRS_VERSION,
    scheduler_version: SCHEDULER_VERSION,
    params_version: PARAMS_VERSION,
  };
}

// 我们的 CardFsrsState → ts-fsrs 的 Card（调度输入）。
// 注意：cardId 用我们的 card_id 回填，保证 revlog 里能对上。
// DefaultSchedulerCard 是联合类型（FSRS-6 无 stabilityFast / FSRS-7 有），
// 且 state/scheduleStatus 字面量较窄。这里构造完整 FSRS-7 形状后整体断言。
export function fromFsrsState(state: CardFsrsState): DefaultSchedulerCard {
  return {
    stability: state.stability,
    stabilityFast: state.stability_fast,
    difficulty: state.difficulty,
    state: state.state,
    scheduleStatus: state.schedule_status,
    dueAt: new Date(state.due_at),
    lastReviewAt: state.last_review_at ? new Date(state.last_review_at) : null,
    cardId: state.card_id,
    reps: state.reps,
    lapses: state.lapses,
    scheduledDays: state.scheduled_days,
    learningStep: state.learning_step,
  } as DefaultSchedulerCard;
}

let _scheduler: Awaited<ReturnType<typeof DefaultScheduler>> | null = null;

// 全局单例 scheduler（DefaultScheduler 是异步创建，需缓存）。
async function getScheduler() {
  if (_scheduler) return _scheduler;
  _scheduler = await DefaultScheduler({
    version: "FSRS-7",
    desiredRetention: 0.9,
    enableShortTerm: true,
    enableFuzz: false,
    maximumInterval: 36_500,
  });
  return _scheduler;
}

// 新卡：返回一张尚未复习的卡片状态（dueAt = 现在，state = New）。
export async function newCardState(cardId: string, now: Date = new Date()): Promise<CardFsrsState> {
  const s = await getScheduler();
  return toFsrsState(s.newCard({ now }), cardId);
}

export interface ScheduleResult {
  card: CardFsrsState; // 评分后的新状态
  revlog: {
    rating: number;
    state: number;
    reviewTime: string;
    scheduledDays: number;
  };
  /** true = 这一轮答对，这张卡毕业：调用方把 card.status 置为 mastered，移出复习队列 */
  mastered: boolean;
}

/**
 * 复习节奏（2026-11 重做，取代此前那张固定的 0/1/3/3 表）。
 *
 * 规则（用户口径）：
 *   没想起来 Again(1) → **当天**再来一次（10 分钟后到期，会话里也会立刻回到队尾），
 *                       并且**第二天还会再考一遍**
 *   想起但费力 Hard(2) → 次日
 *   正常想起 Good(3)   → 交给 FSRS 算，间隔按 3 天 → 7 天 → 16 天 → 38 天 … 递增
 *   轻松想起 Easy(4)   → 同 Good，但起点和增速都更高
 *
 * 为什么还要「封顶增速」而不是完全听 FSRS 的：
 *   1) FSRS-7 默认参数（desiredRetention 0.9）对中文题库这种短问答题给出的间隔非常激进 ——
 *      实测第一轮 Good 就是 4.8 天，第二轮直接 26 天，第三轮 92 天。对备考来说，
 *      「16 天后才复习」才是能接受的节奏，26 天已经脱离考试周期。
 *   2) 所以这里保留 FSRS 的记忆强度模型（stability / difficulty / lapses 照常推进，
 *      统计页和「记了多久」仍然真实），只把**输出间隔**限制在每轮最多 ×2.4（Good）/
 *      ×3.5（Easy），起点 Good=3 天、Easy=5 天。这样得到的序列正好是 3 → 7 → 16 → 38。
 *   3) 想完全交给模型时，把 GOOD_GROWTH / EASY_GROWTH 调大（或删掉 clamp）即可。
 *
 * 答错的卡怎么保证「当天 + 次日」都复习到：
 *   · 当天：rating=1 时不排到未来，due_at = 现在 + RELEARN_MINUTES，立刻回到今日队列；
 *           同时前端把这卡追加到本轮队尾，本轮内就能再答一次。
 *   · 次日：只要「上一轮评分是 Again」，这张卡下一次答对后的间隔强制压到 1 天 ——
 *           哪怕当天补答对了，也不允许跳回 3 天起（lapse 后必须隔天再验一次）。
 */
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Again 之后多久重新进入今日队列（对齐常见 relearning step，10 分钟） */
export const RELEARN_MINUTES = 10;

/** 第一轮（此前没有任何间隔）答对时的天数 */
const FIRST_GOOD_DAYS = 3;
const FIRST_EASY_DAYS = 5;

/** 每轮间隔的增长上限：Good ×2.4 → 3/7/16/38；Easy ×3.5 → 5/17/59 */
const GOOD_GROWTH = 2.4;
const EASY_GROWTH = 3.5;

/** 间隔达到这个天数 = 记住了，卡片毕业（移出复习排期，只是不再排期，历史都留着） */
export const MASTER_INTERVAL_DAYS = 60;

/** 上一轮评分是不是 Again —— 用 last_lapse_at 与 last_review_at 是否同一时刻判断 */
function lastRatingWasAgain(current: CardFsrsState): boolean {
  if (!current.last_lapse_at || !current.last_review_at) return false;
  const lapse = new Date(current.last_lapse_at).getTime();
  const review = new Date(current.last_review_at).getTime();
  if (Number.isNaN(lapse) || Number.isNaN(review)) return false;
  return Math.abs(lapse - review) < 1000;
}

/**
 * 这一轮之后隔多少天再出现。
 * @param fsrsDays FSRS 依据记忆强度算出的间隔（可能非常激进，要封顶）
 */
function nextIntervalDays(current: CardFsrsState, rating: number, fsrsDays: number): number {
  // 费力 = 次日，不参与增长（用户口径就是这样，连续费力也不会被拉长）
  if (rating === 2) return 1;

  // 上一轮答错 → 这次答对也先只隔 1 天：错过的题必须隔天再确认一次
  if (lastRatingWasAgain(current)) return 1;

  const prev = current.scheduled_days > 0 ? current.scheduled_days : 0;
  const cap =
    prev === 0
      ? rating === 4
        ? FIRST_EASY_DAYS
        : FIRST_GOOD_DAYS
      : prev * (rating === 4 ? EASY_GROWTH : GOOD_GROWTH);

  const fromFsrs = Math.max(1, Math.round(fsrsDays));
  // cap 用 floor：3 → 7.2→7 → 16.8→16 → 38.4→38，正好是期望的序列
  const limit = Math.max(1, Math.floor(cap));
  return Math.min(fromFsrs, limit);
}

/**
 * 毕业判据：这一轮答对，且新间隔已经到 MASTER_INTERVAL_DAYS（默认 60 天）。
 * 「答对两次就毕业」的旧规则已废弃 —— 那会让 3→7→16 的递增根本没机会发生。
 */
export function shouldMaster(rating: number, nextDays: number): boolean {
  return rating >= 3 && nextDays >= MASTER_INTERVAL_DAYS;
}

// 评分调度：输入当前状态 + 评分 → 输出新状态 + revlog。
// rating ∈ {1,2,3,4}（Again/Hard/Good/Easy）。不读写 IO，纯计算。
export async function schedule(
  current: CardFsrsState,
  rating: number,
  now: Date = new Date()
): Promise<ScheduleResult> {
  const s = await getScheduler();

  // 始终以「长期复习卡」的身份喂给 FSRS：Learning 态在 FSRS 里走的是分钟级学习步，
  // stability 会停在低值。我们要的是它的记忆强度模型，间隔由 nextIntervalDays 决定。
  const reviewCard = {
    ...fromFsrsState(current),
    state: FsrsState.Review,
    scheduleStatus: "review",
  } as DefaultSchedulerCard;

  const grade = (rating as 1 | 2 | 3 | 4) as never;
  const result = s.review({ card: reviewCard, grade: grade as Parameters<typeof s.review>[0]["grade"], now });

  const isLapse = rating === 1;
  const days = isLapse ? 0 : nextIntervalDays(current, rating, result.card.scheduledDays);

  // days = 0（答错）→ 10 分钟后到期，这张卡当天还会回到队列里
  const dueAt = new Date(now.getTime() + (isLapse ? RELEARN_MINUTES * MINUTE_MS : days * DAY_MS));

  // 答错 = 回到重学；其余情况都已进入长期复习
  const nextState = isLapse ? FsrsState.Relearning : FsrsState.Review;

  const card = toFsrsState(result.card, current.card_id);
  card.due_at = dueAt.toISOString();
  card.scheduled_days = days;
  card.state = nextState;
  card.schedule_status = isLapse ? "relearning" : "review";
  card.learning_step = isLapse ? 0 : result.card.learningStep;
  // 答错记下时刻：下次答对时靠它判断「上一轮是 Again」，把间隔压到 1 天
  card.last_lapse_at = isLapse ? now.toISOString() : (current.last_lapse_at ?? null);
  card.updated_at = now.toISOString();

  return {
    card,
    revlog: {
      rating: Number(result.revlog.rating),
      state: nextState,
      reviewTime:
        result.revlog.reviewTime instanceof Date
          ? result.revlog.reviewTime.toISOString()
          : String(result.revlog.reviewTime),
      scheduledDays: days,
    },
    // 移出排期只改卡片 status，FSRS 状态照常落库（保留记忆强度用于统计；
    // 将来要「移回复习」也能接着算，不用从头再来）。
    mastered: shouldMaster(rating, days),
  };
}
