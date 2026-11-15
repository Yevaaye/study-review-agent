// 领域类型定义 · v3：FSRS 卡片复习（彻底移除旧测验模型）
//
// 数据模型两段式：
//   子系统 A（内容构建）：textbooks → chapters → knowledge_points → source_fragments → cards
//   子系统 B（长期复习）：cards → card_fsrs_states → review_sessions → card_reviews
//
// 字段命名对齐 ts-fsrs v6 / FSRS-7：
//   - 库内 Card 状态用 camelCase：dueAt / lastReviewAt / stabilityFast / scheduledDays / learningStep
//   - Rating 枚举：Again=1 Hard=2 Good=3 Easy=4
//   - State 枚举：New=0 Learning=1 Review=2 Relearning=3

export type ID = string;

// ---- 子系统 A：内容构建 ----

export type SourceFormat = "markdown" | "pdf";

export interface Textbook {
  id: ID;
  title: string;
  author?: string | null;
  subject?: string | null;
  source_format: SourceFormat;
  original_file_name?: string | null;
  storage_key?: string | null;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  content_hash?: string | null;
  parser_version?: string | null;
  /**
   * 导入时的原文全文（Markdown 原文）。
   * 片段是「解析后的结构化产物」，会按标题切分、trim，无法 100% 还原排版；
   * 资料库要「完整显示上传的资料」就必须留一份原文。老数据没有这个字段，
   * 页面会回退到用片段拼接近似全文，并提示重新导入。
   */
  raw_text?: string | null;
  source_version: number;
  status: "ready" | "archived";
  imported_at?: string | null;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Chapter {
  id: ID;
  textbook_id: ID;
  title: string;
  page_start?: number | null;
  page_end?: number | null;
  sort_order: number;
  deleted_at?: string | null;
}

export interface KnowledgePoint {
  id: ID;
  chapter_id: ID;
  /**
   * 知识点陈述。历史字段叫 title，语义已统一为「这一条要知道什么」的一句话，
   * 新写入直接用 statement 的值，老数据读时回退到 title。
   */
  title: string;
  summary?: string | null;
  content?: string | null;
  sort_order: number;
  deleted_at?: string | null;

