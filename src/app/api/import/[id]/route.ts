import { getStore } from "@/lib/db/store";
import { config } from "@/lib/config";
import {
  generateKnowledgeAndCards,
  type ExistingKp,
  type GenMode,
  type GenKnowledgePoint,
} from "@/lib/cards/generate";
import { cardIdFor, kpIdFor } from "@/lib/cards/identity";
import { createJob, failJob, finishJob, startTicker, updateJob } from "@/lib/jobs";
import { errorResponse, readJSON } from "@/lib/http";
import type { Card, SourceFragment } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 每批并行的章数。5 是「总耗时可接受 + 上游不容易限流」的折中。 */
const PARALLEL = 5;
/** 少于这个字数的章跳过：模型只会返回空数组，白烧一次调用还容易误报失败 */
const MIN_CHAPTER_CHARS = 30;

/** 归一化：丢掉空白与标点，只留可比对的字 */
function normText(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/**
 * 把一条 evidence（模型从原文摘的引文）落回最可能的原文片段。
 *
 * 模型拿到的是整章拼接文本，不会返回片段 id；早期因此一律绑 usable[0]（章首），
 * 复习页「回到原文」永远跳第一段，片段级卡点统计也全部归并到首片段。
 * 这里用引文本身定位：优先找包含整条引文的片段，其次按 4 字窗口重叠率打分，
 * 完全无线索才退回章首。
 */
function bestFragmentId(
  evidence: string | null | undefined,
  frags: SourceFragment[]
): string | null {
  const first = frags[0]?.id ?? null;
  const q = normText(evidence ?? "");
  if (q.length < 8 || frags.length === 0) return first;

  const grams: string[] = [];
  for (let i = 0; i + 4 <= q.length; i += 2) grams.push(q.slice(i, i + 4));
  if (grams.length === 0) return first;

  let bestId = first;
  let bestScore = 0;
  for (const f of frags) {
    const t = normText(f.content ?? "");
    if (!t) continue;
    if (t.includes(q)) return f.id;
    let hit = 0;
    for (const g of grams) if (t.includes(g)) hit++;
    const score = hit / grams.length;
    if (score > bestScore) {
      bestScore = score;
      bestId = f.id;
    }
  }
  return bestScore > 0 ? bestId : first;
}

/** 目录 / 前言 / 序 / 导读这类章标题只有导航与说明，没有可考的知识 */
const NAV_TITLES =
  /^(目\s*录|前\s*言|序|序\s*言|导\s*读|摘\s*要|内容简介|阅读指南|使用说明|版本说明|声\s*明)$/;

/**
 * 前置章节判定。
 *
 * 实测教训：一份纯知识点文档（AI 产品经理知识点）导入后，模型从「目录」章
 * 出了一堆「材料目录中，AI 技术底之后的章节是什么？」这类题 —— 有 evidence、
 * 格式完全合法，但对复习毫无价值，还排在审核台最前面。
 * 这不是提示词能根治的（模型确实"忠于原文"），得在送进模型之前就不送。
 *
 * 三种特征：① 标题就是目录/前言；② 正文是大片 `[xxx](#anchor)` 锚点（目录）；
 * ③ 整段都是 `>` 引用块且不长（覆盖文档开头的说明/阅读建议）。
 */
function isFrontMatter(title: string, text: string): boolean {
  if (NAV_TITLES.test(title.trim())) return true;
  if ((text.match(/\]\(#/g) ?? []).length >= 3) return true;
  // `>` 单独成行、`---` 分隔线都不算内容行，否则「两段引用 + 一条分隔线」
  // 会被算成 2/3 引用而漏判。
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== ">" && !/^[-*=_]{3,}$/.test(l));
  if (lines.length === 0) return true;
  const quoted = lines.filter((l) => l.startsWith(">")).length;
  // 整章都是引用、没有子标题、又很短 —— 这就是文档开头的说明/阅读建议
  if (quoted / lines.length >= 0.8 && !/^#{2,}/m.test(text) && text.length < 500) return true;
  return false;
}

/** 不送进模型的片段类型：题目与答案区，送了就是让模型重复出题 / 把答案当正文 */
function isExcluded(ft: SourceFragment["fragment_type"]): boolean {
  if (!ft) return false;
  return ft.startsWith("question_") || ft.startsWith("answer_");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await getStore();
  const job = await store.getImportJob(id);
  if (!job) return Response.json({ error: "任务不存在" }, { status: 404 });
  const textbook = await store.getTextbook(job.textbook_id);
  const chapters = await store.listChapters(job.textbook_id);
  return Response.json({ job, textbook, chapters });
}

/**
 * 生成卡片（第二段，唯一会花钱的一步）。
 *
 * body: { mode?: 'off' | 'smart' | 'deep' }，默认 smart。
 *   off    → 完全不调模型。原题已在解析阶段落库，任务正常结束（不是失败）。
 *   smart  → 每章提炼知识点 + 按 kp×1.5 出卡
 *   deep   → 每章提炼知识点 + 按 kp×2.5 出卡，题型更全
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const store = await getStore();
    const job = await store.getImportJob(id);
    if (!job) return Response.json({ error: "任务不存在" }, { status: 404 });

    const textbook = await store.getTextbook(job.textbook_id);
    if (!textbook) return Response.json({ error: "材料不存在" }, { status: 404 });

    let body: Record<string, unknown> = {};
    try {
      body = (await readJSON(req)) as Record<string, unknown>;
    } catch {
      /* 无 body 按默认 mode */
    }
    const mode: GenMode =
      body.mode === "off" || body.mode === "deep" || body.mode === "smart"
        ? body.mode
        : "smart";

    const chapters = await store.listChapters(textbook.id);
    const fragments = await store.listFragments(textbook.id);
    const allCards = await store.listCards({ textbookId: textbook.id });
    const originalCards = allCards.filter((c) => c.source === "original");

    // ---- mode='off'：只收录原题，零模型调用 ----
    if (mode === "off") {
      await store.updateImportJob(id, {
        stage: "review_required",
        progress: 100,
        finished_at: new Date().toISOString(),
        model: null,
        detail: `只收录模式：未调用 AI。原题 ${originalCards.length} 道已进入待审核，如需补题可在章节页手动触发。`,
        result_summary: { mode, original_card_count: originalCards.length, ai_cards: 0 },
      });
      return Response.json({
        mode,
        original_card_count: originalCards.length,
        ai_card_count: 0,
        knowledge_point_count: 0,
      });
    }

    if (fragments.length === 0) {
      await store.updateImportJob(id, {
        stage: "failed",
        error: "材料没有可解析的片段",
        finished_at: new Date().toISOString(),
      });
      return Response.json({ error: "材料没有可解析的片段" }, { status: 400 });
    }

    await store.updateImportJob(id, {
      stage: "generating",
      progress: 10,
      stage_started_at: new Date().toISOString(),
      model: config.llm.openaiModel,
    });

    // 按章分组，并剔除题组/答案片段（防止模型重复出题）
    const fragsByChapter = new Map<string, SourceFragment[]>();
    for (const f of fragments) {
      if (!f.chapter_id) continue;
      const arr = fragsByChapter.get(f.chapter_id) ?? [];
      arr.push(f);
      fragsByChapter.set(f.chapter_id, arr);
    }

    const jobs = chapters
      .map((ch) => {
        const all = fragsByChapter.get(ch.id) ?? [];
        const usable = all.filter((f) => !isExcluded(f.fragment_type));
        const text = usable.map((f) => f.content).join("\n\n").trim();
        return {
          chapter: ch,
          text,
          usable,
          hasContrast: all.some((f) => f.fragment_type === "contrast_table"),
          chapterPath: [ch.title],
          // 该章的原题（按题号排序，供绑定用）
          originals: originalCards
            .filter((c) => (c.chapter_path?.[0] ?? "") === ch.title)
            .sort((a, b) => (a.question_no ?? 0) - (b.question_no ?? 0)),
        };
      })
      .filter((j) => j.text.length >= MIN_CHAPTER_CHARS && !isFrontMatter(j.chapter.title, j.text));

    if (jobs.length === 0) {
      const longest = Math.max(
        0,
        ...chapters.map((ch) =>
          (fragsByChapter.get(ch.id) ?? [])
            .filter((f) => !isExcluded(f.fragment_type))
            .map((f) => f.content)
            .join("")
            .trim().length
        )
      );
      // 全是原题、没有正文可提炼 —— 这不是失败，原题照样可用。
      // 知识点数按库里实际有的报（导入时已按小节规则提炼过一批）。
      const kpHave = (await store.listKnowledgePoints({ textbookId: textbook.id })).length;
      await store.updateImportJob(id, {
        stage: "review_required",
        progress: 100,
        finished_at: new Date().toISOString(),
        detail: `没有可提炼正文的章节（最长 ${longest} 字）。原题 ${originalCards.length} 道、知识点 ${kpHave} 条已就绪。`,
        result_summary: {
          mode,
          original_card_count: originalCards.length,
          ai_cards: 0,
          knowledge_point_count: kpHave,
        },
      });
      return Response.json({
        mode,
        original_card_count: originalCards.length,
        ai_card_count: 0,
        knowledge_point_count: kpHave,
        note: "没有可提炼的正文段落，仅收录原题（知识点已按原文结构提炼）",
      });
    }

    // ---- 从这里开始是慢活：逐章调模型，可能要几分钟 ----
    //
    // 同步接口的问题：整本书十几章，第一批 5 章并行也要 15 秒以上，
    // 全部跑完一两分钟。浏览器干等，用户不知道还要多久，页面也动不了。
    // 改成「立刻返回 job_id，前端轮询 /api/jobs」，
    // 进度按「已完成章数 / 总章数」真实推进，不是估的。
    // 每批按 40 秒估（实测一次出 JSON 40~100 秒，原来按 16 秒估，
    // 整本书导入时倒计时刚走完一半才跑到第三批）。
    const eta = Math.min(600000, Math.max(30000, Math.ceil(jobs.length / PARALLEL) * 40000));
    const genJob = createJob({
      kind: "import-generate",
      title: textbook.title,
      href: "/cards?status=draft",
      eta_ms: eta,
    });

    void (async () => {
      const stopTicker = startTicker(genJob.id, 5, 85);
      try {
        updateJob(genJob.id, {
          phase: "生成卡片",
          message: `共 ${jobs.length} 章，每批 ${PARALLEL} 章并行…`,
          percent: 5,
        });

        let kpTotal = 0;
        let kpInUse = 0;
        let aiCards = 0;
        let bound = 0;
        let unbound = 0;
        let lastError: string | null = null;

        for (let i = 0; i < jobs.length; i += PARALLEL) {
          const batch = jobs.slice(i, i + PARALLEL);
          updateJob(genJob.id, {
            message: `正在生成第 ${i + 1}-${Math.min(i + PARALLEL, jobs.length)} 章 / 共 ${jobs.length} 章…`,
            percent: Math.min(88, 5 + Math.round((i / jobs.length) * 83)),
          });

      const results = await Promise.allSettled(
        batch.map(async (j) => {
          // 导入时已经按小节规则提炼过知识点。这一轮的任务是「结合这些知识点出题」，
          // 不再重新提炼 —— 否则库里会出现两套语义重复的 kp，页面上的知识点列表翻倍。
          const existing = await store.listKnowledgePoints({ chapterId: j.chapter.id });
          const onlyKps: ExistingKp[] | undefined =
            existing.length > 0
              ? existing.map((k, idx) => ({
                  index: idx,
                  statement: k.statement ?? k.title,
                  evidence: k.evidence ?? null,
                }))
              : undefined;

          const bundle = await generateKnowledgeAndCards(j.text, mode, {
            hasContrast: j.hasContrast,
            onlyKps,
          });
          return { job: j, bundle, existing };
        })
      );

      for (const r of results) {
        if (r.status !== "fulfilled") {
          lastError = (r.reason as Error)?.message ?? "生成失败";
          continue; // 单章失败不整单失败
        }
        const { job: j, bundle, existing } = r.value;
        const { chapter, chapterPath, usable } = j;

        // ---- 1) 知识点入库（确定性 id，重复导入不翻倍）----
        const kpRows = bundle.knowledge_points.map((kp: GenKnowledgePoint, idx: number) => ({
          id: kpIdFor(textbook.id, chapterPath, kp.statement),
          chapter_id: chapter.id,
          title: kp.statement,
          statement: kp.statement,
          evidence: kp.evidence,
          summary: null,
          content: null,
          sort_order: idx,
          deleted_at: null,
          textbook_id: textbook.id,
          chapter_path: chapterPath,
          source_fragment_id: bestFragmentId(kp.evidence, usable),
          created_at: new Date().toISOString(),
        }));
        const kpInsert = await store.bulkInsertKnowledgePoints(kpRows);
        kpTotal += kpInsert.inserted;

        // 已存在的知识点也要能绑 —— 取出本 kp 列表对应的真实 id（含历史已存在的）。
        // 补题模式下 bundle.knowledge_points 为空，直接用库里已有的那批 id。
        const kpIds =
          existing.length > 0
            ? existing.map((k) => k.id)
            : bundle.knowledge_points.map((kp: GenKnowledgePoint) =>
                kpIdFor(textbook.id, chapterPath, kp.statement)
              );
        kpInUse += kpIds.length;

        // ---- 2) 卡片入库 ----
        const cardRows: Array<
          Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: string }
        > = [];
        const fragByCardId = new Map<string, string | null>();
        for (const c of bundle.cards) {
          const kpId = kpIds[c.kp_index] ?? null;
          const cardId = cardIdFor(textbook.id, chapterPath, c.front);
          // 卡自身的 evidence 最贴切；补题模式下卡可能没带，退回所属知识点的 evidence
          const evidence = c.evidence || bundle.knowledge_points[c.kp_index]?.evidence;
          fragByCardId.set(cardId, bestFragmentId(evidence, usable));
          cardRows.push({
            id: cardId,
            kind: c.options ? "choice" : "qa",
            front: c.front,
            back: c.back,
            options: c.options ?? null,
            answer: c.answer ?? null,
            status: "draft",
            content_revision: 1,
            content_hash: null,
            generation_job_id: id,
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
        const cardInsert = await store.bulkInsertCards(cardRows);
        aiCards += cardInsert.inserted;

        // 按卡各自的引文定位片段；bulkInsertCards 只返回新插入的卡，
        // 所以用 cardId → fragmentId 映射取值，不依赖返回数组的顺序。
        const links = cardInsert.cards.flatMap((c) => {
          const fid = fragByCardId.get(c.id) ?? usable[0]?.id;
          return fid ? [{ card_id: c.id, source_fragment_id: fid }] : [];
        });
        if (links.length > 0) await store.bulkLinkCardSources(links);

        // ---- 3) 原题绑定：导入时已经按「同章 + 文本相似度」自动挂好了 ----
        // 这里不再走一遍 AI 绑定。那既多一次模型调用，又会把规则挂好的结果
        // 用 null 覆盖掉（无匹配时 AI 返回 null），于是刚挂上的题又变回「未关联」。
        const chapterCards = await store.listCards({ chapterId: chapter.id });
        for (const c of chapterCards) {
          if (c.source !== "original") continue;
          if (c.kp_id) bound++;
          else unbound++;
        }
      }
    }

    if (aiCards === 0 && kpTotal === 0 && originalCards.length === 0) {
      await store.updateImportJob(id, {
        stage: "failed",
        error: lastError ?? "未生成任何卡片",
        finished_at: new Date().toISOString(),
      });
      failJob(genJob.id, lastError ?? "未生成任何卡片");
      return;
    }

    const summary = {
      mode,
      knowledge_point_count: kpInUse,
      ai_card_count: aiCards,
      original_card_count: originalCards.length,
      bound,
      unbound,
      last_error: lastError,
    };

    await store.updateImportJob(id, {
      stage: "review_required",
      progress: 100,
      finished_at: new Date().toISOString(),
      detail:
        `${mode === "deep" ? "深度补充" : "智能补充"}：` +
        `围绕 ${kpInUse} 条知识点生成卡片 ${aiCards} 张` +
        (kpTotal > 0 ? `（新增知识点 ${kpTotal} 条）` : "") +
        `；原题 ${originalCards.length} 道（已关联知识点 ${bound}，未关联 ${unbound}）`,
      result_summary: {
        mode,
        knowledge_point_count: kpInUse,
        ai_card_count: aiCards,
        original_card_count: originalCards.length,
        bound,
        unbound,
      },
    });

        finishJob(genJob.id, { ...summary, added: aiCards, ai_card_count: aiCards });
      } catch (e) {
        await store
          .updateImportJob(id, {
            stage: "failed",
            error: (e as Error)?.message ?? "生成卡片失败",
            finished_at: new Date().toISOString(),
          })
          .catch(() => {});
        failJob(genJob.id, (e as Error)?.message ?? "生成卡片失败");
      } finally {
        stopTicker();
      }
    })();

    return Response.json(
      { job_id: genJob.id, queued: true, eta_ms: eta, chapter_count: jobs.length },
      { status: 202 }
    );
  } catch (e) {
    return errorResponse(e, "生成卡片失败");
  }
}
