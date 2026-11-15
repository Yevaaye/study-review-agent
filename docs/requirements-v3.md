# 个人学习复盘 Agent · v3 需求分析文档（FSRS 卡片复习重构）

> 版本：v3.1（2026-11-03，最终定稿）
> 基线：v3.0 + 用户 12 条数据库调整 + 三条拍板结论
> 定位：把 v1/v2 的「章节测验闭环 Demo」重构为「**导入 Markdown → AI 生成卡片 → 用户审核 → FSRS 复习 → 自动排期**」的个人间隔复习工具。
> 状态：**定稿，按此实施**。文中每条设计均标注了代码证据 / 复用来源。

### 本版三条拍板结论（用户确认）

1. **彻底移除旧测验**：`questions / quiz_sessions / session_chapters / quiz_answers / mastery_records / training_attempts` 六表及相关视图/函数/页面/API 全部删除，不再"并行保留"。
2. **只做 Markdown**：PDF 文本抽取列为后续扩展（schema 已预留 `source_format='pdf'`，但不实现解析）。
3. **导出 JSON**：数据导出仅实现 JSON 格式。

### 数据库 12 条调整（本轮核心修订）

逐条对照用户建议，落点在 `db/schema.sql` 与 `src/lib/db/types.ts`，关键修订见 §5。

---

## 目录

1. 项目目标与边界
2. 两个子系统：AI 建知识结构 vs FSRS 管长期复习（本版最核心的一节）
3. 用户流程与业务规则
4. 页面与功能需求
5. 状态机与数据模型
6. 技术架构与复用清单
7. LLM 使用规范与异常处理
8. 分阶段开发计划
9. 测试与验收清单
10. 后续扩展方向

---

## 1. 项目目标与边界

### 1.1 项目目标

构建一个面向个人学习者的 Web 复习助手：用户导入学习材料（Markdown 或可提取文本的 PDF），
系统用 AI 把材料整理为**可审核的问答卡片**；用户确认后，系统基于 **FSRS** 根据历史复习表现安排后续复习时间。
产品首页以「**今日复习任务**」为核心，提供清晰的待复习数量、预计耗时与复习入口，
同时保留学习来源、卡片编辑、基础统计与数据导出能力。

### 1.2 本版（MVP）必须实现

1. **材料导入（仅 Markdown）**：上传后进入导入任务，可看进度 / 重试 / 恢复；每条产出都带原文定位（标题路径 / 段落）。
2. **AI 分章 + 找知识点（可核对）**：AI 给出章节划分与知识点建议，先进入**草稿**，用户可编辑 / 合并 / 拆分 / 删除后再确认。
3. **生成问答卡片（可审核）**：对已确认的章节，AI 生成问答卡片草稿；用户审核通过后卡片才进入复习。
4. **FSRS 复习 + 自评**：逐卡「先回忆 → 揭示答案 → 自评（Again/Hard/Good/Easy）」，由 ts-fsrs（FSRS-7）计算下次到期时间。
5. **今日任务首页**：待复习数量、预计耗时、一键开始复习。
6. **记录完整**：每次评分写成独立事件（幂等）；复习会话保存卡片快照；可回溯。

### 1.3 明确不做（本版）

- **PDF 导入**（schema 预留 `source_format='pdf'`，本期不实现解析；扫描件 OCR 更不做）
- 旧测验 / 题库（彻底移除，见 §1.0 拍板结论）
- 整本书一次性自动生成卡片（改为按章节 / 用户选定范围生成）
- 填空卡、摘要卡、多选卡（**第一版只做问答卡**）
- 多用户 / 登录 / 数据隔离 / RLS
- 复杂 Agent / 知识图谱 / 向量检索 / RAG
- 自动判定开放题答案（问答卡一律用户自评，AI 不替用户判分）
- FSRS 个性化参数训练（第一版用默认参数）
- CSV 导出（仅 JSON）
- 移动端原生 App

### 1.4 单用户说明

本版仅供开发者本人使用。不添加 `user_id`，不配置 Auth / RLS。材料默认**不公开、不分享**。

---

## 2. 两个子系统（本版最核心的一节）

