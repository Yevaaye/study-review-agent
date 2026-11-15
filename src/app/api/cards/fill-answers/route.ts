import { getStore } from "@/lib/db/store";
import { draftCardAnswer, missingAnswer, type MaterialCache } from "@/lib/cards/answer-fill";
import { createJob, failJob, finishJob, startTicker, updateJob } from "@/lib/jobs";
import { errorResponse, readJSON } from "@/lib/http";

export const dynamic = "force-dynamic";
// 一次补上百张卡是分钟级任务，这里只负责「启动」，真正的活在后台账本里跑
export const maxDuration = 120;

/** 单次任务最多处理多少张：防止误点把上千张卡一次性打给模型 */
const MAX_CARDS = 400;
/** 并发数：网关承受得住，又不至于把 300 张卡排队排到天荒地老 */
const CONCURRENCY = 3;
/** 攒够多少条才落一次盘（每次落盘都是整库 JSON 写入，不能一张一写） */
const FLUSH_EVERY = 8;

/**
 * 批量「AI 补答案」。
 *
 * body: { textbookId?: string, limit?: number }
 *
 * 只挑「还缺答案」的卡（needs_answer 或 back 为空），已有答案的卡一张不碰。
 * 材料不足的卡会被跳过并保持原状 —— 宁可显示「待补答案」，也不写一条编造的答案。
 *
 * 返回 202 + job_id，进度由全局任务浮层显示；完成时结果里带 filled / insufficient。
 */
export async function POST(req: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await readJSON(req)) as Record<string, unknown>;
    } catch {
      /* 允许空 body */
    }
    const textbookId = typeof body.textbookId === "string" ? body.textbookId : undefined;
    const limit = Math.min(MAX_CARDS, Math.max(1, Number(body.limit ?? MAX_CARDS) || MAX_CARDS));

    const store = await getStore();
    const all = await store.listCards({ textbookId });
    const targets = all.filter(missingAnswer).slice(0, limit);

    if (targets.length === 0) {
      return Response.json({
        filled: 0,
        queued: false,
        message: "当前没有缺答案的卡片",
      });
    }

    // 并发 3、单张约 4 秒 → 每张摊到约 1.4 秒
    const eta_ms = Math.min(30 * 60_000, Math.max(20_000, Math.round(targets.length * 1400)));
    const job = createJob({
      kind: "fill-answers",
      title: `AI 补答案：${targets.length} 张`,
      href: "/cards?status=draft",
      eta_ms,
    });

    void (async () => {
      const stopTicker = startTicker(job.id, 3, 92);
      const cache: MaterialCache = new Map();
      const queue = [...targets];

      let done = 0;
      let filled = 0;
      let insufficient = 0;
      let noMaterial = 0;
      let failed = 0;
      const buffer: Array<{
        id: string;
        back: string;
        answer: string | null;
        explanation: string | null;
        grounded: boolean;
      }> = [];

      const flush = async () => {
        if (buffer.length === 0) return;
        // splice 保证同一条只会被写一次（多个 worker 可能同时触发 flush）
        const batch = buffer.splice(0, buffer.length);
        try {
          await store.bulkFillCardAnswers(batch);
        } catch {
          failed += batch.length;
        }
      };

      const worker = async () => {
        for (;;) {
          const card = queue.shift();
          if (!card) return;
          try {
            const d = await draftCardAnswer(store, card, { cache, timeoutMs: 32000 });
            if (d.ok && d.back) {
              buffer.push({
                id: card.id,
                back: d.back,
                answer: d.answer ?? null,
                explanation: d.explanation ?? null,
                grounded: d.grounded ?? false,
              });
              filled++;
            } else if (d.reason === "no-material") {
              noMaterial++;
            } else {
              insufficient++;
            }
          } catch {
            failed++;
          }
          done++;
          if (buffer.length >= FLUSH_EVERY) await flush();
          updateJob(job.id, {
            phase: "生成答案",
            message: `已完成 ${done}/${targets.length} 张 · 补上 ${filled} 条`,
          });
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
        );
        await flush();
        finishJob(job.id, {
          filled,
          insufficient,
          no_material: noMaterial,
          failed,
          total: targets.length,
        });
      } catch (e) {
        await flush();
        failJob(job.id, (e as Error)?.message ?? "补答案失败");
      } finally {
        stopTicker();
      }
    })();

    return Response.json(
      { job_id: job.id, queued: true, total: targets.length, eta_ms },
      { status: 202 }
    );
  } catch (e) {
    return errorResponse(e, "补答案失败");
  }
}
