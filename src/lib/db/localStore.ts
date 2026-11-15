import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { CardStore } from "./store";
import type {
  AnswerFixLog,
  AuditNodeRef,
  Card,
  CardErrorReport,
  CardFsrsState,
  CardReview,
  Chapter,
  DueCard,
  ID,
  ImportJob,
  KnowledgePoint,
  ReviewRejection,
  ReviewSession,
  ReviewSessionCard,
  SourceFragment,
  Textbook,
  TodayStats,
} from "./types";
import { FsrsState } from "./types";
import { newCardState, schedule } from "../fsrs";
import { seed } from "./seed";
import { filterFixLogs } from "../cards/answer-fix-log";
import { describeNode, describeQuestionType, step } from "../audit/ledger-model";
import { appendRejection, appendRejections } from "../audit/ledger-file";
import { isSameLocalDay, sameScope, type ReviewScopeKey } from "../review/progress";

// 持久化的本地数据结构（序列化为 JSON 文件）
interface LocalDB {
  textbooks: Textbook[];
  chapters: Chapter[];
  knowledgePoints: KnowledgePoint[];
  source_fragments: SourceFragment[];
  import_jobs: ImportJob[];
  cards: Card[];
  card_sources: { card_id: ID; source_fragment_id: ID; role: string }[];
  card_fsrs_states: CardFsrsState[];
  review_sessions: ReviewSession[];
  review_session_cards: ReviewSessionCard[];
  card_reviews: CardReview[];
  answer_fix_logs: AnswerFixLog[];
  card_error_reports: CardErrorReport[];
  seeded: boolean;
}

function emptyDB(): LocalDB {
  return {
    textbooks: [],
    chapters: [],
    knowledgePoints: [],
    source_fragments: [],
    import_jobs: [],
    cards: [],
    card_sources: [],
    card_fsrs_states: [],
    review_sessions: [],
    review_session_cards: [],
    card_reviews: [],
    answer_fix_logs: [],
    card_error_reports: [],
    seeded: false,
  };
}

function nowISO(): string {
  return new Date().toISOString();
}

function uuid(): ID {
  return crypto.randomUUID();
}

/**
 * 由选项列表派生 is_choice 布尔标记。
 * 有 2 个及以上选项 → true（1，选择题区域）；否则 false（0，问答卡区域）。
 * 这是唯一的判定源，kind / is_choice 都必须由它派生，避免三处状态互相矛盾。
 */
function deriveIsChoice(options: string[] | null | undefined): boolean {
  return Array.isArray(options) && options.length >= 2;
}

export class LocalStore implements CardStore {
  private dbPath: string;
  private db: LocalDB = emptyDB();
  /**
   * 上一次与磁盘同步时的文件指纹（mtime + size）。
   *
   * 为什么需要它：Next.js 会把「页面（RSC）」和「API 路由」分别编译成不同的模块实例。
   * 正常情况下 store.ts 用 globalThis 共享同一个实例，指纹同步只是兜底
   * （例如 dev 热更新重建模块、或外部脚本直接改了 db.json）。
   */
  private lastSig = "";

  /**
   * 串行队列：磁盘读同步与写盘都必须排进同一条链。
   *
   * 之前没有队列，踩过的坑：
   * 1) 两次写并发时共用固定的 db.json.tmp → 先完成的那次 rename 把 tmp 移走，
   *    后一次 rename 找不到文件抛 ENOENT；Windows 上还会因杀软扫描抛 EPERM/EBUSY。
   * 2) save() 正在 rename 的瞬间，另一个请求的 syncFromDisk 读到「旧的 db.json」，
   *    指纹判定为他人修改 → 把内存回滚成旧快照 → 刚写的数据被覆盖丢失。
   * 把读与写放进同一条串行链，这两个竞态都不存在了。
   */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor() {
    // DATA_DIR 可指定数据目录：同一份代码跑多个实例（各自独立的 db.json）靠它，
    // 容器部署时把它指向挂载卷（如 /app/data），重建容器数据不丢。
    // 不设置时沿用「启动目录下的 data/」，本地开发行为不变。
    const dir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(process.cwd(), "data");
    this.dbPath = path.join(dir, "db.json");
  }

  /** 把一段磁盘操作排队执行，保证同一实例的读写不会重叠。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    // 前一次失败不能阻断后续操作，所以链上只记录「已完成」
    this.opChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async fileSig(): Promise<string> {
    try {
      const st = await fs.stat(this.dbPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }

  private async load(): Promise<"ok" | "missing" | "corrupt"> {
    try {
      const sig = await this.fileSig();
      const raw = await fs.readFile(this.dbPath, "utf8");
      if (!raw.trim()) {
        this.db = emptyDB();
        this.lastSig = sig;
        return "missing";
      }
      try {
        this.db = { ...emptyDB(), ...(JSON.parse(raw) as LocalDB) };
      } catch {
        // 关键：解析失败绝不能当成「空库」然后播种覆盖 —— 那会把用户数据直接抹掉。
        // 先把疑似损坏的文件另存一份，再由调用方决定是否重建。
        const bak = `${this.dbPath}.corrupt-${Date.now()}.json`;
        await fs.copyFile(this.dbPath, bak).catch(() => {});
        console.warn(`[localStore] db.json 解析失败，已备份为 ${bak}`);
        this.db = emptyDB();
        this.lastSig = sig;
        return "corrupt";
      }
      this.lastSig = sig;
      return "ok";
    } catch {
      this.db = emptyDB();
      this.lastSig = "";
      return "missing";
    }
  }

  /**
   * 若磁盘上的 db.json 已被其他实例改写，则重新加载。
   * 每个对外方法调用前都会跑一次（见 store.ts 的代理包装）。
   * 必须排在写队列后面：否则会读到 save() 正在替换中的旧文件。
   */
  async syncFromDisk(): Promise<void> {
    return this.enqueue(async () => {
      const sig = await this.fileSig();
      if (!sig || sig === this.lastSig) return;
      await this.load();
    });
  }

  /**
   * 结构迁移：补齐历史数据缺失的派生字段。
   * 幂等（值已正确时不写盘），每次 ensureSeeded 都会跑，
   * 因此老 db.json 不需要重建也能拿到新字段。
   */
  private async migrate(): Promise<void> {
    let dirty = false;

    for (const c of this.db.cards) {
      const expected = deriveIsChoice(c.options);
      if (c.is_choice !== expected) {
        c.is_choice = expected;
        dirty = true;
      }
      // kind 与 options 也顺带对齐，避免出现 kind=choice 却没有选项的脏卡
      const expectedKind = expected ? "choice" : "qa";
      if (c.kind !== expectedKind) {
        c.kind = expectedKind;
        dirty = true;
      }

      // 历史状态归一：早期版本的 reject 写的是 status="rejected"，
      // 而「是否进复习队列」只看 status === "active" —— 这类卡会变成谁都看不到的幽灵，
      // 既不复习也不在待审核里。统一归回 active，并把到期时间拉到当下，让它回到队列。
      if (c.status === "rejected") {
        c.status = "active";
        dirty = true;
        const st = this.db.card_fsrs_states.find((s) => s.card_id === c.id);
        if (st && new Date(st.due_at).getTime() > Date.now()) {
          st.due_at = nowISO();
          st.updated_at = nowISO();
        }
      }

      // 原题保真改造新增字段的存量回填。
      // 改造前所有卡都是模型生成的，所以 source 缺省按 ai_generated 补；
      // card_type 从 kind 派生（选择→choice，其余→qa）；needs_answer 缺省 false。
      // 只在字段为 undefined 时补，null 是有意义的取值（未绑定知识点）不能被覆盖。
      if (c.source === undefined) {
        c.source = "ai_generated";
        dirty = true;
      }
      if (c.card_type === undefined) {
        c.card_type = c.kind === "choice" ? "choice" : "qa";
        dirty = true;
      }
      if (c.needs_answer === undefined) {
        c.needs_answer = false;
        dirty = true;
      }

      // 多选标记由 answers 派生：老数据没有 answers 字段，一律按单选处理。
      // 只补 undefined，不覆盖显式 false（用户把多选改回单选时写的就是 false）。
      const expectedMulti = Array.isArray(c.answers) && c.answers.length > 1;
      if (c.is_multi === undefined || c.is_multi !== expectedMulti) {
        c.is_multi = expectedMulti;
        dirty = true;
      }
      // answers 至多只在多选时有值：单选卡留着旧数组会让「正确答案」高亮出两项
      if (!expectedMulti && Array.isArray(c.answers)) {
        c.answers = null;
        dirty = true;
      }
    }

    // active 卡必须有一条调度状态，否则会被 listDueCards 的 `if (!fsrs) continue`
    // 静默跳过 —— 表现为「状态是复习中，但复习队列里永远查不到」的幽灵卡。
    // 历史数据会缺这条记录（早期 approve 曾写成 active，或手工改过 db.json），这里补齐。
    const liveFsrs = new Set(this.db.card_fsrs_states.map((s) => s.card_id));
    for (const c of this.db.cards) {
      if (c.status !== "active" || c.deleted_at || liveFsrs.has(c.id)) continue;
      this.db.card_fsrs_states.push(await newCardState(c.id));
      liveFsrs.add(c.id);
      dirty = true;
    }

    // 顺带清掉历史遗留的悬空引用（已删卡的 FSRS 状态 / 复习记录 / 会话快照）
    if (this.pruneOrphans()) dirty = true;

    if (dirty) await this.save();
  }

