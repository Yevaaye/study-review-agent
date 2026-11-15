# 个人学习复盘 Agent · v2 需求分析与技术方案

> 版本：v2.0（2026-11-03）
> 基线：v1 已上线（`https://study-review-agent-juwezvmtl-yevaa.vercel.app`），本地 `http://localhost:3000`
> 状态：**设计稿，待确认后实施**。文中每条需求都标注了代码证据，可逐条核对。

---

## 0. 关于模板（已定位）

用户提到的「今天早上的需求分析模板」已找到：`个人学习复盘Agent_MVP项目需求与开发模板.pdf`。
它是**聚焦的 MVP 规范**：一本教材、严格线性闭环（教材主页 → 测验 → 结果 → 复习 → 训练 → 报告），并**明确把
「多本教材 / 自动解析整本 PDF / 复杂数据看板」列为「后续扩展方向」**（原文 §1.3 明确不做、§10 列为 MVP 之后）。

**v2 与该模板的协同关系（关键结论）**：
- 模板的**线性闭环 + 流程硬约束**是地基，v2 必须尊重：复习确认前不许进训练、全部章节完成才出薄弱汇总、后端控状态前端不跳门槛。
- v2 的「多书 / 下钻 / 看板 / 加书删除」属于模板的**扩展层**，叠加在地基之上，不破坏约束。
- 因此 v2 的 FR-04~FR-12 是模板 §10 扩展项的具体化；PDF 自动切章（FR-11）属范围扩张，按两阶段设计降级为「规则优先、人工确认」。

> 文档结构（诊断 → 目标 → 功能 → 数据 → API → 方案 → 路线图 → 验收）保留不变，技术结论不受模板格式影响。

---

## 1. 问题诊断：诉求 vs 代码现状

所有结论均来自实际读码，不是推测。

| # | 用户诉求 | 代码现状（证据） | 差距 | 优先级 |
|---|---|---|---|---|
| G1 | 首页 6 个框点不了 | `src/app/page.tsx` 中 `STEPS.map` 渲染的是 `<div className="card">`，无 `Link`/`onClick` | 纯静态装饰 | **P0** |
| G2 | 点击「选择章节」→选书→选章→开测 | `src/app/study/page.tsx` 已实现完整选择器（`/api/chapters` 拉三级树，勾选章节后 `startQuiz`） | 功能**已存在**，只是首页进不去 | **P0**（仅需连通） |
| G3 | 薄弱分析 → 跳数据看板看哪里不行 | `/api/dashboard` + `dashboard/page.tsx` 已有薄弱点 TOP 列表 | 已存在，但**看板无下钻**（点薄弱点不能进知识点详情） | P1 |
| G4 | 教材复习列出薄弱知识点是哪几个 | `study/page.tsx` step=`review` 已按 `weak[]` 列出 KP + 教材原文 + 页码 | 已存在（仅在 study 流程内） | P1 |
| G5 | 变式训练没有入口 | `study/page.tsx` step=`review` 底部「开始变式训练 →」按钮存在 | 已存在，**没有独立可直达页面** | P1 |
| G6 | 掌握更新没有 | `src/lib/flow.ts` `updateMastery()` + `mastery_records` 表 | 状态机已实现，**缺章节/书籍级汇总** | P1 |
| G7 | 章节/知识点加错删不掉 | `store.ts` 只有 `deleteQuestion()`；`manage/page.tsx` 章节与知识点标签页**只有新增，无删除按钮** | **确实缺 delete 能力** | **P0** |
| G8 | 无法新增书籍 | `store.ts` 有 `upsertTextbook()`，但**没有对应 API 路由、也没有 UI** | 半成品，缺 `/api/manage/textbooks` | **P0** |
| G9 | 上传 PDF 自动识别章节并划分 | 无任何相关代码 | **全新功能**（且与 v1 spec「不解析 PDF」冲突，见 §8.1） | **P1** |
| G10 | 章节 → 知识点 下钻 | `/api/chapters` 一次返回三级树，但**没有单章节详情接口**，无知识点详情页 | 缺下钻路由与页面 | P1 |
| G11 | 标注章节 OK / 不OK | 掌握度只到 KP 级（`mastery_records`），无章节/书籍级汇总 | **缺聚合层** | **P1** |
| G12 | 书籍要有分类 | `textbooks.subject` 字段已存在但**从未被使用**（`upsertTextbook` 未暴露） | 字段需启用 + 新增 `category` | P1 |
| G13 | 知识点要有分类和规划 | `knowledge_points` 仅有 `summary/content/sort_order` | 缺 `tags`、页码、预估时长 | P2 |