> 这条是整个重构的**分水岭**。v1/v2 只有一个系统（章节测验闭环）；v3 必须拆成两个
> **状态独立、通过「来源定位」相连**的子系统。不拆清，就会把"AI 建结构"和"FSRS 排期"搅在一起，两头都做不稳。

```
┌─────────────────────────────────────┐
│  子系统 A：内容构建（AI 建知识结构）     │
│  导入 → AI 分章/知识点 → 用户校正        │
│  → 生成卡片草稿 → 用户审核 → 转正式      │
│  产出：带原文定位的「材料 + 卡片」        │
│  状态：draft → confirmed / active       │
└───────────────┬─────────────────────┘
                │ 审核通过（一次性交接）
                ▼
┌─────────────────────────────────────┐
│  子系统 B：长期复习（FSRS 调度）        │
│  今日到期卡片 → 回忆 → 自评 → 记录      │
│  → 算下次到期 → 回首页                  │
│  状态：由卡片级 FSRS 状态驱动           │
│  产出：复习事件 + 到期时间              │
└─────────────────────────────────────┘
```

### 2.1 为什么要拆

| 维度 | 子系统 A（内容构建） | 子系统 B（长期复习） |
|---|---|---|
| 核心对象 | 材料 / 章节 / 知识点 / 卡片草稿 | 卡片 + FSRS 状态 |
| 用户动作 | 导入、校正、审核 | 回忆、自评 |
| 状态终点 | 卡片被审核通过 | **没有终点**（卡片间隔越来越长） |
| AI 角色 | **主链路第一环**（生成卡片） | 无（调度是确定性算法） |
| 失败处理 | 可重试、可部分成功、需人工兜底 | 幂等记账，不允许丢事件 |

**一句话**：A 是"造卡片"，B 是"用卡片"。A 的质量决定 B 的上限；B 的调度准确性决定用户每天是否愿意打开。

### 2.2 两个子系统的连接点：来源定位（source locator）

A 产出的每个章节、知识点、卡片，都必须携带**来源定位**，指向材料里的原文位置：

- Markdown：文件 + 标题层级 + 段落（`path#h2-h3 > para N`）
- PDF：页码区间（`page 31-35`）

**没有来源定位的知识点/卡片，不允许进入复习**（用户无法核对质量）。这是 A → B 交接的**质检闸门**。

---

## 3. 用户流程与业务规则

### 3.1 主闭环

```
导入材料(MD/PDF) → AI 分章+找知识点(带原文定位) → 用户校正 → 生成问答卡草稿
   → 用户审核 → 开始复习(今日到期) → 先回忆再自评 → 保存事件+算下次到期 → 回首页
```

### 3.2 必须遵守的流程约束

1. **草稿隔离**：AI 生成的一切（章节、知识点、卡片）先入 `draft`，未审核**绝不**进入复习队列。
2. **来源可回溯**：进入复习的卡片必须能点回原文位置（验收硬指标）。
3. **先回忆后揭晓**：复习时先展示卡片正面（问题），用户主动"显示答案"后才可自评；评分含义固定为
   Again=没想起来 / Hard=想起但费力 / Good=正常想起 / Easy=轻松想起（Anki 语义，不是"答对/答错"）。
4. **排期由库计算**：到期时间一律来自 FSRS 库，业务层不手写间隔公式。
5. **事件追加不覆盖**：每次评分 = 一条独立 `card_reviews` 事件；FSRS 状态是派生结果，历史不可改写。
6. **本轮完成 ≠ 全部掌握**：完成 = 把今日到期卡片各处理一次；没想起来的卡片会再次进入队列，但本轮仍可结束。

### 3.3 状态机（两套，独立）

**内容对象状态（子系统 A）**

```
source:  uploading → parsing → split_ready → (人工校正) → confirmed
chapter: draft → confirmed / merged / deleted
card:    draft → active / edited / deleted
```

**卡片复习状态（子系统 B，由 ts-fsrs 派生）**

```
new → learning → review / relearning（根据 Again 触发）
         │
         └── 到期 due 由 stability / difficulty / elapsed_days 计算
```

