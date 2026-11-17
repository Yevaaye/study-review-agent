# 自主复习台

将 Markdown 教材，变成一套能长期刷下去的复习卡：同时题目来自原文并且可以分类出知识点让ai出题，答案亦有出处。

它解决什么什么问题：学习完一本教材最大的问题在于缺少一套题目或者题目分散，而不只是记不住。手工筛选出题目太慢，让 AI 随便出题又无法对应到具体章节的知识点。

这个工具把「从原文里把题抠出来」和「让机器按记忆规律安排复习」这两件事自动化，同时让你能核对每道题的知识点，更可以根据不熟的知识点再出题增加熟练度。

---

v3 只有一个后端：`LocalStore`，全部状态存在本地 `DATA_DIR/db.json`。没有 Supabase、没有测验/变式训练/掌握度看板那一套 v2 流程 —— 相关代码、`db/schema.sql`、旧冒烟脚本都已成为历史，不再是运行时的一部分。

---

## 1. 跑起来

```bash
npm install
npm run build && npm start   # 日常使用 / 手机访问：生产模式（推荐）
npm run serve                # 同上，一条命令完成 build + start
npm run dev                  # 仅限改代码时调试，别拿它日常使用
```

零配置。首次启动从 `db/seed-data.json` 播种（**1 本教材 / 2 章 / 4 个知识点 / 4 张卡**，均为待审核 `draft`）。

### 手机怎么打开

```bash
npm start       # 终端 1：应用，监听 3000
npm run lan     # 终端 2：把 80 端口转发到 3000（让手机不用输 :3000）
npm run qr      # 生成 qr-access.html，电脑上打开、手机扫码
```

手机必须**连上和电脑同一个 WiFi**（顶部出现 WiFi 图标，不是 5G / 4G）。内网地址 `192.168.x.x` 在移动数据下一定打不开。

- 带端口：`http://<本机局域网 IP>:3000`
- 不带端口（跑了 `npm run lan` 后）：`http://<本机局域网 IP>`
- 自助排查：手机浏览器访问 `http://<IP>/api/health`，能返回 JSON 就说明网络通，问题在应用侧。

> `npm run lan` 在 Windows 上绑 80 端口可能需要管理员权限；绑不上会打印原因并退出，不影响 3000。

> **日常使用请务必用生产模式。** `npm run dev` 的 Turbopack 会在源码变动后换掉 chunk hash，
> 已经打开的旧标签页随后会拿到 `ChunkLoadError` / `Failed to fetch`（dev overlay 标 `(stale)`），
> 表现为点任何链接都报错、页面反复自己刷新。2026-11-05 的处理是把 3000 端口从 dev 切回
> `next start`（`.next-prod`）：没有 HMR、chunk 固定、没有 dev 报错浮层，问题消失。
> 代价是**源码改动后必须重新 `npm run build` 并重启**，生产模式不会热更新。

> **dev 与 build 的产物目录是分开的**（`next.config.ts`）：dev 用默认 `.next`，build / start 输出到 `.next-prod`。
> 别把方向反过来 —— 自定义目录不在 Turbopack 的 watch 忽略名单里，dev 会把自己写的编译产物当成源码变化，
> 表现就是**页面每 0.3 秒自己刷新一次、完全没法用**（2026-11-05 实事故）。`smoke.mjs` 与 `serve-share.mjs` 已按 `.next-prod` 对齐。

> Windows 提示：若 `npm install` 报 `SAFE_DELETE_*` / `Some operations were aborted`，改用
> `npm install --ignore-scripts --prefer-offline`。

### 环境变量（`.env.local`）

| 变量 | 作用 |
|---|---|
| `APP_PASSWORD` | 访问口令。**为空时口令门关闭**，挂公网等于全裸 |
| `DATA_DIR` | 数据目录，默认 `./data`。多实例必须各自指向不同目录 |
| `SKIP_SEED=1` | 新实例不播种示例材料 |
| `LLM_PROVIDER` | `openai`（默认）/ `deepseek` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI 兼容网关；模型默认 `gpt-5.5` |
| `DEEPSEEK_API_KEY` | 切 DeepSeek 时用 |
| `LLM_JSON_MODE` | 默认 `off`。部分网关带 `response_format` 会 502，确认支持再开 |

