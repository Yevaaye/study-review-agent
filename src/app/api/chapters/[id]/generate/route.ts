import { getStore } from "@/lib/db/store";
import {
  generateKnowledgeAndCards,
  type ExistingKp,
  type GenMode,
} from "@/lib/cards/generate";
import { cardIdFor, kpIdFor, normalizeFront } from "@/lib/cards/identity";
import { createJob, failJob, finishJob, learnedEta, startTicker, updateJob } from "@/lib/jobs";
import { errorResponse, readJSON } from "@/lib/http";
import type { Card } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 估个时长，用来给用户「预计还需 X 秒」。
 *
 * 公式只是冷启动的兜底：实测这个网关出一次 JSON 普遍 40~100 秒，
 * 原来「8 秒 + 每千字 2.5 秒」估出 12~15 秒，界面说「还需约 12 秒」然后跑了 70 秒，
 * 倒计时比没有倒计时更让人怀疑系统卡死。
 *
 * 所以从第二次起用实测中位数（learnedEta）占大头，公式只用来做长度微调。
 */
function estimateEta(chars: number, mode: GenMode): number {
  const heuristic = (18000 + chars * 3) * (mode === "deep" ? 1.25 : 1);
  const learned = learnedEta("chapter-generate");
  const blended = learned ? learned * 0.7 + heuristic * 0.3 : heuristic;
  return Math.min(180000, Math.max(20000, Math.round(blended)));
}

