"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EnumeratedText } from "@/components/enumerated-text";
import { AnswerText } from "@/components/answer-text";
import { AnswerSourceNote } from "@/components/source-note";
import { AiProgress } from "@/components/ai-progress";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { originReadHref, type CardOrigin } from "@/lib/cards/origin";
import { answerLabels, correctKeysOf, judgeSelection } from "@/lib/cards/answer-keys";
import { ERROR_KINDS } from "@/lib/cards/error-report";
import { reviewedLabel } from "@/lib/review/labels";
import { firstUnratedIndex, nextUnratedIndex, ratedCount } from "@/lib/review/progress";
import {
  progressLabel,
  resumeBadgeText,
  resumeHintText,
  summarizeProgress,
  type ResumableSession,
} from "@/lib/review/resume";
import type { CardErrorKind } from "@/lib/db/types";
import { uuid } from "@/lib/uuid";

type SessionCard = {
  id: string;
  card_id: string;
  front: string;
  back: string;
  kind: string;
  is_choice: boolean;
  options: string[] | null;
  answer: string | null;
  /** 多选：全部正确选项全文；null = 单选 */
  answers?: string[] | null;
  /** 是否多选题（answers ≥ 2 时由服务端派生） */
  is_multi?: boolean;
  /** 答案来源："ai" = 原文没给答案、由 AI 依据知识点生成 */
  answer_origin?: string | null;
  /** false = 原文没有依据，AI 用专业知识补的 */
  answer_grounded?: boolean | null;
  sort_order: number;
  /** 这张卡在原文里的落点；null = 没找到出处，不显示「去原文」按钮 */
  origin: CardOrigin | null;
  /**
   * 服务端记的「这一轮里已经答过」。
   *
   * 这是进度的唯一真相：页面重挂（去原文 / 点别的页面 / 手机切后台被回收）
   * 之后靠它把已经答过的题跳过，而不是回到第 1 题重刷。
   */
  rated?: boolean;
};

/** 今日复习页顶部书籍选择器的一行 */
type BookOption = { id: string; title: string; due: number; retry?: number };

/** /api/today 返回的今日统计（只需要拆分用到的几个字段） */
type TodayStatsLite = {
  due_count: number;
  new_count: number;
  review_count: number;
  relearn_count: number;
  /** 今天答错、还没答对的题（当天可重做） */
  retry_count?: number;
};

/** 复习分组：null = 两类混在一起；due = 只刷到期的；new = 只学新卡 */
type Group = "due" | "new" | null;

/**
 * 一次评分的落库结果，用来在底部回执里说「刚才那次答成什么、下次什么时候来」。
 * label 是给选择题用的：那边没有四档自评，说「答对了 / 答错了」比「正常想起」贴切。
 */
type RateNotice = { rating: number; dueAt: string; mastered: boolean; label?: string };

/**
 * 选择题的一次作答结果。
 * picked 是数组：单选题里最多一项，多选题里是用户勾的全部项 ——
 * 判题用集合相等，单选用同一套逻辑（1 对 1）也不会错。
 */
type ChoiceResult = { correct: boolean; picked: string[] };

/** 每道题离开时的现场，用于「返回上一题」还原（含已选/已翻面） */
type CardProgress = { revealed: boolean; picked: string[]; result: ChoiceResult | null };

const RATINGS = [
  { key: 1, label: "没想起来", hint: "Again", color: "bg-danger/15 text-danger" },
  { key: 2, label: "想起但费力", hint: "Hard", color: "bg-warning/15 text-warning" },
  { key: 3, label: "正常想起", hint: "Good", color: "bg-success/15 text-success" },
  { key: 4, label: "轻松想起", hint: "Easy", color: "bg-accent/15 text-accent" },
];

/** 提示条配色跟四档自评保持一致，看到颜色就知道说的是哪一档 */
const NOTICE_TONE: Record<number, string> = {
  1: "border-danger/45 text-danger",
  2: "border-warning/45 text-warning",
  3: "border-success/45 text-success",
  4: "border-accent/45 text-accent",
};

/**
 * 把到期时间说成人话：今天 / 明天（11月6日）/ 3 天后（11月8日）。
 * 直接 toLocaleString 会渲染成「2026/11/8 10:48:22」——秒级精度既没用又像系统日志。
 * 按「日历日」算差值，避免 23 小时后被算成 0 天、25 小时被算成 1 天这种抖动。
 */
function dueLabel(iso: string): string {
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return "稍后";
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(due) - dayStart(new Date())) / 86_400_000);
  const md = `${due.getMonth() + 1} 月 ${due.getDate()} 日`;
  if (days <= 0) return "今天";
  if (days === 1) return `明天（${md}）`;
  return `${days} 天后（${md}）`;
}

/**
 * 回执文案，两行：
 *   第一行 = 你刚才点的哪一档
 *   第二行 = 这张卡下一次什么时候再出现
 *
 * 不写「上一次作答」这种前缀 —— 回执是点完立刻在拇指边弹出来的，
 * 时间上已经能自证归属；省下的字用来把「下次什么时候」说清楚。
 */
function noticeParts(n: RateNotice): { title: string; sub: string } {
  const label = n.label ?? RATINGS.find((r) => r.key === n.rating)?.label ?? "已记录";
  if (n.mastered) {
    // 间隔已经拉到 60 天以上 → 毕业，不再进排期；标识留在资料库的题目列表里
    return { title: label, sub: "已掌握 · 间隔已超 60 天，不再进入复习排期" };
  }
  if (n.rating === 1) {
    // 答错的卡要「当天 + 次日」各来一遍：当天靠 10 分钟后回到队列 + 本轮 requeue，
    // 次日靠服务端把下一次间隔压到 1 天（见 lib/fsrs.ts 的 lapse 规则）
    return { title: label, sub: "今天之内还会再出现（直到答对）· 明天再考一次" };
  }
  // 四档里只有这一支是「真的排到了未来某天」，把「已排期」写出来，
  // 避免用户以为只是随口一句提示，而没意识到下次出现时间已经定了。
  return { title: label, sub: `已排期 · ${dueLabel(n.dueAt)}再出现这道题` };
}

/**
 * 评分回执做成独立组件：主答题页和「本轮完成」页都要用。
 * 最后一题答完会立刻切到完成页，若只在主分支渲染，那一题的排期提示就永远看不到。
 *
 * 存活时间 2.2s（+0.4s 淡出）—— 用户实报：这条绿色回执一直挂着，
 * 而它其实是「上一题」的结论，很容易被误读成当前这道题已经答对 / 已排期。
 * 结论性的信息不需要长期停留：看一眼记住了，留着反而误导。
 */
const TOAST_HOLD_MS = 2200;
const TOAST_FADE_MS = 400;

/**
 * 续接提示：告诉用户「你确实回到了上次的位置」，而不是从头发车。
 *
 * 和 RateToast 分开是因为寿命不同：回执是「上一题的结论」，2.2 秒就该走；
 * 断点是「我这轮的状态」，要留够时间让人看清「第 9 张 / 共 30 张，前面 8 张已复习」。
 * 同时给关闭按钮 —— 8 秒是上限，不是强制。
 */
const RESUME_HOLD_MS = 20000;

function ResumeHint({ text, onClose }: { text: string; onClose: () => void }) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const t = setTimeout(() => closeRef.current(), RESUME_HOLD_MS);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div
      className="flex items-start justify-between gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] px-4 py-2.5 text-[12px] leading-relaxed text-accent"
      role="status"
      aria-live="polite"
    >
      <span className="min-w-0">{text}</span>
      <button
        type="button"
        className="shrink-0 text-accent/60 transition hover:text-accent"
        onClick={onClose}
        title="收起提示（不影响复习进度）"
      >
        收起
      </button>
    </div>
  );
}

/**
 * 进度条：把「已完成 / 待复习」画出来。
 *
 * 只写「6 / 30」时，用户分不清这 30 是今天的全部还是这一轮的，也看不出还剩多少；
 * 一条两像素的进度条 + 一行对照文案，能直接回答「我还差多少」。
 */
function SessionProgressBar({ total, rated }: { total: number; rated: number }) {
  const percent = total === 0 ? 0 : Math.min(100, Math.round((rated / total) * 100));
  const remaining = Math.max(0, total - rated);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="micro tabular-nums">{progressLabel({ rated, remaining })}</div>
    </div>
  );
}

/**
 * 「返回上一层」的文字链接。
 *
 * 复习的答题页原来只有一个「换一本书」的小胶囊，藏在右上角、和「← 上一题」
 * 挤在一起 —— 从名字上看像「切换到另一本书」，不像「退回选书页」，
 * 所以用户会觉得「没有返回入口」。返回是导航动作，按站内其它页面的惯例
 * （资料库 → 章节 / 全文都是「← 返回…」文字链接）放左上角、明确写出去向。
 */
function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1.5 rounded-md text-sm text-muted transition hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      <span aria-hidden>←</span>
      {label}
    </button>
  );
}

/**
 * 选书页的断点徽标：这本书有一轮没刷完时，直接写「已答 5/30 · 继续」。
 *
 * 数据来自 /api/review/inprogress（当天进行中会话）。它和右侧的「待复习数」
 * 是两个口径：后者是排期，前者是「你这轮刷到第几张」—— 用户抱怨进度消失时，
 * 缺的正是后者。
 */
function ResumeHintLine({ item }: { item: ResumableSession }) {
  return (
    <span className="text-[11px] tabular-nums text-accent">
      {/* 只写数字：右边的按钮已经是「继续」，徽标再缀一遍就成了重复 */}
      {resumeBadgeText(item)}
    </span>
  );
}