`src/proxy.ts` 是口令门：未登录页面 307 跳 `/login`，接口返 401；登录接口按 IP 限 5 次 / 5 分钟。

---

## 2. 一条完整链路

```
① 导入      /import 贴 Markdown → POST /api/import
            标题层级归一 → 分章 → 切片 → 规则分类 → 抽「原题」
            抽原题 = 规则逐字抽取（保底基线）+ 模型辅助判断题目边界 / 题型 / 答案引用。
            模型只做判断、不产出文本；失败 / 超时 / 格式异常自动回退规则，导入不会失败。
            原题当场入库（status=draft, source=original）
② 生成      POST /api/import/{jobId}  mode=smart|deep|off
            AI 按章提炼知识点 + 出卡；纯知识点材料会在结果面板主动询问是否出题
            出卡有一道代码闸门：每题必须带 evidence，且 evidence 能在本章正文里
            逐字找到、与所属知识点同源，否则**直接丢弃并计数**（见第 4 节）
③ 审核      /cards 审核台：通过 / 加入复习 / 内容错误 / 编辑 / 绑知识点 / 批量操作
            「通过」= 已掌握 → status=mastered，**不进复习**；
            「加入复习」= status=active + due=now，立刻进今日队列
            「内容错误」= AI 把非题目内容误判成题 → status=invalid，**既不通过也不复习**，
                         移出审核台与复习队列；数据保留，可在「内容错误」分区恢复或彻底删除
            「删除」入口只挂在「内容错误」分区的卡片上：普通卡片一个动作（作废，可撤销），
                         避免与「内容错误」语义重复、也避免手滑抹掉还能救的卡（API 的 DELETE 不设限）
            前两条路径都会补一条 FSRS 初始状态（见 localStore.applyVerdict）
④ 复习      /review 翻面自评或做选择题；答完立刻给出「下一次什么时候出现」
⑤ 回看      /library 书 → /chapter/{id} 章节题目 → /read/{id} 全文 + 原文定位
            /stats 看题型分布、复习次数、遗忘次数
```

**抽取保真（`src/lib/import/fidelity.ts`）**

原题是从 Markdown 里逐字搬的，但链路里有几个「无害动作」会让卡上的字和原文不再严格相等：
去 `**` / 多行 `join("\n")` / 选项补 `A. ` 前缀 / 表格单元格切片 / 判断题补「（对/错）」后缀。
这些绝大多数是排版等价，可一旦真的吞了半句、拼进下一段，人在审核台是看不出来的 ——
卡上只有结果，没有原文对照。

所以导入时对每道题做一次**反向核对**：题干 / 选项 / 答案归一化后回原文找。

| 状态 | 含义 | 界面 |
|---|---|---|
| `exact` | 全部逐字命中 | 不打扰（绝大多数） |
| `partial` | 60%~99% 命中（多行拼接、答案非原文） | 黄色「部分匹配原文」 |
| `missing` | <60% 命中（疑似改写） | 红色「⚠ 原文未找到」 |

定级只看**题干 + 选项**（题目本身）；答案字面对不上只降级到 partial 并在 note 里说明 ——
问答卡的答案本来就可能是一句归纳，不因此判成「被改写」。判断题的「对/错」选项、
「（对/错）」题型后缀都在比对前剥掉，避免题型归一被误报成改写。

章节页顶部有核对条（原文逐字 / 部分匹配 / 未找到 / AI 生成），每个知识点下可展开
「题目清单（N 道）」逐条看题干、题型、来源、保真状态。要离开屏幕核对，点
**导出核对清单** → `GET /api/outline?chapterId=…`（或 `?textbookId=…`）导出按
「章节 → 知识点 → 题目」摊平的 Markdown，末尾附「未关联知识点的题」和「需要优先核对的题」。
`?format=json` 给结构化版本。

存量卡用 `npm run backfill:fidelity`（默认只统计，`-- --write` 才写盘，自动备份）。
本次回填 494 张：**490 exact / 4 partial / 0 missing**。

**AI 出题的原文闸门（`src/lib/cards/generate.ts` + `grounding.ts`）**

提示词里写「evidence 必须逐字出现」是请求，不是约束。所以每张 AI 卡入库前要过三道：

