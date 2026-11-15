/**
 * 两本独立台账文件的读写：data/audit/answer-gaps.json、data/audit/rejected-cards.json。
 *
 * 为什么是「独立文件」而不是 db.json 里的两个集合：
 *   监督员（学习复盘 Agent）要的是**可以直接读、可以直接喂给模型**的样本集，
 *   db.json 是一百多 KB 的全库快照，混着卡片正文、原文片段、FSRS 状态，
 *   丢给它既超上下文又全是噪音。这两本台账只装「过程缺陷」，
 *   每条自带节点链路 + 题型画像 + 函数管道，单文件就能归因。
 *
 * 写入约定（三条，改动前先读）：
 *   1) **best-effort**：台账写失败绝不能让「补答案」「点拒绝」这两个用户操作失败，
 *      只打日志。台账是审计，不是业务主链路。
 *   2) **幂等**：按 id 去重，同一条重复追加不会写两遍。
 *   3) **串行**：进程内用一条 promise 链排队，避免读-改-写互相覆盖。
 *      Next.js 多 worker 下没有跨进程锁 —— 单人本地应用可接受，
 *      换成多实例部署时这里要改成文件锁或单一写入服务。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { AnswerGapReport, ReviewRejection } from "../db/types";
import {
  ANSWER_GAP_LEGEND,
  REJECTION_LEGEND,
  summarizeAnswerGaps,
  summarizeRejections,
  type AnswerGapTotals,
  type RejectionTotals,
} from "./ledger-model";

export type LedgerKind = "answer-gaps" | "rejected-cards";

export const LEDGER_FILES: Record<LedgerKind, string> = {
  "answer-gaps": "answer-gaps.json",
  "rejected-cards": "rejected-cards.json",
};

const SCHEMA_VERSION = 1;

const PURPOSES: Record<LedgerKind, string> = {
  "answer-gaps":
    "AI 补全答案的过程台账：每条说明「这个问题为什么没回答清楚」，补成功与没补上都记。给学习复盘监督员找规律用。",
  "rejected-cards":
    "审核时点「拒绝 / 不熟」放进复习队列的节点台账：每条带节点链路、题型、拒绝前后 FSRS 状态。给学习复盘监督员核对「拒绝得对不对」用。",
};

interface LedgerEnvelope<T, S> {
  schema_version: number;
  ledger: LedgerKind;
  purpose: string;
  updated_at: string;
  totals: S;
  legend: Record<string, string>;
  items: T[];
}

function auditDir(): string {
  const base = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "data");
  return path.join(base, "audit");
}

function ledgerPath(kind: LedgerKind): string {
  return path.join(auditDir(), LEDGER_FILES[kind]);
}

/** 进程内串行队列：与 localStore.enqueue 同理，读-改-写不能重叠。 */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function writeAtomic(file: string, json: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, json, "utf8");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