**结论**：v1 的**闭环逻辑是完整的**，问题集中在三处 —— ① 首页入口没连线；② 内容管理**只增不删、不能建书**；
③ 缺「书籍→章节→知识点」的下钻浏览层与章节级状态汇总。

---

## 2. 目标与非目标

### 目标
1. **入口连通**：首页 6 个卡片各自指向一个**真实可用**的界面，不是死链。
2. **三级下钻**：书籍 → 章节 → 知识点，任何一层都能点进去看下一层，并能从任意层**直接发起测验/训练**。
3. **章节级状态**：每章可显示 OK / 不OK，书籍可显示整体掌握率。
4. **内容可逆**：新增的书/章/知识点/题目都能删（软删，保学习历史）。
5. **批量导入**：上传 PDF → 自动切分章节 → 人工确认 → 生成知识点。
6. **多书**：至少支持 3 本真实书籍，按分类分组。

### 非目标（本期不做）
- 用户登录 / 多租户（保持单人 Demo）
- OCR 扫描件识别（明确报错，不静默失败）
- 题目自动生成（除变式训练外，题库仍人工维护）
- 移动端原生 App

---

## 3. 用户故事

| ID | 作为 | 我想要 | 以便 |
|---|---|---|---|
| US-01 | 学习者 | 在首页点「选择章节」，先选书再选章 | 找到要练的内容，而不是从头再来 |
| US-02 | 学习者 | 在章节页看到该章是 OK 还是不OK | 一眼知道该复习还是该巩固 |
| US-03 | 学习者 | 点不OK的章节，直接开测 | 不用重新走一遍选择流程 |
| US-04 | 学习者 | 点 OK 的章节，能重复训练 | 保持手感 |
| US-05 | 学习者 | 从看板点任一薄弱点，进到知识点详情 | 看到原文、页码、我的错题历史 |
| US-06 | 学习者 | 上传一本 PDF 教材 | 系统自动切好章节，我只需确认 |
| US-07 | 内容维护者 | 删掉加错的章节/知识点/题目 | 不让脏数据污染统计 |
| US-08 | 内容维护者 | 给书打上分类标签 | 书籍多时仍能归类查找 |

---

## 4. 功能需求清单

> 验收标准用 Given/When/Then 描述，可直接转成测试用例。

### P0 —— 让现有能力暴露出来

**FR-01 首页 6 卡片可点击**
- 卡片渲染为 `next/link`，带 hover 态（位移 + 描边高亮）与 `→` 指示。
- 映射：`选择章节`/`章节测验`/`教材复习`/`变式训练` → `/study`；`薄弱分析`/`掌握更新` → `/dashboard`。
- AC：点击任一卡片，300ms 内进入目标页且无 404。

**FR-02 章节/知识点可删除（软删）**
- `DELETE /api/manage/chapters/[id]`、`DELETE /api/manage/knowledge-points/[id]`。
- 语义：**软删**（置 `deleted_at`），保留 `quiz_answers` 学习历史；UI 提供「彻底删除」仅在该对象无关联作答时可用。
- AC：删除后列表立即消失；`/api/chapters` 不再返回；历史作答仍在看板统计中；关联题目/KP 级联软删。

**FR-03 可新增书籍**
- `POST /api/manage/textbooks`（title 必填，category/subject/author 可选）。
- UI：`/manage` 新增「书籍」标签页，支持新增、编辑分类、删除。
- AC：新建书籍后，`/books` 立刻出现该书（0 章节状态为「未开始」）。

### P1 —— 补上下钻层与章节状态

