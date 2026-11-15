-- ============================================================================
--  ⚠️ 休眠文件 / HISTORICAL — 当前 v3 运行时不使用本文件
--
--  v3 只有一个后端：LocalStore，状态全部存 DATA_DIR/db.json（默认 ./data/db.json）。
--  src/lib/db/supabaseStore.ts 已删除，src/lib/config.ts 不读任何 SUPABASE_* 变量。
--  本文件保留仅供将来若恢复关系型后端时参考，**不是当前 schema 的真源**；
--  当前字段以 src/lib/db/types.ts + db/seed-data.json 为准。
--  两者已有漂移（例如下面 knowledge_points 曾缺 last_generated_at），恢复前须逐列核对。
--
-- ----------------------------------------------------------------------------
--  个人学习复盘 Agent · v3 — 数据库结构 (PostgreSQL / Supabase) [历史存档]
--
--  定位：把 v1/v2「章节测验 Demo」重构为「导入 Markdown → AI 生成卡片草稿
--        → 用户审核 → FSRS 复习 → 自动排期」的个人间隔复习工具。
--
--  本版三条约定的落地：
--    1. 彻底移除旧测验（questions / quiz_* / mastery_records / training_attempts 全部删除）
--    2. 只做 Markdown（PDF 文本抽取列为后续，本 schema 已预留 source_format）
--    3. 卡片级 FSRS（ts-fsrs v6，默认 FSRS-7）
--
--  删除策略总原则（关键修正）：
--    · 默认软删除 / 归档，保留学习历史，绝不因改章节/删片段而级联清空复习记录
--    · 只有用户「显式删除材料」时，才提供「同时物理删除相关卡片+复习历史」的选项
--    · 因此本 schema 中对外键一律使用 on delete set null / restrict，不使用 cascade
--
--  执行方式：Supabase 控制台 → SQL Editor → 粘贴全段 → Run
--  幂等：create table if not exists / alter ... if not exists，可重复执行
-- ============================================================================

-- 依赖扩展
create extension if not exists gen_random_uuid;