  // ---- 知识点提炼改造新增（均可空，兼容存量数据）----
  /** 所属材料，便于按书一次性取全（不必先绕章节） */
  textbook_id?: ID | null;
  /** 章节标题路径，如 ["第三章 访问控制", "3.2 权限模型"] */
  chapter_path?: string[] | null;
  /** 知识点陈述（= title 的主语义，保留双字段是为了不破坏老页面） */
  statement?: string | null;
  /** 支撑这条陈述的原文短语，用于回原文取证 */
  evidence?: string | null;
  /** 该知识点来自哪个片段 */
  source_fragment_id?: ID | null;
  /**
   * 上次「按需补题」的时间。
   * 有值表示这条知识点已经补过一轮题 —— 再次点「出题」直接返回 0 张，
   * 避免同一个知识点被反复补题刷屏（模型换个问法就能绕过题干去重）。
   * 导入时的首轮生成不写这个字段：那不算「补题」。
   */
  last_generated_at?: string | null;
  created_at?: string | null;
}

export interface SourceFragment {
  id: ID;
  textbook_id: ID;
  chapter_id?: ID | null;
  fragment_index: number;
  heading_path?: string | null;
  paragraph_index?: number | null;
  page_start?: number | null;
  page_end?: number | null;
  char_start?: number | null;
  char_end?: number | null;
  locator: string;
  content: string;
  content_hash?: string | null;
  /**
   * 块分类（纯规则判定，零 token）：
   *   normal           普通正文 → 送 LLM 提炼知识点
   *   question_*       已经是题目 → 直接转成 original 卡，不再送 LLM（防重复出题）
   *   answer_*         答案/解析区 → 只用于按题号 join，不单独出卡
   *   error_table      易错表 → 每行转一张 judge 卡
   *   contrast_table   对比表 → 标记给 LLM（对比型知识点优先出 contrast 卡）
   */
  fragment_type?: FragmentType | null;
  /** 解析出的题号（仅 question_* / answer_* 有值） */
  question_no?: number | null;
}

export type FragmentType =
  | "normal"
  | "question_choice"
  | "question_qa"
  | "question_cloze"
  | "question_judge"
  | "answer_table"
  | "answer_analysis"
  | "error_table"
  | "contrast_table";

export type ImportStage =
  | "uploaded"
  | "parsing"
  | "splitting"
  | "generating"
  | "review_required"
  | "done"
  | "failed";

export interface ImportJob {
  id: ID;
  textbook_id: ID;
  input_hash: string;
  attempt_count: number;
  stage: ImportStage;
  progress: number;
  stage_started_at?: string | null;
  detail?: string | null;
  error?: string | null;
  parser_version?: string | null;
  model?: string | null;
  result_summary?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
}

// ---- 卡片 ----

export type CardKind = "qa" | "choice";
/**
 * 卡片状态 —— 与「是否进复习队列」严格对应：
 *
 *   draft     待审核。AI 刚生成，还没人判定过。
 *   mastered  已掌握。审核时点「通过 / 已会」→ **不进复习队列，也不需要复习**。
 *   active    复习中。审核时点「拒绝 / 不熟」，或复习时答错被拉回来 → 在今日队列里。
 *   invalid   内容错误。AI 把「不是题目」的内容误判成题（抽取误报）→ 作废：
 *             **既不通过、也不复习**，从审核台和复习队列一并移出。
 *             数据保留（不软删），可在「内容错误」分区查看、恢复为 draft 或彻底删除。
 *   rejected  历史兼容（早期版本用的「已拒绝」），读取时按 active 处理。
 *   archived  已废弃，保留枚举仅为兼容存量数据。
 *
 * 关键约束：只有 active 会出现在 /api/review 与今日待复习统计里。
 * 「通过」绝不能落到 active —— 那会让用户刚说「我会了」的卡立刻堆回复习列表。
 */
export type CardStatus = "draft" | "active" | "mastered" | "invalid" | "rejected" | "archived";

/**
 * 卡片来源：
 *   original      原文里本来就有的题（含易错表转出的判断题）—— 由规则抽取，零 token，措辞逐字保真
 *   ai_generated  模型按知识点补出来的题
 * 两者都进 draft，都必须人工审核。
 */
export type CardOrigin = "original" | "ai_generated";

/**
 * 卡片题型。注意与 kind 的分工：
 *   kind       只决定「复习界面怎么渲染」（有选项 = 选择题区域 / 无选项 = 翻面自答）
 *   card_type  记录语义题型，用于统计、补题配比、后续扩展
 * 映射关系：choice→kind=choice；judge→kind=choice（对/错两项）；qa/cloze/contrast→kind=qa。
 */
export type CardType = "choice" | "qa" | "cloze" | "judge" | "contrast";

export interface Card {
  id: ID;
  kind: CardKind;
  front: string;
  back: string;
  // 选择题专用：选项列表 + 正确选项（存选项文本，避免依赖索引）
  options?: string[] | null;
  /**
   * 正确答案（展示 + 兼容字段）。
   *   单选：存正确选项全文（旧数据形态，界面提示「正确答案是 …」最自然）
   *   多选：存选项字母列表 "A、C"（人能读，也能被 parseAnswerKeys 解析回下标）
   */
  answer?: string | null;
  /**
   * 多选专用：全部正确选项的**全文**。
   * 单选的 answer 就是整段文本，多选光靠 answer 只能给出字母，
   * 所以另存一份原文，供「正确答案」高亮与 AI 核对时逐项比对。
   * null / 缺省 = 单选或无答案。
   */
  answers?: string[] | null;
  /** 是否多选题（由 answers.length ≥ 2 派生，与 is_choice 一样只做冗余标记） */
  is_multi?: boolean;

  // 冗余布尔标记（用户可读的二分维度）：
  //   true  = 1 = 有选项 → 归入「选择题」区域
  //   false = 0 = 无选项 → 归入「问答卡」区域
  // 写入时由 options 派生，保证与 kind 始终一致；存量数据由 ensureSeeded 回填。
  is_choice: boolean;
  status: CardStatus;
  content_revision: number;
  content_hash?: string | null;
  generation_job_id?: ID | null;
  reviewed_at?: string | null;
  rejected_at?: string | null;
  /** 被标为「内容错误」（AI 误抽取）的时间；恢复为 draft 时清空 */
  invalid_at?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;

