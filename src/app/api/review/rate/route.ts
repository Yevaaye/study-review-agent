import { getStore } from "@/lib/db/store";
import { schedule } from "@/lib/fsrs";
import { BadRequestError, errorResponse, readJSON, requireFields } from "@/lib/http";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

// 评分（幂等）：客户端生成 idempotency_key，重复提交返回已存在事件，不重复排期。
export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    requireFields(body, ["card_id", "rating"]);
    const cardId = String(body.card_id);
    const rating = Number(body.rating);
    if (![1, 2, 3, 4].includes(rating)) {
      throw new BadRequestError("评分必须是 1(Again)/2(Hard)/3(Good)/4(Easy)");
    }

    // 幂等键：客户端应传一个稳定的键（同一张卡 + 同一轮作答）。
    // 没传时只能生成随机键 —— 那只防「同一次请求被重复执行」，
    // 不提供跨请求去重能力（旧注释写成「按 card+rating+会话兜底」，与实现不符）。
    const idempotencyKey =
      body.idempotency_key != null
        ? String(body.idempotency_key)
        : crypto.randomUUID();

    const store = await getStore();

    // 已存在则直接返回（幂等命中）
    const existing = await store.getReviewByKey(idempotencyKey);
    if (existing) {
      return Response.json({
        review: existing,
        next_due: existing.due_after,
        mastered: (await store.getCard(cardId))?.status === "mastered",
        deduped: true,
      });
    }

    // 这里原先有「同一 session_card_id 只允许一次评分」的第二道护栏，已移除。
    // 它与 v3 的重练语义直接冲突：「没想起来」会把同一张会话卡 requeue 回本轮
    // 队列末尾，用户再答一次时 session_card_id 不变，旧护栏一律返回 deduped，
    // 导致 review 不落库、FSRS 不推进 —— 点几次 Again 都像没生效。
    //
    // 现在去重只认 idempotency_key（前端每次作答生成新键），重复提交由前端
    // 同步锁 + 浏览器同请求体重试覆盖；跨页面/跨设备会开新会话，session_card_id
    // 本来就不同，不需要这道护栏。recordReview 是追加式写，同一会话卡可以有多条
    // 复习事件，session_card.review_id 只指向最新一条，历史仍在 card_reviews 里。

    const card = await store.getCard(cardId);
    const fsrsState = await store.getFsrsState(cardId);
    if (!card || !fsrsState) {
      return Response.json({ error: "卡片或调度状态不存在" }, { status: 404 });
    }

    const before = fsrsState;
    const result = await schedule(fsrsState, rating);
    const after = result.card;

    // after 直接交给 recordReview 落库，不让它在内部再算一遍 schedule()
    const review = await store.recordReview(
      {
        idempotency_key: idempotencyKey,
        card_id: cardId,
        session_id: body.session_id ? String(body.session_id) : null,
        session_card_id: body.session_card_id ? String(body.session_card_id) : null,
        rating,
        elapsed_ms: body.elapsed_ms ? Number(body.elapsed_ms) : null,
        content_revision: card.content_revision,
        card_snapshot: { front: card.front, back: card.back, content_revision: card.content_revision },
        state_before: before as unknown as Record<string, unknown>,
        state_after: after as unknown as Record<string, unknown>,
        scheduled_days: after.scheduled_days,
        due_before: before.due_at,
        due_after: after.due_at,
        fsrs_version: after.fsrs_version,
      },
      after
    );

    // 毕业在评分落库之后再做：先把这次复习记账、写新的 FSRS 状态，
    // 再翻卡片 status —— 顺序反了会出现「已掌握但没有复习记录」的中间态。
    if (result.mastered) await store.masterCard(cardId);

    return Response.json(
      {
        review,
        next_due: after.due_at,
        // 毕业：3 天那一轮又答对 → 之后不再排期，只在资料库里保留「已掌握」标识
        mastered: result.mastered,
        deduped: false,
      },
      { status: 201 }
    );
  } catch (e) {
    return errorResponse(e, "评分失败");
  }
}
