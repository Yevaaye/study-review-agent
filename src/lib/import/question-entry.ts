// 题目抽取对外的唯一新入口 —— 供 POST /api/import 调用。
//
// 兼容性设计（关键）：
//   · 原有 extractQuestions(md, chapters) 保持同步、签名与返回结构完全不变，
//     继续作为「规则基线」与 blockTypes 来源，因此任何隐藏调用点都不受影响。
//   · 新链路是它的增强：结构化分块 → 候选扫描 → 模型辅助仲裁 → 逐字抽取
//     → 答案关联 → 去重 → 校验，再适配回同一个 ClassifyResult。
//   · 模型失败 / 超时 / 返回畸形 / 新管线异常，一律回退整份规则基线，
//     导入流程绝不因模型而失败；HTTP 层仍是「一次 POST → 一次响应」的同步导入。

import { extractQuestions } from "./classify";
import type { ClassifyResult } from "./classify";
import type { ParsedChapter } from "./markdown";
import { adaptToClassifyResult } from "./question-adapter";
import { createLlmJudge } from "./question-llm";
import { runQuestionPipeline } from "./question-pipeline";
import type { AnswerExpansion } from "./answer-expansion";

export interface QuestionEntryStats {
  degraded: boolean;
  degradeReason: string;
  llmCalls: number;
  chunks: number;
  scannedChunks: number;
  candidates: number;
  questions: number;
}

/** 供诊断用，不含任何配置 / 认证信息，也不落库。 */
let lastStats: QuestionEntryStats | null = null;
export function getLastQuestionStats(): QuestionEntryStats | null {
  return lastStats;
}

/**
 * 本次抽取里「规则层自动补齐答案」的记录。导入路由会把它写进
 * answer_fix_logs —— 每次漏截 / 截断都留痕，后续优化识别准确率有样本可查。
 * 与 lastStats 一样是模块级快照：一次导入一次读取，不会跨请求串味。
 */
let lastExpansions: AnswerExpansion[] = [];
export function getLastAnswerExpansions(): AnswerExpansion[] {
  return lastExpansions;
}

/**
 * 抽取原文已有题目（规则 + 模型辅助仲裁），返回结构与原 extractQuestions 完全一致。
 * 模型默认启用；失败时退化为「与改造前等价」的纯规则结果。
 */
export async function extractQuestionsWithLLM(
  markdown: string,
  chapters: ParsedChapter[]
): Promise<ClassifyResult> {
  // 规则基线先算出来：它是零 token、同步、永不失败的保底结果
  const fallback = extractQuestions(markdown, chapters);

  try {
    const pipeline = await runQuestionPipeline(markdown, {
      // 模型只做「模糊候选」的仲裁，且必须快：超时 6s、不重试、单批 12 个。
      // 规则基线已经把 99% 的题定稿，模型超时就直接用规则结果——
      // 绝不能让它把一次导入拖到 80 秒以上（用户会以为解析失败）。
      judge: createLlmJudge({ timeoutMs: 6000, retries: 0 }),
      maxLlmCalls: 1,
      batchSize: 12,
    });

    lastExpansions = pipeline.expansions ?? [];
    lastStats = {
      degraded: pipeline.stats.degraded,
      degradeReason: pipeline.stats.degradeReason,
      llmCalls: pipeline.stats.llmCalls,
      chunks: pipeline.stats.totalChunks,
      scannedChunks: pipeline.stats.scannedChunks,
      candidates: pipeline.stats.totalCandidates,
      questions: pipeline.stats.finalQuestions,
    };

    // 新管线没抽出题时不覆盖基线（例如全是旧格式、规则更擅长）
    if (pipeline.questions.length === 0) return fallback;
    return adaptToClassifyResult(pipeline, chapters, markdown, fallback);
  } catch {
    // 兜底：任何未预期的异常都不能让导入失败
    lastExpansions = [];
    lastStats = {
      degraded: true,
      degradeReason: "题目抽取管线异常，已回退规则",
      llmCalls: 0,
      chunks: 0,
      scannedChunks: 0,
      candidates: 0,
      questions: fallback.questions.length,
    };
    return fallback;
  }
}