1. `evidence` 必须能在本章正文里找到（三级放宽：整段包含 → 掐头尾 → 12 字连续片段）
2. `evidence` 必须与所属知识点同源（bigram 重叠 ≥2 且 ≥20%，挡「挂错知识点」）
3. 选择题答案必须命中某个选项（否则无法判分）

不通过的卡**丢弃**而不是标记 —— 无据可查的题留在审核台只会消耗人的注意力。
挡掉的数量与原因写进 job 结果（`rejected`），"这次怎么只出了 1 张" 有解释。
知识点本身同理：`evidence` 在原文查不到的条目直接不入库。


**复习节奏**（`src/lib/fsrs.ts`，2026-11 重做：间隔交给 FSRS，只给增长封顶）：

| 操作 | 下次出现 |
|---|---|
| 没想起来 / 选择题答错 | **当天**（10 分钟后回到今日队列，本轮里也会立刻回到队尾）**+ 明天再考一次** |
| 想起但费力 | 明天（连续费力也停在 1 天，不会自动拉长） |
| 正常想起 | 由 FSRS 算，序列 **3 → 7 → 16 → 38 → 91 天** |
| 轻松想起 | 同 Good，起点 5 天、增速更高：**5 → 17 → 59 天** |
| 间隔 ≥ 60 天 | **已掌握**：移出复习排期，标识留在资料库的题目列表里 |

为什么是「FSRS + 封顶」而不是纯 FSRS：默认参数（desiredRetention 0.9）对这种中文短问答题非常激进 —— 实测第一轮 Good 就给 4.8 天，第二轮 26 天，第三轮 92 天，脱离考试周期。所以记忆强度（stability / difficulty / lapses）仍由 FSRS 推进、统计页照实展示，只把每轮间隔压到最多 ×2.4（Good）/ ×3.5（Easy），得到 3/7/16/38 这条可预期的曲线。要完全交给模型，把 `GOOD_GROWTH` / `EASY_GROWTH` 调大或删掉封顶即可。

答错的卡怎么保证「当天 + 次日」都复习到：`rating=1` 不排到未来（`due = now + 10min`，状态进 `relearning`），并且记下 `last_lapse_at`；只要**上一轮评分是 Again**，这张卡下一次答对后的间隔强制压到 1 天 —— 哪怕当天就补答对了，也不允许跳回 3 天起。序列由 `npm run check:schedule` 钉死成断言（15 条）。

---

## 3. 架构

```
页面      src/app/page.tsx          今日任务
         library / chapter/[id] / read/[id]   资料库 → 章节 → 全文
         import / cards / review / stats      导入 / 审核 / 复习 / 统计
         src/components/site-nav.tsx          桌面侧栏 / 手机底栏
─────────────────────────────────────────────────────────────────────
接口      src/app/api/**/route.ts  17 个路由文件（清单见第 5 节）
         src/proxy.ts             口令门（Next 16 middleware 等价物）
─────────────────────────────────────────────────────────────────────
领域      src/lib/import/*         Markdown 解析、标题归一、片段分类、原题抽取
         src/lib/cards/*          确定性 id、AI 生成卡、原题绑定
         src/lib/knowledge/*      规则抽知识点 + 题目归属
         src/lib/fsrs.ts          间隔表 + 毕业判据（ts-fsrs 只算记忆强度）
         src/lib/stats/*          全站统一的题型口径
         src/lib/llm.ts           OpenAI 兼容 provider + 超时/JSON 校验
         src/lib/jobs.ts          进程内异步作业（注意：重启即失，见第 7 节）
─────────────────────────────────────────────────────────────────────
数据      src/lib/db/store.ts      CardStore 接口 + globalThis 单例
         src/lib/db/localStore.ts JSON 文件实现（唯一后端）
         src/lib/db/types.ts      字段真源
         db/seed-data.json        种子数据真源
```

**数据层只有一个实现**，`getStore()` 永远返回 `LocalStore`。`db/schema.sql` 是历史存档，运行时不读；`DATA_BACKEND` / `SUPABASE_*` 不是有效配置。

### db.json 里的集合

