// AI 卡片生成 —— 两段式：先提炼知识点，再按知识点出题。
//
// 与旧实现的区别（旧版是「整章文本 → 直接出 3~8 张卡」）：
//   1) 知识点先落库，成为一等对象。卡片必须挂到某个知识点上（kp_id），
//      于是「这一章我到底要记住几件事」变成可数的，补题也有了锚点。
//   2) 卡片数量由内容决定，不设上下限。材料能支撑几道互不重复、各有原文
//      依据的题就出几道；不再按 kp×系数算配额，也不为凑数补题。
//      （配额制的两个副作用：内容厚的知识点被截断，内容薄的知识点被凑数。）
//   3) 每张卡必须带 evidence（原文短语）。没有证据的卡一律剔除 ——
//      这是防编造最有效的一道闸，比在提示词里写十遍「不要编造」管用。
//
// 仍然坚持的旧原则：
//   · 一律 status='draft'，模型不能绕过审核
//   · schema 校验失败显式抛错，不静默返回空
//   · 单章失败不整单回滚（由调用方处理）

import { chatJSON } from "../llm";
import type { CardType } from "../db/types";
import { isGroundedIn, normForMatch, sharesSourceRun } from "./grounding";

export type GenMode = "off" | "smart" | "deep";

export interface GenKnowledgePoint {
  statement: string;
  evidence: string;
}

export interface GenCard {
  kp_index: number;
  card_type: CardType;
  front: string;
  back: string;
  options?: string[];
  answer?: string;
  evidence: string;
}

export interface GeneratedBundle {
  knowledge_points: GenKnowledgePoint[];
  cards: GenCard[];
  /** 被闸门挡掉的卡，按原因计数（给界面/日志一个交代，不静默吞） */
  rejected?: Record<string, number>;
}

/** 已存在的知识点（补题时只围绕它们出卡，不再提炼新的） */
export interface ExistingKp {
  index: number;
  statement: string;
  evidence?: string | null;
}

const SYSTEM = `你是一名学习内容编辑，负责把一章学习材料拆成「知识点 + 复习卡片」。

工作分两步：
1. 提炼知识点：把材料里需要掌握的内容归纳成 3~8 条陈述。每条是一句**可独立成立**的话，不要写成标题短语。
2. 按知识点出卡片：每张卡都必须挂到某条知识点上（kp_index 指向 knowledge_points 的下标）。

只输出 JSON：
{"knowledge_points":[{"statement":"...","evidence":"原文短语"}],
 "cards":[{"kp_index":0,"card_type":"qa","front":"问题","back":"答案","options":[],"answer":"","evidence":"原文短语"}]}

硬性规则（违反的卡会被直接丢弃）：
- evidence 必须是材料里**逐字出现**的短语（不超过 60 字），不得改写、不得概括。没有原文依据的卡不要出。
- 系统会拿 evidence 回原文逐字核对，**查不到的卡直接丢弃**，不要赌。
- 一张卡只考它所属的那一条知识点（kp_index 指向的那条），不要跨知识点提问，
  也不要问「这一章讲了什么」这种整体性问题。evidence 要从该知识点所在的段落里摘。
- 术语、公式、数字、上下限一律照抄原文，不改写、不换算、不补充原文没有的信息。
- card_type 只能取：qa（问答）、choice（选择题）、cloze（填空）、judge（判断）、contrast（对比）。
  · choice 必须给 4 个选项与 answer，answer 必须与某个选项文本完全一致；干扰项要同领域、易混淆。
  · cloze 的 front 必须包含六个下划线 ______，答案放 back。
  · judge 的 back 只能是「对」或「错」。
  · contrast 的 front 写成「A 与 B 的区别」，back 分点对照。
- 材料里已经出现过的题目不要重复出（那部分已由系统单独收录）。
- 只考知识本身。不要出关于「这份材料」自身的问题（目录顺序、章节排列、「本文/本材料提到…」、
  阅读建议、篇幅结构）——那类问题背下来没有用。
- 宁缺毋滥：凑数的卡不如不出。`;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isNonEmptyString(x));
}

/* 数量不加配额：多少张由内容决定，见下方 task 里的明确要求 */

const VALID_TYPES: CardType[] = ["choice", "qa", "cloze", "judge", "contrast"];

