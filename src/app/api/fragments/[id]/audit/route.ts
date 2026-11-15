import { getStore } from "@/lib/db/store";
import { errorResponse, readJSON } from "@/lib/http";
import { cardIdFor } from "@/lib/cards/identity";
import {
  applyVerdicts,
  coverage,
  matchIdentified,
  normalizeManualCard,
  scanCandidates,
  splitKnowledgeBlocks,
  type QuestionCandidateRow,
} from "@/lib/audit/fragment-questions";
import { judgeCandidates } from "@/lib/audit/question-judge";
import type { CardType } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 单个原文片段的「题目识别核对」接口。
 *
 * GET   ?block=<n>   扫出候选、与已有卡对齐，标出「已识别 / 遗漏」
 * POST  action=scan  重新识别（可带 ai=true 让模型判定哪些真是题）
 *       action=judge 只判定用户勾选的那几条（人工复核效率最高的一步）
 *       action=create 把勾选 / AI 确认的候选建成卡片（人工录入也走这里）
 *
 * 为什么按片段而不是按书：用户是在原文某一页发现「这里好像漏了题」，
 * 按书扫会把 2000 多个片段一次性摊开，既慢又没法定位。
 */
async function loadFragment(fragmentId: string) {
  const store = await getStore();
  const frags = await store.listFragments();
  const fragment = frags.find((f) => f.id === fragmentId) ?? null;
  if (!fragment) return { store, fragment: null, cards: [], blocks: [], rows: [] as QuestionCandidateRow[] };
  const cards = await store.listCards({ fragmentId });
  const blocks = splitKnowledgeBlocks(fragment.content ?? "");
  const rows = matchIdentified(
    scanCandidates(blocks),
    cards.map((c) => ({ id: c.id, front: c.front }))
  );
  return { store, fragment, cards, blocks, rows };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const blockParam = url.searchParams.get("block");
    const { fragment, cards, blocks, rows } = await loadFragment(id);
    if (!fragment) return Response.json({ error: "原文片段不存在" }, { status: 404 });

    // block=<n>：只看某个知识点块（界面里点「再次识别」时用）
    const filtered =
      blockParam !== null
        ? rows.filter((r) => String(r.block) === blockParam)
        : rows;

    return Response.json({
      ok: true,
      fragment: {
        id: fragment.id,
        heading_path: fragment.heading_path ?? null,
        chapter_id: fragment.chapter_id ?? null,
        textbook_id: fragment.textbook_id,
        content: fragment.content,
      },
      blocks,
      rows: filtered,
      coverage: coverage(filtered),
      cards: cards.map((c) => ({
        id: c.id,
        front: c.front,
        status: c.status,
        is_choice: c.is_choice,
        is_multi: c.is_multi === true,
        options: c.options ?? null,
        answer: c.answer ?? null,
        answers: c.answers ?? null,
      })),
    });
  } catch (e) {
    return errorResponse(e, "读取识别情况失败");
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJSON(req);
    const action = String(body.action ?? "");

    if (action === "scan" || action === "judge") {
      const { fragment, rows } = await loadFragment(id);
      if (!fragment) return Response.json({ error: "原文片段不存在" }, { status: 404 });

      // 只对「规则说是候选、但还没对上卡片」的跑 AI：已识别的不用花钱重判
      const pendingRows = rows.filter((r) => !r.card_id);
      const wantedIds =
        action === "judge" && Array.isArray(body.ids)
          ? new Set(body.ids.map((v: unknown) => String(v)))
          : null;
      const targets = wantedIds
        ? pendingRows.filter((r) => wantedIds.has(r.id))
        : pendingRows;

      if (body.ai !== true) {
        // 纯规则重新识别：不调模型，立刻返回（用户点「再次识别」的第一段）
        const scoped = wantedIds
          ? rows.filter((r) => wantedIds.has(r.id) || r.card_id)
          : rows;
        return Response.json({
          ok: true,
          ai: false,
          rows: scoped,
          coverage: coverage(rows),
          note: "规则已重新扫描；没有调用 AI，判定仍待确认",
        });
      }

      const verdicts = await judgeCandidates(targets, fragment.content ?? "");
      if (!verdicts) {
        // AI 不可用：把规则结果原样返回，让界面明确提供人工入口
        return Response.json({
          ok: true,
          ai: false,
          ai_failed: true,
          rows,
          coverage: coverage(rows),
          note: "AI 未能完成判定（未配置或超时），请用下面的「人工录入」补题",
        });
      }

      const merged = applyVerdicts(rows, verdicts);
      const scoped = wantedIds ? merged.filter((r) => wantedIds.has(r.id) || r.card_id) : merged;
      return Response.json({
        ok: true,
        ai: true,
        rows: scoped,
        coverage: coverage(merged),
        judged: verdicts.length,
      });
    }

    if (action === "create") {
      const store = await getStore();
      const frags = await store.listFragments();
      const fragment = frags.find((f) => f.id === id) ?? null;
      if (!fragment) return Response.json({ error: "原文片段不存在" }, { status: 404 });

      const rawItems = Array.isArray(body.items) ? body.items : [body];
      const chapterPath = fragment.heading_path ? [fragment.heading_path] : [];
      const created: Array<{ id: string; front: string; skipped: boolean }> = [];
      const rows: Array<Parameters<typeof store.bulkInsertCards>[0][number]> = [];

      for (const raw of rawItems) {
        const item = normalizeManualCard(raw);
        if (!item) continue;
        const cardId = cardIdFor(fragment.textbook_id, chapterPath, item.front);
        const existing = await store.getCard(cardId);
        if (existing) {
          created.push({ id: cardId, front: item.front, skipped: true });
          continue;
        }
        const isChoice = item.options.length >= 2;
        rows.push({
          id: cardId,
          kind: isChoice ? "choice" : "qa",
          front: item.front,
          back: item.back,
          options: isChoice ? item.options : null,
          answer: isChoice ? item.answer || null : null,
          answers: null,
          is_multi: false,
          status: "draft",
          content_revision: 1,
          content_hash: null,
          generation_job_id: null,
          reviewed_at: null,
          rejected_at: null,
          deleted_at: null,
          source: "original",
          card_type: (isChoice ? "choice" : "qa") as CardType,
          kp_id: null,
          needs_answer: !(item.back || item.answer),
          chapter_path: chapterPath,
          evidence: null,
          question_no: null,
          explanation: null,
          fidelity_status: null,
          fidelity_note: null,
        });
        created.push({ id: cardId, front: item.front, skipped: false });
      }

      if (rows.length > 0) {
        // 用批量插入而不是逐张 createCard：卡片 id 由内容算出（幂等），
        // 重复点「补这张」不会变成两张卡；顺带只写一次盘。
        await store.bulkInsertCards(rows);
        await store.bulkLinkCardSources(
          rows.map((r) => ({ card_id: r.id, source_fragment_id: fragment.id, role: "manual" }))
        );
      }

      if (created.length === 0) {
        return Response.json({ error: "没有可创建的内容（题干太短或格式不对）" }, { status: 400 });
      }
      return Response.json({
        ok: true,
        created,
        inserted: created.filter((c) => !c.skipped).length,
        skipped: created.filter((c) => c.skipped).length,
      });
    }

    return Response.json({ error: "未知操作" }, { status: 400 });
  } catch (e) {
    return errorResponse(e, "识别核对失败");
  }
}