`textbooks` · `chapters` · `knowledgePoints` · `source_fragments` · `import_jobs` · `cards` · `card_sources` · `card_fsrs_states` · `review_sessions` · `review_session_cards` · `card_reviews` · `answer_fix_logs` · `card_error_reports` · `seeded`

卡片通过 `card_sources` 挂到原文片段，复习时「回到原文」按这个链接跳转；AI 生成的卡用模型给出的 `evidence` 引文去匹配最相关的片段，而不是一律指向章首。题型以 `card_type`（choice / cloze / judge / qa / contrast）为准，`is_choice` 只作老数据兜底。

---

## 4. AI 用在哪儿，挂了怎么办

| 场景 | 依赖 AI | 失败时 |
|---|---|---|
| 解析、分章、抽原题、审核、排期、统计 | ❌ 纯规则 | 不受影响 |
| 提炼知识点 / 生成复习卡 | ✅ 可选 | 保留规则抽出的原题，导入仍可用 |
| 原题与知识点的自动绑定 | ❌ 纯规则（同章 + 文本相似度） | — |

**规则提炼知识点时会跳过题组与答案区**（`question_*` / `answer_*` 片段），并在小节内过滤题干行、选项行、答案行、疑问句。不跳的话，一个以题为主体的小节会提炼出「1.1 政策工具：1. 下列哪项属于财政政策的工具？」这种陈述 —— 知识点变成题目的复述，「按知识点出题」就退化成「拿题出题」，而且 statement 和 evidence 明显对不上号（真实事故：一本材料 42 条知识点里 41 条被题目污染）。

模型配置统一读 `src/lib/config.ts`。导入作业记录的 `model` 也来自 `config.llm.openaiModel`，改 `OPENAI_MODEL` 后不会「配置说一套、导入做一套」。生成失败是**单章失败不整单失败**，其余章照常入库。

---

## 5. 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 后端 / 数据库 / LLM 配置自检 |
| GET/POST | `/api/books` | 材料列表 / 手工建材料 |
| DELETE | `/api/books/{id}` | 删材料（级联删章节、片段、卡片、复习记录） |
| GET | `/api/cards` | 卡片列表（按 status / type / chapter / fragment 过滤） |
| POST/DELETE | `/api/cards/{id}` | `action=approve`（已掌握，不复习）/ `reject`（加入复习）/ `invalidate`（内容错误作废，不通过也不复习）/ `restore`（恢复为待审核）/ `edit` / `bindKp`；DELETE 软删除 |
| POST | `/api/cards/batch` | 批量审核 |
| POST | `/api/import` | 导入 Markdown，建 `import_job` |
| GET/POST | `/api/import/{id}` | 查作业 / 触发整本生成 |
| POST | `/api/chapters/{id}/generate` | 单章按需补题 |
| GET | `/api/jobs` | 进程内作业状态 |
| POST | `/api/review` | 开复习会话（`scope=all` / `group=due\|new` / `textbookId`）；`resume=true` 时续接同范围、当天、未完成的一轮，不新建；无卡可刷时回 **200 + `empty: true`**（不是 400） |
| GET | `/api/review/current` | 当前这一轮（当天未完成）；`?book=<id>` 只认这本书的轮次（从书详情/原文跳回来时不串书）；没有则 `session: null` |
| GET | `/api/review/inprogress` | 当天所有没刷完的轮次（总数 / 已答 / 剩余 / 下一张 / 书名），供选书页写「已答 5/30 · 继续」 |
| POST | `/api/review/rate` | 评分（幂等键 = 一次作答动作） |
| POST | `/api/review/complete` | 结算本轮 |
| GET | `/api/today` | 今日待复习 + 分书统计 |
| GET | `/api/export` | 导出数据 |
| GET | `/api/outline` | 核对清单：`?textbookId=` / `?chapterId=`，默认 Markdown（章节 → 知识点 → 题目），`format=json` 给结构化版本 |
| POST | `/api/cards/{id}/answer-key` | 手动标注正确答案（`keys: [0,2]` 即多选；`backfill=true` 供脚本批量回填，不写台账） |
| GET/POST/PATCH | `/api/card-errors` | 出题错误台账：上报 / 明细 / 统计（`?view=summary`）/ 监督员结论（`?view=review`）/ Agent 紧凑视图（`?format=agent`） |
| GET/POST | `/api/audit/ledgers` | 两本审计台账（答案缺口 + 拒绝入复习）：`GET` 全量、`?format=agent` 紧凑；`POST {action:"backfill"}` 从历史痕迹回填（幂等） |
| GET/POST | `/api/fragments/{id}/audit` | 原文识别核对：候选与覆盖率；`action=scan\|judge` 重新识别（可 AI）、`action=create` 人工补录建卡 |
| GET | `/api/llm-status` | 模型可用状态 |
| POST | `/api/auth/login` · `/api/auth/logout` | 口令门 |

