// 核对清单导出 —— 按「材料 → 章节 → 知识点 → 题目」把结构摊平成 Markdown。
//
// 为什么需要导出而不是只在页面上看：
//   用户要核对的是「这一章提炼出的知识点，对应的题是不是真的考它、措辞是不是原文」。
//   这件事在页面上要一层层点开，在手机上更是点不动；导成一份清单后，可以打印、
//   可以贴进笔记、可以逐条打勾。核对这件事必须能离开屏幕进行。
//
// 输出刻意做成 Markdown 纯文本，不依赖任何格式能力：
//   · 章节标题 + 本章保真统计
//   · 每条知识点：陈述 + 原文依据 + 该知识点下的题目（题干 / 选项 / 答案 / 保真状态 / 来源）
//   · 末尾附「未关联知识点的题」和「有保真问题的题」，方便优先处理

import { getStore } from "@/lib/db/store";
import type { Card, KnowledgePoint } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  choice: "选择题",
  qa: "问答",
  cloze: "填空",
  judge: "判断题",
  contrast: "对比",
};

function oneLine(s: string, max = 200): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function fidelityMark(c: Card): string {
  if (c.fidelity_status === "missing") return " ⚠️原文未找到";
  if (c.fidelity_status === "partial") return " △部分匹配";
  return "";
}