  /**
   * 原子写盘。失败必须抛出，绝不能静默吞掉。
   *
   * 旧实现的致命缺陷：写失败时 catch 里只设 readOnly = true 然后返回，
   * 于是【这一次】和【之后所有】写入全部被丢弃，而 API 照常返回 200/201 ——
   * 用户答完一整轮题、导入一整本书，界面都是成功的，磁盘上却一条记录都没有。
   * 现在改成：唯一临时文件名 + 重试 + 失败抛错（接口返回 500，前端能看见）。
   */
  private async save(): Promise<void> {
    return this.enqueue(async () => {
      const json = JSON.stringify(this.db, null, 2);
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

      // 临时文件名带上 pid + 随机串：即使有别的进程/实例同时在写，也不会互相覆盖
      const tmp = `${this.dbPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, json, "utf8");

      // 留一份上一版备份；备份失败不影响主流程
      await fs.copyFile(this.dbPath, `${this.dbPath}.bak`).catch(() => {});

      // Windows 上 rename 可能被杀软/索引器短暂占用（EPERM/EBUSY），重试几次即可
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.rename(tmp, this.dbPath);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }
      if (lastErr) {
        await fs.unlink(tmp).catch(() => {});
        throw new Error(
          `写入 ${this.dbPath} 失败：${(lastErr as { code?: string })?.code ?? String(lastErr)}`
        );
      }

      // 记录自己写入后的指纹，避免下一次 syncFromDisk 读到自己的写入又白重载一次
      this.lastSig = await this.fileSig();
    });
  }

  async ensureSeeded(): Promise<void> {
    const status = await this.load();

    // 只要磁盘上已经有内容，就绝不重新播种 —— 哪怕 seeded 标记丢了。
    // 这条守卫是数据安全的最后一道防线。
    const hasData = this.db.textbooks.length > 0 || this.db.cards.length > 0;
    if (status === "ok" && (hasData || this.db.seeded)) {
      if (!this.db.seeded) {
        this.db.seeded = true;
        await this.save();
      }
      await this.migrate();
      return;
    }
    if (status === "corrupt" && hasData) {
      // 理论上走不到（corrupt 时 db 已被清空），保留判断以防未来改动
      return;
    }

    // 种子：一份样例 Markdown 材料 + 预生成卡片草稿（供演示）。
    // 分享给别人的实例通常不想要我的示例书 —— SKIP_SEED=1 直接落一份空库。
    if (process.env.SKIP_SEED === "1") {
      this.db.seeded = true;
      await this.save();
      return;
    }

    this.db.textbooks = (seed.textbooks ?? []).map((t) => ({
      ...t,
      source_format: t.source_format ?? "markdown",
      source_version: t.source_version ?? 1,
      status: t.status ?? "ready",
    }));
    this.db.chapters = seed.chapters ?? [];
    this.db.knowledgePoints = seed.knowledgePoints ?? [];
    this.db.source_fragments = (seed.source_fragments ?? []).map((f) => ({
      ...f,
      id: f.id || uuid(),
    }));
    this.db.cards = (seed.cards ?? []).map((c) => {
      const options = c.options ?? null;
      const isChoice = deriveIsChoice(options);
      return {
        ...c,
        id: c.id || uuid(),
        kind: isChoice ? "choice" : "qa",
        is_choice: isChoice,
        status: c.status ?? "draft",
        content_revision: c.content_revision ?? 1,
        options,
        answer: c.answer ?? null,
      };
    });
    // 卡片↔片段关联
    for (const cs of seed.card_sources ?? []) {
      this.db.card_sources.push(cs);
    }

    this.db.seeded = true;
    await this.save();
  }

  // ---- 材料 ----
  async listTextbooks(): Promise<Textbook[]> {
    return this.db.textbooks.filter((t) => !t.archived_at).slice();
  }
  async getTextbook(id: ID): Promise<Textbook | null> {
    return this.db.textbooks.find((t) => t.id === id) ?? null;
  }
  async createTextbook(t: Omit<Textbook, "id" | "created_at">): Promise<Textbook> {
    const row: Textbook = { ...t, id: uuid(), created_at: nowISO() };
    this.db.textbooks.push(row);
    await this.save();
    return row;
  }

  /**
   * 删除一份材料，并级联清理它派生出来的全部数据。
   *
   * 为什么必须级联：卡片、FSRS 状态、复习记录、会话卡快照都是靠
   * source_fragments → card_sources 挂在这本书下面的。只把 textbooks 里那行删掉，
   * 库里会留下一堆孤儿卡：资料库看不到它们（列表按书过滤），但今日待复习、
   * 统计总数、复习队列里仍然会冒出来 —— 表现为「删了书但卡片还在跳」。
   *
   * 这里做的是硬删除（不是软删）：用户重新上传同一份材料时，
   * 旧的内容不该以任何形式残留、也不该被 content_hash 去重逻辑挡掉。
   */
  async deleteTextbook(id: ID): Promise<{
    ok: boolean;
    chapters: number;
    fragments: number;
    cards: number;
    reviews: number;
  }> {
    const idx = this.db.textbooks.findIndex((t) => t.id === id);
    if (idx < 0) {
      return { ok: false, chapters: 0, fragments: 0, cards: 0, reviews: 0 };
    }

    // 1) 本书的片段与章节
    const fragIds = new Set(
      this.db.source_fragments.filter((f) => f.textbook_id === id).map((f) => f.id)
    );
    const chapterIds = new Set(
      this.db.chapters.filter((c) => c.textbook_id === id).map((c) => c.id)
    );

    // 2) 这些片段关联出来的卡片
    const cardIds = new Set(
      this.db.card_sources
        .filter((cs) => fragIds.has(cs.source_fragment_id))
        .map((cs) => cs.card_id)
    );

    const before = {
      chapters: chapterIds.size,
      fragments: fragIds.size,
      cards: cardIds.size,
      reviews: this.db.card_reviews.filter((r) => cardIds.has(r.card_id)).length,
    };

    // 3) 自底向上清理，避免留下任何悬空引用
    this.db.card_reviews = this.db.card_reviews.filter((r) => !cardIds.has(r.card_id));
    this.db.review_session_cards = this.db.review_session_cards.filter(
      (sc) => !cardIds.has(sc.card_id)
    );
    this.db.card_fsrs_states = this.db.card_fsrs_states.filter((s) => !cardIds.has(s.card_id));
    this.db.card_sources = this.db.card_sources.filter(
      (cs) => !cardIds.has(cs.card_id) && !fragIds.has(cs.source_fragment_id)
    );
    this.db.cards = this.db.cards.filter((c) => !cardIds.has(c.id));
    // 删书时把这本书的错题上报一起清掉：留着就是指向已不存在卡片的孤儿记录
    this.db.card_error_reports = this.db.card_error_reports.filter(
      (r) => !cardIds.has(r.card_id) && r.textbook_id !== id
    );
    this.db.knowledgePoints = this.db.knowledgePoints.filter(
      (k) => !chapterIds.has(k.chapter_id)
    );
    this.db.chapters = this.db.chapters.filter((c) => c.textbook_id !== id);
    this.db.source_fragments = this.db.source_fragments.filter((f) => f.textbook_id !== id);
    this.db.import_jobs = this.db.import_jobs.filter((j) => j.textbook_id !== id);
    this.db.textbooks.splice(idx, 1);

    // 会话若已没有任何卡，一并清掉，免得统计里出现空的复习会话
    const liveSessionIds = new Set(this.db.review_session_cards.map((sc) => sc.session_id));
    this.db.review_sessions = this.db.review_sessions.filter((s) => liveSessionIds.has(s.id));

    // 兜底：清掉任意来源的悬空引用。
    // 有些历史卡片并没有 card_sources 记录（早期手工/种子生成），只按片段反推卡片会漏掉它们，
    // 于是会话快照仍指向已不存在的卡。这里统一按「活着的卡片」重新裁剪一遍。
    this.pruneOrphans();

    await this.save();
    return { ok: true, ...before };
  }

  /**
   * 清理悬空引用：卡片已被删除，但 FSRS 状态 / 复习记录 / 会话快照还留着。
   * 幂等，migrate 与 deleteTextbook 都会调用。
   */
  private pruneOrphans(): boolean {
    const liveCards = new Set(this.db.cards.map((c) => c.id));
    const liveFrags = new Set(this.db.source_fragments.map((f) => f.id));
    const count = () =>
      this.db.card_fsrs_states.length +
      this.db.card_reviews.length +
      this.db.review_session_cards.length +
      this.db.card_sources.length +
      this.db.review_sessions.length;

    const before = count();

    this.db.card_fsrs_states = this.db.card_fsrs_states.filter((s) => liveCards.has(s.card_id));
    this.db.card_reviews = this.db.card_reviews.filter((r) => liveCards.has(r.card_id));
    this.db.review_session_cards = this.db.review_session_cards.filter((sc) =>
      liveCards.has(sc.card_id)
    );
    this.db.card_sources = this.db.card_sources.filter(
      (cs) => liveCards.has(cs.card_id) && liveFrags.has(cs.source_fragment_id)
    );
    this.db.review_sessions = this.db.review_sessions.filter((s) =>
      this.db.review_session_cards.some((sc) => sc.session_id === s.id)
    );

    return count() !== before;
  }

  async listChapters(textbookId?: ID): Promise<Chapter[]> {
    let rows = this.db.chapters.filter((c) => !c.deleted_at);
    if (textbookId) rows = rows.filter((c) => c.textbook_id === textbookId);
    return rows.sort((a, b) => a.sort_order - b.sort_order);
  }
  async getChapter(id: ID): Promise<Chapter | null> {
    return this.db.chapters.find((c) => c.id === id && !c.deleted_at) ?? null;
  }
  async createChapter(c: Omit<Chapter, "id">): Promise<Chapter> {
    const row: Chapter = { ...c, id: uuid() };
    this.db.chapters.push(row);
    await this.save();
    return row;
  }
  async updateChapter(id: ID, patch: Partial<Omit<Chapter, "id">>): Promise<Chapter | null> {
    const idx = this.db.chapters.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    this.db.chapters[idx] = { ...this.db.chapters[idx], ...patch, id };
    await this.save();
    return this.db.chapters[idx];
  }
  async deleteChapter(id: ID): Promise<boolean> {
    const idx = this.db.chapters.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return false;
    this.db.chapters[idx] = { ...this.db.chapters[idx], deleted_at: nowISO() };
    await this.save();
    return true;
  }

  async listKnowledgePoints(
    filters?: { chapterId?: ID; textbookId?: ID }
  ): Promise<KnowledgePoint[]> {
    let rows = this.db.knowledgePoints.filter((k) => !k.deleted_at);
    if (filters?.chapterId) rows = rows.filter((k) => k.chapter_id === filters.chapterId);
    if (filters?.textbookId) {
      // textbook_id 是新字段，老数据没有 —— 用章节反查补齐，两种都要能筛到
      const chapterIds = new Set(
        this.db.chapters.filter((c) => c.textbook_id === filters.textbookId).map((c) => c.id)
      );
      rows = rows.filter(
        (k) => k.textbook_id === filters.textbookId || chapterIds.has(k.chapter_id)
      );
    }
    return rows.sort((a, b) => a.sort_order - b.sort_order);
  }
  async getKnowledgePoint(id: ID): Promise<KnowledgePoint | null> {
    return this.db.knowledgePoints.find((k) => k.id === id && !k.deleted_at) ?? null;
  }
  async createKnowledgePoint(kp: Omit<KnowledgePoint, "id">): Promise<KnowledgePoint> {
    const row: KnowledgePoint = { ...kp, id: uuid() };
    this.db.knowledgePoints.push(row);
    await this.save();
    return row;
  }
  /**
   * 批量插入知识点，按 id 幂等（id 由规则算出：材料 + 章节 + 陈述的哈希）。
   * 已存在则跳过 —— 重复导入/重复补题不会让知识点翻倍，也不会覆盖人工改过的内容。
   */
  async bulkInsertKnowledgePoints(
    rows: Array<Omit<KnowledgePoint, "id"> & { id: ID }>
  ): Promise<{ inserted: number; skipped: number; points: KnowledgePoint[] }> {
    const existing = new Set(this.db.knowledgePoints.map((k) => k.id));
    const out: KnowledgePoint[] = [];
    let skipped = 0;
    for (const r of rows) {
      if (!r.id || existing.has(r.id)) {
        skipped++;
        continue;
      }
      const row: KnowledgePoint = { ...r, created_at: r.created_at ?? nowISO() };
      this.db.knowledgePoints.push(row);
      existing.add(row.id);
      out.push(row);
    }
    if (out.length > 0) await this.save();
    return { inserted: out.length, skipped, points: out };
  }
  /**
   * 标记这些知识点「已补过一轮题」，只写一次盘。
   * 补题接口用它在下次请求时短路返回 0 张。
   */
  async markKpsGenerated(ids: ID[]): Promise<number> {
    if (ids.length === 0) return 0;
    const set = new Set(ids);
    const at = nowISO();
    let n = 0;
    for (const k of this.db.knowledgePoints) {
      if (!set.has(k.id)) continue;
      k.last_generated_at = at;
      n++;
    }
    if (n > 0) await this.save();
    return n;
  }
  async updateKnowledgePoint(id: ID, patch: Partial<Omit<KnowledgePoint, "id">>): Promise<KnowledgePoint | null> {
    const idx = this.db.knowledgePoints.findIndex((k) => k.id === id);
    if (idx < 0) return null;
    this.db.knowledgePoints[idx] = { ...this.db.knowledgePoints[idx], ...patch, id };
    await this.save();
    return this.db.knowledgePoints[idx];
  }
  async deleteKnowledgePoint(id: ID): Promise<boolean> {
    const idx = this.db.knowledgePoints.findIndex((k) => k.id === id && !k.deleted_at);
    if (idx < 0) return false;
    this.db.knowledgePoints[idx] = { ...this.db.knowledgePoints[idx], deleted_at: nowISO() };
    await this.save();
    return true;
  }

  async listFragments(textbookId?: ID, chapterId?: ID): Promise<SourceFragment[]> {
    let rows = this.db.source_fragments.slice();
    if (textbookId) rows = rows.filter((f) => f.textbook_id === textbookId);
    if (chapterId) rows = rows.filter((f) => f.chapter_id === chapterId);
    return rows.sort((a, b) => a.fragment_index - b.fragment_index);
  }
  async createFragment(f: Omit<SourceFragment, "id">): Promise<SourceFragment> {
    const row: SourceFragment = { ...f, id: uuid() };
    this.db.source_fragments.push(row);
    await this.save();
    return row;
  }

  /** 大批量导入用：全部 push 完只 save 一次（2500 条逐条写盘要 80 秒）。 */
  async bulkInsertFragments(rows: Array<Omit<SourceFragment, "id">>): Promise<SourceFragment[]> {
    if (rows.length === 0) return [];
    const out = rows.map((r) => ({ ...r, id: uuid() }));
    this.db.source_fragments.push(...out);
    await this.save();
    return out;
  }

  // ---- 导入任务 ----
  async createImportJob(
    t: Omit<ImportJob, "id" | "created_at" | "updated_at"> & { id?: ID }
  ): Promise<ImportJob> {
    const row: ImportJob = {
      ...t,
      // 传入 id 时复用它（导入接口把内存任务 id 落成主键），否则自增式生成
      id: t.id ?? uuid(),
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    this.db.import_jobs.push(row);
    await this.save();
    return row;
  }
  async getImportJob(id: ID): Promise<ImportJob | null> {
    return this.db.import_jobs.find((j) => j.id === id) ?? null;
  }
  async updateImportJob(id: ID, patch: Partial<Omit<ImportJob, "id">>): Promise<ImportJob | null> {
    const idx = this.db.import_jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    this.db.import_jobs[idx] = { ...this.db.import_jobs[idx], ...patch, id, updated_at: nowISO() };
    await this.save();
    return this.db.import_jobs[idx];
  }
  async listImportJobs(textbookId?: ID): Promise<ImportJob[]> {
    let rows = this.db.import_jobs.slice();
    if (textbookId) rows = rows.filter((j) => j.textbook_id === textbookId);
    return rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }

  // ---- 答案修正审计 --------------------------------------------------------
  /**
   * 批量留痕：一次导入可能自动补齐几十条答案，逐条 save() 会把整库 JSON
   * 重写几十次，所以合并成一次写盘。
   */
  async createAnswerFixLogs(
    logs: Array<Omit<AnswerFixLog, "id" | "created_at">>
  ): Promise<AnswerFixLog[]> {
    if (logs.length === 0) return [];
    const now = nowISO();
    const rows = logs.map((l) => ({ ...l, id: uuid(), created_at: now }));
    this.db.answer_fix_logs.push(...rows);
    await this.save();
    return rows;
  }
  async listAnswerFixLogs(filters?: {
    cardId?: ID;
    trigger?: "user" | "rule";
    limit?: number;
  }): Promise<AnswerFixLog[]> {
    return filterFixLogs(this.db.answer_fix_logs, filters ?? {});
  }

  // ---- 出题错误台账 --------------------------------------------------------
  /**
   * 上报一条「这张卡本身有问题」。批量写一次盘：用户可能一次连报几张。
   * 幂等性交给调用方（同一张卡连续点两次会留下两条，这是有意的 ——
   * 重复上报本身也是「这题真的很烦」的信号，监督员看频次）。
   */
  async createCardErrorReports(
    rows: Array<Omit<CardErrorReport, "id" | "created_at" | "status"> & {
      status?: CardErrorReport["status"];
    }>
  ): Promise<CardErrorReport[]> {
    if (rows.length === 0) return [];
    const now = nowISO();
    const list = rows.map((r) => ({
      ...r,
      id: uuid(),
      status: r.status ?? ("open" as CardErrorReport["status"]),
      reviewed_at: r.reviewed_at ?? null,
      created_at: now,
    }));
    this.db.card_error_reports.push(...list);
    await this.save();
    return list;
  }

  async listCardErrorReports(filters?: {
    cardId?: ID;
    textbookId?: ID;
    status?: CardErrorReport["status"];
    kind?: CardErrorReport["kind"];
    limit?: number;
  }): Promise<CardErrorReport[]> {
    let rows = this.db.card_error_reports.slice();
    if (filters?.cardId) rows = rows.filter((r) => r.card_id === filters.cardId);
    if (filters?.textbookId) rows = rows.filter((r) => r.textbook_id === filters.textbookId);
    if (filters?.status) rows = rows.filter((r) => r.status === filters.status);
    if (filters?.kind) rows = rows.filter((r) => r.kind === filters.kind);
    // 新的在前：监督员先看最近的，用户在上报后也要立刻看到自己刚提交的那条
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return typeof filters?.limit === "number" ? rows.slice(0, filters.limit) : rows;
  }

  async updateCardErrorReport(
    id: ID,
    patch: Partial<Omit<CardErrorReport, "id" | "created_at">>
  ): Promise<CardErrorReport | null> {
    const at = this.db.card_error_reports.findIndex((r) => r.id === id);
    if (at < 0) return null;
    this.db.card_error_reports[at] = { ...this.db.card_error_reports[at], ...patch, id };
    await this.save();
    return this.db.card_error_reports[at];
  }

  // ---- 卡片 ----
  /**
   * 列出卡片，可按状态 / 材料 / 片段 / 章节过滤。
   *
   * fragmentId 与 chapterId 是为「从原文定位到某一段的卡片」准备的：
   * 卡片与原文的关联是 card_sources → source_fragments，
   * 所以片段过滤要先反查片段集合，再反查卡片集合。
   */
  async listCards(filters?: {
    status?: Card["status"];
    textbookId?: ID;
    fragmentId?: ID;
    chapterId?: ID;
  }): Promise<Card[]> {
    let rows = this.db.cards.filter((c) => !c.deleted_at);
    if (filters?.status) rows = rows.filter((c) => c.status === filters.status);
    if (filters?.textbookId) {
      const fragIds = new Set(
        this.db.source_fragments.filter((f) => f.textbook_id === filters.textbookId).map((f) => f.id)
      );
      const cardIds = new Set(
        this.db.card_sources.filter((cs) => fragIds.has(cs.source_fragment_id)).map((cs) => cs.card_id)
      );
      rows = rows.filter((c) => cardIds.has(c.id));
    }
    if (filters?.fragmentId || filters?.chapterId) {
      const fragIds = new Set<ID>(
        filters.fragmentId
          ? [filters.fragmentId]
          : this.db.source_fragments
              .filter((f) => f.chapter_id === filters.chapterId)
              .map((f) => f.id)
      );
      const cardIds = new Set(
        this.db.card_sources
          .filter((cs) => fragIds.has(cs.source_fragment_id))
          .map((cs) => cs.card_id)
      );
      rows = rows.filter((c) => cardIds.has(c.id));
    }
    return rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }
  async getCard(id: ID): Promise<Card | null> {
    return this.db.cards.find((c) => c.id === id && !c.deleted_at) ?? null;
  }
  async createCard(
    c: Omit<Card, "id" | "created_at" | "updated_at" | "is_choice"> & { is_choice?: boolean }
  ): Promise<Card> {
    // is_choice / kind 一律由 options 派生，调用方不用管，也不会写歪。
    const options = c.options ?? null;
    const isChoice = deriveIsChoice(options);
    const row: Card = {
      ...c,
      options,
      is_choice: isChoice,
      kind: isChoice ? "choice" : "qa",
      id: uuid(),
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    this.db.cards.push(row);
    await this.save();
    return row;
  }

  /**
   * 批量插入卡片，幂等。
   *
   * 两个必须批量的理由：
   *   1) 幂等 —— 导入 30 道原题、补题一次 20 张，若逐张 createCard 就是 30~50 次写盘，
   *      在 Windows 上每次都是「写临时文件 + 备份 + rename 重试」，导入会明显卡住。
   *   2) 去重 —— 按确定性 id（hash(材料+章节路径+题干)）判定是否已存在。
   *      已存在的卡**原样跳过，绝不覆盖**：用户可能已经审核过、改过、复习过它，
   *      覆盖会让「已审核」状态回退成 draft、把复习历史挂到一张内容已变的卡上。
   *
   * 只写一次盘：全部插入完再 save。
   */
  async bulkInsertCards(
    rows: Array<
      Omit<Card, "created_at" | "updated_at" | "is_choice"> & { id: ID; is_choice?: boolean }
    >
  ): Promise<{ inserted: number; skipped: number; cards: Card[] }> {
    const existing = new Set(this.db.cards.map((c) => c.id));
    const out: Card[] = [];
    let skipped = 0;

    for (const r of rows) {
      if (!r.id || existing.has(r.id)) {
        skipped++;
        continue;
      }
      const options = r.options ?? null;
      const isChoice = deriveIsChoice(options);
      const row: Card = {
        ...r,
        options,
        is_choice: isChoice,
        kind: isChoice ? "choice" : "qa",
        // 多选标记只认 answers 长度，不信任调用方 —— 单一真源，避免出现
        // is_multi=true 但 answers 只有一个的脏卡（复习页会显示出「多选」却只有一项正确）
        is_multi: Array.isArray(r.answers) && r.answers.length > 1,
        needs_answer: r.needs_answer ?? false,
        created_at: nowISO(),
        updated_at: nowISO(),
      };
      this.db.cards.push(row);
      existing.add(row.id);
      out.push(row);
    }

    if (out.length > 0) await this.save();
    return { inserted: out.length, skipped, cards: out };
  }

  /** 按 id 覆盖式更新（仅用于新链路内部，不改状态机字段） */
  async patchCardMeta(id: ID, patch: Partial<Pick<Card, "kp_id" | "needs_answer">>): Promise<boolean> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return false;
    this.db.cards[idx] = { ...this.db.cards[idx], ...patch, updated_at: nowISO() };
    await this.save();
    return true;
  }
  async updateCard(id: ID, patch: Partial<Omit<Card, "id">>): Promise<Card | null> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return null;
    // 「只传了 back」时 patch.front 是 undefined，直接展开会把题干抹成 undefined
    // （/api/cards/:id 的 edit 就是这样调用的）。undefined 表示「不改这个字段」，
    // null 才是显式清空 —— 两者必须区分，否则一次答案编辑就毁掉整张卡。
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    ) as Partial<Omit<Card, "id">>;
    const merged = { ...this.db.cards[idx], ...cleanPatch, id, updated_at: nowISO() };
    // 内容被编辑时由 store 自增版本号，不信任客户端传值 ——
    // 复习快照里的 content_revision 靠它才能判断「当时看到的是哪一版内容」。
    if (
      cleanPatch.front !== undefined ||
      cleanPatch.back !== undefined ||
      cleanPatch.options !== undefined
    ) {
      merged.content_revision = (this.db.cards[idx].content_revision ?? 0) + 1;
    }
    // 编辑了选项就重算派生字段
    if ("options" in cleanPatch || "kind" in cleanPatch) {
      const isChoice = deriveIsChoice(merged.options);
      merged.is_choice = isChoice;
      merged.kind = isChoice ? "choice" : "qa";
    }
    // 改了正确答案（含「标注为多选」）就同步 is_multi，并升一版内容版本 ——
    // 答案键变了意味着判题口径变了，快照里的旧答案不能再当作「同一版内容」复用。
    if ("answers" in cleanPatch || "answer" in cleanPatch) {
      const multi = Array.isArray(merged.answers) && merged.answers.length > 1;
      merged.is_multi = multi;
      if (!multi && Array.isArray(merged.answers) && merged.answers.length <= 1) {
        merged.answers = null;
      }
      merged.content_revision = (this.db.cards[idx].content_revision ?? 0) + 1;
    }
    this.db.cards[idx] = merged;
    await this.save();
    return this.db.cards[idx];
  }

  async bulkFillCardAnswers(
    items: Array<{
      id: ID;
      back: string;
      answer: string | null;
      explanation?: string | null;
      grounded?: boolean;
    }>
  ): Promise<number> {
    if (items.length === 0) return 0;
    const byId = new Map(items.map((i) => [i.id, i]));
    const now = nowISO();
    let n = 0;
    for (let i = 0; i < this.db.cards.length; i++) {
      const c = this.db.cards[i];
      if (c.deleted_at) continue;
      const u = byId.get(c.id);
      if (!u) continue;
      this.db.cards[i] = {
        ...c,
        back: u.back,
        answer: u.answer,
        explanation: c.explanation ?? u.explanation ?? null,
        needs_answer: false,
        answer_origin: "ai",
        answer_grounded: u.grounded ?? false,
        answer_generated_at: now,
        // 内容变了，版本号跟着走（与 updateCard 的规则一致）
        content_revision: (c.content_revision ?? 0) + 1,
        updated_at: now,
      };
      n++;
    }
    if (n > 0) await this.save();
    return n;
  }
  /**
   * 审核判定的唯一实现：单卡与批量都走这里，避免两条路径行为漂移。
   *
   * 语义（用户视角，只有这两条，不要再加分支）：
   *   · 通过 / 已会（approve）——「这张我掌握了」→ status = mastered，**离开复习队列**。
   *     不调 schedule()：不复习的卡不该消耗一次 FSRS 评分，否则间隔会被凭空拉长。
   *   · 拒绝 / 不熟（reject）——「这张不熟」→ status = active 且 due_at 拉到此刻，
   *     下次打开复习立刻出现，原文侧标注为需重学。
   */
  private async applyVerdict(
    idx: number,
    action: "approve" | "reject",
    now: string
  ): Promise<CardFsrsState> {
    const card = this.db.cards[idx];

    // 这里是整个产品最核心的一条规则，别再动它：
    //   通过 = 已掌握 → status = mastered，**离开复习队列**，不需要复习；
    //   拒绝 = 不熟   → status = active  + due_at = now，立刻进入今日队列。
    //
    // 早期版本把「通过」也写成 status = active，再用 FSRS Good 把 due 推到未来。
    // 结果：卡片虽然今天不考了，但它仍然是 active —— 会出现在「复习中」列表、
    // 会被 /api/review?scope=all（再复习一轮）重新拉出来、章节页也标「复习中」。
    // 用户感知就是「我明明点了通过，怎么它还在复习列表里」。
    // 现在通过即 mastered，从 listDueCards / scope=all 的过滤条件上被彻底排除。
    this.db.cards[idx] = {
      ...card,
      status: action === "approve" ? "mastered" : "active",
      reviewed_at: now,
      rejected_at: action === "reject" ? now : null,
      updated_at: now,
    };

    const fsrsIdx = this.db.card_fsrs_states.findIndex((s) => s.card_id === card.id);
    const existing = fsrsIdx >= 0 ? this.db.card_fsrs_states[fsrsIdx] : null;

    // 已掌握：记忆进度原样保留（以后若「移回复习」还能接着算），但 due_at 不动。
    // 不调 schedule() —— 不复习的卡不该占用一次 FSRS 评分，否则间隔会被凭空拉长。
    if (action === "approve") {
      if (existing) return existing;
      const fresh = await newCardState(card.id);
      this.db.card_fsrs_states.push(fresh);
      return fresh;
    }

    // 拒绝：没有状态就新建（due = now）；有则把到期时间拉到此刻，立刻回到今日队列。
    if (!existing) {
      const fresh = await newCardState(card.id);
      this.db.card_fsrs_states.push(fresh);
      return fresh;
    }
    const next = { ...existing, due_at: now, updated_at: now };
    this.db.card_fsrs_states[fsrsIdx] = next;
    return next;
  }

  async approveCard(id: ID): Promise<{ card: Card; fsrs: CardFsrsState } | null> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return null;
    const fsrs = await this.applyVerdict(idx, "approve", nowISO());
    await this.save();
    return { card: this.db.cards[idx], fsrs };
  }

  async rejectCard(id: ID): Promise<{ card: Card; fsrs: CardFsrsState } | null> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return null;
    const before = this.rejectionProbe(idx);
    const now = nowISO();
    const fsrs = await this.applyVerdict(idx, "reject", now);
    await this.save();
    await this.logRejection(before, now, "cards", null);
    return { card: this.db.cards[idx], fsrs };
  }

  /** 取拒绝前的现场（卡片 + FSRS），供台账记录「拒绝时它本来是什么状态」 */
  private rejectionProbe(idx: number): { card: Card; fsrs: CardFsrsState | null } {
    const card = this.db.cards[idx];
    const fsrs = this.db.card_fsrs_states.find((s) => s.card_id === card.id) ?? null;
    return { card: { ...card }, fsrs: fsrs ? { ...fsrs } : null };
  }

  /**
   * 卡片在知识树里的位置 —— 直接读内存里的四张表，不再走异步查询。
   *
   * 批量拒绝时一次要写几十条台账，逐条 await store.getTextbook() 会把
   * 「点批量拒绝」变成几秒的等待；这里全是同步查找，成本可以忽略。
   */
  private nodeRefOf(card: Card): AuditNodeRef {
    const links = this.db.card_sources.filter((s) => s.card_id === card.id);
    const frags = links
      .map((l) => this.db.source_fragments.find((f) => f.id === l.source_fragment_id))
      .filter((f): f is SourceFragment => !!f);
    const textbookId = frags.find((f) => f.textbook_id)?.textbook_id ?? null;
    const chapterId = frags.find((f) => f.chapter_id)?.chapter_id ?? null;
    const textbook = textbookId ? this.db.textbooks.find((t) => t.id === textbookId) : undefined;
    const chapter = chapterId ? this.db.chapters.find((c) => c.id === chapterId) : undefined;
    const kp = card.kp_id ? this.db.knowledgePoints.find((k) => k.id === card.kp_id) : undefined;
    return describeNode({ card, textbook, chapter, kp, fragments: frags });
  }

  /** 组装一条「拒绝入复习」台账记录（不落盘，便于批量收齐后一次写）。 */
  private buildRejectionRow(
    before: { card: Card; fsrs: CardFsrsState | null },
    now: string,
    source: "cards" | "batch" | "review",
    batchSize: number | null
  ): ReviewRejection {
    const { card, fsrs } = before;
    return {
      id: crypto.randomUUID(),
      node: this.nodeRefOf(card),
      question: String(card.front ?? "").slice(0, 400),
      question_type: describeQuestionType(card),
      snapshot: {
        front: String(card.front ?? "").slice(0, 1200),
        back: String(card.back ?? "").slice(0, 1200),
        options: card.options ?? null,
        answer: card.answer ?? null,
        answers: card.answers ?? null,
        is_multi: card.is_multi === true,
        card_type: card.card_type ?? null,
      },
      context: {
        source,
        fsrs_before: fsrs
          ? { due_at: fsrs.due_at, reps: fsrs.reps, lapses: fsrs.lapses, state: String(fsrs.state) }
          : null,
        due_after: now,
        batch_size: batchSize,
      },
      note: null,
      pipeline: [
        step("applyVerdict", `action=reject，原 status=${card.status}`, "info"),
        step("applyVerdict", `status → active，rejected_at=${now.slice(0, 19)}`, "ok"),
        step(
          "schedule",
          fsrs
            ? `已有 FSRS 状态，due_at → now（reps=${fsrs.reps}）`
            : "无 FSRS 状态，按新卡入队（due=now）",
          "ok"
        ),
      ],
      created_at: now,
    };
  }

  /** 写一条「拒绝入复习」台账；best-effort，失败只告警（不能让审核点不动）。 */
  private async logRejection(
    before: { card: Card; fsrs: CardFsrsState | null },
    now: string,
    source: "cards" | "batch" | "review",
    batchSize: number | null
  ): Promise<void> {
    try {
      await appendRejection(this.buildRejectionRow(before, now, source, batchSize));
    } catch (e) {
      console.warn(`[audit] 写拒绝台账失败：${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * 复习毕业：连续答对到「3 天后那一轮也过了」→ 移出复习队列。
   *
   * 与审核「通过」的区别：这里**已经**有一次正常的 FSRS 评分刚落库，
   * 所以只翻卡片状态，不碰 FSRS 状态（due_at 会停在 3 天后，但卡片已不是 active，
   * 不会再被 listDueCards / scope=all 拉出来）。
   * 保留状态是为了两件事：统计页还能看在它身上花了多少次复习；
   * 将来若做「移回复习」，能接着原来的记忆强度算，而不是从新卡重来。
   */
  async masterCard(id: ID): Promise<boolean> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return false;
    const card = this.db.cards[idx];
    if (card.status === "mastered") return false;
    const now = nowISO();
    this.db.cards[idx] = { ...card, status: "mastered", updated_at: now };
    await this.save();
    return true;
  }
  /**
   * 批量审核：一次事务内完成 N 张卡的通过/拒绝，只写一次盘。
   *
   * 为什么必须放在服务端做：旧实现是前端 for 循环逐张 POST，
   * 60 张卡就是 60 次 HTTP + 60 次全量 db.json 写盘（每次近 100KB）。
   * 用户点完「批量拒绝」觉得慢、切到首页看结果 → 页面卸载 → 剩下的 fetch 全被
   * 浏览器 abort，最后只有第 1 张生效。这里改成单请求，天然没有「处理到一半」。
   */
  async batchReview(
    ids: ID[],
    action: "approve" | "reject"
  ): Promise<{ ok: number; missing: number; failed: number; due_count: number }> {
    const now = nowISO();
    const unique = Array.from(new Set(ids.filter(Boolean)));
    let ok = 0;
    let missing = 0;
    let failed = 0;
    // 台账先攒在内存里，循环结束后一次写盘：60 张卡逐个写会把台账文件读 60 遍
    const rejected: ReviewRejection[] = [];

    for (const id of unique) {
      const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
      if (idx < 0) {
        missing++;
        continue;
      }
      try {
        // 先抓现场再改状态 —— 改完就取不到「拒绝前的 FSRS」
        const before = action === "reject" ? this.rejectionProbe(idx) : null;
        // 与单卡走同一套判定：通过 = mastered（出队），拒绝 = active + due=now（入队）。
        await this.applyVerdict(idx, action, now);
        if (before) rejected.push(this.buildRejectionRow(before, now, "batch", unique.length));
        ok++;
      } catch (e) {
        console.warn(`[localStore] 批量${action}失败 ${id}:`, e);
        failed++;
      }
    }

    if (ok > 0) await this.save();
    if (rejected.length > 0) {
      try {
        await appendRejections(rejected);
      } catch (e) {
        console.warn(`[audit] 批量写拒绝台账失败：${(e as Error)?.message ?? e}`);
      }
    }
    const due = await this.listDueCards(10000);
    return { ok, missing, failed, due_count: due.length };
  }

  /**
   * 内容错误（AI 误抽取）→ 作废。
   *
   * 与「通过 / 加入复习」的根本区别：它既不算学会，也不进排期。
   * 只翻 status 与标记时间，FSRS 状态原样保留 —— 万一恢复，记忆进度能接上；
   * 且 status !== active，listDueCards / scope=all 天然不会再拉到这张卡。
   */
  async invalidateCard(id: ID): Promise<Card | null> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return null;
    const now = nowISO();
    this.db.cards[idx] = {
      ...this.db.cards[idx],
      status: "invalid",
      invalid_at: now,
      reviewed_at: now,
      updated_at: now,
    };
    await this.save();
    return this.db.cards[idx];
  }

  /** 撤销作废：只把 invalid 放回 draft，避免误把已掌握/复习中的卡打回审核台 */
  async restoreCard(id: ID): Promise<Card | null> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return null;
    const card = this.db.cards[idx];
    if (card.status !== "invalid") return card;
    this.db.cards[idx] = {
      ...card,
      status: "draft",
      invalid_at: null,
      updated_at: nowISO(),
    };
    await this.save();
    return this.db.cards[idx];
  }

  async deleteCard(id: ID): Promise<boolean> {
    const idx = this.db.cards.findIndex((c) => c.id === id && !c.deleted_at);
    if (idx < 0) return false;
    this.db.cards[idx] = { ...this.db.cards[idx], deleted_at: nowISO(), updated_at: nowISO() };
    await this.save();
    return true;
  }
  async listCardSources(cardId: ID): Promise<SourceFragment[]> {
    const links = this.db.card_sources.filter((cs) => cs.card_id === cardId);
    const fragIds = new Set(links.map((l) => l.source_fragment_id));
    return this.db.source_fragments.filter((f) => fragIds.has(f.id));
  }
  /** 全部「卡 ↔ 片段」关联，一次拿全 —— 统计页/复习页要按书聚合时避免逐卡 N 次查询 */
  async listAllCardSources(): Promise<{ card_id: ID; source_fragment_id: ID }[]> {
    return this.db.card_sources.map((cs) => ({ card_id: cs.card_id, source_fragment_id: cs.source_fragment_id }));
  }
  async linkCardSource(cardId: ID, fragmentId: ID, role = "source"): Promise<void> {
    if (this.db.card_sources.some((cs) => cs.card_id === cardId && cs.source_fragment_id === fragmentId)) return;
    this.db.card_sources.push({ card_id: cardId, source_fragment_id: fragmentId, role });
    await this.save();
  }

  /**
   * 批量关联「卡 ↔ 片段」，只写一次盘。
   * 导入 30 道原题时逐张 link 就是 30 次全量写盘（每次都重写整个 db.json），
   * 在 Windows 上足以把导入拖到十几秒。
   */
  async bulkLinkCardSources(
    pairs: Array<{ card_id: ID; source_fragment_id: ID; role?: string }>
  ): Promise<number> {
    const exists = new Set(
      this.db.card_sources.map((cs) => `${cs.card_id}::${cs.source_fragment_id}`)
    );
    let added = 0;
    for (const p of pairs) {
      const key = `${p.card_id}::${p.source_fragment_id}`;
      if (exists.has(key)) continue;
      this.db.card_sources.push({
        card_id: p.card_id,
        source_fragment_id: p.source_fragment_id,
        role: p.role ?? "source",
      });
      exists.add(key);
      added++;
    }
    if (added > 0) await this.save();
    return added;
  }

  // ---- FSRS 状态 ----
  async getFsrsState(cardId: ID): Promise<CardFsrsState | null> {
    return this.db.card_fsrs_states.find((s) => s.card_id === cardId) ?? null;
  }
  /** 全部 FSRS 状态，一次拿全 —— 统计页/复习页要按书聚合时避免逐卡 N 次查询 */
  async listAllFsrsStates(): Promise<CardFsrsState[]> {
    return [...this.db.card_fsrs_states];
  }
  async upsertFsrsState(s: CardFsrsState): Promise<void> {
    const idx = this.db.card_fsrs_states.findIndex((x) => x.card_id === s.card_id);
    if (idx >= 0) this.db.card_fsrs_states[idx] = s;
    else this.db.card_fsrs_states.push(s);
    await this.save();
  }

  // ---- 复习会话 ----
  async createReviewSession(scope?: Record<string, unknown>): Promise<ReviewSession> {
    const row: ReviewSession = {
      id: uuid(),
      status: "in_progress",
      scope: scope ?? null,
      timezone: "Asia/Shanghai",
      started_at: nowISO(),
      finished_at: null,
    };
    this.db.review_sessions.push(row);
    await this.save();
    return row;
  }
  async getReviewSession(id: ID): Promise<ReviewSession | null> {
    return this.db.review_sessions.find((s) => s.id === id) ?? null;
  }
  /**
   * 续接查找：同范围 + 未完成 + 同一天，取最近开的那一轮。
   *
   * 为什么必须按天判断：in_progress 会话不会自己过期，昨天没刷完的那轮今天还在，
   * 直接续接就会把今天到期的卡挤到队列后面，用户看到「昨天的题又来了」。
   */
  async findInProgressSession(match: ReviewScopeKey): Promise<ReviewSession | null> {
    const same = this.db.review_sessions
      .filter((s) => s.status === "in_progress" && sameScope(s.scope, match))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    const today = same.find((s) => isSameLocalDay(s.started_at));
    return today ?? null;
  }
  async abandonReviewSession(id: ID): Promise<void> {
    const s = this.db.review_sessions.find((x) => x.id === id);
    if (s && s.status === "in_progress") {
      s.status = "abandoned";
      s.finished_at = nowISO();
      await this.save();
    }
  }
  async abandonOtherInProgress(keepId: ID, match?: ReviewScopeKey): Promise<number> {
    let n = 0;
    const now = nowISO();
    for (const s of this.db.review_sessions) {
      if (s.id === keepId || s.status !== "in_progress") continue;
      // 带 match 时只收尾「同范围」的重复轮次：A 书和 B 书各自的进行中会话
      // 应当并存，否则「去 B 看一眼再回 A」就把 A 的进度作废了（用户实报）。
      if (match && !sameScope(s.scope, match)) continue;
      s.status = "abandoned";
      s.finished_at = now;
      n++;
    }
    if (n > 0) await this.save();
    return n;
  }
  async listInProgressSessions(): Promise<ReviewSession[]> {
    return this.db.review_sessions
      .filter((s) => s.status === "in_progress" && isSameLocalDay(s.started_at))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  async latestInProgressSession(): Promise<ReviewSession | null> {
    const rows = await this.listInProgressSessions();
    return rows[0] ?? null;
  }
  async completeReviewSession(id: ID): Promise<void> {
    const s = this.db.review_sessions.find((x) => x.id === id);
    if (s) {
      s.status = "completed";
      s.finished_at = nowISO();
      await this.save();
    }
  }
  async addSessionCards(sessionId: ID, cardIds: ID[]): Promise<ReviewSessionCard[]> {
    const rows: ReviewSessionCard[] = [];
    for (let i = 0; i < cardIds.length; i++) {
      const card = await this.getCard(cardIds[i]);
      const row: ReviewSessionCard = {
        id: uuid(),
        session_id: sessionId,
        card_id: cardIds[i],
        sort_order: i,
        card_snapshot: {
          front: card?.front,
          back: card?.back,
          kind: card?.kind ?? "qa",
          options: card?.options ?? null,
          answer: card?.answer ?? null,
          // 多选：会话快照必须带上全部正确项，否则复习页只能看到一个字母，
          // 判题退化成「选中的集合 vs 单字母」永远判错
          answers: card?.answers ?? null,
          is_multi: card?.is_multi ?? false,
          is_choice: card?.is_choice ?? deriveIsChoice(card?.options),
          content_revision: card?.content_revision,
          // 复习时也要能分清「原文给的答案」和「AI 补的答案」
          answer_origin: card?.answer_origin ?? null,
          answer_grounded: card?.answer_grounded ?? null,
        },
        rated: false,
        review_id: null,
      };
      this.db.review_session_cards.push(row);
      rows.push(row);
    }
    await this.save();
    return rows;
  }
  async listSessionCards(sessionId: ID): Promise<ReviewSessionCard[]> {
    return this.db.review_session_cards
      .filter((sc) => sc.session_id === sessionId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }
  async markSessionCardRated(sessionCardId: ID, reviewId: ID): Promise<void> {
    const sc = this.db.review_session_cards.find((x) => x.id === sessionCardId);
    if (sc) {
      sc.rated = true;
      sc.review_id = reviewId;
      await this.save();
    }
  }
  /**
   * 服务端幂等第二道护栏：同一张会话卡只允许被评一次分。
   * 客户端幂等键靠前端复用，但换个浏览器/页面重开就失效了；
   * 会话卡的 review_id 是落库后的既成事实，以它为准兜底去重。
   */
  async findReviewBySessionCard(sessionCardId: ID): Promise<CardReview | null> {
    const sc = this.db.review_session_cards.find((x) => x.id === sessionCardId);
    if (!sc?.review_id) return null;
    return this.db.card_reviews.find((r) => r.id === sc.review_id) ?? null;
  }

  // ---- 复习事件（追加式 + 幂等）----
  /**
   * 记录一次复习事件，并在同一「事务」内推进 FSRS 状态。
   *
   * @param nextState 调用方已经算好的「评分后状态」。
   *   旧实现让 /api/review/rate 先算一次 schedule() 填快照，recordReview 内部
   *   又算第二次 —— 两处各做一遍排期，靠「输入恰好相同」才对得上。
   *   这是颗定时炸弹：只要将来有人在写回状态之外再调一次 recordReview，
   *   reps 就会被记两次、间隔被凭空拉长。现在排期入口只有一处：
   *   传入 nextState 就用它，不传才在内部补算。
   */
  async recordReview(
    r: Omit<CardReview, "id" | "reviewed_at">,
    nextState?: CardFsrsState
  ): Promise<CardReview> {
    // 幂等：同一 idempotency_key 已存在则直接返回，不重复记账。
    const existing = this.db.card_reviews.find((x) => x.idempotency_key === r.idempotency_key);
    if (existing) return existing;

    const row: CardReview = { ...r, id: uuid(), reviewed_at: nowISO() };

    const fsrsIdx = this.db.card_fsrs_states.findIndex((s) => s.card_id === r.card_id);
    if (nextState) {
      if (fsrsIdx >= 0) this.db.card_fsrs_states[fsrsIdx] = nextState;
      else this.db.card_fsrs_states.push(nextState);
    } else if (fsrsIdx >= 0) {
      const result = await schedule(this.db.card_fsrs_states[fsrsIdx], r.rating);
      this.db.card_fsrs_states[fsrsIdx] = result.card;
    }

    this.db.card_reviews.push(row);

    // 会话卡标记随同一次写盘完成（不能调 markSessionCardRated —— 它会再 save 一次）
    if (r.session_card_id) {
      const sc = this.db.review_session_cards.find((x) => x.id === r.session_card_id);
      if (sc) {
        sc.rated = true;
        sc.review_id = row.id;
      }
    }

    await this.save();
    return row;
  }
  async getReviewByKey(idempotencyKey: ID): Promise<CardReview | null> {
    return this.db.card_reviews.find((x) => x.idempotency_key === idempotencyKey) ?? null;
  }
  async listReviewsAfter(iso: string): Promise<CardReview[]> {
    const from = new Date(iso).getTime();
    if (Number.isNaN(from)) return [];
    return this.db.card_reviews.filter((r) => {
      const at = new Date(r.reviewed_at).getTime();
      return !Number.isNaN(at) && at >= from;
    });
  }
  async listReviews(cardId?: ID, limit = 50): Promise<CardReview[]> {
    let rows = this.db.card_reviews.slice();
    if (cardId) rows = rows.filter((r) => r.card_id === cardId);
    return rows.sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at)).slice(0, limit);
  }

  // ---- 今日任务 ----
  async listDueCards(limit = 200): Promise<DueCard[]> {
    const now = Date.now();
    const due: DueCard[] = [];
    for (const c of this.db.cards) {
      if (c.status !== "active" || c.deleted_at) continue;
      const fsrs = this.db.card_fsrs_states.find((s) => s.card_id === c.id);
      if (!fsrs) continue;
      if (new Date(fsrs.due_at).getTime() <= now) {
        due.push({
          card_id: c.id,
          front: c.front,
          back: c.back,
          kind: c.kind ?? "qa",
          options: c.options ?? null,
          answer: c.answer ?? null,
          is_choice: c.is_choice ?? deriveIsChoice(c.options),
          card_type: c.card_type ?? null,
          status: c.status,
          content_revision: c.content_revision,
          stability: fsrs.stability,
          stability_fast: fsrs.stability_fast,
          difficulty: fsrs.difficulty,
          state: fsrs.state,
          schedule_status: fsrs.schedule_status,
          scheduled_days: fsrs.scheduled_days,
          reps: fsrs.reps,
          lapses: fsrs.lapses,
          due_at: fsrs.due_at,
          last_review_at: fsrs.last_review_at,
          rejected_at: c.rejected_at ?? null,
        });
      }
    }
    // 排序：学过（reps > 0）的排期卡全部排在前面，新卡垫底。
    // 只按 due_at 升序会把几十张「今天刚生成、due = 创建时间」的新卡
    // 插到真正的到期复习卡前面 —— 打开一轮复习，先被塞一堆没学过的，
    // 用户会以为排期乱了。组内仍按 due_at 升序，保证到期越久越先出现。
    return due
      .sort((a, b) => {
        const aOld = a.reps > 0 ? 0 : 1;
        const bOld = b.reps > 0 ? 0 : 1;
        if (aOld !== bOld) return aOld - bOld;
        return a.due_at.localeCompare(b.due_at);
      })
      .slice(0, limit);
  }

  /**
   * 今天答错、还没答对的卡。
   *
   * 用户实报：点了「没想起来」，页面说「今天之内还会再出现」，可退出再进来
   * 直接显示「已复习」，那题再也不出来，只能等明天。
   *
   * 根因是到期口径：Again 把 due_at 压到 now+10min，而 listDueCards 只认
   * `due_at <= now`，于是这 10 分钟里它既不是「到期」、又被会话判成「已作答」。
   *
   * 这里单独给一个「今日错题」口径：今天有评分记录、且**最后一次仍是 1** 的卡。
   * 与 due 无关，所以重做入口随时可用；答对之后最后一次评分变成 3/4，
   * 它自然从这个列表里消失。
   */
  async listTodayRetryCards(limit = 1000): Promise<Card[]> {
    const dayOf = (iso: string) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    };
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

    // 每张卡「今天的最后一次评分」
    const latest = new Map<string, { at: number; rating: number }>();
    for (const r of this.db.card_reviews) {
      if (dayOf(r.reviewed_at) !== today) continue;
      const at = new Date(r.reviewed_at).getTime();
      const prev = latest.get(r.card_id);
      if (!prev || at >= prev.at) latest.set(r.card_id, { at, rating: Number(r.rating) });
    }

    const rows: Array<{ card: Card; at: number }> = [];
    for (const [cardId, info] of latest) {
      if (info.rating !== 1) continue; // 最后一次答对了 → 不再算错题
      const card = this.db.cards.find((c) => c.id === cardId && !c.deleted_at);
      if (!card || card.status !== "active") continue;
      rows.push({ card, at: info.at });
    }
    // 越早答错的越先重做（先错的印象更浅）
    rows.sort((a, b) => a.at - b.at);
    return rows.slice(0, limit).map((r) => r.card);
  }