错误约定由 `src/lib/http.ts` 统一：非法 JSON / 缺必填 / 参数越界 → 400，实体不存在 → 404，重复导入 → 409，其余 → 500。写盘失败**一定是 500**，不会静默降级。

**幂等语义**：`/api/review/rate` 用 `idempotency_key` 去重，键绑定「这一次作答动作」而非卡片 —— 「没想起来」会把同一张会话卡 requeue 回本轮队列，第二次评分必须能再落一条复习事件，否则 FSRS 永远不推进。

**空池语义**：今天刷完 / 这本书没有卡片时，`POST /api/review` 回 `200 { empty: true, message }`，前端按正常状态展示「已复习」。以前回 400，前端渲染成红色告警，用户刚刷完切回来会以为进度坏了。

**状态文案只有一个来源**：`src/lib/review/labels.ts` 的 `REVIEWED_LABEL` / `reviewedLabel()`。对外统一说「已复习」，不写「无到期」「没有到期」这类排期内部说法 —— `check:wording` 会扫全部 `.tsx` 拦住回退。

**进度语义（别改成前端自己记）**：一轮复习的「答到哪了」只有一个真相 —— `review_session_cards.rated`。客户端 sessionStorage 快照只存「停在哪一题 + 当时的选择」，**不存卡片列表**；重挂时先 `GET /api/review/current`，命中就用服务端卡片，并用 `firstUnratedIndex` 跳到第一张没答的题。这样从原文、卡片页、手机切后台回来都是同一轮；跨天的 `in_progress` 不复用（按 `abandoned` 收尾）。

**跨书并行（别改回全局作废）**：续接时只收尾**同范围**的重复轮次（`abandonOtherInProgress(id, scope)`）。早期不区分范围，凡别的 `in_progress` 一律作废 —— 于是「A 书刷到第 5 张 → 去 B 书看一眼 → 回 A 书」时 A 那轮已被作废，进度凭空消失。现在 A、B 各自保留，`/api/review/inprogress` 按范围去重后逐本列出，选书页据此显示断点并给「继续」按钮（点击时带上原来的 `mode/group`，否则续接不上）。

补一层判定：`findAnsweredSince` 会把「本轮开始之后、在别的会话里答过的题」也算作已答 —— 换书、双标签页、上一轮没点完成就退出，都会造出这种「已经答过却还 rated=false」的卡。

**多选语义**：`cards.answers` 存全部正确选项的**全文**，`answer` 存字母列表（`A、C`），`is_multi` 由 `answers.length ≥ 2` 派生。导入、手动标注、复习判题共用 `src/lib/cards/answer-keys.ts` 的同一套解析，多选判题是**集合相等** —— 少选一个、多选一个都算错。

**错误台账给谁用**：复习页「错误」按钮写入 `card_error_reports`（含当时的卡片快照），复盘 Agent 的监督员按下面的路径取用：

1. `GET /api/card-errors?format=agent` —— 病因、用户标注、卡片快照，用于聚类；
2. `GET /api/card-errors?view=review` —— 直接拿到 `findings`（按病因归集 + 影响面 + 代表样本）、`next_actions`、`narrative`；
3. `PATCH /api/card-errors` —— 把核查结论写回（`status=reviewed|fixed|dismissed` + `verdict` + `suggested_action`）。

归因是**纯规则**的（`src/lib/cards/error-report.ts`），同样一批数据每次跑出的结论一致，改完规则可以用同一批样本回归 —— 这是「据此自我迭代」能验证的前提。

### 两本审计台账（过程缺陷，独立 JSON 文件）

`card_error_reports` 回答「这张卡错在哪」；**过程缺陷**另有两本台账，落在 `data/audit/`：

