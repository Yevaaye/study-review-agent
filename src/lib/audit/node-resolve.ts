/**
 * 把一张卡还原成「在知识树里的位置」——台账里的 node 字段。
 *
 * 这一步是台账能不能用的分水岭：只记 card_id 等于没记，
 * 监督员拿到一串 uuid 既不能按书分组、也不能判断「是不是整章都烂」。
 * 所以宁可多查三次库，也要把书 / 章节 / 知识点 / 原文定位全部填上。
 *
 * 取不到一律 null，不做兜底猜测：null 本身就是结论
 * （「这张卡没绑知识点」= 抽取环节没对上，属于要改的地方）。
 */

import type { CardStore } from "../db/store";
import type { AuditNodeRef, Card } from "../db/types";
import { describeNode } from "./ledger-model";

export async function resolveCardNode(store: CardStore, card: Card): Promise<AuditNodeRef> {
  let sources: Awaited<ReturnType<CardStore["listCardSources"]>> = [];
  try {
    sources = await store.listCardSources(card.id);
  } catch {
    /* 来源表坏了也要能记台账，退化成「无片段」 */
  }

  const textbookId = sources.find((s) => s.textbook_id)?.textbook_id ?? null;
  const chapterId = sources.find((s) => s.chapter_id)?.chapter_id ?? null;

  const [textbook, chapter, kp] = await Promise.all([
    textbookId ? store.getTextbook(textbookId).catch(() => null) : Promise.resolve(null),
    chapterId ? store.getChapter(chapterId).catch(() => null) : Promise.resolve(null),
    card.kp_id ? store.getKnowledgePoint(card.kp_id).catch(() => null) : Promise.resolve(null),
  ]);

  return describeNode({
    card,
    textbook: textbook ?? null,
    chapter: chapter ?? null,
    kp: kp ?? null,
    fragments: sources,
  });
}