> 注意：旧项目的 `not_started → learning → mastered`（连对 2 次 = 掌握）**不再负责排期**。
> FSRS 世界里"掌握"是渐进的，没有终点；旧状态机保留给旧题库测验（如需）。

---

## 4. 页面与功能需求

| 页面 | 主要功能 | 关键交互 |
|---|---|---|
| **首页（今日任务）** | 待复习卡片数、预计耗时、今日已复习进度、一键开始 | 开始复习；进入导入 / 来源库 / 统计 |
| **导入页** | 上传 MD/PDF；显示进度（解析→分章→找点→生成卡）；失败重试 | 选文件；查看任务状态 |
| **校正台（分章/知识点）** | AI 结果草稿，带原文定位；编辑/合并/拆分/删除 | 逐条确认或修正 |
| **卡片审核台** | 卡片草稿，正面/背面/来源；通过/编辑/删除 | 审核后转 active |
| **复习页** | 逐卡：正面 → 显示答案 → 自评 Again/Hard/Good/Easy | 自评后自动下一张 |
| **来源库 / 阅读页** | 材料、章节、知识点下钻，卡片挂载点 | 复用旧 `/books` 骨架 |
| **统计 / 导出** | 复习数量、卡片增长、耗时；导出 JSON/CSV | 查看；导出 |
| **设置** | 隐私说明（哪些内容会发 AI）、数据删除 | 查看；删除 |

### 4.1 MVP 交互要求

- 全程显示加载 / 空状态 / 错误提示与**重试入口**。
- 评分提交**幂等**，重复点击不重复记账；刷新后能恢复进行中的复习。
- 导入与 AI 处理**按步骤显示进度**；已成功的章节不因后续失败而丢失。
- 未审核卡片在复习队列中不可见。

---

## 5. 数据模型

### 5.1 现状与处置

旧 9 表中，`textbooks → chapters → knowledge_points` 是**现成的内容树**，复用为"材料目录 + 阅读页"。
其余 6 表（`questions / quiz_sessions / session_chapters / quiz_answers / mastery_records / training_attempts`）连同相关视图（`v_mastery_overview / v_weak_points / v_learning_overview`）、函数（`pick_questions`）、页面（`/manage`、`/study`、`/dashboard` 旧逻辑）与 API **彻底移除**。

### 5.2 最终表清单（对齐 12 条调整）

| 表 | 作用 | 关键设计点（对应建议条目） |
|---|---|---|
| `textbooks` | 材料 | 版本元数据（`source_format / original_file_name / storage_key / mime_type / file_size_bytes / content_hash / parser_version / source_version`）+ 材料级状态 `ready/archived` + `archived_at` 软删（#2 #1 #5） |
| `chapters` | 章节 | 软删除 `deleted_at`，拆/合章不级联清空（#5） |
| `knowledge_points` | 知识点 | 软删除（#5） |
| `source_fragments` | 原文片段 | 结构化定位 `heading_path / paragraph_index / page_start~end / char_start~end / fragment_index / content_hash`，`locator` 仅作可读摘要（#3 #12） |
| `import_jobs` | 一轮导入任务 | `input_hash / attempt_count / progress / stage_started_at / updated_at / parser_version / model / result_summary`；`stage` 加 `review_required`（#1） |
| `cards` | 问答卡 | 状态 `draft/active/rejected/archived` + `content_revision / content_hash / generation_job_id / reviewed_at / rejected_at / deleted_at`（#11） |
| `card_sources` | 卡↔片段 多对多 | 带 `role`（#4） |
| `knowledge_point_sources` | 知识点↔片段 多对多 | （#4） |
| `card_fsrs_states` | 卡片 FSRS 状态 | 对齐 ts-fsrs v6/FSRS-7 字段，含 `fsrs_version / scheduler_version / params_version`（#9） |
| `review_sessions` | 复习会话 | `scope / timezone / started_at / finished_at`（#8 #10） |
| `review_session_cards` | 会话↔卡片清单 | `sort_order / card_snapshot / rated / review_id`（#8） |
| `card_reviews` | 复习事件 | `idempotency_key` 唯一 + `content_revision` + `state_before/state_after` JSONB + `due_before/due_after` + `elapsed_ms`（#6 #7） |