function RateToast({ notice, onClose }: { notice: RateNotice; onClose: () => void }) {
  const parts = noticeParts(notice);
  const [leaving, setLeaving] = useState(false);
  // 父组件每次渲染都会传新的 onClose（内联箭头函数），直接进依赖会让计时器
  // 被反复重置、回执永远不消失。用 ref 取最新回调，effect 只跟 notice 走。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), TOAST_HOLD_MS);
    const gone = setTimeout(() => closeRef.current(), TOAST_HOLD_MS + TOAST_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [notice]);

  return (
    <div
      className={`review-toast ${leaving ? "review-toast-out" : ""} ${
        NOTICE_TONE[notice.rating] ?? "text-muted"
      }`}
      role="status"
      aria-live="polite"
      onClick={onClose}
    >
      <div className="text-[13px] font-medium">{parts.title}</div>
      <div className="mt-0.5 text-xs opacity-80">{parts.sub}</div>
    </div>
  );
}

/**
 * 「去原文查依据 → 返回继续这道题」的现场快照。
 *
 * v3 起快照只记「停在哪一题 + 当时的作答现场」，**不再存卡片列表**。
 *
 * 为什么要退化：v2 把 cards[] 一起存进 sessionStorage，于是同一轮复习有了两个
 * 真相 —— 快照里的旧卡片数组 和 服务端的 review_session_cards。用户从浏览器
 * 返回时命中旧快照，idx 指着一张已经答过的题；换个入口进来又是新一轮 idx=0。
 * 现在卡片和「答过没答过」一律问服务端（rated 位），快照只负责体验细节：
 * 回来还是这张题、这个选项、要不要显答案。
 *
 * 用 sessionStorage 而不是 localStorage：关掉标签页就该失效，
 * 不该第二天打开复习页还硬塞回昨天那轮。另加 2 小时 TTL 兜底。
 */
const RESUME_KEY = "review:resume:v1";
const RESUME_TTL_MS = 2 * 60 * 60 * 1000;

type ReviewSnapshot = {
  v: 3;
  savedAt: number;
  sessionId: string;
  idx: number;
  revealed: boolean;
  selected: string[];
  choiceResult: ChoiceResult | null;
};

/**
 * 读快照。v1 / v2 的旧快照照样能读（字段是超集），只是丢弃 cards / notice：
 *   - cards 不再可信（见上）；
 *   - notice 是「上一题」的排期回执，恢复它就会在新的一题上显示上一题的结论，
 *     这正是用户报的「绿色框一直挂着、以为是这道题」的由来。
 */
function readSnapshot(): ReviewSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as {
      v?: number;
      savedAt?: number;
      sessionId?: string;
      idx?: number;
      revealed?: boolean;
      selected?: string | string[] | null;
      choiceResult?: { correct?: boolean; picked?: string | string[] } | null;
    };
    if (s.v !== 1 && s.v !== 2 && s.v !== 3) return null;
    if (!s.sessionId || typeof s.idx !== "number" || s.idx < 0) return null;
    const savedAt = typeof s.savedAt === "number" ? s.savedAt : 0;
    if (Date.now() - savedAt > RESUME_TTL_MS) {
      window.sessionStorage.removeItem(RESUME_KEY);
      return null;
    }
    const selected = Array.isArray(s.selected) ? s.selected : s.selected ? [s.selected] : [];
    const cr = s.choiceResult;
    const choiceResult: ChoiceResult | null = cr
      ? {
          correct: !!cr.correct,
          picked: Array.isArray(cr.picked) ? cr.picked : cr.picked ? [cr.picked] : [],
        }
      : null;
    return {
      v: 3,
      savedAt,
      sessionId: s.sessionId,
      idx: s.idx,
      revealed: !!s.revealed,
      selected,
      choiceResult,
    };
  } catch {
    return null;
  }
}

function writeSnapshot(s: Omit<ReviewSnapshot, "v" | "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({ v: 3, savedAt: Date.now(), ...s })
    );
  } catch {
    // 隐私模式 / 存储配额满：跳原文仍可用，只是回来无法还原现场
  }
}

function clearSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* 同上 */
  }
}

/** 由 options 派生：有 2 个及以上选项即视为选择题（与后端 is_choice 同一判定源） */
function hasOptions(c: { options: string[] | null }): boolean {
  return Array.isArray(c.options) && c.options.length >= 2;
}

/** 把 URL / 会话 scope 里的分组字段收窄成 Group，遇到脏值一律当「不分组」 */
function normalizeGroup(v: unknown): Group {
  return v === "due" || v === "new" ? v : null;
}

/** 会话卡在服务端的一行（/api/review 与 /api/review/current 同结构） */
type SessionCardRow = {
  id: string;
  card_id: string;
  sort_order: number;
  /** 这一轮里是否已经评过分 —— 进度的唯一真相 */
  rated?: boolean;
  card_snapshot: {
    front: string;
    back: string;
    kind: string;
    is_choice?: boolean;
    options: string[] | null;
    answer: string | null;
    answers?: string[] | null;
    is_multi?: boolean;
    /** "ai" = 这条答案是 AI 依据知识点补的（原文没给） */
    answer_origin?: string | null;
    /** false = 原文没有依据，AI 用专业知识补的 */
    answer_grounded?: boolean | null;
  };
};

/** 一轮会话的接口载荷 */
type ReviewPayload = {
  /**
   * 池子空（今天已复习）时服务端回 200 + empty。
   * 这不是错误：把它当失败渲染成红色告警，用户会以为进度坏了。
   */
  empty?: boolean;
  message?: string;
  session: { id: string; scope?: Record<string, unknown> | null };
  cards: SessionCardRow[];
  matched?: number;
  origins?: Record<string, CardOrigin>;
};

/**
 * 距离某时刻过了多少毫秒，上限 30 分钟（防止标签页挂一夜后算出天文数字）。
 * 放在模块级而不是组件里：组件体内直接调 Date.now() 会被
 * react-hooks/purity 判成「渲染期调用不纯函数」。
 */
function msSince(startedAt: number): number | null {
  if (!startedAt) return null;
  return Math.max(0, Math.min(Date.now() - startedAt, 30 * 60 * 1000));
}

/**
 * 每题的「错误」入口。
 *
 * 两件事合成一个面板，因为用户发现问题时只有一个念头：「这题不对」。
 * 让他先分清「答案标错了」还是「AI 出题错了」再去找不同入口，等于劝退。
 *
 *   上半：标注正确答案（勾选项 → 立刻改判题口径，并留一条 answer_key_wrong 记录）
 *   下半：上报 AI 出题错误（选题型 + 一句话 → 进台账，监督员按病因聚类）
 *
 * 面板由父组件门控（open），翻到下一题自动收起，不会把上一题的操作带过去。
 */