// ---------------------------------------------------------------------------
// 原文校验闸门
// ---------------------------------------------------------------------------
//
// 提示词里写「evidence 必须逐字出现」是一句请求，不是约束 —— 模型随时会
// 顺手概括一句、把两个短语拼起来、或者干脆编一句看起来很像原文的话。
// 一旦这样的卡落库，审核台上它和真卡长得一模一样，人只能逐题回原文查。
//
// 所以这里做代码级校验：evidence 必须真的能在这章正文里找到。
// 找不到 → 这张卡丢掉（不是标记，是丢弃 —— 无据可查的题没有保留价值）。
//
// 判定细节见 ./grounding.ts（三级放宽，避免误杀）。

/**
 * 把模型返回的原始 JSON 过一遍校验闸门。
 *
 * 导出是为了能被回归脚本直接测：这是「AI 出题是否会编造」的唯一一道代码闸，
 * 靠真实调模型去碰「恰好编了一句」不可靠，必须能用固定输入断言它确实会挡。
 */
export function sanitize(
  raw: unknown,
  kpCount: number,
  material = "",
  existingEvidence: string[] = []
): { kps: GenKnowledgePoint[]; cards: GenCard[]; rejected: Record<string, number> } {
  const obj = (raw ?? {}) as {
    knowledge_points?: unknown;
    cards?: unknown;
  };
  const hay = normForMatch(material);
  const rejected: Record<string, number> = {};
  const drop = (reason: string): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  const kps: GenKnowledgePoint[] = [];
  if (Array.isArray(obj.knowledge_points)) {
    for (const k of obj.knowledge_points) {
      const row = k as { statement?: unknown; evidence?: unknown };
      if (!isNonEmptyString(row?.statement)) continue;
      // evidence 为空的知识点不入库：没有原文依据的陈述无法核验，留着只会误导
      if (!isNonEmptyString(row?.evidence)) {
        drop("kp_no_evidence");
        continue;
      }
      const evidence = row.evidence.trim().slice(0, 120);
      // 有 evidence 但原文里查不到 → 这条知识点的依据是编的，一并丢弃
      if (hay && !isGroundedIn(evidence, hay)) {
        drop("kp_evidence_not_in_source");
        continue;
      }
      kps.push({ statement: row.statement.trim(), evidence });
    }
  }

  const cards: GenCard[] = [];
  if (Array.isArray(obj.cards)) {
    for (const c of obj.cards) {
      const row = c as Record<string, unknown>;
      if (!isNonEmptyString(row?.front)) continue;
      if (!isNonEmptyString(row?.evidence)) {
        drop("card_no_evidence"); // 无证据不出卡
        continue;
      }

      const idx = Number(row.kp_index);
      if (!Number.isInteger(idx) || idx < 0 || (kpCount > 0 && idx >= kpCount)) {
        drop("card_bad_kp_index");
        continue;
      }

      const type = VALID_TYPES.includes(row.card_type as CardType)
        ? (row.card_type as CardType)
        : "qa";

      const front = (row.front as string).trim();
      const evidence = (row.evidence as string).trim().slice(0, 120);

      // ---- 闸门 1：证据必须出自本章原文 ----
      if (hay && !isGroundedIn(evidence, hay)) {
        drop("card_evidence_not_in_source");
        continue;
      }

      // ---- 闸门 2：证据必须与所属知识点同源（挡挂错 kp）----
      // 补题模式下 kp 来自数据库，用它的 evidence；首轮用模型刚给的 kps。
      const kpEvidence = existingEvidence[idx] ?? kps[idx]?.evidence ?? "";
      if (kpEvidence && !sharesSourceRun(evidence, kpEvidence)) {
        drop("card_kp_mismatch");
        continue;
      }

      if (type === "choice") {
        if (!isStringArray(row.options) || (row.options as string[]).length < 2) {
          drop("choice_bad_options");
          continue;
        }
        const options = (row.options as string[]).map((o) => o.trim());
        const answer = isNonEmptyString(row.answer) ? (row.answer as string).trim() : "";
        if (!answer) {
          drop("choice_no_answer");
          continue;
        }
        // answer 必须命中某个选项，否则这题无法判分
        const hit = options.find((o) => o === answer || o.replace(/^[A-D][.、．]\s*/, "") === answer);
        if (!hit) {
          drop("choice_answer_not_in_options");
          continue;
        }
        cards.push({
          kp_index: idx,
          card_type: "choice",
          front,
          back: hit,
          options,
          answer: hit,
          evidence,
        });
        continue;
      }

      if (type === "cloze") {
        if (!/_{3,}/.test(front)) {
          drop("cloze_no_blank");
          continue;
        }
        if (!isNonEmptyString(row.back)) {
          drop("cloze_no_answer");
          continue;
        }
        cards.push({
          kp_index: idx,
          card_type: "cloze",
          front,
          back: (row.back as string).trim(),
          evidence,
        });
        continue;
      }

      if (type === "judge") {
        const a = isNonEmptyString(row.back) ? (row.back as string).trim() : "";
        if (!/^(对|错|正确|错误|√|×|✓|✗|T|F)$/i.test(a)) {
          drop("judge_bad_answer");
          continue;
        }
        const ans = /^(对|正确|√|✓|T)$/i.test(a) ? "对" : "错";
        cards.push({
          kp_index: idx,
          card_type: "judge",
          front,
          back: ans,
          options: ["对", "错"],
          answer: ans,
          evidence,
        });
        continue;
      }

      // qa / contrast
      if (!isNonEmptyString(row.back)) {
        drop("qa_no_answer");
        continue;
      }
      cards.push({
        kp_index: idx,
        card_type: type,
        front,
        back: (row.back as string).trim(),
        evidence,
      });
    }
  }

  return { kps, cards, rejected };
}