  async getTodayStats(): Promise<TodayStats> {
    const due = await this.listDueCards(10000);
    // 今日错题：与 due 并列统计，不并进 due_count（原因见 listTodayRetryCards）
    const retry = await this.listTodayRetryCards(10000);

    // 待复习总数 = 今天到期的 active 卡（新卡 due=now 也算在内），再拆成两组：
    //   新卡     : 从没学过（reps = 0）—— 今天导入 / 刚审核通过的
    //   到期复习 : 学过（reps > 0）—— 按 FSRS 排期今天该回来的
    //              其中答错过的（lapses > 0 或 Relearning）再单列为「重学」，
    //              它是复习的细分而不是并列项，保证三项相加恒等于 due_count。
    //
    // 判据只用 reps / state，不用 rejected_at。
    // 旧实现把 rejected_at 当成重学标记，但「审核时点拒绝」的语义是
    // 「这张不熟、放进队列」，卡本身可能一次都没学过。结果一整批新导入的卡
    // 全被算进重学，new_count 恒为 0，首页永远看不出「哪些是排期复习、
    // 哪些是今天新生成的」—— 这正是用户反馈的「68 张混在一起分不清」。
    const newCount = due.filter((d) => d.reps === 0).length;
    const relearnCount = due.filter(
      (d) => d.reps > 0 && (d.lapses > 0 || d.state === FsrsState.Relearning)
    ).length;
    const reviewCount = due.length - newCount - relearnCount;

    const pendingDraft = this.db.cards.filter(
      (c) => c.status === "draft" && !c.deleted_at
    ).length;

    // 预计耗时：历史平均单卡时长（ms），无历史则按 8 秒/卡估算。
    const elapsed = this.db.card_reviews.filter((r) => r.elapsed_ms != null).map((r) => r.elapsed_ms!);
    const avgMs = elapsed.length
      ? elapsed.reduce((a, b) => a + b, 0) / elapsed.length
      : 8000;

    // 今日已完成：今天真正评过分的「不同卡片数」。
    // 旧实现写成 active.length - due.length，那不是「今日完成」，而是「还没到期的卡数」，
    // 拒绝一批卡进队列后这个数字纹丝不动，看起来就像统计没更新。
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const doneToday = new Set(
      this.db.card_reviews
        .filter((r) => new Date(r.reviewed_at).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) === today)
        .map((r) => r.card_id)
    ).size;

    return {
      due_count: due.length,
      new_count: newCount,
      review_count: reviewCount,
      relearn_count: relearnCount,
      pending_draft: pendingDraft,
      retry_count: retry.length,
      estimated_minutes: Math.max(1, Math.round((due.length * avgMs) / 60000)),
      completed_today: doneToday,
    };
  }
}