function IssueBar({
  cardId,
  options,
  correctKeys,
  open,
  kind,
  note,
  busy,
  markBusy,
  markKeys,
  message,
  onToggle,
  onKind,
  onNote,
  onMarkToggle,
  onSaveMark,
  onSubmit,
}: {
  cardId: string;
  textbookId: string | null;
  options: string[];
  correctKeys: number[];
  open: boolean;
  kind: CardErrorKind;
  note: string;
  busy: boolean;
  markBusy: boolean;
  markKeys: number[];
  message: string;
  onToggle: () => void;
  onKind: (k: CardErrorKind) => void;
  onNote: (v: string) => void;
  onMarkToggle: (i: number) => void;
  onSaveMark: () => void;
  onSubmit: () => void;
}) {
  void cardId;
  const reportKinds = ERROR_KINDS.filter((k) => k.key !== "answer_key_wrong");

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        className={`self-end rounded-lg border px-3 py-1.5 text-[12px] transition ${
          open
            ? "border-danger/60 bg-danger/10 text-danger"
            : "border-line text-muted hover:border-danger/40 hover:text-danger"
        }`}
      >
        错误
      </button>

      {open && (
        <div className="rounded-xl border border-line/70 bg-surface-2/30 p-4">
          {message && (
            <div className="mb-3 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">
              {message}
            </div>
          )}

          {options.length >= 2 && (
            <div>
              <div className="text-[12px] font-medium">标注正确答案</div>
              <div className="micro mt-1">
                这题的正确项不对？勾选真正正确的项并保存，之后判题就按它算
                {markKeys.length > 1 ? "（勾多项即视为多选）" : ""}。
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {options.map((opt, i) => {
                  const letter = String.fromCharCode(65 + i);
                  const on = markKeys.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onMarkToggle(i)}
                      className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
                        on
                          ? "border-success bg-success/15 text-success"
                          : "border-line text-muted hover:bg-surface-2"
                      }`}
                      title={opt}
                    >
                      {letter}
                      {on ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={markBusy || markKeys.length === 0}
                  onClick={onSaveMark}
                  className="rounded-lg bg-success/15 px-3 py-1.5 text-[12px] font-medium text-success transition hover:bg-success/25 disabled:opacity-50"
                >
                  {markBusy ? "保存中…" : `保存（${markKeys.length} 项）`}
                </button>
                {correctKeys.length > 0 && (
                  <span className="text-[11px] text-muted">
                    当前标注：{answerLabels(correctKeys)}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className={options.length >= 2 ? "mt-4 border-t border-line/60 pt-3" : ""}>
            <div className="text-[12px] font-medium">这道题本身有问题？</div>
            <div className="micro mt-1">
              记下来会进错误台账，后续复盘 Agent 的监督员会按类型核查并总结。
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {reportKinds.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => onKind(k.key)}
                  title={k.hint}
                  className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
                    kind === k.key
                      ? "border-danger bg-danger/10 text-danger"
                      : "border-line text-muted hover:bg-surface-2"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <input
              value={note}
              onChange={(e) => onNote(e.target.value)}
              placeholder="具体哪里不对（可选，写清楚更好定位）"
              className="mt-2 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[12px] text-fg outline-none placeholder:text-muted/60"
            />
            <button
              type="button"
              disabled={busy}
              onClick={onSubmit}
              className="mt-2 rounded-lg bg-danger/15 px-3 py-1.5 text-[12px] font-medium text-danger transition hover:bg-danger/25 disabled:opacity-60"
            >
              {busy ? "提交中…" : "提交错误记录"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReviewPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cards, setCards] = useState<SessionCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [choiceResult, setChoiceResult] = useState<ChoiceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ rated: number; unrated: number } | null>(null);
  /**
   * 上一次评分的结果提示。
   * 它描述的是「刚才那个动作」，不是「当前这张卡」——所以绝不能和卡片内容一起渲染，
   * 否则会变成「还没作答就先告诉我排期」（旧版就是把它挂在卡片下方的答案区，
   * 上一张卡的排期一直留到下一张卡翻面时才被看见）。
   */
  const [notice, setNotice] = useState<RateNotice | null>(null);
  /**
   * 本次会话「符合条件的总卡数」。正常情况下等于 cards.length；
   * 只有超过服务端单轮上限（1000）才会更大，此时要说明「还有多少张没进来」，
   * 否则用户会以为排期漏卡。
   */
  const [poolMatched, setPoolMatched] = useState(0);
  /** 空池时服务端给的说明（「今天已复习」/「这本书还没有卡片」），不当作错误展示 */
  const [emptyHint, setEmptyHint] = useState<string | null>(null);
  /**
   * 当天所有没刷完的轮次（按书 / 按分组），给选书页写「已答 5/30 · 继续」。
   *
   * 和 bookOptions 的 due 数是两个口径：due 是排期，这里是「这轮刷到第几张」。
   * 用户「A 书刷一半 → 去看别的 → 回 A 书」时，能让进度可见的正是后者。
   */
  const [resumeItems, setResumeItems] = useState<ResumableSession[]>([]);
  /** 续接时那一句「已回到上次的中断处 · 第 6 张 / 共 30 张」；null = 不显示 */
  const [resumeHint, setResumeHint] = useState<string | null>(null);

  // ---- 「返回上一题」----
  // 每道题离开时把现场存下来：用户可以往回翻着核对上一题选的什么、答案是什么，
  // 而不是回去看到一张「还没作答」的空白卡（那等于把刚才那次作答抹掉了）。
  const visited = useRef<Record<number, CardProgress>>({});

  // ---- 「错误」按钮：标注正确答案 / 记录 AI 出题错误 ----
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueCardId, setIssueCardId] = useState<string | null>(null);
  const issueActive = issueCardId === (cards[idx]?.card_id ?? null);
  const [issueKind, setIssueKind] = useState<CardErrorKind>("answer_wrong");
  const [issueNote, setIssueNote] = useState("");
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueMsg, setIssueMsg] = useState("");
  /** 标注正确答案时勾中的下标（预填当前标注，便于「只改一处」） */
  const [markKeys, setMarkKeys] = useState<number[]>([]);
  const [markBusy, setMarkBusy] = useState(false);
  // ---- 「答案不全」修复 ----
  // 用户发现参考答案漏了半句 / 被截断 / 与原文不符时，选原因让 AI 核对原文重生成。
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairReason, setRepairReason] = useState<"missing" | "truncated" | "inaccurate">(
    "truncated"
  );
  const [repairNote, setRepairNote] = useState("");
  /**
   * 是否在「全书正文」里查找答案。
   *
   * 默认只查「这张卡绑定的片段 + 所在章节」——范围小、命中准、也快。
   * 有些书的答案被排到了别的章，复习时看到的就只有半句；这时用户勾上这个开关，
   * 才把整本书的正文都拿出来匹配。
   */
  const [repairFullText, setRepairFullText] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairStartedAt, setRepairStartedAt] = useState<number | null>(null);
  const [repairError, setRepairError] = useState("");
  const [repairResult, setRepairResult] = useState<{
    diagnosis: string;
    points: string[];
    grounded: boolean;
    /** "source" = 用了原文标准答案；"ai" = 原文没有，AI 整理 */
    origin: "source" | "ai";
    /** 检索范围，来自服务端 */
    scope: string | null;
  } | null>(null);

  // 面板只认「打开它的那张卡」：翻到下一张时旧面板/回执自然不显示，
  // 不需要在 effect 里同步 setState（那会触发级联渲染）。
  const currentCardId = cards[idx]?.card_id ?? null;
  const [repairCardId, setRepairCardId] = useState<string | null>(null);
  const repairActive = repairCardId === currentCardId;

  const repairAnswer = useCallback(async () => {
    const target = cards[idx];
    if (!target || repairBusy) return;
    setRepairBusy(true);
    setRepairError("");
    setRepairResult(null);
    setRepairStartedAt(Date.now());
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(target.card_id)}/fix-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: repairReason,
          note: repairNote.trim() || null,
          fullText: repairFullText,
        }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok || json.ok !== true) {
        setRepairError(String(json.error ?? "修复失败，原答案未改动"));
        return;
      }
      const back = String(json.back ?? "");
      const origin = json.origin === "source" ? "source" : "ai";
      setCards((prev) =>
        prev.map((c) =>
          c.card_id === target.card_id
            ? { ...c, back, answer_origin: origin, answer_grounded: json.grounded === true }
            : c
        )
      );
      setRepairResult({
        diagnosis: String(json.diagnosis ?? ""),
        points: Array.isArray(json.knowledge_points)
          ? (json.knowledge_points as unknown[]).map(String)
          : [],
        grounded: json.grounded === true,
        origin,
        scope: typeof json.scope === "string" ? json.scope : null,
      });
      setRepairOpen(false);
    } catch {
      setRepairError("网络异常，请重试；原答案未改动");
    } finally {
      setRepairBusy(false);
      setRepairStartedAt(null);
    }
  }, [cards, idx, repairBusy, repairReason, repairNote, repairFullText]);

  /** 书籍选择：null = 还在拉取；空数组 = 没有书可选；非空 = 展示选择器 */
  const [bookOptions, setBookOptions] = useState<BookOption[] | null>(null);
  /** 当前会话的书籍名（null = 全部材料），只在复习进行中展示 */
  const [sessionBook, setSessionBook] = useState<string | null>(null);
  /** 当前会话只刷哪一组（今天拆成「到期复习」和「新卡」两组） */
  const [group, setGroup] = useState<Group>(null);
  /** 今日拆分统计，用于「全部材料」卡上说清这一轮里两类各有多少 */
  const [stats, setStats] = useState<TodayStatsLite | null>(null);
  /**
   * 当前这张卡「出现在屏幕上」的时刻，用来算真实答题耗时。
   *
   * 以前这里传的是 `Math.round(Math.random() * 3000 + 3000)` —— 假数据。
   * 它会被写进 card_reviews.elapsed_ms，进而污染统计页的「平均单卡耗时」
   * 和首页的「预计总耗时」（后者直接用历史平均 × 待复习数）。
   * 现在改成真实计时：进入一张卡记一次时间，提交评分时取差值。
   */
  const cardShownAt = useRef(0);
  // 幂等键按「会话内的卡」稳定复用：同一张卡在本次会话里无论点多少次评分
  //（正常提交、网络超时后重试）都用同一个键，服务端才能去重。
  // 之前每次点击都随机生成，等于把服务端的幂等护栏彻底架空——
  // 响应丢失后重试会重复记一次复习、重复推进 FSRS 排期。
  // 同步提交锁：setBusy(true) 要等下一次渲染才让按钮 disabled，
  // 极快的双击会漏过去。用它挡住「同一次动作被提交两遍」。
  const submitting = useRef(false);
  /** bookOptions 的同步 ref：URL ?book= 流程里要在 loadBooks 完成后立刻读最新列表 */
  const bookOptionsRef = useRef<BookOption[]>([]);
  /** loadBooks 在 start 之后定义，直接引用会踩 TDZ —— 用 ref 让 start 能回头调用它 */
  const loadBooksRef = useRef<(() => Promise<void>) | null>(null);

  // 每次切到新卡（含开始新一轮会话）重置计时起点
  useEffect(() => {
    cardShownAt.current = Date.now();
  }, [idx, sessionId]);

  // 回执 2.2 秒后自动淡出（见 RateToast）：它说的是「上一题」的排期，
  // 一直挂着会被当成当前这道题的结论 —— 这是用户实报的误读来源。

  /**
   * 把服务端返回的一轮会话灌进页面状态。
   *
   * 三个要点：
   *   1) 卡片列表和「答过没答过」全部以服务端为准（session_card.rated），
   *      客户端不再自己累加 —— 那正是「同一轮复习有两个真相」的来源；
   *   2) 起点 = 第一张没答过的卡；若本地还留着同一会话的快照、且快照指的那张
   *      还没答过，就用快照的位置，保证「去原文再回来」还是刚才那一题；
   *   3) 已答过的卡预置「已翻面」，往回看时直接看到答案，不用再点一次显示答案。
   */
  const applySession = useCallback(
    (data: ReviewPayload, opts?: { preferSnapshot?: boolean }) => {
      const origins = (data.origins ?? {}) as Record<string, CardOrigin>;
      const mapped: SessionCard[] = (data.cards ?? []).map((sc) => {
        const options = sc.card_snapshot?.options ?? null;
        return {
          id: sc.id,
          card_id: sc.card_id,
          sort_order: sc.sort_order,
          front: sc.card_snapshot?.front ?? "",
          back: sc.card_snapshot?.back ?? "",
          kind: sc.card_snapshot?.kind ?? "qa",
          // 旧会话快照没有 is_choice 字段时，用 options 兜底派生
          is_choice: sc.card_snapshot?.is_choice ?? hasOptions({ options }),
          options,
          answer: sc.card_snapshot?.answer ?? null,
          answers: sc.card_snapshot?.answers ?? null,
          is_multi: sc.card_snapshot?.is_multi === true,
          answer_origin: sc.card_snapshot?.answer_origin ?? null,
          answer_grounded: sc.card_snapshot?.answer_grounded ?? null,
          origin: origins[sc.card_id] ?? null,
          rated: sc.rated === true,
        };
      });

      let start = firstUnratedIndex(mapped);
      let state: CardProgress = { revealed: false, picked: [], result: null };
      const snap = opts?.preferSnapshot ? readSnapshot() : null;
      if (
        snap &&
        snap.sessionId === data.session.id &&
        snap.idx < mapped.length &&
        !mapped[snap.idx]?.rated
      ) {
        start = snap.idx;
        state = { revealed: snap.revealed, picked: snap.selected, result: snap.choiceResult };
      }

      // 已答过的题回看时直接给「已翻面」现场，否则往回翻会看到一张空白的题
      const seed: Record<number, CardProgress> = {};
      mapped.forEach((c, i) => {
        if (c.rated) seed[i] = { revealed: true, picked: [], result: null };
      });
      if (start >= 0) seed[start] = state;
      visited.current = seed;

      setCards(mapped);
      setSessionId(data.session.id);
      setPoolMatched(typeof data.matched === "number" ? data.matched : mapped.length);
      setIdx(start >= 0 ? start : Math.max(0, mapped.length - 1));
      setRevealed(state.revealed);
      setSelected(state.picked);
      setChoiceResult(state.result);
      setDone(null);
      // 回执属于上一题，续接时不恢复（快照里也不再存它）
      setNotice(null);
      setError("");

      const scope = (data.session.scope ?? {}) as Record<string, unknown>;
      const scopeBook = typeof scope.textbook_id === "string" ? scope.textbook_id : null;
      setGroup(normalizeGroup(scope.group));
      if (!scopeBook) {
        setSessionBook(null);
      } else {
        // 按书复习的会话没有书名本身，从原文落点里反查（每张卡都指向同一本）
        const hit = Object.values(origins).find((o) => o?.textbook_id === scopeBook);
        setSessionBook(hit?.textbook_title ?? "选中的书");
      }

      /**
       * 断点提示：只有「确实有已复习的题、且还有没复习的」才弹。
       *
       * 位置用 start（页面真正停下的那一张），不用 firstUnratedIndex：
       * 「返回上一题」回看后，第一张未答的可能比停下的位置更靠前，
       * 那时写「第 6 张」而屏幕上是第 9 张，反而自相矛盾。
       */
      const summary = summarizeProgress(mapped);
      if (summary.rated > 0 && summary.remaining > 0 && start >= 0) {
        setResumeHint(resumeHintText({ ...summary, nextIndex: start }));
      } else {
        setResumeHint(null);
      }

      return { allRated: start < 0 };
    },
    []
  );

  /**
   * 拉取「当天没刷完的轮次」——选书页据此展示每本书的断点与「继续」按钮。
   *
   * 不依赖 loadBooks：它只读 /api/review/inprogress，所以能定义在 start 之前，
   * start 的空池分支（今天已复习）可以直接调它刷新列表，不必再套一层 ref。
   */
  const loadResumePoints = useCallback(async () => {
    try {
      const res = await fetch("/api/review/inprogress");
      if (!res.ok) throw new Error("无法读取复习断点");
      const data = await res.json();
      setResumeItems(Array.isArray(data.items) ? (data.items as ResumableSession[]) : []);
    } catch {
      // 断点只是锦上添花：读不到退化成「只有待复习数」，不影响开始复习
      setResumeItems([]);
    }
  }, []);

  /** 收尾一轮：标记完成并拿到「已答 / 未答」统计 */
  const finishSession = useCallback(async (sid: string) => {
    try {
      const res = await fetch("/api/review/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid }),
      });
      const data = await res.json();
      if (res.ok) {
        setDone(data);
        // 完成页要能立刻说「今天还有 N 道答错的可以重做」，
        // 所以统计必须重新拉一次（否则用的是本轮开始时的旧数）
        void loadBooksRef.current?.();
      }
    } catch {
      // 完成失败不影响用户已经提交的评分：下次进来还会命中这一轮
    }
  }, []);

  // start(scope, textbookId, bookTitle, grp)
  //   scope 默认 = 今日到期；'all' = 所有 active 卡
  //   textbookId 限定某一本书
  //   grp = 'due' 只刷学过、按排期到期的；'new' 只学从没学过的新卡
  //
  // 一律带 resume=true：同范围当天没刷完的一轮会被续接，而不是另开一轮。
  // 「再复习一轮」这类入口走的是 scope=all，上一轮已 completed 时自然新建。
  const start = useCallback(
    async (scope?: string, textbookId?: string, bookTitle?: string, grp?: Group) => {
      setBusy(true);
      setError("");
      setNotice(null);
      try {
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // retry = 今天答错、还没答对的题；all = 再复习一轮（全部 active）
            ...(scope === "all" || scope === "retry" ? { scope } : {}),
            ...(textbookId ? { textbookId } : {}),
            ...(grp ? { group: grp } : {}),
            resume: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "无法开始复习");
        if (data.empty) {
          // 今天已经复习过（或这本书还没有卡片）：回到「选一本书」状态，
          // 页面上显示「已复习」，而不是一条红色告警。
          setCards([]);
          setDone(null);
          setSessionId(null);
          setSessionBook(null);
          setGroup(null);
          setEmptyHint(typeof data.message === "string" ? data.message : "已复习");
          setResumeHint(null);
          void loadBooksRef.current?.();
          void loadResumePoints();
          return;
        }
        setEmptyHint(null);
        const { allRated } = applySession(data as ReviewPayload);
        // 用户明确点进来的那本书，书名以点击时看到的为准
        if (textbookId) setSessionBook(bookTitle ?? "选中的书");
        // 「重做今天答错的题」不是某一本书，标题单独给它一句
        else if (scope === "retry") setSessionBook("今天答错的题");
        if (allRated) await finishSession(data.session.id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        setInitializing(false);
      }
    },
    [applySession, finishSession, loadResumePoints]
  );

  /** 拉取各书待复习数，填充书籍选择器 */
  const loadBooks = useCallback(async () => {
    try {
      const res = await fetch("/api/today");
      if (!res.ok) throw new Error("无法载入书籍列表");
      const data = await res.json();
      const books = (data.books as BookOption[]) ?? [];
      bookOptionsRef.current = books;
      setBookOptions(books);
      setStats((data.stats as TodayStatsLite) ?? null);
    } catch {
      bookOptionsRef.current = [];
      setBookOptions([]);
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    loadBooksRef.current = loadBooks;
  }, [loadBooks]);

  /**
   * 回到选书页：书籍列表与断点一起刷新。
   *
   * 必须成对刷新 —— 只刷 due 数不刷断点，用户会看到「刚答了 5 张，列表还是旧的」，
   * 那正是他要修的观感问题。
   */
  const refreshPicker = useCallback(async () => {
    await Promise.all([loadBooks(), loadResumePoints()]);
  }, [loadBooks, loadResumePoints]);

  /**
   * 退回选书页（答题页 / 完成页共用）。
   *
   * 服务端那一轮**不结束**：用户只是想换本书、或先去做别的事，回来要能接着答。
   * 所以这里只清客户端的会话现场 —— 断点由 /api/review/inprogress 提供，
   * 清完刷新一遍，选书页会显示「已答 N · 继续」。
   */
  const backToPicker = useCallback(() => {
    clearSnapshot();
    setSessionId(null);
    setCards([]);
    setDone(null);
    setSessionBook(null);
    setGroup(null);
    setError("");
    setNotice(null);
    // 这两条是「刚才那一轮」的说明/提示，回到选书页还挂着会张冠李戴
    setEmptyHint(null);
    setResumeHint(null);
    void refreshPicker();
  }, [refreshPicker]);

  /**
   * 续接「当天还没刷完」的那一轮。
   * 返回 true = 已经接上（页面直接显示那道没答的题）；false = 没有可续接的轮次。
   *
   * 传 book 时只认这本书的轮次（对应 /api/review/current?book=）：
   * 用户从书详情点进来的是 A 书，就不该被「最近一轮是 B 书」带走。
   */
  const resumeCurrent = useCallback(
    async (book?: string): Promise<boolean> => {
      setBusy(true);
      try {
        const url = book
          ? `/api/review/current?book=${encodeURIComponent(book)}`
          : "/api/review/current";
        const res = await fetch(url);
        if (!res.ok) throw new Error("无法读取复习进度");
        const data = await res.json();
        if (!data.session || !Array.isArray(data.cards) || data.cards.length === 0) return false;
        const { allRated } = applySession(data as ReviewPayload, { preferSnapshot: true });
        if (allRated) await finishSession(data.session.id);
        return true;
      } catch (e) {
        // 续接失败不该把用户卡在空白页：退回选书页，并说明原因
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
        setInitializing(false);
      }
    },
    [applySession, finishSession]
  );

  // 首屏四条路：
  //   ?book=<id>  从书详情 / 原文跳来 → 先续接这本书的轮次，没有才开新的
  //   ?group=…    首页的「只刷到期 / 只学新卡」
  //   其它        先看有没有当天没刷完的一轮，接不上才展示选书页
  //
  // 后两条是修「进度消失」的关键：以前这里直接 loadBooks()，
  // 用户从原文 / 卡片页绕回来，上一轮的进度就像没存在过。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const book = params.get("book");
    const grp = normalizeGroup(params.get("group"));
    if (book) {
      // 首屏挂载即拉数据：这里的 setState 都是异步返回后的，不是渲染期级联，
      // 规则按「effect 里同步调用带 setState 的函数」判，故定向豁免。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadBooks().then(async () => {
        // 先按这本书续接：它可能挂着 mode=all / group=due 的轮次，
        // 只按「due + 该书」去 start 会错过，用户看到的就是「进度没了」。
        const resumed = await resumeCurrent(book);
        if (resumed) {
          // 书名以点击进去那本书为准（会话里只有 id）
          const opt = bookOptionsRef.current.find((b) => b.id === book);
          if (opt) setSessionBook(opt.title);
          return;
        }
        const opt = bookOptionsRef.current.find((b) => b.id === book);
        void start(undefined, book, opt?.title, grp);
      });
      return;
    }
    if (grp) {
      void loadBooks();
      void loadResumePoints();
      void start(undefined, undefined, undefined, grp);
      return;
    }
    void loadBooks();
    void loadResumePoints();
    void resumeCurrent();
  }, [start, loadBooks, loadResumePoints, resumeCurrent]);

  /**
   * 切到第 n 题：有历史进度就还原，没有就重置成未作答。
   * 统一入口的意义在于「返回上一题 → 重答 → 再下一题」时不会把刚才的作答抹掉，
   * 也不会因为某条分支忘了重置而把上一题的选项带到这一题。
   */
  function showCard(next: number) {
    const saved = visited.current[next];
    setIdx(next);
    setRevealed(saved?.revealed ?? false);
    setSelected(saved?.picked ?? []);
    setChoiceResult(saved?.result ?? null);
    // 注意：这里不能清 notice。rate() 是「先拿到 next_due 写 notice，再切下一题」，
    // 切题时顺手清掉，排期回执就永远看不到（改这一行前请先读 rate 的调用顺序）。
    setIssueMsg("");
    // 断点提示例外：它说的是「你回到了哪里」，一旦开始翻页 / 答题就已经自证，
    // 再挂着只会占一行（与回执不同，回执是结论，这条是位置说明）
    setResumeHint(null);
  }

  // 提交评分；requeueOnAgain 表示「没想起来」时把该卡追加到本轮末尾重新复习
  // label 只在选择题里传（「答对了 / 答错了」），四档自评用默认档位名
  async function rate(rating: number, requeueOnAgain = true, label?: string) {
    if (!sessionId || idx >= cards.length) return;
    if (submitting.current) return;
    submitting.current = true;
    const card = cards[idx];
    // 离开这题前先记现场：「返回上一题」看到的应该是刚才那次作答，不是空白卡
    visited.current[idx] = { revealed, picked: selected, result: choiceResult };
    setBusy(true);
    setError(""); // 上一轮失败的红色提示不该在重试成功后继续挂在页顶
    setNotice(null); // 这是一次新的作答，旧的排期提示立刻作废
    try {
      const res = await fetch("/api/review/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card_id: card.card_id,
          rating,
          session_id: sessionId,
          session_card_id: card.id,
          // 每次发起评分都生成新键：键绑定的是「这一次作答动作」，不是卡片。
          // 早期按 card.id 缓存键，导致「没想起来」把同一张卡 requeue 回队列后，
          // 第二次评分命中幂等去重被丢弃，FSRS 永远不推进 —— 用户再练几次都没用。
          // 网络层重试由同一个请求体天然复用；双击由 submitting 同步锁挡住。
          // 不能用 crypto.randomUUID()：手机走 http://192.168.x.x 是非安全上下文，
          // 该 API 为 undefined，评分请求会在发出前就抛错（整页卡在原题上）。
          idempotency_key: uuid(),
          elapsed_ms: msSince(cardShownAt.current),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "评分失败");
      // 排期只在服务端确认落库之后才敢显示 —— 这也是「点完才出现」的保证：
      // 拿不到 next_due 就不编一个给用户看。
      if (data.next_due) {
        setNotice({
          rating,
          dueAt: String(data.next_due),
          mastered: Boolean(data.mastered),
          label,
        });
      }
      // 每答一题就刷新一次服务端数据：否则返回首页/统计页时，Next 的客户端路由缓存
      // 会拿旧的 RSC 快照，用户看到「题数没变」。
      router.refresh();

      // 本地立刻把这张标成「已作答」：进度的真相在服务端，但界面不能等下一轮
      // 请求回来才更新，否则「下一题」还按旧数组算，可能又跳回这道题。
      const marked: SessionCard[] = cards.map((c) =>
        c.id === card.id ? { ...c, rated: true } : c
      );

      // 「没想起来」(Again=1) → 把该卡追加到本轮末尾重新复习。
      // 末尾这份是**新的一次作答**，rated 必须重置，否则会被跳号逻辑直接跳过。
      if (rating === 1 && requeueOnAgain) {
        const next: SessionCard[] = [...marked, { ...card, rated: false }];
        setCards(next);
        const go = nextUnratedIndex(next, idx + 1);
        showCard(go >= 0 ? go : next.length - 1);
        setBusy(false);
        return;
      }

      setCards(marked);
      // 从下一张开始找「还没答过的」：上一题回看时顺手重答过的卡不该再被推一遍
      const go = nextUnratedIndex(marked, idx + 1);
      if (go < 0) {
        await finishSession(sessionId);
      } else {
        showCard(go);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  /**
   * 返回上一题。
   *
   * 三件事：
   *   1) 先把当前这题的现场存下来（不然往回一次再往前，刚做的题就白了）；
   *   2) 还原上一题离开时的状态（选中项 / 是否翻面 / 判题结果）；
   *   3) 收起排期回执 —— 那是「刚才那道题」的结论，回到上一题后继续挂着会张冠李戴。
   *
   * 不重新请求服务端：这一轮的卡片和评分都已在本地，回退只是换下标。
   * 也不改 cardShownAt 之外的东西 —— 复习耗时按「重新看到这题」重新计时。
   */
  function goPrev() {
    if (idx <= 0 || busy) return;
    visited.current[idx] = { revealed, picked: selected, result: choiceResult };
    const prev = idx - 1;
    const saved = visited.current[prev];
    setIdx(prev);
    setRevealed(saved?.revealed ?? false);
    setSelected(saved?.picked ?? []);
    setChoiceResult(saved?.result ?? null);
    setNotice(null);
    setIssueMsg("");
  }

  /**
   * 跳去原文查这道题的依据。
   *
   * 两件事必须在跳转前做完：
   *  1) 把「停在哪一题 + 当时的作答现场」写进快照（不再存整份卡片列表）；
   *  2) 用 replaceState 把当前地址改成 ?resume=1 —— 这样即使用户按的是
   *     浏览器返回键（没走页面上的按钮），回来的也是可恢复的地址。
   *     Next App Router 允许原生 history API，replaceState 不会触发 RSC 重渲染。
   *
   * 回来时卡片列表与 rated 会重新问服务端：即使中途在别的页面里答了题，
   * 也不会被这份快照带回一张已经答过的题上。
   */
  function goToSource() {
    const current = cards[idx];
    if (!sessionId || !current?.origin) return;
    writeSnapshot({ sessionId, idx, revealed, selected, choiceResult });
    window.history.replaceState(window.history.state, "", "/review?resume=1");
    router.push(originReadHref(current.origin, current.card_id));
  }

  // 首帧还在拉取会话时不要先闪一下「今天没有待复习的卡片」
  if (initializing) {
    return <div className="text-muted">正在载入今日卡片…</div>;
  }

  if (done) {
    const retryCount = stats?.retry_count ?? 0;
    return (
      <div className={`flex flex-col gap-7 ${notice ? "pb-24" : ""}`}>
        {/* 完成页同样要能退回选书页：不是每个人都想「回到今日任务」，
            有的人是想换一本书继续刷 */}
        <div className="flex flex-col gap-2.5">
          <BackLink label="返回选书" onClick={backToPicker} />
          <PageHeader title="本轮完成" />
        </div>
        <div className="card flex items-center gap-6 p-5 md:p-6">
          <div>
            <div className="metric text-4xl text-success">{done.rated}</div>
            <div className="micro mt-2">已作答</div>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <div className="metric text-4xl text-warning">{done.unrated}</div>
            <div className="micro mt-2">未完成 · 会再次进入队列</div>
          </div>
        </div>

        {/* 答错的题当天必须能重做。
            以前这一页只有「回到今日任务 / 再选一本书」，而答错的卡到期被压到
            10 分钟后，选书页那边又是「已复习」——用户点完「没想起来」就再也
            见不到这道题，只能等第二天。这里把它做成主入口。 */}
        {retryCount > 0 && (
          <section className="card flex items-center justify-between gap-4 border-warning/30 p-4 md:p-5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-warning">今天答错 {retryCount} 道</div>
              <div className="micro mt-1">答错的题当天可以反复重做，直到答对为止</div>
            </div>
            <button className="btn-primary btn-sm shrink-0 px-4" onClick={() => start("retry")}>
              重做这些题
            </button>
          </section>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary btn-sm px-4"
            onClick={() => {
              router.refresh();
              router.push("/");
            }}
          >
            回到今日任务
          </button>
          <button className="btn-ghost btn-sm px-4" onClick={backToPicker}>
            再选一本书
          </button>
          <button className="btn-ghost btn-sm px-4" onClick={() => start("all")}>
            再复习一轮
          </button>
        </div>
        {notice && <RateToast notice={notice} onClose={() => setNotice(null)} />}
      </div>
    );
  }

  if (cards.length === 0 && !busy && !error) {
    const totalDue = (bookOptions ?? []).reduce((a, b) => a + b.due, 0);
    // 今天答错、还没答对的题：与「到期」分开算 —— 答错后到期被压到 10 分钟后，
    // 这段时间里它不在任何到期池中，但用户明确期待「当天还能再考一次」。
    const retryTotal = (bookOptions ?? []).reduce((a, b) => a + (b.retry ?? 0), 0);
    // 全部材料的待复习量按来源拆开：到期复习 / 新卡。
    // 两个数相加就是 totalDue，所以只在「两类都有」时才需要展示拆解。
    const dueReview = stats ? stats.review_count + stats.relearn_count : 0;
    const newCount = stats?.new_count ?? 0;
    const bothGroups = dueReview > 0 && newCount > 0;
    /**
     * 这本书有没有没刷完的一轮。
     *
     * 注意「待复习数」和「断点」是两个口径：due=0 只说明今天到期都答完了，
     * 可能仍有一轮 mode=all / 别的分组停在半路 —— 那种情况也要能点「继续」，
     * 否则用户会觉得进度又没了。所以按 scope.textbook_id 找，不看 due。
     */
    const resumeFor = (bookId: string | null) =>
      resumeItems.find((it) => (it.scope.textbook_id ?? null) === bookId) ?? null;
    const allResume = resumeFor(null);
    return (
      <div className="flex flex-col gap-7">
        {/* 选书页也是「某一层」：从今日任务点进来的人，要能原路退回去 */}
        <div className="flex flex-col gap-2.5">
          <BackLink label="返回今日任务" onClick={() => router.push("/")} />
          <PageHeader title="开始复习" sub="选一本书，只复习它的到期卡片" />
        </div>

        {bookOptions && bookOptions.length > 0 ? (
          <>
            {/*
             * 「全部材料」原来是列表里第一个同样大小的行，
             * 和下面每本书长得一模一样，看不出它是默认选项。
             * 现在单独提成一张卡，成为这一页唯一的主按钮。
             */}
            <section className="card flex items-center justify-between gap-4 p-4 md:p-5">
              <div className="min-w-0">
                <div className="text-sm font-medium">全部材料</div>
                <div className="micro mt-1">
                  {allResume ? (
                    <span className="text-accent">
                      {resumeBadgeText(allResume)} · 接着上次继续
                    </span>
                  ) : bothGroups ? (
                    `到期复习 ${dueReview} · 新卡 ${newCount}`
                  ) : dueReview > 0 ? (
                    `${totalDue} 张待复习 · 都是按排期到期的`
                  ) : (
                    `${totalDue} 张待复习 · 都是新卡`
                  )}
                </div>
                {retryTotal > 0 && (
                  <div className="micro mt-1 text-warning">
                    今天答错 {retryTotal} 道还没答对
                    {/* 有到期卡时主按钮去刷到期，错题就必须自己有一个能点的入口 ——
                        不然这行字写着「可以马上重做」，用户却在卡里找不到按钮 */}
                    {totalDue === 0 ? " · 可以马上重做" : " · 也可以先重做这些"}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* 到期与错题同时存在：主入口仍是「开始复习」，错题降级成次按钮 */}
                {retryTotal > 0 && totalDue > 0 && (
                  <button
                    className="btn-ghost btn-sm px-3 text-warning"
                    onClick={() => start("retry")}
                  >
                    重做答错的 {retryTotal} 道
                  </button>
                )}
                <button
                  className="btn-primary btn-sm shrink-0 px-4"
                  onClick={() =>
                    allResume
                      ? start(allResume.scope.mode, undefined, undefined, allResume.scope.group)
                      : totalDue > 0
                        ? start()
                        : start("retry")
                  }
                  disabled={totalDue === 0 && retryTotal === 0 && !allResume}
                >
                  {allResume
                    ? "继续复习"
                    : totalDue === 0 && retryTotal > 0
                      ? `重做答错的 ${retryTotal} 道`
                      : totalDue === 0
                        ? "已复习"
                        : "开始复习"}
                </button>
              </div>
            </section>

            {/* 两类都有时给出分开刷的入口，回首页那条链接是同一套语义 */}
            {bothGroups && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn-ghost btn-sm px-3"
                  onClick={() => start(undefined, undefined, undefined, "due")}
                >
                  只刷到期复习 {dueReview} 张
                </button>
                <button
                  className="btn-ghost btn-sm px-3"
                  onClick={() => start(undefined, undefined, undefined, "new")}
                >
                  只学新卡 {newCount} 张
                </button>
              </div>
            )}

            {/*
             * 原来每本书都配一个「开始复习 →」——窄屏时按钮被压到两行，
             * 文字断成「开始复习 / →」，而且 0 张到期的书同样占一整行一个按钮。
             * 现在：数量在前、按钮固定宽度且不断行，0 张的直接降级成灰字。
             */}
            <section className="flex flex-col gap-1">
              <h2 className="section-label mb-1">按书籍</h2>
              <div className="flex flex-col">
                {bookOptions.map((b) => {
                  const rs = resumeFor(b.id);
                  return (
                    <div key={b.id} className="row">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{b.title}</div>
                        {(b.retry ?? 0) > 0 && (
                          <div className="micro mt-0.5 text-warning">
                            今天答错 {b.retry} 道待重做
                          </div>
                        )}
                        {rs && (
                          <div className="mt-0.5">
                            <ResumeHintLine item={rs} />
                          </div>
                        )}
                      </div>
                      <span
                        className={`w-10 shrink-0 text-right text-xs tabular-nums ${
                          b.due > 0 ? "text-muted" : "text-muted/40"
                        }`}
                      >
                        {b.due}
                      </span>
                      <span className="w-14 shrink-0 text-right">
                        {rs ? (
                          /* 有断点时「继续」优先于「复习」：同一本书可能 due=0
                             但仍有一轮归在别的分组里没刷完 */
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() =>
                              start(
                                rs.scope.mode,
                                b.id,
                                b.title,
                                rs.scope.group
                              )
                            }
                          >
                            继续
                          </button>
                        ) : b.due > 0 ? (
                          <button
                            className="btn-ghost btn-sm"
                            onClick={() => start(undefined, b.id, b.title)}
                          >
                            复习
                          </button>
                        ) : (b.retry ?? 0) > 0 ? (
                          /* 到期是 0，但今天答错过 —— 直接给「重做」，别让用户等第二天 */
                          <button
                            className="btn-ghost btn-sm text-warning"
                            onClick={() => start("retry", b.id, b.title)}
                          >
                            重做
                          </button>
                        ) : (
                          /* 「0 张待复习」是排期的内部状态，直接写出来用户会读成
                             「这书是不是有问题」。统一说人话：今天这书的卡都复习过了。 */
                          <span className="text-[11px] text-muted/60">{reviewedLabel(b.due)}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <button
              className="self-start text-xs text-muted transition hover:text-fg"
              onClick={() => start("all")}
            >
              复习全部卡片（含未到期，再过一轮）→
            </button>
          </>
        ) : (
          <div className="card px-6 py-10 text-center text-sm text-muted">
            {bookOptions
              ? (emptyHint ?? "今天已复习，选一本书可以再过一轮。")
              : "正在载入书籍列表…"}
            {bookOptions && (
              <button className="btn-primary btn-sm mt-4 block w-full" onClick={() => start("all")}>
                复习全部卡片
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const card = cards[idx];
  // 复习形式完全由卡片类型决定，不再让用户手动切换：
  //   is_choice = true（有选项）→ 直接展示 A/B/C/D 作答
  //   is_choice = false（无选项）→ 展示「显示答案」翻面 + 四档自评
  const isChoice = card ? card.is_choice || hasOptions(card) : false;
  const answered = !!choiceResult;
  const origin = card?.origin ?? null;

  /*
   * 多选题判定与正确答案下标。
   *
   * multi 有三个来源，按可靠度取：answers 数组（多选全文）> is_multi 标记 >
   * answer 文本里能解析出多个键（旧数据里 "A、C" 就属于这种）。
   * 缺了这一层兜底，多选卡会退化成单选：点第二个选项就把第一个顶掉，
   * 用户永远选不全，判题必然错。
   */
  const cardOptions = card?.options ?? [];
  const correctKeys = card ? correctKeysOf(card) : [];
  const multi =
    (Array.isArray(card?.answers) && card.answers.length > 1) ||
    card?.is_multi === true ||
    correctKeys.length > 1;
  /** 正确答案的展示形态：多选给字母（选项太长），单选给全文 */
  const answerDisplay = multi ? answerLabels(correctKeys) : (card?.answer ?? "");

  return (
    <div className={`flex flex-col gap-6 ${notice ? "pb-24" : ""}`}>
      {/*
       * 头部两层：
       *   第一层是「去哪」—— 返回选书页。它属于导航，和下面是两回事；
       *   第二层是「这一轮到哪了」+ 站内的翻页动作（上一题）。
       * 早先只有一个「换一本书」的小胶囊混在右上角的动作里，从名字看不出
       * 它是返回，用户会以为这页没有退出的路。
       */}
      <header className="flex flex-col gap-2.5">
        <BackLink label="返回选书" onClick={backToPicker} />
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h1 className="page-title truncate">
              {sessionBook ?? (group === "due" ? "到期复习" : group === "new" ? "新卡" : "复习")}
            </h1>
            <span className="micro shrink-0 tabular-nums">
              {idx + 1} / {cards.length}
              {/* 续接上来时把「已经答了几题」明写出来：只给「6 / 8」，
                  用户不知道前面 5 题是不是自己答的，观感上就等于「进度没了」 */}
              {ratedCount(cards) > 0 && (
                <span className="ml-1.5 text-muted/70">· 已答 {ratedCount(cards)}</span>
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 翻页动作留在标题行：它是「在当前这一轮里往回看」，
                和「返回选书」这种改变范围的动作不是一类 */}
            <button
              className="chip bg-surface-2 text-muted transition enabled:hover:text-fg disabled:opacity-40"
              disabled={idx === 0 || busy}
              onClick={goPrev}
              title={idx === 0 ? "已经是第一题" : "回到上一题（保留刚才的选择）"}
            >
              ← 上一题
            </button>
            {card && (
              <span className="chip hidden bg-surface-2 text-[11px] text-muted md:inline-flex">
                {isChoice ? (multi ? "多选题" : "选择题") : "问答卡"}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* 进度条：一眼看清「已完成 / 待复习」各多少（与上方「第几张」互补） */}
      <SessionProgressBar total={cards.length} rated={ratedCount(cards)} />

      {resumeHint && <ResumeHint text={resumeHint} onClose={() => setResumeHint(null)} />}

      {error && <div className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}

      {poolMatched > cards.length && (
        <div className="rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">
          本次只拉入 {cards.length} 张，还有 {poolMatched - cards.length} 张没进这一轮；刷完再点一次「开始复习」会接着拉。
        </div>
      )}

      {card && (
        <div className="flex flex-col gap-5">
          {/* 题干：带「题目」小标题。两张卡外观完全一样时，翻面后只有字号
              差 2px，很容易把答案看成题干的续写；贴上标签就能一眼分清。 */}
          <div className="card p-4 md:p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="block-cap">题目</div>
              {/* 回看已答的题时明确标出来，否则它与「还没答的题」长得一样，
                  用户会以为被打回原点了 */}
              {card.rated && (
                <span className="chip shrink-0 bg-success/10 text-[11px] text-success">已复习</span>
              )}
            </div>
            <div className="text-lg font-medium leading-relaxed">
              <EnumeratedText text={card.front} />
            </div>
          </div>

          {/*
           * 「去原文查依据」常驻在题干下方：不会做、翻完面、答错时都能点。
           * 选择题答错后文案会点明用途，避免用户还要找按钮。
           * 返回时用 sessionStorage 快照还原到这同一张卡（见 goToSource）。
           */}
          {origin ? (
            <button
              type="button"
              onClick={goToSource}
              className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition hover:bg-surface-2 ${
                answered && !choiceResult?.correct
                  ? "border-danger/45 bg-danger/[0.06]"
                  : "border-border/70 bg-surface-2/30"
              }`}
            >
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-fg/90">
                  {answered && !choiceResult?.correct
                    ? "答错了 · 去原文找依据 →"
                    : "去原文查依据 →"}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  《{origin.textbook_title}》·{" "}
                  {origin.via === "book" ? "打开全书" : "定位到对应段落"}
                </span>
              </span>
              <span className="chip shrink-0 bg-surface-2 text-[11px] text-muted">看原文</span>
            </button>
          ) : (
            <div className="text-[11px] text-muted/50">这张卡暂未关联原文，无法跳转查看。</div>
          )}

          {isChoice ? (
            /* ---- 选择题：单选点一个，多选勾多个 ---- */
            <div className="flex flex-col gap-3">
              {multi && !answered && (
                <div className="rounded-xl bg-accent/[0.07] px-4 py-3 text-[12px] leading-relaxed text-accent">
                  多选题：选齐全部正确项再提交（少选、多选都算错）。
                </div>
              )}
              {correctKeys.length === 0 && !answered && (
                <div className="rounded-xl bg-warning/10 px-4 py-3 text-[12px] leading-relaxed text-warning">
                  这道题还没标注正确答案，暂时无法判题。点下方「错误」把正确项标出来，之后一直有效。
                </div>
              )}

              {cardOptions.map((opt, i) => {
                const letter = String.fromCharCode(65 + i);
                const isSel = selected.includes(opt);
                const isAnswer = correctKeys.includes(i);
                // 作答后：正确项绿、选错的项红（多选里可能同时有多项标红）
                const stateClass = answered
                  ? isAnswer
                    ? "border-success bg-success/10 text-success"
                    : isSel
                      ? "border-danger bg-danger/10 text-danger"
                      : "opacity-60"
                  : isSel
                    ? "border-accent bg-accent/10"
                    : "";
                return (
                  <button
                    key={i}
                    className={`card flex flex-wrap items-center gap-2.5 p-3.5 text-left transition hover:-translate-y-0.5 ${stateClass}`}
                    disabled={busy || answered}
                    aria-pressed={isSel}
                    onClick={() => {
                      // 开始答下一题 → 上一次的回执自动收起，屏幕只留当前这张卡
                      setNotice(null);
                      setResumeHint(null);
                      setSelected((prev) => {
                        if (!multi) return prev.includes(opt) ? [] : [opt];
                        return prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt];
                      });
                    }}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center bg-surface-2 text-sm font-medium ${
                        // 多选给方框（勾选语义），单选给圆点（互斥语义）——形状本身就是提示
                        multi ? "rounded-md" : "rounded-full"
                      } ${isSel && !answered ? "ring-2 ring-accent" : ""}`}
                    >
                      {letter}
                    </span>
                    <span className="min-w-0 flex-1 text-base break-words">{opt}</span>
                    {!answered && isSel && multi && (
                      <span className="shrink-0 text-[11px] whitespace-nowrap text-accent">已选</span>
                    )}
                    {answered && isAnswer && (
                      <span className="shrink-0 text-xs whitespace-nowrap">正确答案</span>
                    )}
                    {answered && isAnswer && card.answer_origin === "ai" && (
                      /* 窄屏上让徽标独占一行，避免把选项文字挤成一字宽 */
                      <span className="w-full pl-10">
                        <AnswerSourceNote
                          origin={card.answer_origin}
                          grounded={card.answer_grounded}
                        />
                      </span>
                    )}
                  </button>
                );
              })}

              {answered && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm ${
                    choiceResult!.correct
                      ? "bg-success/10 text-success"
                      : "bg-danger/10 text-danger"
                  }`}
                >
                  <div>
                    {choiceResult!.correct
                      ? multi
                        ? `回答正确（${answerDisplay} 全选对）`
                        : "回答正确"
                      : `回答错误，正确答案是「${answerDisplay}」`}
                  </div>
                  {/* 答错时视线和手指都在这条提示上，把「去原文」放到拇指边，
                      不用再往上滚回题干下方找按钮 */}
                  {!choiceResult!.correct && origin && (
                    <button
                      type="button"
                      onClick={goToSource}
                      className="mt-2.5 inline-flex items-center gap-1 rounded-lg border border-danger/40 px-3 py-1.5 text-[13px] font-medium text-danger transition hover:bg-danger/10"
                    >
                      去原文看这个知识点 →
                    </button>
                  )}
                </div>
              )}

              {!answered ? (
                <button
                  className="btn-primary py-3"
                  disabled={busy || selected.length === 0 || correctKeys.length === 0}
                  onClick={() => {
                    if (selected.length === 0) return;
                    const pickedIdx = selected
                      .map((t) => cardOptions.indexOf(t))
                      .filter((i) => i >= 0);
                    setChoiceResult({
                      // 判题与「哪些项高亮为正确答案」共用 correctKeys，单选用同一套集合比较
                      // （1 对 1）也不会错，多选则要求集合完全相等
                      correct: judgeSelection(pickedIdx, correctKeys),
                      picked: selected,
                    });
                  }}
                >
                  {multi ? `提交答案（已选 ${selected.length} 项）` : "提交答案"}
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    className="btn-ghost flex-1 py-3"
                    disabled={busy || idx === 0}
                    onClick={goPrev}
                  >
                    ← 上一题
                  </button>
                  <button
                    className="btn-primary flex-[2] py-3"
                    disabled={busy}
                    onClick={() => {
                      const correct = choiceResult!.correct;
                      // 选择题没有四档自评，回执直接说「答对了 / 答错了」，
                      // 否则会出现「你选了 B，回执写着『正常想起』」的错位感
                      void rate(correct ? 3 : 1, true, correct ? "答对了" : "答错了");
                    }}
                  >
                    {busy ? "提交中…" : "下一题 →"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* ---- 问答卡：翻面自评 ---- */
            <>
              {!revealed ? (
                <button
                  className="btn-primary py-4"
                  onClick={() => {
                    setNotice(null); // 开始答下一题，收掉上一次的回执
                    setResumeHint(null); // 已经开始作答，断点位置说明不再需要
                    setRevealed(true);
                  }}
                  disabled={busy}
                >
                  显示答案
                </button>
              ) : (
                <>
                  <div className="card p-4 md:p-6">
                    <div className="block-cap">参考答案</div>
                    {/* 答案正文：表格/清单会渲染成真正的结构，普通段落仍按分号断行；
                        来源标注挂在最后一行末尾，尺寸压到 11px 灰字。用 div 而不是 p：
                        表格不能嵌在段落里（HTML 不允许，React 会报 hydration 错） */}
                    <div className="break-words text-base leading-relaxed text-fg/90">
                      <AnswerText
                        text={card.back ?? ""}
                        trailing={
                          <AnswerSourceNote
                            origin={card.answer_origin}
                            grounded={card.answer_grounded}
                            className="ml-1.5 align-[1px]"
                          />
                        }
                      />
                    </div>

                    {/* 答案不全：选原因 → AI 检索该段落知识点 → 重生成完整答案并留痕 */}
                    <div className="mt-5 border-t border-line/50 pt-4">
                      <button
                        type="button"
                        disabled={repairBusy}
                        onClick={() => {
                          setRepairCardId(currentCardId);
                          setRepairOpen((v) => !v);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-60"
                      >
                        答案不全？让 AI 补全
                      </button>

                      {repairActive && repairOpen && (
                        <div className="mt-3 rounded-xl border border-line/60 bg-surface-2/40 p-4">
                          <div className="micro mb-2">哪里不全？</div>
                          <div className="flex flex-wrap gap-2">
                            {(
                              [
                                ["missing", "答案缺失"],
                                ["truncated", "答案截断"],
                                ["inaccurate", "答案不准"],
                              ] as const
                            ).map(([key, label]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => setRepairReason(key)}
                                className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
                                  repairReason === key
                                    ? "border-accent bg-accent/10 text-fg"
                                    : "border-line text-muted hover:bg-surface-2"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <input
                            value={repairNote}
                            onChange={(e) => setRepairNote(e.target.value)}
                            placeholder="补充说明（可选）"
                            className="mt-3 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[12px] text-fg outline-none placeholder:text-muted/60"
                          />

                          {/* 检索范围开关：默认只查这张卡的片段 + 所在章节。
                              有些书的答案被排到别的章，勾上才扫全书正文。 */}
                          <button
                            type="button"
                            onClick={() => setRepairFullText((v) => !v)}
                            className={`mt-3 flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[12px] transition ${
                              repairFullText
                                ? "border-accent bg-accent/10 text-fg"
                                : "border-line text-muted hover:bg-surface-2"
                            }`}
                            aria-pressed={repairFullText}
                          >
                            <span
                              className={`mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                repairFullText
                                  ? "border-accent bg-accent text-white"
                                  : "border-line"
                              }`}
                            >
                              {repairFullText ? "✓" : ""}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="font-medium">在全书正文中查找</span>
                              <span className="mt-0.5 block text-muted">
                                默认只查这道题所在的章节；勾上后扫描整本书，并优先采用原文里的答案
                              </span>
                            </span>
                          </button>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={repairBusy}
                              onClick={() => void repairAnswer()}
                              className="btn-primary px-4 py-2 text-[12px] disabled:opacity-60"
                            >
                              {repairFullText ? "在全书里查找答案" : "重新生成完整答案"}
                            </button>
                            <button
                              type="button"
                              disabled={repairBusy}
                              onClick={() => setRepairOpen(false)}
                              className="rounded-lg border border-line px-4 py-2 text-[12px] text-muted hover:bg-surface-2"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}

                      {repairActive && repairBusy && (
                        <AiProgress
                          startedAt={repairStartedAt}
                          percent={null}
                          phase={repairFullText ? "检索全书正文" : "检索原文并分析知识点"}
                          status="running"
                          note={
                            repairFullText
                              ? "正在整本书里找这道题的答案，找到就直接采用原文"
                              : "先在这道题所在章节找原文答案，找不到才让 AI 整理"
                          }
                          className="mt-3"
                        />
                      )}
                      {repairActive && repairError && (
                        <div className="mt-3 text-[12px] text-warning">{repairError}</div>
                      )}
                      {repairActive && repairResult && (
                        <div className="mt-3 rounded-xl border border-line/60 p-3 text-[12px] leading-relaxed">
                          <div className="font-medium text-fg">
                            {repairResult.origin === "source"
                              ? "已采用原文答案"
                              : repairResult.grounded
                                ? "原文没给完整答案 · 已由 AI 依据原文整理"
                                : "原文没给答案 · 已由 AI 补充，建议核对"}
                            {repairResult.origin === "source" && repairResult.scope && (
                              <span className="ml-1 font-normal text-muted">
                                （来自
                                {repairResult.scope === "card"
                                  ? "本题出处段落"
                                  : repairResult.scope === "chapter"
                                    ? "所在章节"
                                    : "全书正文"}
                                ）
                              </span>
                            )}
                          </div>
                          {repairResult.origin === "ai" && repairResult.grounded && (
                            <div className="mt-1 text-muted">
                              原文里的答案不完整，以上是 AI 按原文整理的版本；可勾「在全书正文中查找」再试一次。
                            </div>
                          )}
                          {repairResult.diagnosis && (
                            <div className="mt-1 text-muted">{repairResult.diagnosis}</div>
                          )}
                          {repairResult.points.length > 0 && (
                            <div className="mt-1 text-muted">
                              涉及知识点：{repairResult.points.join("、")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 这里以前挂过「已排期，下次到期 …」——但它属于上一张卡，
                      翻到这张卡并展开答案时会先看到一条与本次作答无关的日期。
                      排期提示已移到页面顶部的评分回执里。 */}
                  <div className="micro">回忆得怎么样？自评一下：</div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {RATINGS.map((r) => (
                      <button
                        key={r.key}
                        className={`card flex flex-col gap-1 p-4 transition hover:-translate-y-0.5 ${r.color}`}
                        disabled={busy}
                        onClick={() => rate(r.key, true)}
                      >
                        <div className="font-medium">{r.label}</div>
                        <div className="text-[11px] opacity-70">{r.hint}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* 问答卡的「上一题」：翻面/未翻面都能用，手指在屏幕下方时不用往上滚 */}
              <button
                className="btn-ghost w-full py-2.5 text-sm"
                disabled={busy || idx === 0}
                onClick={goPrev}
              >
                ← 上一题
              </button>
            </>
          )}

          {/* ---- 每题都有的「错误」入口：标注正确答案 + 记录 AI 出题错误 ---- */}
          <IssueBar
            cardId={card.card_id}
            textbookId={origin?.textbook_id ?? null}
            options={cardOptions}
            correctKeys={correctKeys}
            open={issueActive && issueOpen}
            kind={issueKind}
            note={issueNote}
            busy={issueBusy}
            markBusy={markBusy}
            markKeys={markKeys}
            message={issueActive ? issueMsg : ""}
            onToggle={() => {
              setIssueCardId(card.card_id);
              setIssueOpen((v) => !(issueActive && v));
              setIssueMsg("");
              // 预填当前标注：用户多半只改其中一项，不用从零勾
              setMarkKeys(correctKeys);
            }}
            onKind={setIssueKind}
            onNote={setIssueNote}
            onMarkToggle={(i) =>
              setMarkKeys((prev) =>
                prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b)
              )
            }
            onSaveMark={async () => {
              if (markKeys.length === 0 || markBusy) return;
              setMarkBusy(true);
              setIssueMsg("");
              try {
                const res = await fetch(
                  `/api/cards/${encodeURIComponent(card.card_id)}/answer-key`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ keys: markKeys }),
                  }
                );
                const json = (await res.json()) as Record<string, unknown>;
                if (!res.ok || json.ok !== true) {
                  setIssueMsg(String(json.error ?? "保存失败"));
                  return;
                }
                // 本地卡片同步更新：判题口径立刻生效，不必等下一次拉会话
                setCards((prev) =>
                  prev.map((c) =>
                    c.card_id === card.card_id
                      ? {
                          ...c,
                          answer: (json.answer as string | null) ?? c.answer,
                          answers: (json.answers as string[] | null) ?? null,
                          is_multi: json.is_multi === true,
                        }
                      : c
                  )
                );
                // 已经作答过的，判题结果按新答案键重算，否则界面还挂着「答错」
                if (choiceResult) {
                  const pickedIdx = selected
                    .map((t) => cardOptions.indexOf(t))
                    .filter((i) => i >= 0);
                  setChoiceResult({
                    correct: judgeSelection(pickedIdx, markKeys),
                    picked: selected,
                  });
                }
                setIssueMsg(
                  `已保存为${markKeys.length > 1 ? "多选" : "单选"}正确答案，并记入错误台账`
                );
              } catch {
                setIssueMsg("网络异常，未保存");
              } finally {
                setMarkBusy(false);
              }
            }}
            onSubmit={async () => {
              if (issueBusy) return;
              setIssueBusy(true);
              setIssueMsg("");
              try {
                const res = await fetch("/api/card-errors", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    card_id: card.card_id,
                    textbook_id: origin?.textbook_id ?? null,
                    kind: issueKind,
                    note: issueNote.trim(),
                    source: "review",
                  }),
                });
                const json = (await res.json()) as Record<string, unknown>;
                if (!res.ok || json.ok !== true) {
                  setIssueMsg(String(json.error ?? "提交失败"));
                  return;
                }
                setIssueNote("");
                setIssueMsg("已记录，监督员会在复盘时核查这一类问题");
              } catch {
                setIssueMsg("网络异常，未提交");
              } finally {
                setIssueBusy(false);
              }
            }}
          />
        </div>
      )}

      {/*
       * 评分回执：固定贴在底栏上方（拇指区域），点完四档立刻能看到「什么时候再来」。
       * 放页面顶部时用户根本注意不到 —— 视线和手指都在按钮这一屏。
       * 只描述「刚才那一次作答」，绝不出现在题目/答案区，避免和当前这张卡混淆。
       */}
      {notice && <RateToast notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