export interface GenerateOptions {
  timeoutMs?: number;
  /** 章节里出现过对比表 → 提示模型多出 contrast 卡 */
  hasContrast?: boolean;
  /** 只围绕这些知识点出卡（补题场景），不再提炼新知识点 */
  onlyKps?: ExistingKp[];
}

const MIN_MATERIAL_CHARS = 30;

/**
 * 一章材料 → 知识点 + 卡片。
 *
 * @param material 该章正文（**已剔除原题片段**，避免模型重复出题）
 * @param mode     smart / deep，决定卡片密度
 */
export async function generateKnowledgeAndCards(
  material: string,
  mode: GenMode,
  opts: GenerateOptions = {}
): Promise<GeneratedBundle> {
  const text = material.trim();
  if (!text) throw new Error("材料为空，无法生成卡片");
  if (text.length < MIN_MATERIAL_CHARS) {
    throw new Error(
      `这段材料只有 ${text.length} 字，内容太少无法生成卡片（至少需要 ${MIN_MATERIAL_CHARS} 字）`
    );
  }

  const onlyKps = opts.onlyKps ?? null;

  // 补题模式：只给知识点，不要求再提炼
  const task = onlyKps
    ? `只围绕下面这些已确定的知识点出卡片，**不要新增知识点**：
${onlyKps.map((k, i) => `${i}. ${k.statement}${k.evidence ? `（原文：${k.evidence}）` : ""}`).join("\n")}

knowledge_points 一律返回空数组，cards 里 kp_index 用上面给出的编号。
数量按内容实际需要来：这条知识点在原文里能支撑几道**互不重复、各有原文依据**的题，就出几道。
不设上下限 —— 只够一两道就出一两道，够十道就出十道；不要为凑数编题、换说法重复问同一件事。`
    : `请按上面的两步法处理。卡片数量按内容实际需要来，**不设上下限**：
每条知识点在原文里能支撑几道互不重复、各有原文依据的题，就出几道；材料薄的知识点可以只出一两道甚至不出。
不要为凑数编题、不要换说法重复问同一件事${
        mode === "deep" ? "；长句解释与对比题按内容需要用，题型不必强求覆盖全部五种" : "；优先出最该记的那几张"
      }。`;

  const contrastHint = opts.hasContrast
    ? "\n\n注意：本章包含对比型内容（表格对比），请为其中的对比关系至少出 1 张 contrast 卡。"
    : "";

  const raw = await chatJSON<unknown>({
    system: SYSTEM,
    user: `${task}${contrastHint}\n\n材料：\n\n${text.slice(0, 8000)}`,
    temperature: 0.4,
    // 两段式输出比旧版更长（知识点 + 卡片），超时给足。实测 60~90 秒常见。
    timeoutMs: opts.timeoutMs ?? 100000,
  });

  if (raw === null) {
    // 说清楚「什么还在、下一步做什么」。原来的「请重试」等于没说 ——
    // 用户不知道是网络问题还是自己没有内容，也不知道重试会不会重复建卡。
    throw new Error(
      "AI 出题失败（网关超时或繁忙）。知识点和原题都还在，稍后再点一次即可，不会重复建卡。"
    );
  }

  const { kps, cards, rejected } = sanitize(
    raw,
    onlyKps ? onlyKps.length : 0,
    text,
    onlyKps ? onlyKps.map((k) => k.evidence ?? "") : []
  );

  if (!onlyKps && kps.length === 0) {
    throw new Error(
      "AI 没有提炼出可用知识点（缺 statement，或 evidence 在本章原文里查不到），请补充实质内容后重试"
    );
  }
  if (cards.length === 0) {
    const blocked = Object.entries(rejected)
      .filter(([k]) => k.startsWith("card_"))
      .map(([k, n]) => `${k}×${n}`)
      .join("、");
    throw new Error(
      blocked
        ? `AI 产出的卡片全部未通过原文校验（${blocked}），未写入任何卡。这通常说明模型在凭印象出题，请重试。`
        : "AI 没有产出可用的卡片（可能缺少原文证据或格式不符），请重试"
    );
  }

  return { knowledge_points: onlyKps ? [] : kps, cards, rejected };
}