  // ---- 原题保真 + 知识点绑定改造新增（均可空，兼容存量数据）----
  /** 来源：原题 / AI 生成 */
  source?: CardOrigin | null;
  /** 语义题型（见 CardType 注释） */
  card_type?: CardType | null;
  /** 绑定到哪个知识点；绑不上为 null（进「未关联」池，题不丢） */
  kp_id?: ID | null;
  /** 有题无答案：卡照建，答案留空，UI 提示「待补答案」 */
  needs_answer?: boolean;
  /** 章节标题路径，透传解析上下文 */
  chapter_path?: string[] | null;
  /** 支撑这张卡的原文短语（AI 卡必须有，原题卡可选） */
  evidence?: string | null;
  /** 原题题号，用于 join 答案与解析、以及绑定知识点时对齐 */
  question_no?: number | null;
  /** 原题自带的解析（来自答案表 / 解析表），审阅时参考 */
  explanation?: string | null;

  // ---- 答案来源标记（AI 补答案改造新增，均可空，兼容存量数据）----
  /**
   * 答案出处：
   *   "source" = 原文里本来就给了答案（导入时 join 到的）
   *   "ai"     = 原文没给答案，AI 依据知识点 / 章节正文补出来的
   *   null/无效 = 还没有答案
   * 审核台据此显示「AI 生成」标识，避免把 AI 补的答案当成原文依据。
   */
  answer_origin?: "source" | "ai" | null;
  /** AI 补答案的时间（ISO 字符串），仅 answer_origin="ai" 时有值 */
  answer_generated_at?: string | null;
  /**
   * AI 答案是否能在原文里找到依据。
   *   true  = 严格照原文整理，可信度高
   *   false = 原文没写，AI 用专业知识补的 —— 界面要提醒「建议核对」
   */
  answer_grounded?: boolean | null;

