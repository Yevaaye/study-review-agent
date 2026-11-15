import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/db/store";
import { errorResponse } from "@/lib/http";
import { expandAnswersFromContext } from "@/lib/import/answer-expansion";
import { buildRuleFixLogs } from "@/lib/cards/answer-fix-log";
import type { UnifiedQuestion } from "@/lib/import/question-types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 存量卡片的答案批量回填（一次性运维 / 也可重复调用，幂等）。
 *
 * 背景：新导入链路已经会把「答案：摘要句 + 后一段完整答案」补齐，但之前导入的
 * 卡片仍是截断版。删库重导会丢掉审核状态与 FSRS 排期，所以这里只按该卡所属
 * 章节的原文片段做一次确定性回填，只改 back，不动状态机。
 *
 * 逻辑直接复用 expandAnswersFromContext —— 与导入时同一套判据，不会出现两套规则。
 * 每次修正都写 answer_fix_logs；已修过的 (card_id, after) 不重复写。
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const textbookId = url.searchParams.get("textbookId") || undefined;
    const dryRun = url.searchParams.get("dryRun") === "1";

    const store = await getStore();
    const cards = await store.listCards(textbookId ? { textbookId } : undefined);
    const allFrags = await store.listFragments();
    const allLinks = await store.listAllCardSources();
    // 只防「同一次调用里同一张卡被多个章节重复处理」；不能拿历史台账当拦截条件 ——
    // 卡片可能后来又被编辑回截断版，那时必须能再修一次。跨调用幂等靠下面
    // 「after === back 就跳过」：修完后 back 已是完整版，扩展判据自然不再命中。
    const done = new Set<string>();

    const fragById = new Map(allFrags.map((f) => [f.id, f]));
    const byChapter = new Map<string, string[]>();
    for (const f of allFrags) {
      if (!f.chapter_id || !f.content?.trim()) continue;
      const list = byChapter.get(f.chapter_id) ?? [];
      list.push(f.content);
      byChapter.set(f.chapter_id, list);
    }
    const chaptersByCard = new Map<string, Set<string>>();
    for (const link of allLinks) {
      const ch = fragById.get(link.source_fragment_id)?.chapter_id;
      if (!ch) continue;
      const set = chaptersByCard.get(link.card_id) ?? new Set<string>();
      set.add(ch);
      chaptersByCard.set(link.card_id, set);
    }

    const drafts: ReturnType<typeof buildRuleFixLogs> = [];
    let scanned = 0;
    let updated = 0;

    for (const card of cards) {
      const back = (card.back ?? "").trim();
      if (back.length < 8) continue;
      const chapters = chaptersByCard.get(card.id);
      if (!chapters?.size) continue;
      scanned++;

      const contents = [...chapters].flatMap((c) => byChapter.get(c) ?? []);
      if (contents.length === 0) continue;
      const pseudoMd = contents.join("\n\n");

      // 只借用扩展判据，不产出题目；返回对象里的 answer 就是补齐后的答案
      const pseudo = {
        question_text: card.front,
        answer: back,
        needs_answer: false,
        flags: [],
      } as unknown as UnifiedQuestion;
      const result = expandAnswersFromContext([pseudo], pseudoMd);
      const expansion = result.expansions[0];
      if (!expansion) continue;
      const after = result.questions[0].answer.trim();
      if (!after || after === back || done.has(`${card.id}::${after}`)) continue;

      done.add(`${card.id}::${after}`);
      const chapterId = [...chapters][0];
      const tbId = allFrags.find((f) => f.chapter_id === chapterId)?.textbook_id ?? null;
      drafts.push(
        ...buildRuleFixLogs(
          [{ ...expansion, question: card.front, before: back, after }],
          tbId,
          new Map([[card.front, card.id]])
        )
      );
      if (!dryRun) {
        const ok = await store.updateCard(card.id, { back: after });
        if (!ok) continue;
      }
      updated++;
    }

    if (!dryRun && drafts.length > 0) {
      await store.createAnswerFixLogs(drafts);
      revalidatePath("/cards");
      revalidatePath("/review");
    }

    return Response.json({ ok: true, scanned, updated, dryRun, logged: drafts.length });
  } catch (e) {
    return errorResponse(e, "批量回填失败");
  }
}
