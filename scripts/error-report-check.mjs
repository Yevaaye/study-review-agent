// 出题错误台账回归 —— npm run check:errorreport
//
// 现场：复习页新增「错误」按钮，一类是「标注正确答案」，一类是「AI 出题错误」。
// 这些记录要能交给复盘 Agent 的监督员按病因聚类、出迭代建议。
// 这里锁住：入参收口、快照保真、统计、监督员结论（含空数据与单一病因）。

import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* 落回原路径 */
      }
    }
    return next(specifier, context);
  },
});

const base = "F:/projects/study-review-agent/src/lib";
const E = await import(pathToFileURL(`${base}/cards/error-report.ts`).href);

let pass = 0;
let fail = 0;
function chk(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const card = {
  id: "c1",
  kind: "choice",
  front: "RAG 与微调该怎么选？",
  back: "看知识更新频率",
  options: ["A. 更新快", "B. 维护弱", "C. 要引用"],
  answer: "A. 更新快",
  answers: null,
  is_multi: false,
  is_choice: true,
  status: "active",
  content_revision: 1,
  card_type: "choice",
};

console.log("\n[1] 入参收口");
{
  const good = E.normalizeReportInput({ kind: "not_question", note: "  这是建议清单  " }, card);
  chk("kind 合法时保留", good.kind === "not_question");
  chk("note 去空白并截断", good.note === "这是建议清单");
  const bad = E.normalizeReportInput({ kind: "不存在的类型", note: "" }, card);
  chk("非法 kind 落到 other（不丢反馈）", bad.kind === "other");
  const clamped = E.normalizeReportInput(
    { kind: "answer_key_wrong", marked_keys: [0, 2, 9, -1, "1"] },
    card
  );
  chk("越界下标被丢弃", JSON.stringify(clamped.marked_keys) === "[0,1,2]", JSON.stringify(clamped));
  const ignored = E.normalizeReportInput({ kind: "answer_wrong", marked_keys: [0, 1] }, card);
  chk("非答案键病因不保留标注（避免误导监督员）", ignored.marked_keys.length === 0);
}

console.log("\n[2] 是否有必要记一条");
{
  chk("只选类型也算有效", E.reportIsUseful({ kind: "not_question", note: "", marked_keys: [] }) === true);
  chk("只写备注也算有效", E.reportIsUseful({ kind: "other", note: "选项顺序乱了", marked_keys: [] }) === true);
  chk("有标注也算有效", E.reportIsUseful({ kind: "answer_key_wrong", note: "", marked_keys: [1] }) === true);
  chk("空提交（other + 空 + 无标注）拒绝", E.reportIsUseful({ kind: "other", note: "", marked_keys: [] }) === false);
}

console.log("\n[3] 快照保真");
{
  const snap = E.snapshotOf(card);
  chk("题干/选项/答案都进快照", snap.front === card.front && snap.options.length === 3 && snap.answer === card.answer);
  chk("快照是拷贝，不是引用", snap.options !== card.options);
  chk("is_multi 归一成布尔", snap.is_multi === false);
}

console.log("\n[4] 统计");
{
  const reports = [
    E.snapshotOf ? null : null,
  ].filter(Boolean);
  const mk = (id, kind, status, cardId = "c1", textbook = "t1", marked = []) => ({
    id,
    card_id: cardId,
    textbook_id: textbook,
    kind,
    note: "",
    snapshot: { front: "题干", back: "", options: [], answer: null, answers: null, is_multi: false },
    marked_keys: marked,
    source: "review",
    status,
    verdict: null,
    suggested_action: null,
    reviewed_at: null,
    created_at: `2026-11-08T10:0${id}:00.000Z`,
  });
  const list = [
    mk("1", "not_question", "open", "c1"),
    mk("2", "not_question", "open", "c2"),
    mk("3", "answer_key_wrong", "fixed", "c1", "t1", [0, 2]),
    mk("4", "other", "reviewed", "c3", "t2"),
  ];
  const s = E.summarizeErrors(list);
  chk("总数 / 待核查", s.total === 4 && s.open === 2);
  chk("按病因计数", s.by_kind.find((k) => k.kind === "not_question").count === 2);
  chk("按卡片聚合（c1 两次）", s.by_card[0].card_id === "c1" && s.by_card[0].count === 2);
  chk("多选标注单独计数", s.marked_multi === 1);
  chk("按书聚合", s.by_book.length === 2 && s.by_book.find((b) => b.textbook_id === "t1").count === 3);
  chk("最新时间取最大值", s.latest_at === "2026-11-08T10:04:00.000Z", s.latest_at);

  const notes = [...reports];
  chk("空列表时统计不炸", E.summarizeErrors(notes).total === 0);
}

console.log("\n[5] 监督员结论");
{
  const mk = (id, kind, status, cardId) => ({
    id,
    card_id: cardId,
    textbook_id: "t1",
    kind,
    note: kind === "not_question" ? "这是编号建议清单" : "",
    snapshot: { front: "给 AI PM 的选型建议", back: "", options: null, answer: null, answers: null, is_multi: false },
    marked_keys: [],
    source: "review",
    status,
    verdict: null,
    suggested_action: null,
    reviewed_at: null,
    created_at: `2026-11-08T10:0${id}:00.000Z`,
  });
  const list = [
    mk("1", "not_question", "open", "c1"),
    mk("2", "not_question", "open", "c2"),
    mk("3", "options_wrong", "open", "c3"),
  ];
  const r = E.buildSupervisorReview(list, "2026-11-08T12:00:00.000Z");
  chk("最集中的病因排第一", r.findings[0].kind === "not_question" && r.findings[0].count === 2);
  chk("影响面按卡片去重", r.findings[0].affected_cards === 2);
  chk("给出可执行动作", r.next_actions.length >= 2 && r.next_actions[0].includes("收紧数字选项折叠"));
  chk("叙述里点明待核查数量", r.narrative.includes("待核查 3"), r.narrative);
  chk("保留代表样本", r.findings[0].samples.length === 2 && r.findings[0].samples[0].note.includes("清单"));

  const empty = E.buildSupervisorReview([], "2026-11-08T12:00:00.000Z");
  chk("没有上报时给中性结论", empty.findings.length === 0 && empty.narrative.includes("没有出题错误上报"));
  chk("没有上报时也有下一步建议", empty.next_actions.length === 1);

  chk("病因枚举覆盖 5 类", E.ERROR_KINDS.length === 5);
  chk("每个病因都有归因与建议", E.ERROR_KINDS.every((k) => k.hypothesis && k.action && k.label));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