完整 DDL 见 `db/schema.sql`（已重写，可直接粘贴执行）。

### 5.3 删除策略（本轮最重要修正）

**v3.0 草案的 `on delete cascade` 是错的**，会随来源片段删除连带清空卡片、随卡片删除连带清空复习历史——与"每部分需记录、便于回溯"直接冲突。最终定稿：

- 内容树（章节/知识点/片段/卡片）一律**软删除**（`deleted_at` / `archived_at`），外键用 `on delete restrict` 或 `set null`，**不使用 cascade**。
- 复习事件（`card_reviews`）**永不物理删除**，是追加式事实。
- 仅当用户**显式删除材料**时，提供"同时物理删除相关卡片 + 学习记录"的明确选项（二次确认，提示不可恢复）。

### 5.4 FSRS 状态字段（对齐 ts-fsrs v6 / FSRS-7）

> 关键修正：v3.0 草案按旧 FSRS 字段建表，**漏了 `stabilityFast`、`learningStep`、`scheduleStatus`**，且误用了 `elapsed_days`（v6 已移除）、`due`/`last_review`（v6 已改名 `dueAt`/`lastReviewAt`）。以下以库真实类型为准。

| ts-fsrs v6 字段 | DB 列 | 类型 | 说明 |
|---|---|---|---|
| `stability` | `stability` | double | 慢速稳定性（天） |
| `stabilityFast` | `stability_fast` | double | **快速稳定性，仅 FSRS-7 有** |
| `difficulty` | `difficulty` | double | 难度 1~10 |
| `state` | `state` | int | New=0 Learning=1 Review=2 Relearning=3 |
| `scheduleStatus` | `schedule_status` | text | new/learning/review/relearning |
| `scheduledDays` | `scheduled_days` | double | 调度间隔（天） |
| `learningStep` | `learning_step` | int | 零基步骤索引（非 reps） |
| `reps` | `reps` | int | 复习次数 |
| `lapses` | `lapses` | int | 遗忘次数 |
| `dueAt` | `due_at` | timestamptz | 到期时间 |
| `lastReviewAt` | `last_review_at` | timestamptz | 上次复习时间（New 为 null） |

Rating 枚举：`Again=1 Hard=2 Good=3 Easy=4`（`Manual=0` 仅内部用，不作为评分）。

**版本追溯**（#9）：`card_fsrs_states.fsrs_version='FSRS-7'`、`scheduler_version='ts-fsrs@6'`、`params_version='default'`，并**锁定 ts-fsrs 依赖版本**，避免升级后历史卡片状态语义漂移。

### 5.5 幂等与事务（#7）

复习提交在**一个数据库事务**内完成三件事：写 `card_reviews` 事件 + 更新 `card_fsrs_states` + 更新 `review_session_cards.rated`。
- 客户端每次评分生成 `idempotency_key`（uuid），`card_reviews.idempotency_key` 加唯一约束 → 双击/网络重试命中唯一冲突即幂等返回，不重复排期。
- Supabase 多请求依次写不等于事务 → 用 **Postgres RPC 函数**（或本地后端单事务）封装，`ts-fsrs` 的 `review()` 返回 `card + revlog` 后一次性落库。

### 5.6 今日待复习查询（首页核心，#10）

```sql
select * from v_due_cards;  -- status='active' and deleted_at is null and due_at <= now()
```

- 到期判定在 DB 层用绝对时间 `due_at <= now()` 是合理的；**学习日边界 / 时区 / 每日新卡上限**在应用层按 `review_sessions.timezone`（默认 `Asia/Shanghai`）与设置项处理。
- **预计耗时**由历史平均单卡时长（`card_reviews.elapsed_ms` 的均值）估算，不采用"固定卡片数 × 常数"的不透明口径。

---

## 6. 技术架构与复用清单

### 6.1 复用（保留不动 / 轻改）