**FR-04 书籍库页 `/books`**
- 按 `category` 分组展示，每本书显示：章节数、知识点数、掌握率、整体状态徽标。
- AC：书籍卡片可点进 `/books/[id]`。

**FR-05 书籍详情 `/books/[id]`**
- 章节列表，每章显示 OK / 不OK / 未开始徽标 + 掌握率 + 错题数。
- 每章两个动作：**「开始测验」**（不OK 章优先）、**「重复训练」**（OK 章）。
- AC：点「开始测验」→ 跳 `/study?chapterIds=<id>` 并自动开测。

**FR-06 章节详情 `/chapters/[id]`**
- 列出本章全部知识点，每条显示：标题、分类标签、掌握状态、页码、预估时长。
- 支持按标签筛选、按掌握状态排序。
- AC：知识点条目可点进 `/kp/[id]`。

**FR-07 知识点详情 `/kp/[id]`**
- 教材原文 + 页码 + AI 讲解入口 + 我的作答历史（对/错/时间）+ 掌握轨迹。
- AC：从看板薄弱点、章节知识点列表、测验解析三处进入，展示一致。

**FR-08 章节级状态判定**
- 规则（见 §6.4 视图）：`mastered` = 本章全部 KP 为 mastered 且 KP 数 > 0 → 徽标 **OK**；
  `learning` = 有错题或学习中 → **不OK**；否则 **未开始**。
- AC：章节状态随答题即时变化；书籍状态由章节状态聚合。

**FR-09 独立「教材复习」页 `/review`**
- 全局列出所有薄弱知识点（跨书籍），按错题次数降序；每条可展开看原文 + 直接进入复习/训练。
- AC：不经过测验会话也能进入。

**FR-10 独立「变式训练」页 `/training`**
- 训练队列 = 全部未掌握 KP；支持「练一个」逐题推进。
- AC：首页「变式训练」卡片直达此页并能立即出题。

**FR-11 PDF 导入**
- 上传 PDF → 建书籍 → 抽取文本 → 识别章节 → 生成章节列表待确认 → 用户确认/改名/删除 → 按需生成知识点。
- AC：见 §8.1 两阶段设计。

### P2 —— 增强

**FR-12 知识点分类与规划**
- `knowledge_points.tags text[]`（如：概念/公式/推导/实验/易错/考点）
- `estimated_minutes int`；章节可维护 `learning_plan`（本章学习顺序建议）。
- AC：章节详情页可按标签筛选；知识点列表显示规划时长。

---

## 5. 信息架构与页面流转

### 5.1 路由表（新增用 🆕，改造用 ♻️）

| 路由 | 作用 | 主要入口 |
|---|---|---|
| `/` | 首页，6 卡片导航 | — |
| `/books` 🆕 | 书籍库（按分类分组） | 首页「选择章节」、侧边栏 |
| `/books/[id]` 🆕 | 书籍详情 → 章节列表 | `/books` |
| `/chapters/[id]` 🆕 | 章节详情 → 知识点清单 | 书籍详情、看板下钻 |
| `/kp/[id]` 🆕 | 知识点详情 | 章节详情、薄弱分析 |
| `/study` ♻️ | 学习闭环向导 | 多处 |
| `/study?chapterIds=a,b` ♻️ | **深链**：带章节进入并自动开测 | 书籍/章节详情页 |
| `/review` 🆕 | 全局薄弱点 + 教材复习 | 首页「教材复习」 |
| `/training` 🆕 | 变式训练队列 | 首页「变式训练」 |
| `/dashboard` ♻️ | 看板：薄弱分析 + 掌握更新 | 首页两卡 |
| `/manage` ♻️ | 内容管理（4 标签：书籍/章节/知识点/题库） | 侧边栏 |

### 5.2 学习闭环（保留 v1，向导式）

`选书/选章` → `测验` → `薄弱分析` → `教材复习` → `变式训练` → `掌握更新` → 回到看板