  // ---- 抽取保真核对（原题卡专用，可空，兼容存量数据）----
  /**
   * 题干 / 选项 / 答案能否在原文里逐字找到：
   *   "exact"   = 全部逐字命中（正常情况，界面不打扰）
   *   "partial" = 部分命中（多为多行拼接 / 排版差异，建议扫一眼）
   *   "missing" = 大面积找不到（疑似被改写或凭空生成，必须核对）
   * null / undefined = 未校验（旧数据、AI 生成的卡）
   */
  fidelity_status?: "exact" | "partial" | "missing" | null;
  /** 保真核对的说明，例如「题干 42% / 选项 60% 可在原文逐字比对」 */
  fidelity_note?: string | null;
}

export interface CardSource {
  card_id: ID;
  source_fragment_id: ID;
  role: string;
}

// ---- 子系统 B：长期复习（FSRS） ----

// 对齐 ts-fsrs v6 State 枚举（数值）
export enum FsrsState {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3,
}

// 对齐 ts-fsrs v6 Rating 枚举（数值）
export enum Rating {
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}

export interface CardFsrsState {
  card_id: ID;
  // 记忆状态（FSRS-7 三件套）
  stability: number;
  stability_fast: number; // 对应库的 stabilityFast
  difficulty: number;
  // 生命周期
  state: FsrsState;
  schedule_status: "new" | "learning" | "review" | "relearning";
  // 调度字段
  scheduled_days: number;
  learning_step: number;
  reps: number;
  lapses: number;
  // 时间（对齐库 dueAt / lastReviewAt）
  due_at: string;
  last_review_at?: string | null;
  /**
   * 最近一次「没想起来」的时间戳。
   *
   * 用途只有一个：判断「今天这张卡是不是答错过」。
   * 答错过的卡当天再答对，间隔不允许跳回 3 天起 —— 必须明天再练一遍
   * （见 lib/fsrs.ts 的 lapse 规则）。不带这个字段就只能翻 card_reviews 全表，
   * 每答一题多一次全量扫描。
   */
  last_lapse_at?: string | null;
  // 版本追溯
  fsrs_version: string;
  scheduler_version: string;
  params_version: string;
  updated_at?: string;
}

export interface ReviewSession {
  id: ID;
  status: "in_progress" | "completed" | "abandoned";
  scope?: Record<string, unknown> | null;
  timezone: string;
  started_at: string;
  finished_at?: string | null;
}

export interface ReviewSessionCard {
  id: ID;
  session_id: ID;
  card_id: ID;
  sort_order: number;
  card_snapshot: Record<string, unknown>;
  rated: boolean;
  review_id?: ID | null;
}

export interface CardReview {
  id: ID;
  idempotency_key: ID;
  card_id: ID;
  session_id?: ID | null;
  session_card_id?: ID | null;
  rating: Rating;
  elapsed_ms?: number | null;
  content_revision: number;
  card_snapshot: Record<string, unknown>;
  state_before: Record<string, unknown>;
  state_after: Record<string, unknown>;
  scheduled_days: number;
  due_before?: string | null;
  due_after?: string | null;
  fsrs_version: string;
  reviewed_at: string;
}

// ---- 业务聚合类型 ----

// 首页「今日任务」
export interface DueCard {
  card_id: ID;
  front: string;
  back: string;
  kind: CardKind;
  options?: string[] | null;
  answer?: string | null;
  is_choice: boolean;
  /** 真实题型（choice/qa/cloze/judge/contrast）。列表上用它显示「选/问/填/判」 */
  card_type?: CardType | null;
  status: CardStatus;
  content_revision: number;
  stability: number;
  stability_fast: number;
  difficulty: number;
  state: FsrsState;
  schedule_status: string;
  scheduled_days: number;
  reps: number;
  lapses: number;
  due_at: string;
  last_review_at?: string | null;
  /** 审核时被「拒绝」的时间；有值说明这张卡是被判定为不熟塞回队列的 → 统计里归为「重学」 */
  rejected_at?: string | null;
}

export interface TodayStats {
  /** 今天真正可复习的卡：active 且 due_at <= now（含新卡与到期卡） */
  due_count: number;
  /**
   * 其中「新卡」：reps = 0，即从没学过（今天导入/审核通过后第一次进队列）。
   * 判据只看 FSRS 的 reps，不看 rejected_at —— 审核时点「拒绝」只表示
   * 「这张我不熟、放进队列」，跟学没学过是两件事。早期版本拿 rejected_at
   * 当重学标记，导致整批新卡被算成重学、new_count 恒为 0。
   */
  new_count: number;
  /** 其中「到期复习」：学过（reps > 0）且状态正常，按排期回来的卡 */
  review_count: number;
  /** 其中「重学」：学过但答错过（lapses > 0 或处于 Relearning），是 review 的细分 */
  relearn_count: number;
  /** 还没审核、不会进入复习队列的草稿卡（提示用，不计入 due_count） */
  pending_draft: number;
  /**
   * 今天答错、还没答对的题。
   *
   * 为什么不并进 due_count：答错后 FSRS 把到期时间压到 10 分钟后，
   * 这段时间里它既不在 due_count 里、也不该让「今日已复习」成立 ——
   * 用户看到的就是「说好今天还会再考，结果一题都不出来」。
   * 这个数独立统计，前端据此给「重做今天答错的题」入口。
   */
  retry_count: number;
  estimated_minutes: number;
  completed_today: number;
}

// ---- 答案修正审计（答案不全 / 截断 / 不准确）------------------------------
/**
 * 每次答案被修正都留一条：既包括导入时规则层自动补齐（trigger="rule"），
 * 也包括用户在复习页点「答案不全」后由 AI 重生成（trigger="user"）。
 * 保留 before/after/原文摘录/诊断，是为了能复盘「为什么漏了」，而不是只看到
 * 一个被改掉的答案 —— 后续优化识别准确率时这些就是可追溯的样本。
 */
export type AnswerFixReason =
  | "missing"       // 完全没有答案
  | "truncated"     // 答案被截断（只拿到摘要句）
  | "multi_answer"  // 同一段落含多个答案，只抽到一部分
  | "inaccurate"    // 答案与原文不符
  | "rule_expanded";// 规则层自动补齐（由 reason 细分到上面两类之一）

export interface AnswerFixLog {
  id: ID;
  card_id: ID | null;
  textbook_id?: ID | null;
  question: string;
  reason: AnswerFixReason;
  trigger: "user" | "rule";
  before: string;
  after: string;
  /** 触发修正的原文片段（规则层是扩展段落，AI 层是检索到的材料摘录） */
  source_excerpt: string;
  /** AI 分析出的该段落涉及的知识点 */
  knowledge_points: string[];
  /** 漏截 / 截断 / 不准的具体原因说明 */
  diagnosis: string;
  /** 新答案是否能在原文找到依据 */
  grounded: boolean;
  /** 用户在按钮里补的备注 */
  note?: string | null;
  created_at: string;
}

// ---- 出题错误台账（复习页「错误」按钮 / 正确答案标注）---------------------
/**
 * 用户在复习时发现「这张卡本身有问题」→ 一键上报，而不是自己去审核台找。
 *
 * 为什么要单独成表、而不是直接改卡片状态：
 *   1) 错误可能是「题不是题」「答案错」「选项错」「正确答案标错」四类完全不同的病因，
 *      处理方式不一样（作废 / 重生成答案 / 重建选项 / 改答案键），直接改卡会丢掉病因；
 *   2) 这些记录是后续「学习复盘 Agent 监督员」的输入 —— 它要按病因聚类，
 *      找出「AI 出题的哪类毛病反复出现」，再反向迭代抽取规则与提示词；
 *   3) 记录要保留**当时的卡片快照**，卡片后来被修好了，样本也不能跟着变。
 */
export type CardErrorKind =
  | "not_question"     // 这段原文根本不是题（AI 误抽）
  | "answer_wrong"     // 参考答案错误 / 答非所问
  | "options_wrong"    // 选项缺失、错位、明显不是四个并行项
  | "answer_key_wrong" // 选项没问题，但标注的正确答案不对（含应为多选却标成单选）
  | "other";

export type CardErrorStatus =
  | "open"       // 刚上报，等监督员核查
  | "reviewed"   // 监督员已核查（附结论）
  | "fixed"      // 已修复（卡片已改 / 已作废）
  | "dismissed"; // 核查后判定「不是问题」（用户误报）

export interface CardErrorReport {
  id: ID;
  card_id: ID;
  textbook_id?: ID | null;
  kind: CardErrorKind;
  /** 用户补充说明 */
  note: string;
  /** 上报时卡片长什么样（快照，后续修卡不影响样本） */
  snapshot: {
    front: string;
    back: string;
    options: string[] | null;
    answer: string | null;
    answers: string[] | null;
    is_multi: boolean;
    card_type?: string | null;
  };
  /** 用户标注的正确选项下标（「标注正确答案」时写入；没标注为空数组） */
  marked_keys: number[];
  /** 上报入口：复习页 / 审核台 */
  source: "review" | "cards";
  status: CardErrorStatus;
  /** 监督员核查结论（AI 或规则生成） */
  verdict?: string | null;
  /** 监督员给出的处理建议，如「应作废」「答案键应为 A、C」 */
  suggested_action?: string | null;
  /** 复核时间 */
  reviewed_at?: string | null;
  created_at: string;
}

// ---- 学习复盘监督员台账（独立 JSON 文件：data/audit/*.json）------------------
/**
 * 为什么要把这两类记录单独落成文件，而不是塞进 card_error_reports：
 *
 *   card_error_reports 回答的是「这张卡本身错在哪」——是内容缺陷；
 *   这两本台账回答的是「流程在哪一步没兜住」——是**过程缺陷**：
 *     · answer-gaps      用户叫人补答案，补不出来 / 补了但不清楚，为什么；
 *     · rejected-cards   审核时被判「不熟」推进复习队列的，都是些什么节点。
 *
 * 监督员看的是分布和规律（哪类题型反复补不出来、哪批节点反复被拒），
 * 所以每条都带「节点链路 + 题型画像 + 函数管道」，让它不用回查数据库就能归因。
 */

/** 卡片在知识树里的位置 —— 「当前节点」的完整链路 */
export interface AuditNodeRef {
  card_id: ID;
  textbook_id: ID | null;
  textbook_title: string | null;
  chapter_id: ID | null;
  chapter_title: string | null;
  /** 章节标题路径（["第三章 访问控制","3.2 权限模型"]） */
  chapter_path: string[];
  kp_id: ID | null;
  kp_statement: string | null;
  /** 这张卡的来源片段 id（可能在多个片段里出现） */
  fragment_ids: ID[];
  /** 原文定位串（片段 locator 或页码），供人工回原文核对 */
  locator: string | null;
}

/** 题型画像：监督员按题型分组，才能回答「哪类题最容易没好答案」 */
export interface AuditQuestionType {
  kind: "single_choice" | "multi_choice" | "judge" | "cloze" | "contrast" | "qa";
  is_choice: boolean;
  is_multi: boolean;
  option_count: number;
  /** 答案写法形态：letter（A）/ circled（①②）/ numeric（12）/ text（整段文本）/ none */
  answer_form: "letter" | "circled" | "numeric" | "text" | "none";
  card_type: CardType | null;
  card_kind: CardKind;
}

/**
 * 一条函数管道记录 —— 「这个结果是被哪段逻辑、用什么判定算出来的」。
 *
 * 不记全栈 trace（噪音太大），只记**决策点**：进了哪个函数、看了什么量、
 * 判定结果是什么。监督员据此能看出「每次都死在同一个 if 上」。
 */
export interface AuditPipelineStep {
  /** 函数 / 阶段名，如 "draftAnswerRepair" */
  step: string;
  /** 判定与关键量，如 "material=3021字 ≥20，放行" */
  detail: string;
  verdict: "ok" | "reject" | "info";
}

/** 为什么这张卡的答案没答清楚（用户看到的症状 / AI 补不出来的成因） */
export type AnswerGapReason =
  | "missing" // 答案完全没有
  | "truncated" // 答案被截断，只拿到摘要句
  | "inaccurate" // 答案与原文不符 / 答非所问
  | "no_material" // AI 补全时原文材料不足
  | "insufficient" // AI 返回畸形 / 答案过短 / 答「材料未提及」
  | "llm_error"; // 模型调用本身失败（超时 / 没配 key / 上游 5xx）

/**
 * 答案缺口台账（data/audit/answer-gaps.json）。
 *
 * 与 answer_fix_logs 的分工：
 *   answer_fix_logs 记「答案被改成了什么」（正文比对用）；
 *   这里记「这次补全为什么成 / 为什么没成」（流程归因用）。
 * 所以**失败也要写一条**——只记成功等于把最该复盘的那批样本丢了。
 */
export interface AnswerGapReport {
  id: ID;
  node: AuditNodeRef;
  question: string;
  question_type: AuditQuestionType;
  /** 用户看到的问题（点「答案不全」时选的症状）或 AI 补不出来时的成因 */
  symptom: AnswerGapReason;
  /** fixed = 补上了；unfixed = 没补上，卡片保持原样 */
  outcome: "fixed" | "unfixed";
  /** 没补上时，具体卡在哪一步（人话，监督员直接读） */
  block_reason: string;
  before_answer: string;
  after_answer: string | null;
  /** 原文里支撑答案的段落 */
  source_excerpt: string;
  knowledge_points: string[];
  diagnosis: string;
  grounded: boolean;
  user_note: string | null;
  pipeline: AuditPipelineStep[];
  created_at: string;
}

/**
 * 审核拒绝台账（data/audit/rejected-cards.json）。
 *
 * 审核台点「拒绝」= 这张卡我不熟 → status=active + due=now，立刻进今日队列。
 * 以前只留一个 rejected_at 时间戳，于是「到底把哪些节点推进了复习队列」
 * 这件事事后完全无法复盘：拒绝得对不对、是不是整章都被拒、哪类题型总被拒，
 * 全都没样本。这里补上节点链路 + 题型 + 拒绝前后的 FSRS 状态。
 */
export interface ReviewRejection {
  id: ID;
  node: AuditNodeRef;
  question: string;
  question_type: AuditQuestionType;
  /** 拒绝那一刻的卡片内容（后续改卡不影响样本） */
  snapshot: {
    front: string;
    back: string;
    options: string[] | null;
    answer: string | null;
    answers: string[] | null;
    is_multi: boolean;
    card_type: CardType | null;
  };
  context: {
    /** 单张拒绝 / 批量拒绝 / 复习页操作 */
    source: "cards" | "batch" | "review";
    /** 拒绝前的 FSRS 状态；从没学过为 null */
    fsrs_before: {
      due_at: string;
      reps: number;
      lapses: number;
      state: string;
    } | null;
    /** 拒绝后重新进入队列的时间（= 操作时刻） */
    due_after: string;
    /** 批量拒绝时这一批有多少张 */
    batch_size: number | null;
    /**
     * 由历史数据回填（不是实时写入）。
     * 这类记录的 fsrs_before 取不到当时的真实状态，统计「新卡被拒占比」时要剔除，
     * 否则会把「不知道」当成「从没学过」。实时写入的记录没有这个字段。
     */
    backfilled?: boolean;
  };
  /** 用户可选填的拒绝理由（审核页暂未采集，留空即 null） */
  note: string | null;
  pipeline: AuditPipelineStep[];
  created_at: string;
}