| 现有代码 | 复用方式 |
|---|---|
| `src/lib/db/store.ts` 的 `DataStore` 接口 + 双后端抽象 | 保留"接口 + localStore/supabaseStore"模式，新增 Card 域方法 |
| `src/lib/llm.ts`（provider 抽象 + `chatJSON` + JSON 提取 + 重试 + 错误留痕） | **直接复用**，喂给"材料→卡片生成" |
| `src/lib/agent.ts` 的 schema 校验思路（`generateVariantQuestion` 的清洗逻辑） | 抽成通用的"生成→校验→清洗"范式，用于卡片生成 |
| `src/lib/http.ts`（400/404/409 约定） | 原样复用 |
| `src/lib/aggregate.ts`（知识点→章节→书籍聚合） | 作为"材料目录/阅读页"的起点 |
| `src/lib/flow.ts` 的"后端控流程、前端不跳门槛"原则 | 保留原则；`updateMastery` 随旧测验一并移除 |
| `src/lib/training.ts` 的"答案留服务端、客户端拿不到" | 随旧测验移除（问答卡是自评，无标准答案下发） |
| UI 风格（glass sidebar / serif / 卡片 / 深色） | 原样复用 |
| `/books` `/chapters/[id]` `/kp/[id]` 下钻页 | 改造为"来源库/阅读页"骨架 |

### 6.2 重写 / 新增

| 模块 | 说明 |
|---|---|
| 数据模型 | 新增 `cards / card_fsrs_states / card_reviews / source_fragments / import_jobs`（§5.2） |
| 调度层 | 新增 `src/lib/fsrs.ts`：封装 **ts-fsrs**，`schedule(state, rating) → newState`；纯函数可单测 |
| 卡片生成 | 新增 `src/lib/cards/generate.ts`：材料片段 → `chatJSON` → 问答卡草稿，schema 校验后落 `draft` |
| 导入解析 | 新增 `src/lib/import/`：Markdown 直接分段；PDF 用 **pdfjs-dist** 抽文本层（扫描件报错） |
| 首页 | 从 6 框导航 → **今日任务**（待复习数 + 预计耗时 + 开始复习） |
| 复习页 | 从"选章测验向导" → "逐卡回忆 + 自评" |

### 6.3 技术选型

| 环节 | 方案 | 理由 |
|---|---|---|
| 调度 | **ts-fsrs**（MIT，v6 默认 FSRS-7） | TS 项目原生适配；**先核对 Node 版本 ≥24**（本机已是 24.14.0）；固定版本避免升级后状态语义漂移 |
| 参数 | 默认参数 | 第一版不训练个性化参数 |
| PDF 文本抽取 | pdfjs-dist（纯 JS） | 避免 `pdf-parse` 老旧依赖与 Turbopack 冲突；扫描件明确报错 |
| 复习交互 | 自评 Again/Hard/Good/Easy | 参考 Recall / Anki 的成熟交互，不照搬代码 |

---

## 7. LLM 使用规范与异常处理

### 7.1 LLM 适用任务（本版主链路）

- 材料片段 → 生成问答卡片（`front` 问题 + `back` 答案 + 原文定位）
- 分章建议 + 知识点标题 / 摘要（带定位）
- **不**替用户判定开放题答案（问答卡一律用户自评）

### 7.2 结构化输出与校验

- 要求模型返回 `{cards: [{front, back, source_locator, kp_title}]}`；服务端做 schema 校验，
  校验失败重试一次；仍失败则**显式报错并保留已成功部分**（不静默清空）。
- 生成结果一律 `status='draft'`，**模型不直接写 `active`**（模型不能绕过审核）。

### 7.3 异常处理

- 模型超时 / 5xx：重试一次；仍失败 → 导入任务 `stage='failed'` + 可读原因 + 重试入口。
- 输出格式错误：拒绝入库，记录日志，保留原片段待人工。
- 网络/数据库失败：提示重试，不丢失已保存的复习事件。
- **隐私**：导入页明示"材料将发送给外部 AI 服务用于生成卡片，可随时删除"；不默认公开。

---

## 8. 分阶段开发计划

> 每阶段可独立演示、独立验证，不堆未验证代码。