v1 的 `study/page.tsx` 状态机保留不动，**只增加两处**：
1. 初始化时读 `?chapterIds=`，命中则跳过选择步骤直接进测验。
2. 「完成」页的按钮从「再来一轮」升级为「回章节页」/「去薄弱分析」/「去训练」三个明确出口。

---

## 6. 数据库设计

### 6.1 现状

9 表 + 3 视图 + 1 函数，层级：`textbooks → chapters → knowledge_points → questions`，
事实表 `quiz_answers` 驱动 `mastery_records`（KP 级状态机），聚合在视图 `v_weak_points` / `v_mastery_overview`。

```
textbooks ──1:N──> chapters ──1:N──> knowledge_points ──1:N──> questions
                        ↑                    ↑                      ↑
              session_chapters      quiz_answers(kp_id)      quiz_answers(question_id)
                                                                        │
                                                          mastery_records (kp_id, 状态机)
```

### 6.2 字段变更（ALTER，全部 `if not exists` 幂等）

```sql
-- 书籍：启用分类 + 记录来源与导入状态
alter table textbooks add column if not exists category   text;               -- 分类：考试/计算机/语言…
alter table textbooks add column if not exists source     text default 'manual'
  check (source in ('manual','pdf'));
alter table textbooks add column if not exists status     text default 'ready'
  check (status in ('importing','ready','failed'));
alter table textbooks add column if not exists cover      text;
alter table textbooks add column if not exists description text;

-- 章节：章序号 + 来源（自动切分/手工）
alter table chapters add column if not exists chapter_no int;
alter table chapters add column if not exists source     text default 'manual'
  check (source in ('manual','auto'));

-- 知识点：来源 + 页码 + 分类标签 + 规划时长 + 溯源批次
alter table knowledge_points add column if not exists source           text default 'manual'
  check (source in ('manual','pdf','ai'));
alter table knowledge_points add column if not exists page_start      int;
alter table knowledge_points add column if not exists page_end        int;
alter table knowledge_points add column if not exists tags            text[] default '{}';
alter table knowledge_points add column if not exists estimated_minutes int;

-- 软删除（关键：保学习历史）
alter table textbooks       add column if not exists deleted_at timestamptz;
alter table chapters        add column if not exists deleted_at timestamptz;
alter table knowledge_points add column if not exists deleted_at timestamptz;
alter table questions       add column if not exists deleted_at timestamptz;
```

### 6.3 新表

```sql
-- PDF 导入批次（溯源 + 异步任务状态）
create table if not exists import_batches (
  id            uuid primary key default gen_random_uuid(),
  textbook_id   uuid references textbooks(id) on delete cascade,
  file_name     text not null,
  file_size     int,
  page_count    int,
  status        text not null default 'pending'
                check (status in ('pending','parsing','splitting','ready','failed')),
  detected_chapters int default 0,
  detected_kps      int default 0,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- 章节学习计划（可选规划，P2）
create table if not exists chapter_plans (
  chapter_id uuid primary key references chapters(id) on delete cascade,
  plan       jsonb not null default '{}'::jsonb,   -- {steps:[{kp_id,order,minutes}],note}
  updated_at timestamptz not null default now()
);
```

### 6.4 新视图：章节 / 书籍级状态（**不建状态表，用派生避免双真值**）

