import { getStore } from "@/lib/db/store";
import { parseMarkdown } from "@/lib/import/markdown";
import { normalizeMarkdownHeadings } from "@/lib/import/normalize";
import {
  classifyText,
  mergePseudoQuestionChapters,
} from "@/lib/import/classify";
import {
  extractQuestionsWithLLM,
  getLastAnswerExpansions,
} from "@/lib/import/question-entry";
import { cardIdFor, kpIdFor } from "@/lib/cards/identity";
import { buildRuleFixLogs } from "@/lib/cards/answer-fix-log";
import { buildAnswerFields, parseAnswerKeys } from "@/lib/cards/answer-keys";
import { extractRuleKnowledgePoints, bindQuestionsToKps } from "@/lib/knowledge/rule";
import { errorResponse, readJSON, requireFields } from "@/lib/http";
import { createJob, failJob, finishJob, getJob, startTicker, updateJob } from "@/lib/jobs";
import type { Card, CardType, SourceFragment } from "@/lib/db/types";
import type { ParseResult } from "@/lib/import/markdown";

export const dynamic = "force-dynamic";
// 抽原题要调模型，可能几十秒。这条是后台任务，但路由本身仍需声明足够预算。
export const maxDuration = 300;

// 解析器版本唯一真源：textbook 与 import_job 必须引用同一常量。
// 本次改造新增了「原题抽取」，解析产物结构变了，版本必须推进 ——
// 否则无法区分「旧解析留下的片段」和「新解析能抽出原题的片段」。
const PARSER_VERSION = "markdown-v3-classify";

/** 后台导入需要的一切：请求层已经算好的东西全部带进来，避免重复解析 */
interface ImportInput {
  jobId: string;
  title: string;
  markdown: string;
  normalized: string;
  parsed: ParseResult;
  content_hash: string;
  meta: { author?: unknown; subject?: unknown; file_name?: unknown };
}

/**
 * 导入 Markdown：解析分章 → 切片 → **规则抽原题** → 建 import_job。
 *
 * ⚠️ 2026-11 起这条接口**不再同步返回结果**，而是立刻回 202 + job_id。
 *
 * 为什么改：原题抽取要调模型（10~40 秒），同步接口下浏览器一直在等，
 * 页面只有按钮上三个字「处理中…」—— 用户不知道是慢还是死，
 * 中途切到别的页面再回来，整段状态直接没了（组件卸载、结果丢失），
 * 而材料其实已经写进库了，重新导入又被「已导入过」挡住。
 * 现在进度、结果都存在服务端任务表里（与出题任务同一套），
 * 页面切成什么样都能通过 /api/jobs 把状态找回来。
 */
export async function POST(req: Request) {
  try {
    const body = await readJSON(req);
    requireFields(body, ["title", "markdown"]);

    const title = String(body.title);
    const markdown = String(body.markdown);

    // 解析前先做一次标题层级归一：标准写法 `# 章 / ## 节` 会被
    // 「## 无条件成章」的规则破坏（# 章变空壳后被清理）。归一只是把
    // `##` 降成 `###`，不碰解析器内部，也不改标题文字。
    const normalized = normalizeMarkdownHeadings(markdown);
    const parsed = parseMarkdown(normalized);
    const content_hash = parsed.content_hash;

    // 重复导入拦截：内容哈希相同说明这份材料已经在库里。
    // 拒绝而不是「再导一遍」—— 再导一遍会让同一道题出现两次，
    // 而用户看到的只是「审核台里多了一倍草稿」，很难察觉。
    const store = await getStore();
    const existing = (await store.listTextbooks()).find(
      (t) => t.content_hash === content_hash && !t.archived_at
    );
    if (existing) {
      return Response.json(
        {
          error: `这份材料已经导入过了（《${existing.title}》）。如需重新生成，请在资料库中删除后重试。`,
          duplicate: true,
          textbook_id: existing.id,
        },
        { status: 409 }
      );
    }

    // 抽取原题是最慢的一段；按字数给一个初值，跑起来后由真实阶段覆盖
    const eta = Math.min(90000, Math.max(12000, Math.ceil(markdown.length / 4000) * 4000));
    const job = createJob({
      kind: "import-parse",
      title: `导入《${title}》`,
      href: "/import",
      eta_ms: eta,
    });

    void runImport({
      jobId: job.id,
      title,
      markdown,
      normalized,
      parsed,
      content_hash,
      meta: { author: body.author, subject: body.subject, file_name: body.file_name },
    });

    return Response.json(
      {
        async: true,
        job_id: job.id,
        title,
        // 前端据此知道「这一次导入是我发起的」，切页回来还能认出来
        started_at: job.started_at,
      },
      { status: 202 }
    );
  } catch (e) {
    return errorResponse(e, "导入失败");
  }
}