/**
 * 按需补题：只针对一章（可选只针对某几个知识点）生成新卡。
 *
 * 与导入时生成的区别：
 *   · 不重跑解析，只读已有的片段与知识点
 *   · 卡片数量按「本章知识点数」算，补的是增量
 *   · 已有卡片按题干归一化去重 —— 连点两次「出题」第二次必须是新增 0 张
 *
 * body: { mode?: 'smart' | 'deep', kpIds?: string[] }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const store = await getStore();
    const chapter = await store.getChapter(id);
    if (!chapter) return Response.json({ error: "章节不存在" }, { status: 404 });

    const textbook = await store.getTextbook(chapter.textbook_id);
    if (!textbook) return Response.json({ error: "材料不存在" }, { status: 404 });

    let body: Record<string, unknown> = {};
    try {
      body = (await readJSON(req)) as Record<string, unknown>;
    } catch {
      /* 默认 */
    }
    const mode: GenMode = body.mode === "deep" ? "deep" : "smart";
    const kpIds = Array.isArray(body.kpIds)
      ? (body.kpIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x)
      : [];

    // 素材：本章片段里剔除题组/答案（那部分已经是卡片，不该再被当正文）
    const fragments = await store.listFragments(textbook.id, chapter.id);
    const usable = fragments.filter(
      (f) =>
        !(f.fragment_type ?? "").startsWith("question_") &&
        !(f.fragment_type ?? "").startsWith("answer_")
    );
    const text = usable.map((f) => f.content).join("\n\n").trim();

    if (text.length < 30) {
      return Response.json(
        { error: "本章没有足够的正文内容可出题（原题片段不计入）", added: 0 },
        { status: 400 }
      );
    }

    const chapterPath = [chapter.title];
    const allKps = await store.listKnowledgePoints({ chapterId: chapter.id });

    /**
     * 每个知识点出多少张卡，由内容实际支撑量决定。
     *
     * 这里曾经有两道数量闸门：「每条知识点最多 4（smart）/6（deep）张」，
     * 以及「这条知识点补过一轮就不再出」。它们一起把单知识点卡数钉死在 4~6，
     * 内容厚的知识点被截断，用户拿不到它本该有的题。
     * 现在两道闸门都去掉，只保留「同一道题」的判重（题干归一化）——
     * 重复点击最多是新增 0 张（模型换个问法问同一件事仍会被内容约束挡住），
     * 而不会因为数量满了而拒绝产出。
     */
    const existingCards = await store.listCards({ chapterId: chapter.id });

    // 选定本次要围绕的知识点：
    //   传了 kpIds → 只用这几条（跳过 kp 提炼）
    //   没传但本章已有 kp → 用全部已有 kp 补题
    //   没有 kp → 走完整两段式，先提炼再出卡
    const selected = kpIds.length > 0 ? allKps.filter((k) => kpIds.includes(k.id)) : allKps;

    if (kpIds.length > 0 && selected.length === 0) {
      return Response.json({
        added: 0,
        skipped: 0,
        mode,
        kp_count: 0,
        new_knowledge_points: 0,
        reason: "kp-not-found",
        message: "指定的知识点不存在（可能已被删除），请刷新页面后重试",
      });
    }

    const onlyKps: ExistingKp[] | undefined =
      selected.length > 0
        ? selected.map((k, i) => ({
            index: i,
            statement: k.statement ?? k.title,
            evidence: k.evidence ?? null,
          }))
        : undefined;

    // ---- 到这里为止都是毫秒级的准备工作；下面是慢活，交给后台 ----
    //
    // 为什么不在请求里等：一次模型调用十几秒，浏览器和页面一直挂着，
    // 用户既看不到进度，也不敢点别的东西。改成「立刻返回 job_id，
    // 前端轮询进度」，页面始终是活的，切到别的页也不影响任务继续跑。
    const job = createJob({
      kind: "chapter-generate",
      title: chapter.title,
      href: `/chapter/${chapter.id}`,
      eta_ms: estimateEta(text.length, mode),
    });
    const kpCount = onlyKps ? onlyKps.length : allKps.length;

    void (async () => {
      const stopTicker = startTicker(job.id);
      try {
        updateJob(job.id, {
          phase: "请求模型",
          message: `正在结合 ${kpCount} 条知识点出题…`,
          percent: 10,
        });

        const bundle = await generateKnowledgeAndCards(text, mode, {
          onlyKps,
          hasContrast: fragments.some((f) => f.fragment_type === "contrast_table"),
        });

        updateJob(job.id, {
          phase: "写入卡片",
          message: `模型返回 ${bundle.cards.length} 张，正在去重写入…`,
          percent: 92,
        });

    // 完整模式才落新知识点
    const newKps = bundle.knowledge_points;
    if (!onlyKps && newKps.length > 0) {
      const rows = newKps.map((kp, idx) => ({
        id: kpIdFor(textbook.id, chapterPath, kp.statement),
        chapter_id: chapter.id,
        title: kp.statement,
        statement: kp.statement,
        evidence: kp.evidence,
        summary: null,
        content: null,
        sort_order: allKps.length + idx,
        deleted_at: null,
        textbook_id: textbook.id,
        chapter_path: chapterPath,
        source_fragment_id: usable[0]?.id ?? null,
        created_at: new Date().toISOString(),
      }));
      await store.bulkInsertKnowledgePoints(rows);
    }

    // kp 下标 → 真实 id（补题模式下是已有 kp 的 id）
    const kpIdsResolved = onlyKps
      ? selected.map((k) => k.id)
      : newKps.map((kp) => kpIdFor(textbook.id, chapterPath, kp.statement));

    // 去重：本章已有卡片的题干归一化集合（挡「同一句话被出两次」）。
    // 数量不设闸门 —— 同一知识点的第二问、第三问照常入库，能出多少就留多少。
    const seen = new Set(existingCards.map((c: Card) => normalizeFront(c.front)));

    const rows: Array<Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: string }> = [];
    let dupSkipped = 0;
    for (const c of bundle.cards) {
      const key = normalizeFront(c.front);
      if (seen.has(key)) {
        dupSkipped++;
        continue;
      }
      const kpId = kpIdsResolved[c.kp_index] ?? null;
      seen.add(key);
      rows.push({
        id: cardIdFor(textbook.id, chapterPath, c.front),
        kind: c.options ? "choice" : "qa",
        front: c.front,
        back: c.back,
        options: c.options ?? null,
        answer: c.answer ?? null,
        status: "draft",
        content_revision: 1,
        content_hash: null,
        generation_job_id: null,
        reviewed_at: null,
        rejected_at: null,
        deleted_at: null,
        source: "ai_generated",
        card_type: c.card_type,
        kp_id: kpId,
        needs_answer: false,
        chapter_path: chapterPath,
        evidence: c.evidence,
        question_no: null,
        explanation: null,
      });
    }

    const inserted = await store.bulkInsertCards(rows);
    if (inserted.cards.length > 0 && usable[0]) {
      await store.bulkLinkCardSources(
        inserted.cards.map((c) => ({ card_id: c.id, source_fragment_id: usable[0].id }))
      );
    }

    // 记录「这条知识点最近一次出题时间」，只作台账，不再作为「不许再出」的闸门
    if (inserted.inserted > 0) {
      await store.markKpsGenerated(kpIdsResolved.filter((x): x is string => !!x));
    }

        finishJob(job.id, {
          added: inserted.inserted,
          skipped: inserted.skipped + dupSkipped,
          mode,
          kp_count: onlyKps ? onlyKps.length : newKps.length,
          new_knowledge_points: onlyKps ? 0 : newKps.length,
          reason: inserted.inserted === 0 ? "no-new-card" : "ok",
          // 原文校验挡掉了多少张、为什么 —— 让「出题变少」这件事有解释
          rejected: bundle.rejected ?? {},
        });
      } catch (e) {
        // 失败也要把话说清楚：知识点和原题都没动，重点一次就好，不会翻倍
        failJob(job.id, (e as Error)?.message ?? "生成失败，请稍后重试");
      } finally {
        stopTicker();
      }
    })();

    return Response.json(
      { job_id: job.id, queued: true, eta_ms: job.eta_ms, kp_count: kpCount },
      { status: 202 }
    );
  } catch (e) {
    return errorResponse(e, "补题失败");
  }
}