function renderCard(c: Card, indent: string): string[] {
  const lines: string[] = [];
  const no = c.question_no != null ? `${c.question_no}. ` : "";
  const origin = c.source === "ai_generated" ? "AI" : "原文";
  const type = TYPE_LABEL[c.card_type ?? (c.kind === "choice" ? "choice" : "qa")] ?? "问答";
  lines.push(`${indent}- **[${origin}·${type}]** ${no}${oneLine(c.front, 300)}${fidelityMark(c)}`);

  if (c.options && c.options.length > 0) {
    for (let i = 0; i < c.options.length; i++) {
      const isAns = c.answer ? c.options[i].replace(/^[A-D][.、．]\s*/, "") === c.answer : false;
      lines.push(`${indent}  - ${isAns ? "**✅** " : ""}${oneLine(c.options[i], 160)}`);
    }
  }
  if (c.back) lines.push(`${indent}  - 答案：${oneLine(c.back, 300)}`);
  if (c.evidence) lines.push(`${indent}  - 依据：${oneLine(c.evidence, 160)}`);
  if (c.answer_origin === "ai") {
    lines.push(
      `${indent}  - 答案来源：AI 补写${c.answer_grounded === false ? "（原文无依据，建议核对）" : "（已对原文）"}`
    );
  }
  if (c.fidelity_note) lines.push(`${indent}  - 保真：${c.fidelity_note}`);
  return lines;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const textbookId = url.searchParams.get("textbookId");
  const chapterId = url.searchParams.get("chapterId");
  const asJson = url.searchParams.get("format") === "json";

  const store = await getStore();

  // 定位材料：显式 textbookId > 单章反查 > 全部
  let textbook = textbookId ? await store.getTextbook(textbookId) : null;
  if (!textbook && chapterId) {
    const ch = await store.getChapter(chapterId);
    if (ch) textbook = await store.getTextbook(ch.textbook_id);
  }

  const chapters = (await store.listChapters(textbook?.id)).filter((ch) =>
    chapterId ? ch.id === chapterId : true
  );
  const cards = await store.listCards({ textbookId: textbook?.id });
  const kps = await store.listKnowledgePoints({ textbookId: textbook?.id });

  // 只为按 chapter 分组用的卡片归属：卡片自带 chapter_path，但那是标题路径；
  // 用 kp 反查更可靠 —— 卡必挂 kp（挂不上的进未关联区）
  const kpById = new Map<string, KnowledgePoint>(kps.map((k) => [k.id, k]));
  const kpsByChapter = new Map<string, KnowledgePoint[]>();
  for (const k of kps) {
    if (!k.chapter_id) continue;
    const arr = kpsByChapter.get(k.chapter_id) ?? [];
    arr.push(k);
    kpsByChapter.set(k.chapter_id, arr);
  }

  const cardsByKp = new Map<string, Card[]>();
  const unbound: Card[] = [];
  for (const c of cards) {
    if (c.deleted_at) continue;
    if (c.kp_id && kpById.has(c.kp_id)) {
      const arr = cardsByKp.get(c.kp_id) ?? [];
      arr.push(c);
      cardsByKp.set(c.kp_id, arr);
    } else {
      unbound.push(c);
    }
  }

  const sortCards = (arr: Card[]) =>
    [...arr].sort((a, b) => (a.question_no ?? 9999) - (b.question_no ?? 9999));

  const structure = chapters.map((ch) => {
    const owned = cards.filter(
      (c) => !c.deleted_at && (kpsByChapter.get(ch.id) ?? []).some((k) => k.id === c.kp_id)
    );
    const chapterKps = (kpsByChapter.get(ch.id) ?? []).sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    return {
      chapter: ch,
      stats: {
        exact: owned.filter((c) => c.fidelity_status === "exact").length,
        partial: owned.filter((c) => c.fidelity_status === "partial").length,
        missing: owned.filter((c) => c.fidelity_status === "missing").length,
        ai: owned.filter((c) => c.source === "ai_generated").length,
        total: owned.length,
      },
      kps: chapterKps.map((k) => ({
        kp: k,
        cards: sortCards(cardsByKp.get(k.id) ?? []),
      })),
    };
  });

  if (asJson) {
    return Response.json({
      textbook: textbook?.title ?? null,
      exported_at: new Date().toISOString(),
      chapters: structure.map((s) => ({
        chapter: { id: s.chapter.id, title: s.chapter.title, sort_order: s.chapter.sort_order },
        stats: s.stats,
        knowledge_points: s.kps.map((x) => ({
          id: x.kp.id,
          statement: x.kp.statement ?? x.kp.title,
          evidence: x.kp.evidence ?? null,
          cards: x.cards.map((c) => ({
            id: c.id,
            question_no: c.question_no ?? null,
            source: c.source ?? null,
            card_type: c.card_type ?? null,
            front: c.front,
            options: c.options ?? null,
            answer: c.answer ?? c.back ?? null,
            evidence: c.evidence ?? null,
            fidelity_status: c.fidelity_status ?? null,
            fidelity_note: c.fidelity_note ?? null,
          })),
        })),
      })),
      unbound_cards: unbound.map((c) => ({ id: c.id, question_no: c.question_no ?? null, front: c.front })),
    });
  }

  // ---- Markdown ----
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const out: string[] = [];
  out.push(`# 核对清单 · ${textbook?.title ?? "（未指定材料）"}`);
  out.push("");
  const totExact = structure.reduce((a, s) => a + s.stats.exact, 0);
  const totPartial = structure.reduce((a, s) => a + s.stats.partial, 0);
  const totMissing = structure.reduce((a, s) => a + s.stats.missing, 0);
  const totCards = structure.reduce((a, s) => a + s.stats.total, 0);
  out.push(
    `> 导出时间 ${stamp} · ${chapters.length} 章 · ${kps.length} 条知识点 · ${totCards} 道题  ` +
      `原文逐字 ${totExact} · 部分匹配 ${totPartial} · 原文未找到 ${totMissing}` +
      (unbound.length > 0 ? ` · 未关联知识点 ${unbound.length} 题` : "")
  );
  out.push("");
  out.push("图例：`[原文·选择题]` = 从原文抽出的题；`[AI·问答]` = 按知识点生成；`✅` = 正确答案；`⚠️原文未找到` = 字面在对不上原文，需人工核对。");
  out.push("");

  for (const s of structure) {
    out.push(`## 第 ${s.chapter.sort_order + 1} 章　${s.chapter.title}`);
    out.push("");
    out.push(
      `本章 ${s.kps.length} 条知识点 · ${s.stats.total} 道题（原文逐字 ${s.stats.exact} / 部分匹配 ${s.stats.partial} / 未找到 ${s.stats.missing} / AI 生成 ${s.stats.ai}）`
    );
    out.push("");

    if (s.kps.length === 0) {
      out.push("_本章没有知识点。_");
      out.push("");
      continue;
    }

    s.kps.forEach((x, ki) => {
      out.push(`### ${ki + 1}. ${oneLine(x.kp.statement ?? x.kp.title, 300)}`);
      if (x.kp.evidence) out.push(`原文依据：${oneLine(x.kp.evidence, 300)}`);
      out.push("");
      if (x.cards.length === 0) {
        out.push("_该知识点还没有题。_");
        out.push("");
        return;
      }
      for (const c of x.cards) out.push(...renderCard(c, ""));
      out.push("");
    });
  }

  if (unbound.length > 0) {
    out.push(`## 未关联知识点的题（${unbound.length}）`);
    out.push("");
    out.push("这些题在原文里有，但没能对应到任何知识点。可在章节页手动归属。");
    out.push("");
    for (const c of sortCards(unbound)) out.push(...renderCard(c, ""));
    out.push("");
  }

  const problems = cards.filter(
    (c) => !c.deleted_at && (c.fidelity_status === "missing" || c.fidelity_status === "partial")
  );
  if (problems.length > 0) {
    out.push(`## 需要优先核对的题（${problems.length}）`);
    out.push("");
    out.push("这些题的题干 / 选项 / 答案在原文里没能完整逐字找到，可能是多行拼接，也可能被改写了。");
    out.push("");
    for (const c of sortCards(problems)) out.push(...renderCard(c, ""));
  }

  const md = out.join("\n");
  const filename = `核对清单-${(textbook?.title ?? "材料").replace(/[\\/:*?"<>|\s]+/g, "_")}-${now
    .toISOString()
    .slice(0, 10)}.md`;

  return new Response(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