```sql
-- 章节进度：KP 级掌握度向上聚合
create or replace view v_chapter_progress as
select
  ch.id            as chapter_id,
  ch.textbook_id,
  ch.title         as chapter_title,
  ch.sort_order,
  count(kp.id)                                        as total_kps,
  count(kp.id) filter (where coalesce(m.status,'not_started') = 'mastered')  as mastered_kps,
  count(kp.id) filter (where coalesce(m.status,'not_started') = 'learning')  as learning_kps,
  count(kp.id) filter (where coalesce(m.status,'not_started') = 'not_started') as not_started_kps,
  coalesce(sum(coalesce(m.total_wrong,0)),0)         as total_wrong,
  coalesce(sum(coalesce(m.total_correct,0)),0)       as total_correct,
  case
    when count(kp.id) = 0 then null
    else round(coalesce(sum(coalesce(m.total_correct,0)),0)::numeric
         / nullif(coalesce(sum(coalesce(m.total_correct,0)+coalesce(m.total_wrong,0)),0),0) * 100, 1)
  end                                                 as accuracy_pct,
  case
    when count(kp.id) = 0 then 'not_started'
    when count(kp.id) filter (where coalesce(m.status,'not_started')='mastered') = count(kp.id) then 'mastered'
    when count(kp.id) filter (where coalesce(m.status,'not_started')='not_started') = count(kp.id) then 'not_started'
    else 'learning'
  end                                                 as status
from chapters ch
left join knowledge_points kp on kp.chapter_id = ch.id and kp.deleted_at is null
left join mastery_records  m  on m.kp_id = kp.id
where ch.deleted_at is null
group by ch.id, ch.textbook_id, ch.title, ch.sort_order;

-- 书籍进度：章节进度再向上聚合
create or replace view v_book_progress as
select
  t.id          as textbook_id,
  t.title,
  t.category,
  count(cp.chapter_id)                                                    as total_chapters,
  coalesce(sum(cp.total_kps),0)                                          as total_kps,
  coalesce(sum(cp.mastered_kps),0)                                       as mastered_kps,
  coalesce(sum(cp.total_wrong),0)                                        as total_wrong,
  case when coalesce(sum(cp.total_kps),0) = 0 then null
       else round(coalesce(sum(cp.mastered_kps),0)::numeric
            / sum(cp.total_kps) * 100, 1) end                             as mastery_pct,
  case
    when coalesce(sum(cp.total_kps),0) = 0 then 'not_started'
    when sum(cp.mastered_kps) = sum(cp.total_kps) then 'mastered'
    when sum(cp.total_kps) - sum(cp.mastered_kps) - sum(cp.not_started_kps) = 0 then 'not_started'
    else 'learning'
  end                                                                      as status
from textbooks t
left join v_chapter_progress cp on cp.textbook_id = t.id
where t.deleted_at is null
group by t.id, t.title, t.category;
```

### 6.5 删除语义（重要设计决策）

| 操作 | 行为 | 理由 |
|---|---|---|
| 删除章节 / 知识点 / 题目 | **软删**（`deleted_at`），关联对象级联软删 | 硬删会连带 `on delete cascade` 删掉 `quiz_answers` → **学习历史被摧毁**，看板统计失真 |
| 彻底删除 | 仅当无关联作答时允许 | 让维护者能清理纯脏数据 |
| 软删数据可见性 | 所有查询过滤 `deleted_at is null` | 避免「已删章节还在统计里」 |

**迁移**：`alter table ... ` + 视图重建 + `supabaseStore`/`localStore` 的 `list*` 方法统一加过滤条件。

### 6.6 数据迁移脚本

新增 `db/migrate-v2.sql`（幂等）：字段 ALTER → 新表 → 新视图 → 旧视图加 `deleted_at` 过滤 → 重建索引。
`scripts/preflight.mjs` 同步加 v2 结构校验（视图存在、字段存在、软删过滤生效）。

---

## 7. API 设计