| 阶段 | 内容 | 完成判据 | 预估 |
|---|---|---|---|
| **P1 模型与调度** | 定义卡片/FSRS 类型 + `fsrs.ts` 封装 ts-fsrs + CardStore 本地落盘 + 单测 | `schedule()` 单测通过：Again 缩短、Easy 拉长；今日到期查询正确 | 1 天 |
| **P2 导入→生成** | 导入 Markdown（先做）+ PDF 文本抽取 + `generate.ts` 生成卡片草稿 + 导入任务进度 | 上传 MD → 出卡片草稿，带原文定位 | 1.5 天 |
| **P3 校正与审核** | 校正台（分章/知识点）+ 卡片审核台 + 草稿→active 转换 | 用户能改/删/合并，审核通过才进队列 | 1.5 天 |
| **P4 复习闭环** | 首页今日任务 + 复习页（回忆→自评→排期）+ 事件记录 + 幂等 | 完整走通一次复习，评分后到期时间正确变化 | 1.5 天 |
| **P5 统计与打磨** | 统计/导出 + 隐私说明 + 空态/响应式 + 手机访问 | 手机端可用、无死链、无 500 | 1 天 |

**总计约 6.5 天**（单人）。核心主链路（P1–P4）约 5.5 天即可验收。

---

## 9. 测试与验收清单

### 9.1 功能验收

- [ ] 用户能看到并修正 AI 划分的章节和知识点（带原文定位）。
- [ ] 每张卡片能回到对应原文位置；**未审核卡片不进入复习**。
- [ ] 刷新后能恢复进行中的复习；重复提交不重复记账（幂等，靠 `idempotency_key` 唯一约束）。
- [ ] Again/Hard/Good/Easy 的下次到期时间由 ts-fsrs（FSRS-7）计算，有评分/时区/重复提交测试。
- [ ] 本轮可完成，即使仍有没想起来的卡片；这些卡片被标记并进入后续学习。
- [ ] 记录材料导入成功率、卡片审核通过/修改/删除比例、导入→首次复习耗时。
- [ ] `tsc --noEmit` / `build` 通过；手机端全流程可用。
- [ ] 无 `user_id` / Auth / RLS 代码；无密钥进仓库。
- [ ] 删除策略：删片段/章节不级联清空卡片与复习历史；显式删材料才物理删除（二次确认）。

### 9.2 面试演示验收标准（本轮核心目标）

> 面试时能否**稳定、清楚**地演示这条闭环，是 v3.1 的最高验收标准。

1. **导入**：从一份样例 Markdown 开始，几分钟内生成并审核卡片。
2. **复习**：能完整复习至少几张卡，逐张揭示答案并自评（Again/Hard/Good/Easy）。
3. **排期**：每次评分后都有记录，下一次到期时间确实由 FSRS 计算（可当场看 `due_at` 变化）。
4. **鲁棒**：刷新页面或 AI 服务失败时，演示不会进入死路（有恢复入口 / 显式错误 + 重试）。
5. **可回溯**：能展示卡片来源、审核前后状态和复习历史。
6. **响应式**：桌面和手机宽度下都能完成主流程。

---

## 10. 后续扩展方向

- **PDF 导入**（schema 已预留 `source_format='pdf'`、`page_start/page_end`，需接 pdfjs-dist 文本抽取）
- 填空卡、摘要卡、多选卡（卡片 `kind` 已预留）
- 笔记平台连接器（Notion / flomo 等）
- FSRS 个性化参数训练（需 `@open-spaced-repetition/binding`）
- 知识图谱 / 向量检索（视真实瓶颈再评估）
- CSV 导出（本期仅 JSON）
- 公开分享（需先加 Auth + 数据隔离）

---

## 附：已确认的决定（非阻塞）

1. **旧测验**：彻底移除（§1.0 拍板结论 1）。
2. **导入范围**：仅 Markdown（§1.0 拍板结论 2）。
3. **导出格式**：JSON（§1.0 拍板结论 3）。

> 流程图（总架构 / 主闭环 / 数据流）见对话内的可视化图；数据库 DDL 见 `db/schema.sql`，类型见 `src/lib/db/types.ts`。

---

> 流程图（总架构 / 主闭环 / 数据流）见对话内的可视化图。