-- ---------------------------------------------------------------------------
-- 1. 材料（textbooks）—— 复用为「材料/书籍」实体，补版本与来源元数据
-- ---------------------------------------------------------------------------
create table if not exists textbooks (
  id                 uuid primary key default gen_random_uuid(),
  title              text        not null,
  author             text,
  subject            text,

  -- 来源与格式（第 2 条：文件与材料版本元数据）
  source_format      text        not null default 'markdown'
                       check (source_format in ('markdown', 'pdf')),
  original_file_name text,                         -- 用户上传的原始文件名
  storage_key        text,                         -- 本地路径 / 对象存储 key（原始文件是否持久化的依据）
  mime_type          text,
  file_size_bytes    bigint,
  content_hash       text,                         -- 提取后全文的哈希，用于识别同名/更新/重复上传
  parser_version     text,                         -- 解析器版本，源文件改动后可判定位是否失效
  source_version     int         not null default 1,  -- 材料版本号，重导入自增

  -- 材料级状态（第 1 条：材料级状态，与 import_jobs 分离）
  status             text        not null default 'ready'
                       check (status in ('ready', 'archived')),
  imported_at        timestamptz,
  archived_at        timestamptz,                  -- 软删除标记
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. 章节（保留内容树父节点；软删除，不级联清空知识点）
-- ---------------------------------------------------------------------------
create table if not exists chapters (
  id           uuid primary key default gen_random_uuid(),
  textbook_id  uuid not null references textbooks(id) on delete restrict,
  title        text        not null,
  page_start   int,                       -- Markdown 无页码时为空；heading_path 才是主定位
  page_end     int,
  sort_order   int         not null default 0,
  deleted_at   timestamptz,               -- 软删除标记（拆/合章后旧章保留引用，不物理删）
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. 知识点（复用为「AI 找出的知识点」；软删除）
-- ---------------------------------------------------------------------------
create table if not exists knowledge_points (
  id           uuid primary key default gen_random_uuid(),
  chapter_id   uuid not null references chapters(id) on delete restrict,
  title        text        not null,
  summary      text,                       -- AI 生成的要点摘要（供阅读，非卡片）
  content      text,
  sort_order   int         not null default 0,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. 原文片段（来源定位的最小单位）
--    第 3 条：结构化定位字段，locator 只作可读摘要
--    第 12 条：content 只存「分段后的片段文本」，不整本塞库；原文由 storage_key 定位
-- ---------------------------------------------------------------------------
create table if not exists source_fragments (
  id             uuid primary key default gen_random_uuid(),
  textbook_id    uuid not null references textbooks(id) on delete restrict,
  chapter_id     uuid references chapters(id) on delete set null,  -- 可先无章节
  fragment_index int  not null default 0,     -- 在材料内的顺序号

  -- 结构化定位（Markdown 用 heading_path + paragraph_index；PDF 用 page 区间）
  heading_path   text,                       -- 如 "第2章 > 2.1 > 小节标题"
  paragraph_index int,
  page_start     int,
  page_end       int,
  char_start     int,
  char_end       int,
  locator        text not null,              -- 可读摘要，如 "第2章 2.1 第3段" 或 "p31-35"

  content        text not null,              -- 片段原文（分段文本，非整本）
  content_hash   text,                       -- 片段内容哈希
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. 导入任务（第 1 条：一轮处理任务；材料可多次导入/重试/重生成）
-- ---------------------------------------------------------------------------
create table if not exists import_jobs (
  id              uuid primary key default gen_random_uuid(),
  textbook_id     uuid not null references textbooks(id) on delete restrict,
  input_hash      text not null,             -- 输入文件哈希（材料版本标识，重跑可追溯旧卡片基于哪份内容）
  attempt_count   int  not null default 1,   -- 第 1 条：重试次数
  stage           text not null default 'uploaded'
                    check (stage in (
                      'uploaded',      -- 已上传
                      'parsing',       -- 解析中
                      'splitting',     -- AI 分章/找知识点
                      'generating',    -- 生成卡片草稿
                      'review_required', -- 待用户校正/审核（AI 完成 ≠ 可复习）
                      'done',
                      'failed'
                    )),
  progress        int  not null default 0,   -- 0-100
  stage_started_at timestamptz,              -- 当前阶段开始时间
  detail          text,                      -- 进度/结果摘要
  error           text,
  parser_version  text,                      -- 本次解析所用解析器版本
  model           text,                      -- 本次 AI 所用模型/provider
  result_summary  jsonb,                     -- 产出统计（章节数/知识点数/卡片数）
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- 6. 卡片（独立问答卡；软删除，多来源关联）
--    第 11 条：状态覆盖 draft/active/rejected/archived；content_revision 支持审核后编辑
-- ---------------------------------------------------------------------------
create table if not exists cards (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'qa' check (kind in ('qa', 'choice')),
  front           text not null,             -- 问题（选择题的题干）
  back            text not null,             -- 答案（问答卡的解答）
  options         jsonb,                     -- 选择题选项数组，如 ["A项","B项","C项","D项"]；问答卡为 null
  answer          text,                      -- 选择题正确选项文本；问答卡为 null
  -- 冗余布尔标记：true(1)=有选项→选择题区域，false(0)=无选项→问答卡区域。
  -- 由 options 派生（options 非空且 >= 2 项），写入时保证与 kind 一致。
  is_choice       boolean not null default false,
  status          text not null default 'draft'
                    check (status in ('draft', 'active', 'mastered', 'rejected', 'archived')),
  content_revision int  not null default 1,  -- 第 6/11 条：内容修订号，编辑后自增
  content_hash    text,                      -- front+back 哈希，回放时校验当时看到的内容
  generation_job_id uuid references import_jobs(id) on delete set null,  -- 第 11 条：哪次导入生成的
  reviewed_at     timestamptz,               -- 审核通过时间
  rejected_at     timestamptz,               -- 审核拒绝时间
  deleted_at      timestamptz,               -- 软删除标记（归档）
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. 卡片↔来源片段 多对多（第 4 条：一张卡可综合多个段落）
--    若 MVP 强制单来源，可先只插一行，但要接受后续迁移成本（本 schema 直接按多对多建）
-- ---------------------------------------------------------------------------
create table if not exists card_sources (
  card_id            uuid not null references cards(id) on delete restrict,
  source_fragment_id uuid not null references source_fragments(id) on delete restrict,
  role               text not null default 'source',  -- 如 'source' / 'supplement'
  primary key (card_id, source_fragment_id)
);

-- ---------------------------------------------------------------------------
-- 9. 卡片 FSRS 状态（每卡一条，对齐 ts-fsrs v6 / FSRS-7 的真实字段）
--    第 9 条：以库真实类型为准，补 stabilityFast / learningStep / scheduleStatus
--    注意：due/last_review 在库内叫 dueAt / lastReviewAt（camelCase），
--          elapsed_days 已从 v6 移除（由时间戳计算），不建该列
-- ---------------------------------------------------------------------------
create table if not exists card_fsrs_states (
  card_id          uuid primary key references cards(id) on delete restrict,
  -- 记忆状态（FSRS-7 三件套）
  stability        double precision not null default 0,
  stability_fast   double precision not null default 0,   -- 库内 snake_case 映射库的 stabilityFast
  difficulty       double precision not null default 0,
  -- 生命周期
  state            int not null default 0
                     check (state in (0, 1, 2, 3)),  -- New=0 Learning=1 Review=2 Relearning=3
  schedule_status  text not null default 'new',     -- 'new' | 'learning' | 'review' | 'relearning'
  -- 调度字段
  scheduled_days   double precision not null default 0,
  learning_step    int  not null default 0,          -- 零基步骤索引（非 reps）
  reps             int  not null default 0,
  lapses           int  not null default 0,
  -- 时间（对齐库内 dueAt / lastReviewAt）
  due_at           timestamptz not null default now(),
  last_review_at   timestamptz,
  -- 版本追溯（第 9 条：保存版本，避免升级后历史状态语义漂移）
  fsrs_version     text not null default 'FSRS-7',
  scheduler_version text not null default 'ts-fsrs@6',
  params_version   text not null default 'default',  -- 调度参数配置版本（默认参数）
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. 复习会话 + 会话卡片清单（第 8 条：刷新恢复、区分本轮完成、回溯）
-- ---------------------------------------------------------------------------
create table if not exists review_sessions (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'in_progress'
                 check (status in ('in_progress', 'completed', 'abandoned')),
  scope        jsonb,                        -- 本轮选择范围（如全部到期 / 指定章节）
  timezone     text not null default 'Asia/Shanghai',  -- 第 10 条：学习日边界
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists review_session_cards (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references review_sessions(id) on delete restrict,
  card_id      uuid not null references cards(id) on delete restrict,
  sort_order   int  not null default 0,      -- 本轮展示顺序
  card_snapshot jsonb not null,              -- 本轮开始时卡的 front/back/content_revision 快照
  rated        boolean not null default false,  -- 是否已评分
  review_id    uuid,                         -- 关联的 card_reviews 事件（评分后回填）
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 11. 复习事件（追加式，不可改写；幂等 + 前后状态快照）
--     第 6 条：content_revision + 来源快照 + FSRS 前后状态
--     第 7 条：idempotency_key 唯一约束，防双击/重试重复排期
-- ---------------------------------------------------------------------------
create table if not exists card_reviews (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,       -- 第 7 条：客户端生成，数据库层强制幂等
  card_id         uuid not null references cards(id) on delete restrict,
  session_id      uuid references review_sessions(id) on delete set null,
  session_card_id uuid references review_session_cards(id) on delete set null,
  rating          int not null check (rating in (1, 2, 3, 4)),  -- Again=1 Hard=2 Good=3 Easy=4
  elapsed_ms      int,                       -- 该卡耗时
  -- 内容快照（第 6 条：回放时说明用户当时看到什么）
  content_revision int not null,
  card_snapshot    jsonb not null,           -- {front, back, content_hash, sources}
  -- FSRS 前后状态快照（第 6 条：可重算输入/输出状态）
  state_before    jsonb not null,
  state_after     jsonb not null,
  scheduled_days  double precision not null,
  due_before      timestamptz,
  due_after       timestamptz,
  fsrs_version    text not null default 'FSRS-7',
  reviewed_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
create index if not exists idx_chapters_textbook   on chapters(textbook_id);
create index if not exists idx_kp_chapter          on knowledge_points(chapter_id);
create index if not exists idx_fragments_textbook   on source_fragments(textbook_id);
create index if not exists idx_fragments_chapter    on source_fragments(chapter_id);
create index if not exists idx_import_jobs_textbook on import_jobs(textbook_id);
create index if not exists idx_cards_status         on cards(status);
create index if not exists idx_cards_generation     on cards(generation_job_id);
create index if not exists idx_fsrs_due             on card_fsrs_states(due_at);
create index if not exists idx_reviews_card         on card_reviews(card_id, reviewed_at);
create index if not exists idx_reviews_session      on card_reviews(session_id);
create index if not exists idx_session_cards        on review_session_cards(session_id, sort_order);

-- ===========================================================================
--  视图：今日待复习（首页核心）
--  第 10 条：due <= now() 用绝对时间；时区与每日新卡上限在应用层按 settings 处理
-- ===========================================================================
create or replace view v_due_cards as
select
  c.id          as card_id,
  c.front,
  c.back,
  c.status,
  c.content_revision,
  f.stability,
  f.stability_fast,
  f.difficulty,
  f.state,
  f.schedule_status,
  f.scheduled_days,
  f.reps,
  f.lapses,
  f.due_at,
  f.last_review_at
from cards c
join card_fsrs_states f on f.card_id = c.id
where c.status = 'active'
  and c.deleted_at is null
  and f.due_at <= now()
order by f.due_at asc;

-- ===========================================================================
--  视图：卡片来源（多对多展开，供「回到原文」跳转）
-- ===========================================================================
create or replace view v_card_sources as
select
  cs.card_id,
  cs.role,
  sf.id          as source_fragment_id,
  sf.locator,
  sf.heading_path,
  sf.page_start,
  sf.page_end,
  sf.content,
  tb.id          as textbook_id,
  tb.title       as textbook_title
from card_sources cs
join source_fragments sf on sf.id = cs.source_fragment_id
join textbooks tb        on tb.id = sf.textbook_id;

-- ===========================================================================
--  迁移 · v3.1：原题保真 + 知识点绑定
--
--  背景：早期卡片全部由模型生成，于是 cards 只需要 front/back/options。
--  新链路要「原文里已有的题逐字保留、按知识点补题、按题号 join 答案」，
--  因此需要 source / card_type / kp_id / needs_answer / chapter_path / evidence，
--  并把 knowledge_points 从「只有标题摘要」升级为「陈述 + 原文证据」。
--
--  幂等：全部使用 add column if not exists，可重复执行。
-- ===========================================================================

alter table cards add column if not exists source       text not null default 'ai_generated';
alter table cards add column if not exists card_type    text;
alter table cards add column if not exists kp_id        text;
alter table cards add column if not exists needs_answer boolean not null default false;
alter table cards add column if not exists chapter_path text[];
alter table cards add column if not exists evidence     text;
alter table cards add column if not exists question_no  int;
alter table cards add column if not exists explanation  text;

-- card_type 由 kind 回填（老数据：有选项=choice，其余=qa）
update cards set card_type = case when kind = 'choice' then 'choice' else 'qa' end
where card_type is null;

create index if not exists idx_cards_kp     on cards(kp_id);
create index if not exists idx_cards_source on cards(source);

-- 知识点：陈述 + 证据 + 归属路径
alter table knowledge_points add column if not exists textbook_id        uuid;
alter table knowledge_points add column if not exists statement          text;
alter table knowledge_points add column if not exists evidence           text;
alter table knowledge_points add column if not exists chapter_path       text[];
alter table knowledge_points add column if not exists source_fragment_id uuid;
alter table knowledge_points add column if not exists created_at         timestamptz default now();
-- 与 src/lib/db/types.ts 的 KnowledgePoint.last_generated_at 对齐：
-- 记录「上次按需补题」时间，避免同一知识点被反复补题刷屏。
alter table knowledge_points add column if not exists last_generated_at  timestamptz;

-- 老数据：statement 缺失时用 title 回填，保证读侧单一路径
update knowledge_points set statement = title where statement is null;

create index if not exists idx_kp_chapter2 on knowledge_points(chapter_id);
create index if not exists idx_kp_textbook on knowledge_points(textbook_id);