### 7.1 新增

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/books` | 书籍树 + `v_book_progress` 汇总（按分类分组） |
| GET | `/api/books/[id]` | 书籍详情：章节列表 + 每章进度 + 徽标 |
| GET | `/api/chapters/[id]` | 章节详情：KP 清单 + 掌握状态 + 标签 + 错题数 |
| GET | `/api/kp/[id]` | 知识点详情：原文/页码/标签/作答历史/掌握轨迹 |
| GET | `/api/weak-points` | 全局薄弱点（跨书），支持 `?limit&bookId&chapterId` |
| GET | `/api/training/queue` | 待训练 KP 队列（未掌握优先，错题多者在前） |
| GET | `/api/progress/chapters` | 章节进度列表（供看板分组） |
| POST | `/api/manage/textbooks` | 新增书籍（title/category/subject/author） |
| PATCH | `/api/manage/textbooks/[id]` | 编辑书籍（含分类） |
| DELETE | `/api/manage/textbooks/[id]` | 软删书籍 |
| DELETE | `/api/manage/chapters/[id]` | 软删章节 |
| DELETE | `/api/manage/knowledge-points/[id]` | 软删知识点 |
| POST | `/api/import/pdf` | 上传 PDF → 建批次 → 解析 → 返回章节候选 |

### 7.2 改造

| 方法 | 路径 | 改动 |
|---|---|---|
| GET | `/api/chapters` | 过滤软删；附带章节级 status/accuracy |
| GET | `/api/dashboard` | 新增 `by_book` / `by_chapter` 分组字段 |
| POST | `/api/quiz` | 支持 `chapterIds` 深链语义不变，新增「只测某章」快捷参数 |

### 7.3 约定（沿用 v1 `src/lib/http.ts`）

- 入参错误 → 400；对象不存在 → 404；冲突（如页码倒置）→ 409；其余 → 500。
- 所有 DELETE 返回 `{ok:true, softDeleted:true}`，不返回 200 + `ok:false`。

---

## 8. 关键技术方案

### 8.1 PDF 自动分章（v1 spec 变更项 ⚠️）

> v1 明确约束「**不解析 PDF**」，本需求属于范围扩张。实现要点：

**两阶段设计（避免一次性烧 token + 错切无法挽回）**

```
阶段 A：切章（便宜、可回滚）
  上传 PDF → 解析文本层 → 优先读「目录页」（正则匹配 章/节 编号 + 标题 + 页码）
              → 无目录则按标题行模式 + 页码密度启发式切分
              → LLM 只做「归一化章节标题 + 补页码」，输出 JSON
              → 写入 chapters(source='auto')，状态待用户确认
阶段 B：知识点（按需、逐章）
  用户确认章节后 → 对每章调用 LLM 生成 3~8 个 KP（标题/摘要/原文摘录/标签/预估时长）
              → 逐章写入，支持单章重生成