/**
 * 回查一次导入的持久化状态。
 *
 * 存在的理由：进度条依赖的 /api/jobs 是**进程内存**表，任务结束 90 秒后就被清掉、
 * 进程重启更是全没。用户在导入完成很久之后回到导入页，就会看到「进度查不到了，
 * 材料也许已经进库」——而 import_jobs 里明明有 finished_at 与 result_summary。
 * 所以任务查不到时先来这里按同一个 id 回查数据库，能查到就直接还原结果。
 *
 * 「未完成但内存里没有这个任务」= 解析被中断（重启/崩溃），
 * 不能继续假装还在跑，返回 error + 说明，让页面给用户一个确定结论。
 */
export async function GET(req: Request) {
  try {
    const jobId = new URL(req.url).searchParams.get("job_id");
    if (!jobId) return Response.json({ error: "缺少 job_id" }, { status: 400 });

    const store = await getStore();
    const row = await store.getImportJob(jobId);
    // 查不到有两种可能：不是本机导入的 id，或这次导入连任务行都没写进去。
    if (!row) return Response.json({ found: false }, { status: 404 });

    const textbook = await store.getTextbook(row.textbook_id);
    const live = getJob(row.id);
    const summary = (row.result_summary ?? {}) as Record<string, unknown>;

    const failed = row.stage === "failed";
    const interrupted = !failed && !row.finished_at && !live;
    const status: "running" | "done" | "error" = failed || interrupted
      ? "error"
      : row.finished_at
        ? "done"
        : "running";

    return Response.json(
      {
        found: true,
        id: row.id,
        status,
        stage: row.stage,
        /** 内存里已没有这个任务、库里也没写完 —— 就是被打断了 */
        interrupted,
        started_at: row.created_at ? Date.parse(row.created_at) : undefined,
        finished_at: row.finished_at ? Date.parse(row.finished_at) : undefined,
        error:
          row.error ??
          (interrupted
            ? "这次导入在服务端中断了（服务重启或崩溃），没拿到最终结果。材料可能已入库，请先去资料库确认。"
            : undefined),
        result: {
          // 与 finishJob 的 result 同形，前端 fromJobResult 直接能吃
          ...summary,
          import_job_id: row.id,
          textbook_id: row.textbook_id,
          textbook_title: textbook?.title,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return errorResponse(e, "查询导入状态失败");
  }
}

/**
 *
 * 每一步都 updateJob：页面上那根进度条的文字就来自这里，
 * 所以文案要写「正在写入片段」这种用户看得懂的动作，而不是内部函数名。
 */
async function runImport(input: ImportInput): Promise<void> {
  const { jobId } = input;
  const stopTicker = startTicker(jobId, 6, 88);
  const store = await getStore();
  let importJobId: string | null = null;

  try {
    updateJob(jobId, {
      phase: "建立材料",
      message: "正在创建材料与导入任务…",
      percent: 8,
    });

    const chapters = mergePseudoQuestionChapters(input.parsed.chapters);

    const textbook = await store.createTextbook({
      title: input.title,
      author: input.meta.author ? String(input.meta.author) : null,
      // 与手工建书（POST /api/books）保持一致：允许导入时带学科，缺省仍为 null。
      // 早期写死 null，导致「导入的书没有 subject、手工建的书有」，
      // 任何按学科过滤/分组的下游逻辑都会把两类书拆开。
      subject: input.meta.subject ? String(input.meta.subject) : null,
      source_format: "markdown",
      original_file_name: input.meta.file_name ? String(input.meta.file_name) : null,
      storage_key: null,
      mime_type: "text/markdown",
      file_size_bytes: Buffer.byteLength(input.markdown, "utf8"),
      content_hash: input.content_hash,
      parser_version: PARSER_VERSION,
      raw_text: input.markdown,
      source_version: 1,
      status: "ready",
      imported_at: new Date().toISOString(),
      archived_at: null,
    });

    const job = await store.createImportJob({
      // ⚠️ 主键刻意复用内存任务 id。前端只认得 /api/import 回给它的那个 job_id，
      // 进程重启后内存任务表空了，若两边 id 不同，前端拿着 jobId 既查不到内存、
      // 也查不到库，只能判「进度丢了」——而 import_jobs 里其实躺着
      // finished_at / result_summary（这次导入明明成功了）。同一个 id 才能回查。
      id: jobId,
      textbook_id: textbook.id,
      input_hash: input.content_hash,
      attempt_count: 1,
      stage: "parsing",
      progress: 0,
      stage_started_at: new Date().toISOString(),
      detail: null,
      error: null,
      parser_version: PARSER_VERSION,
      model: null,
      result_summary: null,
      finished_at: null,
    });
    importJobId = job.id;

    updateJob(jobId, {
      phase: "写入片段",
      message: `已切分 ${chapters.length} 章，正在写入原文片段…`,
      percent: 18,
    });

    // 落章节 + 片段（顺带给每个片段打 fragment_type）
    //
    // 片段必须批量写：这本书 2501 个片段，逐条 createFragment 每条都要
    // 全量序列化 db.json + 备份 + rename，实测 84 秒才导完，用户以为卡死。
    // 现在先全部收集，最后 bulkInsertFragments 只落一次盘。
    const chapterIdByIndex: string[] = [];
    const fragsByChapter = new Map<string, Array<{ id: string; content: string }>>();
    const pendingFrags: Array<{
      chapterId: string;
      row: Omit<SourceFragment, "id">;
    }> = [];
    let fragIndex = 0;

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const chapter = await store.createChapter({
        textbook_id: textbook.id,
        title: ch.title,
        page_start: null,
        page_end: null,
        sort_order: i,
      });
      chapterIdByIndex.push(chapter.id);
      fragsByChapter.set(chapter.id, []);

      for (const frag of ch.fragments) {
        pendingFrags.push({
          chapterId: chapter.id,
          row: {
            textbook_id: textbook.id,
            chapter_id: chapter.id,
            fragment_index: fragIndex++,
            heading_path: frag.heading_path ?? ch.heading_path,
            paragraph_index: frag.paragraph_index,
            page_start: null,
            page_end: null,
            char_start: null,
            char_end: null,
            locator: frag.locator,
            content: frag.content,
            content_hash: null,
            fragment_type: classifyText(frag.content),
            question_no: null,
          },
        });
      }
    }

    const insertedFrags = await store.bulkInsertFragments(pendingFrags.map((p) => p.row));
    insertedFrags.forEach((row, idx) => {
      const cid = pendingFrags[idx].chapterId;
      fragsByChapter.get(cid)?.push({ id: row.id, content: row.content });
    });

    updateJob(jobId, {
      phase: "抽取原题",
      message: `正在从 ${fragIndex} 个片段中抽取原题（这一步要调模型，最慢）…`,
      percent: 42,
    });

    // 原题抽取：规则基线 + 模型辅助仲裁（失败自动降级）
    const { questions } = await extractQuestionsWithLLM(input.normalized, chapters);

    updateJob(jobId, {
      phase: "提炼知识点",
      message: "按原文结构提炼知识点并挂靠原题…",
      percent: 68,
    });

    // 规则提炼知识点（零 token）+ 原题挂靠
    //
    // 这一步放在「建卡片之前」是关键：知识点是卡片的容器，先有容器才能挂。
    // 之前知识点完全依赖 AI，于是「只收录」模式和 AI 超时时，章节页就是
    // 「知识点 0 条 + 8 张卡 + 41 题未关联」—— 用户既看不懂也没法补题。
    const ruleKps = extractRuleKnowledgePoints(chapters);
    const kpIds = ruleKps.map((k) => kpIdFor(textbook.id, k.chapter_path, k.statement));
    const nowISO = new Date().toISOString();
    if (ruleKps.length > 0) {
      await store.bulkInsertKnowledgePoints(
        ruleKps.map((k, i) => ({
          id: kpIds[i],
          textbook_id: textbook.id,
          chapter_id: chapterIdByIndex[k.chapterIndex] ?? chapterIdByIndex[0],
          chapter_path: k.chapter_path,
          title: k.statement.slice(0, 60),
          statement: k.statement,
          evidence: k.evidence,
          summary: null,
          content: null,
          sort_order: k.sort_order,
          source_fragment_id: null,
          last_generated_at: null,
          deleted_at: null,
          created_at: nowISO,
        }))
      );
    }
    const kpBinding = bindQuestionsToKps(questions, ruleKps);

    const rows: Array<Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: string }> = [];
    const links: Array<{ card_id: string; source_fragment_id: string }> = [];

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const chapter = chapters[q.chapterIndex];
      const chapterId = chapterIdByIndex[q.chapterIndex];
      if (!chapter || !chapterId) continue;

      const chapterPath = [chapter.title];
      const id = cardIdFor(textbook.id, chapterPath, q.front);

      // 判断题统一成「对/错」两选项，复习界面按选择题渲染，不需要额外分支
      const options =
        q.type === "choice" ? (q.options ?? null) : q.type === "judge" ? ["对", "错"] : null;
      const back = q.back;

      /*
       * 答案归一：把「A」「①②③」「A、C」「选项全文」统一解析成选项下标。
       *
       * 多选是这版的改造点：原文写「①②③」「A、C」「AC」时，旧逻辑把整串原样
       * 存进 answer，复习页按「整串等于某个选项」比对，永远匹配不上 ——
       * 结果是三个正确项一个都不高亮，用户以为答案丢了。
       * 现在解析出多个下标就落 answers（全文数组）+ answer（字母列表），
       * 复习页据此渲染多选并做集合判定。
       */
      let answerText: string | null = q.answer || back || null;
      let answersTexts: string[] | null = null;
      let isMulti = false;
      if (options && options.length >= 2) {
        const parsedAnswer = parseAnswerKeys(q.answer, options);
        if (parsedAnswer.multi) {
          const fields = buildAnswerFields(options, parsedAnswer.keys);
          answerText = fields.answer;
          answersTexts = fields.answers;
          isMulti = fields.is_multi;
        } else if (parsedAnswer.keys.length === 1) {
          // 单选：统一存选项全文，界面提示「正确答案是 …」才不会出现一个孤零零的字母
          answerText = options[parsedAnswer.keys[0]];
        }
      }

      rows.push({
        id,
        kind: options ? "choice" : "qa",
        front: q.front,
        back,
        options,
        answer: q.type === "choice" || q.type === "judge" ? answerText : null,
        answers: answersTexts,
        is_multi: isMulti,
        status: "draft",
        content_revision: 1,
        content_hash: null,
        generation_job_id: job.id,
        reviewed_at: null,
        rejected_at: null,
        deleted_at: null,
        source: "original",
        card_type: q.type as CardType,
        // 自动挂靠到本章最相关的知识点；挂不上就挂本章第一条。
        // 留 null 会让审核台出现「未关联（41 题）」这种没人想去点第二遍的东西。
        kp_id: kpBinding[qi] >= 0 ? kpIds[kpBinding[qi]] : null,
        needs_answer: q.needs_answer,
        chapter_path: chapterPath,
        evidence: null,
        question_no: q.no,
        explanation: q.explanation ?? null,
        // 保真核对：题干/选项/答案能否在原文逐字找到。审核台据此提示「需核对原文」。
        fidelity_status: q.fidelity?.status ?? null,
        fidelity_note: q.fidelity?.note ?? null,
      });

      // 定位到具体片段：优先找包含题干文字的片段，退化为该章第一个片段
      const pool = fragsByChapter.get(chapterId) ?? [];
      const probe = q.front.replace(/\s+/g, "").slice(0, 18);
      const hit =
        pool.find((f) => f.content.replace(/\s+/g, "").includes(probe)) ?? pool[0] ?? null;
      if (hit) links.push({ card_id: id, source_fragment_id: hit.id });
    }

    updateJob(jobId, {
      phase: "写入卡片",
      message: `正在写入 ${rows.length} 张卡片…`,
      percent: 88,
    });

    const inserted = await store.bulkInsertCards(rows);
    await store.bulkLinkCardSources(links);

    // 规则层自动补齐的答案（「答案：摘要句」→ 同段落完整答案）逐条留痕。
    // 这些是识别准确率的迭代样本：原因、前后文本、原文摘录都在，可复盘。
    const expansions = getLastAnswerExpansions();
    if (expansions.length > 0) {
      const idByFront = new Map(rows.map((r) => [r.front, r.id]));
      await store.createAnswerFixLogs(buildRuleFixLogs(expansions, textbook.id, idByFront));
    }

    // 标记完成（待用户校正 / 决定要不要 AI 补题）
    const questionCount = questions.length;
    const missingAnswer = questions.filter((q) => q.needs_answer).length;
    // 按题型分账：用户最关心的就是「我那 15 道选择题到底收进来没有」，
    // 只报一个总数等于让他再去审核台一张张数。
    const byType = { choice: 0, qa: 0, cloze: 0, judge: 0 };
    for (const q of questions) byType[q.type]++;
    const typeLine = [
      byType.choice ? `选择 ${byType.choice}` : "",
      byType.qa ? `问答 ${byType.qa}` : "",
      byType.cloze ? `填空 ${byType.cloze}` : "",
      byType.judge ? `判断 ${byType.judge}` : "",
    ]
      .filter(Boolean)
      .join(" / ");

    await store.updateImportJob(job.id, {
      stage: "review_required",
      progress: 100,
      finished_at: new Date().toISOString(),
      detail:
        `已切分 ${chapters.length} 章、${fragIndex} 个片段；` +
        `收录原题 ${inserted.inserted} 道` +
        (typeLine ? `（${typeLine}）` : "") +
        (ruleKps.length > 0 ? `，提炼知识点 ${ruleKps.length} 条` : "") +
        (inserted.skipped > 0 ? `，跳过重复 ${inserted.skipped}` : "") +
        (missingAnswer > 0 ? `，${missingAnswer} 道缺答案` : ""),
      result_summary: {
        chapter_count: chapters.length,
        fragment_count: fragIndex,
        original_card_count: inserted.inserted,
        original_skipped: inserted.skipped,
        question_count: questionCount,
        needs_answer: missingAnswer,
        by_type: byType,
        knowledge_point_count: ruleKps.length,
      },
    });

    finishJob(jobId, {
      textbook_id: textbook.id,
      textbook_title: textbook.title,
      import_job_id: job.id,
      chapter_count: chapters.length,
      fragment_count: fragIndex,
      original_card_count: inserted.inserted,
      original_skipped: inserted.skipped,
      question_count: questionCount,
      needs_answer: missingAnswer,
      knowledge_point_count: ruleKps.length,
      by_type: byType,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (importJobId) {
      // 材料/章节可能已经写进去了：标成失败，用户可在资料库用「生成卡片」续跑
      await store
        .updateImportJob(importJobId, {
          stage: "failed",
          error: msg,
          finished_at: new Date().toISOString(),
        })
        .catch(() => undefined);
    }
    failJob(jobId, msg || "导入失败");
  } finally {
    stopTicker();
  }
}