async function readEnvelope<T, S>(kind: LedgerKind, emptyTotals: () => S): Promise<LedgerEnvelope<T, S>> {
  const file = ledgerPath(kind);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LedgerEnvelope<T, S>>;
    return {
      schema_version: parsed.schema_version ?? SCHEMA_VERSION,
      ledger: kind,
      purpose: PURPOSES[kind],
      updated_at: parsed.updated_at ?? "",
      totals: parsed.totals ?? emptyTotals(),
      legend: kind === "answer-gaps" ? ANSWER_GAP_LEGEND : REJECTION_LEGEND,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (e) {
    // 文件不存在 = 第一次写，正常；解析失败说明文件坏了，留一份残骸再重建
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      await fs
        .copyFile(file, `${file}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
    return {
      schema_version: SCHEMA_VERSION,
      ledger: kind,
      purpose: PURPOSES[kind],
      updated_at: "",
      totals: emptyTotals(),
      legend: kind === "answer-gaps" ? ANSWER_GAP_LEGEND : REJECTION_LEGEND,
      items: [],
    };
  }
}

const emptyGapTotals = (): AnswerGapTotals => summarizeAnswerGaps([]);
const emptyRejectionTotals = (): RejectionTotals => summarizeRejections([]);

async function appendRows<T, S>(
  kind: LedgerKind,
  rows: T[],
  idOf: (row: T) => string,
  summarize: (items: T[]) => S,
  emptyTotals: () => S
): Promise<void> {
  if (rows.length === 0) return;
  await enqueue(async () => {
    const env = await readEnvelope<T, S>(kind, emptyTotals);
    const seen = new Set(env.items.map(idOf));
    let added = 0;
    for (const row of rows) {
      const id = idOf(row);
      if (seen.has(id)) continue; // 幂等：重放不写两遍
      seen.add(id);
      env.items.push(row);
      added++;
    }
    if (added === 0) return;
    env.totals = summarize(env.items); // 每次追加都重算，别让 totals 与 items 漂移
    env.updated_at = new Date().toISOString();
    env.schema_version = SCHEMA_VERSION;
    env.purpose = PURPOSES[kind];
    env.legend = kind === "answer-gaps" ? ANSWER_GAP_LEGEND : REJECTION_LEGEND;
    await writeAtomic(ledgerPath(kind), `${JSON.stringify(env, null, 2)}\n`);
  });
}

/** 追加一条答案缺口记录；失败只告警，不影响补全流程本身。 */
export async function appendAnswerGap(row: AnswerGapReport): Promise<void> {
  try {
    await appendRows<AnswerGapReport, AnswerGapTotals>(
      "answer-gaps",
      [row],
      (r) => r.id,
      summarizeAnswerGaps,
      emptyGapTotals
    );
  } catch (e) {
    console.warn(`[audit] 写 answer-gaps 失败：${(e as Error)?.message ?? e}`);
  }
}

/**
 * 追加一条审核拒绝记录；同样 best-effort。
 * 批量拒绝请用 appendRejections —— 60 张卡逐个写会把文件读 60 遍。
 */
export async function appendRejection(row: ReviewRejection): Promise<void> {
  try {
    await appendRows<ReviewRejection, RejectionTotals>(
      "rejected-cards",
      [row],
      (r) => r.id,
      summarizeRejections,
      emptyRejectionTotals
    );
  } catch (e) {
    console.warn(`[audit] 写 rejected-cards 失败：${(e as Error)?.message ?? e}`);
  }
}

/** 批量追加（一次读、一次写、一次重算 totals）。 */
export async function appendRejections(rows: ReviewRejection[]): Promise<void> {
  try {
    await appendRows<ReviewRejection, RejectionTotals>(
      "rejected-cards",
      rows,
      (r) => r.id,
      summarizeRejections,
      emptyRejectionTotals
    );
  } catch (e) {
    console.warn(`[audit] 批量写 rejected-cards 失败：${(e as Error)?.message ?? e}`);
  }
}

export async function readAnswerGaps(): Promise<LedgerEnvelope<AnswerGapReport, AnswerGapTotals>> {
  return readEnvelope<AnswerGapReport, AnswerGapTotals>("answer-gaps", emptyGapTotals);
}

export async function readRejections(): Promise<LedgerEnvelope<ReviewRejection, RejectionTotals>> {
  return readEnvelope<ReviewRejection, RejectionTotals>("rejected-cards", emptyRejectionTotals);
}

/**
 * 给监督员的一次性快照：两本台账 + 交叉结论。
 *
 * 「交叉结论」是这批日志真正的价值所在 —— 单看任一本只能看到「多」，
 * 两本合起来才能回答「是不是同一批题在反复出问题」：
 * 某本书既大量补不出答案、又大量被拒 → 那本书的抽取质量是根因，不是审核标准。
 */
export interface LedgerSnapshot {
  generated_at: string;
  answer_gaps: LedgerEnvelope<AnswerGapReport, AnswerGapTotals>;
  rejections: LedgerEnvelope<ReviewRejection, RejectionTotals>;
  cross_findings: string[];
}

export async function readLedgerSnapshot(): Promise<LedgerSnapshot> {
  const [gaps, rejections] = await Promise.all([readAnswerGaps(), readRejections()]);
  return {
    generated_at: new Date().toISOString(),
    answer_gaps: gaps,
    rejections,
    cross_findings: crossFindings(gaps, rejections),
  };
}

/** 纯规则交叉归因（不调模型，保证可复现） */
export function crossFindings(
  gaps: LedgerEnvelope<AnswerGapReport, AnswerGapTotals>,
  rejections: LedgerEnvelope<ReviewRejection, RejectionTotals>
): string[] {
  const out: string[] = [];
  const g = gaps.totals;
  const r = rejections.totals;

  if (g.count === 0 && r.count === 0) return ["台账还没有样本：先做几次「补答案」和「拒绝入复习」再看结论。"];

  const unfixed = g.by_outcome?.unfixed ?? 0;
  if (g.count > 0 && unfixed / g.count >= 0.3) {
    const topStep = Object.entries(g.by_block_step ?? {})[0];
    out.push(
      `${unfixed}/${g.count} 条补答案没补上（${Math.round((unfixed / g.count) * 100)}%），` +
        (topStep ? `主要卡在 ${topStep[0]}（${topStep[1]} 条）——先去修那个判定，比改提示词见效快。` : "先看 by_block_step 定位卡点。")
    );
  }

  const topType = Object.entries(g.by_question_type ?? {})[0];
  if (topType && g.count >= 5 && topType[1] / g.count >= 0.5) {
    out.push(`补答案集中在 ${topType[0]}（${topType[1]}/${g.count}）：这一题型的答案抽取规则需要单独复核。`);
  }

  if (g.unbound_kp > 0) {
    out.push(`${g.unbound_kp}/${g.count} 条没绑知识点：抽题时没对上知识点，答案再补也归不了档。`);
  }

  const firstTime = r.first_time ?? 0;
  if (r.count > 0 && firstTime / r.count >= 0.6) {
    out.push(
      `${firstTime}/${r.count} 张被拒的卡是「从没学过的新卡」：审核标准偏保守，` +
        `或者这批题本身太难，建议抽查这批卡的题干质量。`
    );
  }

  const topBook = Object.entries(r.by_textbook ?? {})[0];
  if (topBook && r.count >= 5 && topBook[1] / r.count >= 0.5) {
    out.push(`拒绝集中在《${topBook[0]}》（${topBook[1]}/${r.count}）：先查这本书的抽取质量，而不是逐张改卡。`);
  }

  // 同一本书同时霸占两本台账 → 根因在抽取，不在审核或答案补全
  const gapBooks = new Set(gaps.items.map((i) => i.node?.textbook_title).filter(Boolean));
  const rejBooks = new Set(rejections.items.map((i) => i.node?.textbook_title).filter(Boolean));
  const both = [...gapBooks].filter((b) => rejBooks.has(b));
  if (both.length > 0 && g.count >= 5 && r.count >= 5) {
    out.push(`《${both[0]}》同时出现在两本台账里：优先复核这本书的原文分块与题目抽取，属于上游问题。`);
  }

  if (out.length === 0) out.push("样本量还不够形成规律，继续积累（每类至少 5 条再判断）。");
  return out;
}