| 文件 | 什么时候写 | 核心字段 |
|---|---|---|
| `answer-gaps.json` | 用户点「答案不全 / 补答案」**每一次**尝试（成功、失败都写） | `outcome`（fixed/unfixed）、`symptom`、`block_reason`、`pipeline` |
| `rejected-cards.json` | 审核点「拒绝 / 不熟」放进复习队列（单张 + 批量） | `node`（书→章节→知识点→片段）、`question_type`、`context.fsrs_before` |

每条记录都带三样东西，缺一不可 —— 少了任何一样，监督员就没法归因：

1. **`node`**：卡片在知识树里的位置。只记 `card_id` 等于没记，监督员拿到一串 uuid 既不能按书分组，也判断不了「是不是整章都烂」。取不到就是 `null`，`null` 本身是结论（没绑知识点 = 抽取环节没对上）。
2. **`question_type`**：题型画像（单选/多选/判断/填空/对比、选项数、答案写法形态）。用来回答「哪类题反复没好答案」。
3. **`pipeline`**：函数决策点 —— 哪个函数、看了什么量、判定 `ok|reject`。用来回答「每次都死在同一个 if 上吗」。

**为什么失败也要写**：只记成功的话，样本里全是「已经修好的」，看不出「哪类题根本修不好」—— 那才是要改规则的地方。`block_reason` 把人话成因写清（原文 0 字 / 材料不足 20 字 / 模型答「材料未提及」/ 模型只回知识点没给 answer / 模型调用失败）。

**`by_block_step` 取第一个 `reject` 步骤**：最后的 `writeBack` 永远是 reject，取最后一个会把所有失败都归成「写回失败」，让监督员去查磁盘，而真实原因可能是网关挂了。

**`context.backfilled`**：`POST /api/audit/ledgers {action:"backfill"}` 会把历史痕迹（`answer_fix_logs`、`status=active && rejected_at` 的卡）回填成台账，用 `bf-` 前缀做幂等。这类记录取不到当时的 FSRS，所以统计「新卡被拒占比」时要剔除 —— 否则会把「不知道」算成「从没学过」。

**给监督员的口子**（三个层级，按上下文预算选）：

```bash
curl "localhost:3000/api/audit/ledgers?format=agent"   # 紧凑：去长文本，留归因字段
curl "localhost:3000/api/audit/ledgers"                # 全量：含 before/after 原文
npm run audit:export                                    # 两本合成 data/audit/supervisor-pack.json（约 400KB / 890 条）
```

`supervisor-pack.json` 顶层就有 `summary`（各维度分组计数）与 `cross_findings`（交叉结论），监督员先读这两块，再决定要不要下钻单条。

---

## 6. 测试

```bash
npm run lint
npm run parse:check          # Markdown 解析回归
npm run check:questions      # 规则基线抽题回归（分行/同一行选项、a)b) 小节标题不误判成题）
npm run check:pipeline       # 新题目抽取管线：10 类合成样例 + 模型异常降级 + 长文档全量覆盖
npm run check:anchor         # 全文页片段定位回归（带卡片的片段必须能在原文里定位到）
npm run check:answerkeys     # 单选/多选答案解析与集合判定（字母、圈号、数字连写、多段文本）
npm run check:errorreport    # 错误台账：入参收口、快照保真、统计、监督员结论
npm run check:auditledger    # 两本审计台账：题型画像、节点链路、卡点归因（取第一个 reject）、交叉结论
npm run check:auditledgerhttp # 台账端到端：拒绝入台账、批量一次写、补答案成功/失败都留痕、回填幂等
npm run check:fragmentaudit  # 原文核对：按知识点分块、候选扫描、与已有卡对齐、AI 裁决合并
npm run check:carderrorhttp  # 上面三块的端到端契约（需服务在跑；含多选落库与复习快照）
npm run check:reviewprogress # 复习进度：跳号、范围判定、跨天判定、跨会话已答补判
npm run check:reviewresume   # 复习续接的端到端契约（需服务在跑；含 rated 位、单轮收尾、完成后再进来、空池回 200）
npm run check:wording        # 复习状态文案（只说「已复习」）+ 复习/审核页宽版式护栏
npm run check:schedule       # 复习节奏曲线（3/7/16/38/91、答错当天+次日、毕业线）
npm run check:fidelity       # 抽取保真定级 + AI 出题的原文闸门（编造/挂错知识点必须被挡）
npm run check:mdfix          # 手机端排版规则（圈号/字母断行守恒、宽表转卡片、代码块不动）
npm run check:textbreak      # 答案按分号断行：分号留行尾、可见字符逐字守恒、无分号不改写
npm run backfill:fidelity    # 存量卡保真回填：默认只统计，`-- --write` 写盘（自动备份）
npm run smoke                # 只读端点 + 页面 + 建书/删书自清理，打已运行的服务
npm run smoke:full           # 自起隔离实例，跑完整写链路（含同一张卡连续评分两次）
npm run build
```

