import { getStore } from "@/lib/db/store";
import { generateKnowledgeAndCards, type ExistingKp, type GenMode } from "@/lib/cards/generate";
import { cardIdFor, kpIdFor, normalizeFront } from "@/lib/cards/identity";
import { createJob, failJob, finishJob, learnedEta, startTicker, updateJob } from "@/lib/jobs";
import { errorResponse, readJSON } from "@/lib/http";
import type { Card, SourceFragment } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 归一化：丢掉空白与标点，只留可比对的字（定位原文片段用） */
function normText(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** 把 evidence 落回最可能的原文片段（与 import 链路的 bestFragmentId 同策略） */
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

/**
 * 围绕「某张卡」出同范围的新题。
 *
 * 范围判定（用户选定「两者自动兜底」）：
 *   1. 卡片绑定了知识点（kp_id）→ 只围绕这条知识点出题，不再新增知识点
 *   2. 卡片没绑定知识点 → 回退到卡片所在章节的原文正文作为范围
 *
 * body: { mode?: 'smart' | 'deep' }
 *   mode 只影响题型的多样程度（deep 题型更全）。**不再接收 count**：
 *   单知识点的卡片数量由内容实际支撑量决定，不设上下限，也不为凑数补题。
 *
 * 去重沿用章节补题的两层防线：题干归一化 + 原文证据。
 * 没有数量闸门 —— 只有「同一道题」会被挡，「同一个知识点的第二问」不会。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const store = await getStore();
    const card = await store.getCard(id);
    if (!card) return Response.json({ error: "卡片不存在" }, { status: 404 });

    let body: Record<string, unknown> = {};
    try {
      body = (await readJSON(req)) as Record<string, unknown>;
    } catch {
      /* 默认 */
    }
    const mode: GenMode = body.mode === "deep" ? "deep" : "smart";

    // 卡片本身不存 chapter_id：优先从绑定的知识点反查，其次从来源片段反查
    let textbook: { id: string; title: string } | null = null;
    let chapter: { id: string; title: string } | null = null;
    let kp: { id: string; statement: string; evidence: string | null } | null = null;

    // 1) 卡片绑定的知识点（范围首选）
    if (card.kp_id) {
      const k = await store.getKnowledgePoint(card.kp_id);
      if (k) {
        kp = {
          id: k.id,
          statement: k.statement ?? k.title,
          evidence: k.evidence ?? null,
        };
        const ch = await store.getChapter(k.chapter_id);
        if (ch) {
          chapter = { id: ch.id, title: ch.title };
          const tb = await store.getTextbook(ch.textbook_id);
          if (tb) textbook = { id: tb.id, title: tb.title };
        }
      }
    }

    // 2) 知识点缺失 → 从卡片来源片段反查章节
    if (!chapter) {
      const sources = await store.listCardSources(card.id);
      for (const s of sources) {
        if (!s.chapter_id) continue;
        const ch = await store.getChapter(s.chapter_id);
        if (!ch) continue;
        chapter = { id: ch.id, title: ch.title };
        const tb = await store.getTextbook(ch.textbook_id);
        if (tb) textbook = { id: tb.id, title: tb.title };
        break;
      }
    }

    if (!textbook) {
      return Response.json({ error: "这张卡片没有可定位的材料，无法出题" }, { status: 400 });
    }

    // 素材：知识点模式下用该知识点陈述 + 章节正文取证；章节模式下用章节正文
    let material = "";
    let frags: SourceFragment[] = [];
    let onlyKps: ExistingKp[] | undefined;
    // 与 onlyKps 下标对齐的真实知识点 id，卡片按 c.kp_index 索引它
    let kpIdsResolved: string[] = [];
    let chapterPath: string[] = [];

    if (kp && chapter) {
      // 围绕知识点出题：正文作为模型取证的素材，知识点作为「只围绕它」的约束
      const allFrags = await store.listFragments(textbook.id, chapter.id);
      frags = allFrags.filter(
        (f) =>
          !(f.fragment_type ?? "").startsWith("question_") &&
          !(f.fragment_type ?? "").startsWith("answer_")
      );
      material = frags.map((f) => f.content).join("\n\n").trim();
      onlyKps = [
        {
          index: 0,
          statement: kp.statement,
          evidence: kp.evidence ?? null,
        },
      ];
      kpIdsResolved = [kp.id];
      chapterPath = [chapter.title];
    } else if (chapter) {
      const allFrags = await store.listFragments(textbook.id, chapter.id);
      frags = allFrags.filter(
        (f) =>
          !(f.fragment_type ?? "").startsWith("question_") &&
          !(f.fragment_type ?? "").startsWith("answer_")
      );
      material = frags.map((f) => f.content).join("\n\n").trim();
      chapterPath = [chapter.title];
      // 章节模式：不限定知识点，但用已有知识点约束（若有），避免重复提炼
      const existing = await store.listKnowledgePoints({ chapterId: chapter.id });
      if (existing.length > 0) {
        onlyKps = existing.map((k, i) => ({
          index: i,
          statement: k.statement ?? k.title,
          evidence: k.evidence ?? null,
        }));
        kpIdsResolved = existing.map((k) => k.id);
      }
    }

    if (material.length < 30) {
      return Response.json(
        { error: "这张卡片所在的范围没有足够的正文可出题", added: 0 },
        { status: 400 }
      );
    }

    // 去重：本章已有卡片题干归一化。不再有「每条知识点最多 4/6 张」的数量闸门 ——
    // 内容能支撑多少张就保留多少张，截断与补齐都由内容自己决定。
    const existingCards = await store.listCards({ chapterId: chapter?.id });

    // 估时：范围越大越慢；有实测样本则混合
    const heuristic = (18000 + material.length * 3) * (mode === "deep" ? 1.25 : 1);
    const learned = learnedEta("chapter-generate");
    const eta_ms = Math.min(
      180000,
      Math.max(20000, Math.round(learned ? learned * 0.7 + heuristic * 0.3 : heuristic))
    );

    const title = kp ? kp.statement.slice(0, 24) : chapter?.title ?? "卡片";
    const job = createJob({
      kind: "chapter-generate",
      title: `出题：${title}`,
      href: "/cards?status=draft",
      eta_ms,
    });

    void (async () => {
      const stopTicker = startTicker(job.id);
      try {
        updateJob(job.id, {
          phase: "请求模型",
          message: `正在围绕「${title}」出题（数量按内容实际需要）…`,
          percent: 10,
        });

        const bundle = await generateKnowledgeAndCards(material, mode, {
          onlyKps,
          hasContrast: frags.some((f) => f.fragment_type === "contrast_table"),
        });

        updateJob(job.id, {
          phase: "写入卡片",
          message: `模型返回 ${bundle.cards.length} 张，正在去重写入…`,
          percent: 92,
        });

        // 章节模式且该章还没有任何知识点 → 模型会走完整两段式提炼新知识点。
        // 落库后同步填充 kpIdsResolved，让卡片能按 kp_index 挂上。
        const newKps = bundle.knowledge_points ?? [];
        if (!onlyKps && newKps.length > 0) {
          const ids = newKps.map((k) => kpIdFor(textbook!.id, chapterPath, k.statement));
          const rows = newKps.map((k, idx) => ({
            id: ids[idx],
            chapter_id: chapter!.id,
            title: k.statement,
            statement: k.statement,
            evidence: k.evidence,
            summary: null,
            content: null,
            sort_order: existingCards.length + idx,
            deleted_at: null,
            textbook_id: textbook!.id,
            chapter_path: chapterPath,
            source_fragment_id: bestFragmentId(k.evidence, frags),
            created_at: new Date().toISOString(),
          }));
          await store.bulkInsertKnowledgePoints(rows);
          kpIdsResolved = ids;
        }

        // kp 下标 → 真实 id（与 onlyKps 下标对齐）
        const seen = new Set(existingCards.map((c: Card) => normalizeFront(c.front)));

        const rows: Array<Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: string }> =
          [];
        let dupSkipped = 0;
        for (const c of bundle.cards) {
          const key = normalizeFront(c.front);
          if (seen.has(key)) {
            dupSkipped++;
            continue;
          }
          // 卡片按 kp_index 挂到对应知识点；解析不到则进「未关联」池（题不丢）
          const kpId = kpIdsResolved[c.kp_index] ?? null;
          seen.add(key);
          rows.push({
            id: cardIdFor(textbook!.id, chapterPath, c.front),
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
        // 按卡各自的 evidence 定位片段；缺证据退回首个可用片段
        const links = inserted.cards.flatMap((c) => {
          const fid = bestFragmentId(c.evidence, frags) ?? frags[0]?.id;
          return fid ? [{ card_id: c.id, source_fragment_id: fid }] : [];
        });
        if (links.length > 0) await store.bulkLinkCardSources(links);

        finishJob(job.id, {
          added: inserted.inserted,
          skipped: inserted.skipped + dupSkipped,
          reason: inserted.inserted === 0 ? "no-new-card" : "ok",
        });
      } catch (e) {
        failJob(job.id, (e as Error)?.message ?? "生成失败，请稍后重试");
      } finally {
        stopTicker();
      }
    })();

    return Response.json({ job_id: job.id, queued: true, eta_ms }, { status: 202 });
  } catch (e) {
    return errorResponse(e, "出题失败");
  }
}