```

**技术选型**

| 环节 | 方案 | 理由 |
|---|---|---|
| 文本抽取 | `pdfjs-dist`（纯 JS，无原生编译） | `pdf-parse` 依赖老旧 `pdfjs`，易与 Next/Turbopack 冲突 |
| 目录页识别 | 正则 `^\s*(第[一二三四五六七八九十百]+[章节]|\d+(\.\d+)*)\s+(.+)$` | 目录页识别准确率远高于正文启发式 |
| 无目录兜底 | 标题行模式 + LLM 归一化 | 覆盖 90% 教科书 |
| 扫描件 | **明确报错** `该 PDF 无文本层，暂不支持 OCR` | 不静默失败 |
| 大文件 | 分页处理 + `maxDuration=60` + 批次表异步化 | Vercel 单函数 60s 上限 |

**风险与取舍**

- 本地 `DATA_BACKEND=local` 走 `data/db.json`，**不适合存 PDF 二进制** → PDF 走文件系统 `data/uploads/`，数据库只存路径与批次状态。
- 章节切错必须能人工修正 → 阶段 A 结束即给用户「改名/删除/新增」入口。
- LLM 不可用时，**降级为纯规则切章**（只读目录页），不阻塞导入。

### 8.2 章节 OK / 不OK 判定

```
mastered   (OK)     : total_kps > 0 且 mastered_kps = total_kps
not_started(未开始) : total_kps = 0 或 全部 KP 未开始
learning   (不OK)   : 其余（有错题或学习中）
```
书籍状态：章节状态聚合（规则同 §6.4 `v_book_progress`）。
**为什么用视图不用表**：同一份事实只存一份，避免「状态表」与「mastery_records」漂移。

### 8.3 下钻与深链

- 统一用查询参数承载上下文：`/study?chapterIds=a,b`、`/dashboard?focus=weak&bookId=x`。
- 所有下钻入口由 `src/components/site-nav.tsx` 与各页卡片统一生成，避免散落硬编码。
- 面包屑组件：书籍 › 章节 › 知识点，任意层可回。

---

## 9. 实施路线图

> 每阶段结束都要能独立演示、独立验证，不堆未验证代码。

| 阶段 | 内容 | 完成判据 | 预估 |
|---|---|---|---|
| **S1 连通** | 首页 6 卡片可点击；`/study` 支持 `?chapterIds=` 深链 | 点卡片 → 进对应页 → 一键开测 | 0.5 天 |
| **S2 内容可逆** | 软删字段 + 4 个 DELETE 路由 + 管理页删除按钮 + 新增书籍（API+UI） | 加错的书/章/KP/题都能删且历史不丢 | 1 天 |
| **S3 下钻层** | `/books`、`/books/[id]`、`/chapters/[id]`、`/kp/[id]` + `v_chapter_progress`/`v_book_progress` | 三级可点穿；章节显示 OK/不OK；不OK 一键开测 | 2 天 |
| **S4 独立页** | `/review`（全局薄弱）、`/training`（训练队列）、`/dashboard` 分组增强 | 首页每张卡都有独立落点与真实数据 | 1.5 天 |
| **S5 PDF 导入** | 两阶段导入链路 + 导入 UI + 批次状态 | 上传 PDF → 出章节候选 → 确认 → 出知识点 | 2.5 天 |
| **S6 打磨** | 分类标签筛选、知识点规划、空态、响应式、错误提示 | 手机端可用、无死链、无 500 | 1 天 |

**总计约 8.5 天**（单人）。若优先做面试 Demo：**S1 + S2 + S3 + S4 = 5 天**即可满足「智能、连通」的主观感受。

---

## 10. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| PDF 切章准确率不稳 | 章节划分错乱 | 两阶段 + 人工确认；规则优先、LLM 兜底 |
| 软删引入「查不到历史数据」的困惑 | 统计口径不一致 | 看板口径固定为「非软删对象」；提供彻底删除选项 |
| 双后端（local / Supabase）行为漂移 | 线上线下表现不同 | 每个新特性必须同步写 `smoke4` 式「读落盘数据断言」测试 |
| `cacheComponents` 与 `force-dynamic` 冲突 | 接口返回快照、空数据 | 已在 v1 修复，新增 GET 一律 `force-dynamic` |
| 章节级状态规则被误解 | 面试被追问时说不清 | 规则集中在 `flow.ts` 单一定义，视图与 UI 共用同一判定函数 |
| 单机 RAM 紧张（16G） | 构建/Docker 起不来 | 本地演示用 `localStore`；PDF 解析耗时需实测上限 |

---

## 11. 验收清单

- [ ] 首页 6 张卡片全部可点击，300ms 内到达目标页，无 404
- [ ] 首页卡片落点各有**真实数据**（不是空列表）
- [ ] 书籍 → 章节 → 知识点三级可点穿任意层
- [ ] 章节显示 OK / 不OK / 未开始，且随答题即时变化
- [ ] 点不OK 章节可直接开测；点 OK 章节可重复训练
- [ ] 看板薄弱点可点进知识点详情，看到错题历史
- [ ] 教材复习列出全部薄弱知识点（跨书籍）
- [ ] 变式训练有独立可直达入口
- [ ] 书籍/章节/知识点/题目**都能删除**，且删除后学习历史不丢
- [ ] 能新增书籍并归类
- [ ] 上传 PDF 能出章节候选，人工可增删改后确认
- [ ] `npm run smoke` 全绿；`npm run build` 通过
- [ ] 手机端（`http://192.168.31.178:3000`）全流程可用

---

## 12. 待你确认（阻塞项）

1. **「需求分析模板」原文** —— ✅ 已定位（`个人学习复盘Agent_MVP项目需求与开发模板.pdf`），协同关系见 §0，无需重排。
2. **那 3 本书** —— 书名 + 各自的章节清单（也可给 PDF，我走 S5 导入链路直接生成）。
3. **范围确认**：PDF 自动切章是否本期必做？（v1 spec 明确「不解析 PDF」，属范围扩张）
4. **章节状态判定阈值**：默认「全章 KP 全部 mastered 才算 OK」，是否接受？还是要按正确率阈值（如 ≥90% 即 OK）？
5. **优先级取舍**：若时间紧，S5（PDF 导入）是否可推迟，先保 S1–S4？