`smoke.mjs` 默认打 `SMOKE_BASE_URL`（缺省 `http://127.0.0.1:3000`）；服务开了口令门时设 `SMOKE_APP_PASSWORD`。`--isolated` 模式用临时 `DATA_DIR` 起独立实例，跑完连数据目录一起删掉，**不会碰你的书库**。

---

### 手机端排版规则（`src/lib/import/md-mobile-fix.ts`）

窄屏上两类内容必然烂：**列数 ≥3 且单元格 ≥60 字的宽表**，以及**行内 `①②③④` / `A. B. C. D.` 连排**。
规则实现成单一模块，只有一条硬规矩：**只允许插 `<br>` / 换表格形态，绝不改写正文**；每步都做守恒自检，失败回退。

它**用在渲染层，不改数据**：

- 原文页：`fragment-body.tsx` 逐行调 `expandInlineEnumeration`，圈号/字母处断行；
- 卡片：`EnumeratedText` 组件同一套规则，题干 `①…②…` 一项一行；
- 宽表：**不转卡片**，走 CSS 堆叠（`data-label` 两栏），桌面仍是真表格。
  导入前转卡片会把「一行一题」的题库表压成 `#### ` 段落，直接**丢题**，所以这条不接进管线。

---

## 7. 部署约束（重要）

状态是进程内存 + 磁盘上的 `db.json`，所以部署前提是：

1. **单实例**。单例挂在 `globalThis`，进程内的读写由一个串行队列保护；但**没有跨进程文件锁**。多实例 / 多容器各持有独立内存副本与独立文件，后写的覆盖先写的（last-writer-wins），会丢数据。
2. **可写持久磁盘**。`LocalStore.save()` 用「临时文件 + rename」原子替换并留 `db.json.bak`；写失败直接抛错，接口返回 500。**不存在「降级为内存态」** —— 那种降级会让用户答完一整轮却什么都没存下。
3. 因此 **Vercel 这类只读 serverless 不能直接用**。除非挂载可写持久卷并保证只有一个实例，否则所有写接口都会 500。`scripts/push-vercel-env.mjs` 现在只同步 LLM 变量，不再推送任何 Supabase / `DATA_BACKEND` 配置。

可用方式：

| 方式 | 命令 / 说明 |
|---|---|
| 本机自用 | `npm run dev` 或 `npm run build && npm start` |
| 临时分享 | `npm run tunnel:install` → `npm run serve:share`：起 3000 / 3001 两个 `next start` 实例，各用独立 `DATA_DIR`，各挂一条 cloudflared quick tunnel。链接随进程存活，关掉即失效 |
| 容器 | `NEXT_OUTPUT=standalone npm run build` → `docker build -t study-review .` → `docker run -p 3000:3000 -v $PWD/data:/app/data -e APP_PASSWORD=xxx study-review`（`output: standalone` 只在 `NEXT_OUTPUT=standalone` 时启用，因为与 `next start` 互斥） |

备份就是拷 `DATA_DIR/db.json`；迁移就是拷目录。`npm run reset:data` 只删文件 —— **运行中的服务仍持有内存副本，必须重启进程**才会从种子重建。

另一个容易踩的点：`src/lib/jobs.ts` 的异步生成作业只在进程内存里，**服务重启后作业消失**，界面可能停在 `generating 10%`。资料库会提示「上次生成被中断」，用书卡上的「生成 / 续跑」按钮重跑即可 —— 卡片 id 是确定性的，不会翻倍。