// ---------------------------------------------------------------------------
// 原题绑定知识点
// ---------------------------------------------------------------------------

export interface BindResult {
  /** question_no（无编号的用下标+10000 作键）→ kp 下标；null 表示绑定失败 */
  bindings: Array<{ index: number; kp_index: number | null; evidence: string }>;
}

/**
 * 为已抽出的原题绑定知识点。
 *
 * 为什么值得多花一次调用：原题是「用户真正要考的」，知识点是「这章要记什么」。
 * 绑上之后才能回答「我这次错的是哪个知识点」，也才能支撑「按知识点补题」。
 *
 * 绑定失败不丢题：kp_index = null → 进「未关联」池，UI 可手动归属。
 */
export async function bindOriginalQuestions(
  questions: Array<{ index: number; front: string }>,
  kps: GenKnowledgePoint[],
  opts: { timeoutMs?: number } = {}
): Promise<Array<{ index: number; kp_index: number | null; evidence: string }>> {
  if (questions.length === 0 || kps.length === 0) {
    return questions.map((q) => ({ index: q.index, kp_index: null, evidence: "" }));
  }

  const raw = await chatJSON<unknown>({
    system: `你负责把「已有题目」对应到「知识点」。只输出 JSON：
{"bindings":[{"index":0,"kp_index":1,"evidence":"原文短语"}]}

规则：
- index 是题目编号（下面给出的数字），原样返回每道题一条，不得遗漏。
- kp_index 是知识点下标；如果这道题考的内容在知识点里找不到对应，kp_index 返回 null。
- evidence 填该题依据的**知识点原文短语**（不是题目自己的措辞）。
- 不要凭题面相似硬绑：宁可 null，也不要绑错。`,
    user: `知识点：
${kps.map((k, i) => `${i}. ${k.statement}`).join("\n")}

题目：
${questions.map((q) => `${q.index}. ${q.front.replace(/\s+/g, " ").slice(0, 120)}`).join("\n")}`,
    temperature: 0.1,
    timeoutMs: opts.timeoutMs ?? 60000,
  });

  const map = new Map<number, { kp_index: number | null; evidence: string }>();
  const obj = (raw ?? {}) as { bindings?: unknown };
  if (Array.isArray(obj.bindings)) {
    for (const b of obj.bindings) {
      const row = b as Record<string, unknown>;
      const idx = Number(row.index);
      if (!Number.isInteger(idx)) continue;
      const kpIdx = row.kp_index === null ? null : Number(row.kp_index);
      const valid =
        kpIdx !== null && Number.isInteger(kpIdx) && kpIdx >= 0 && kpIdx < kps.length
          ? kpIdx
          : null;
      map.set(idx, {
        kp_index: valid,
        evidence: isNonEmptyString(row.evidence) ? (row.evidence as string).trim().slice(0, 120) : "",
      });
    }
  }

  // 模型漏掉的题一并返回（进未关联池），不静默丢弃
  return questions.map((q) => ({
    index: q.index,
    kp_index: map.get(q.index)?.kp_index ?? null,
    evidence: map.get(q.index)?.evidence ?? "",
  }));
}
