// 题目抽取管线内部类型 —— 纯类型定义，无运行时依赖。
//
// 这里刻意独立于 db/types.ts 与 classify.ts：新管线的结构化输出不落库、不外泄，
// 只在 question-adapter.ts 里转换成既有 ExtractedQuestion，保证下游零改动。

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "quote"
  | "code"
  | "blank";

export type QuestionType = "choice" | "qa" | "cloze" | "judge";

/** 一个 Markdown 内容块，位置为原文字符偏移（半开区间 [start, end)）。 */
export interface MarkdownBlock {
  id: string;
  kind: BlockKind;
  /** 块内原始文本（保留行内 Markdown 标记） */
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** 标题层级 1-6；非标题为 0 */
  headingLevel: number;
  /** 当前所处的标题路径（由外到内） */
  headingPath: string[];
}

/** 抽取专用分块：只在本模块内使用，绝不写入 source_fragments。 */
export interface QuestionChunk {
  chunkId: string;
  index: number;
  blocks: MarkdownBlock[];
  /** 前一块的尾部内容，仅作上下文，不参与抽题（避免重叠导致重复出题） */
  contextBlocks: MarkdownBlock[];
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  chapterPath: string[];
  prevChunkId: string | null;
  nextChunkId: string | null;
}

/** 规则扫描发现的候选题目；规则只负责「发现」，不负责定性。 */
export interface QuestionCandidate {
  id: string;
  chunkId: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** 命中的规则信号，如 question_no / option / ask / cloze / judge / answer / table */
  signals: string[];
  excerpt: string;
  context: string;
  confidence: number;
  /** 边界模糊 / 跨段落 / 题型不明，需要模型仲裁 */
  needsLlm: boolean;
}

/** 统一输出结构（对齐任务书第六节）。 */
export interface UnifiedQuestion {
  question_text: string;
  question_type: QuestionType;
  options: string[];
  answer: string;
  explanation: string;
  chapter_path: string[];
  source_chunk_id: string;
  source_start: number;
  source_end: number;
  source_evidence: string;
  confidence: number;
  review_required: boolean;
  /** 适配 ExtractedQuestion 所需的内部字段，不外泄到卡片结构 */
  no: number | null;
  needs_answer: boolean;
  /** 模型给出的答案区引用（题号/明确引用），仅供答案关联使用 */
  answer_ref?: string;
  /** 合并重复题时保留的全部来源 */
  sources: string[];
  /** 校验发现的问题 */
  flags: string[];
  /** 审核轨迹：规则信号 + 模型理由，供人工复核（不落库、不进卡片结构） */
  audit_trail?: QuestionAuditTrail;
}

/** 模型裁决：只允许给判断与定位，不允许携带任何题干/选项/答案文本。 */
export interface LlmVerdict {
  candidateIndex: number;
  is_question: boolean;
  question_type?: QuestionType;
  /** 建议的题目边界（原文行号，含端点） */
  start_line?: number;
  end_line?: number;
  /** 答案/解析区的题号或明确引用，供 reconcile 优先匹配 */
  answer_ref?: string;
  confidence?: number;

  // ---- 选项组证真 / 证伪（spec: ai_audit_layer）----
  // 只对「数字/圈号条目」候选有意义：它们既可能是选项，也可能是题号清单、
  // 解析步骤、答案要点。规则层拿不准的交给模型结合上下文与表现形式裁定。
  /** 这组条目到底是不是选项组 */
  is_option_group?: boolean;
  /** 不是选项时它是什么身份，供回退（绝不强行当选项） */
  alt_identity?: "question_number" | "procedure_step" | "answer_point" | "other";
  /** 判定理由：必须引用上下文证据 + 题面表现形式证据，供人工复核 */
  reasoning?: string;
  /** 模型自己也没把握，交人工 */
  needs_human?: boolean;
  /** 模型认为的选项标签（只做交叉校验，不覆盖规则从原文取到的文本） */
  labels?: string[];
  /** 模型认为的选中项（只做交叉校验；与规则答案冲突时标待审核，绝不覆盖） */
  selected?: string[];
}

/** 一道题的审核轨迹：规则用了什么信号、模型说了什么，都可追溯。 */
export interface QuestionAuditTrail {
  /** 规则层命中的行级信号，如 question_no / option / numeric_option */
  rule_signals: string[];
  /** 规则判定的题型 */
  rule_type: QuestionType;
  /** 选项来源：字母选项 / 数字圈号折叠 */
  option_source: "letter" | "numbered" | "none";
  /** 答案归一时发现的歧义（multi_select_answer / answer_out_of_range） */
  answer_ambiguous: string | null;
  /** 模型裁决摘要；模型未参与时为空 */
  ai: {
    is_question: boolean;
    confidence: number | null;
    is_option_group?: boolean;
    alt_identity?: string;
    reasoning?: string;
    needs_human?: boolean;
  } | null;
}

export interface JudgeRequest {
  candidates: Array<{
    index: number;
    chunkId: string;
    signals: string[];
    excerpt: string;
    context: string;
  }>;
}

/** 依赖注入的模型仲裁器；返回 null 表示失败，管线自动降级到纯规则。 */
export type LlmJudge = (req: JudgeRequest) => Promise<LlmVerdict[] | null>;

export interface PipelineOptions {
  /** 默认由 question-llm.ts 注入；测试可传假实现或 null 强制纯规则 */
  judge?: LlmJudge | null;
  /** 单次导入最多几批模型调用（控制同步导入耗时） */
  maxLlmCalls?: number;
  /** 每批最多几个候选 */
  batchSize?: number;
}

export interface PipelineStats {
  totalChunks: number;
  scannedChunks: number;
  totalCandidates: number;
  llmCalls: number;
  llmFailed: number;
  rawQuestions: number;
  finalQuestions: number;
  /** 模型链路是否整体降级（失败/未配置/异常） */
  degraded: boolean;
  degradeReason: string;
}

export interface PipelineResult {
  questions: UnifiedQuestion[];
  chunks: QuestionChunk[];
  blocks: MarkdownBlock[];
  stats: PipelineStats;
  /** 规则层自动补齐的答案记录（摘要句 → 完整段落），供审计留痕 */
  expansions?: import("./answer-expansion").AnswerExpansion[];
}