---

## 8. 视觉层级与配色（UI 硬规矩）

界面上所有文字都属于下列五档之一，**不允许临时发明第六档**，也不允许靠字号去强调提示。

| 层级 | 用途 | 字号 | 颜色 | 实现 |
| --- | --- | --- | --- | --- |
| L1 题干 | 要你回答的那句话 | 17px | `--color-fg`（最亮） | `.question-stem` |
| L2 答案 | 答案正文 | 15px（复习页 16px） | `--color-fg` / 85% | `text-[15px]` |
| L2 选项 | A/B/C/D | 14px | `--color-fg` / 80% | `text-sm` |
| L3 次要 | 来源、`定位原文`、行内说明、计数 | 11px | `--color-muted` | `.micro` |
| L4 微标注 | 「AI 提供，原文未给出」这类**来源**标注、区块小标题 | 11px | 中性 `--color-muted` | `.source-note` / `.block-cap` |

配色语义（只有这四种）：

- **正文白** `--color-fg`：内容本身。**不用来当徽标底色或文字色** —— 它比正文还亮，会抢焦点。
- **中性灰** `--color-muted`：所有「说明性」文字。来源、计数、提示默认都是灰的。
- **金色** `--color-warning`：**风险**语义。只给「原文未给出」这类必须人看一眼的情况，不给普通来源标注。
- **红/绿** `--color-danger` / `--color-success`：作废与正确。

三条据此定下来的做法：

1. **提示不占版位**：来源标注永远贴着它描述的那段内容（行内、末尾），不单独占一行、不做成带底色的 chip。
2. **提示不改字号**：需要「更显眼」时换颜色，不加粗、不放大。反过来，任何必须读的文字不许缩到 11px 以下。
3. **一层只说一件事**：`.micro` 说明事实（几号、哪一段、第几次），`.source-note` 说明出处（谁写的）。两者不混用。

### 题干 / 答案必须一眼可辨

只靠字号差 2px 不够 —— 题干和答案长度接近时，会被读成「一段话」，用户分不清哪句是问题、哪句是答案。所以三个区块各有一套**结构标记**，而不是只调字号：

| 区块 | 结构标记 | 为什么这样 |
| --- | --- | --- |
| 题干 | 17px + 最亮 + 无框，独立成段 | 卡片里唯一「亮而无框」的文字 = 要你看的 |
| 答案 | 左侧 2px 竖线 + `.block-cap`「参考答案」 | 引文式框定，即使文字大小接近也能看出边界 |
| 页脚（来源 / 定位原文 / 复习记录） | 上方 hairline `border-t` + 11px | 从正文里切出去，不再读成答案的最后一句 |

复习页两张卡外观一致，所以题干卡贴「题目」、答案卡贴「参考答案」——翻面后靠标签而不是靠回忆判断哪张是哪个。

### 答案来源标注的文案

`answer_origin === "ai"` 一律带标注，按 `answer_grounded` 分两档，**越危险越短**：

| 档位 | 文案 | 颜色 | 含义 |
| --- | --- | --- | --- |
| 有原文依据 / 未核对 | `AI 提供，原文未给出` | 灰 | 原文没写答案，AI 依据原文内容整理 |
| 无依据 | `原文未给出` | 金 | 原文没写，AI 用专业知识补的，要人核对 |

「建议核对」这类劝导语不进文案 —— 金色本身就是提醒，把字留给事实。

答案的**分号断行**同样属于显示层规则（`src/lib/text/linebreak.ts`）：`；`/`;` 处断行，分号留在上一行末尾，可见字符一个不丢；AI 生成与原文摘录同样处理，不给 AI 答案「更碎」的观感。

---

## 9. 目录

```
src/app/       页面 + api/ 路由 + globals.css + layout.tsx
src/components/ 导航、页头、生成按钮、原文片段渲染等
src/lib/       import / cards / knowledge / db / fsrs / stats / llm / jobs / config / http
db/            seed-data.json（真源）、schema.sql（历史存档，运行时不读）
data/          DATA_DIR 默认值：db.json + db.json.bak
scripts/       parse-check、preflight、serve-share、tunnel 安装、vercel env 同步、where
smoke.mjs      v3 端到端冒烟
```
