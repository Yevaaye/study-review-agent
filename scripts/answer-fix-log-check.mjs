// 答案修正台账的纯逻辑回归 —— npm run check:answerfixlog
//
// 用户要求「记录每次答案漏截、截断或不准确的原因，形成可追踪的修正依据」。
// 这里锁住台账构造与检索：规则层自动补齐（rule）与用户点「答案不全」（user）
// 都带齐原因、修正前后文本、原文摘录、诊断；可按卡/触发方式过滤、按原因汇总，
// 让后续能统计「哪种漏法最多」来迭代识别准确率。
// 真实落盘与 AI 修复由 check:answerfixhttp 端到端验证。

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

const F = await import(
  pathToFileURL("F:/projects/study-review-agent/src/lib/cards/answer-fix-log.ts").href
);

let pass = 0;
let fail = 0;
function chk(name, ok) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

const SUM = "过拟合指模型在训练数据上表现很好，但在测试数据上表现不佳。";
const FULL = SUM + "欠拟合指模型无法捕获数据中的复杂模式。";
const expansions = [
  {
    question: "什么是过拟合和欠拟合？",
    before: SUM,
    after: FULL,
    reason: "multi_answer",
    excerpt: FULL,
  },
  {
    question: "什么是神经网络？",
    before: "神经网络是一种计算模型",
    after: "神经网络是一种计算模型，由多层神经元组成。",
    reason: "truncated",
    excerpt: "原文段落",
  },
];

// 1 —— 规则层自动补齐
{
  const logs = F.buildRuleFixLogs(
    expansions,
    "tb-1",
    new Map([
      ["什么是过拟合和欠拟合？", "card-1"],
      ["什么是神经网络？", "card-2"],
    ])
  );
  chk("规则层：一条 expansion 一条记录", logs.length === 2);
  chk(
    "规则层：trigger=rule、grounded=true、card_id 按题干对齐",
    logs.every((l) => l.trigger === "rule" && l.grounded === true) &&
      logs[0].card_id === "card-1" &&
      logs[1].card_id === "card-2"
  );
  chk(
    "规则层：原因保留 multi_answer / truncated",
    logs[0].reason === "multi_answer" && logs[1].reason === "truncated"
  );
  chk(
    "规则层：诊断写明为什么漏（并列答案 / 截断）",
    logs[0].diagnosis.includes("并列答案") && logs[1].diagnosis.includes("截断")
  );
  chk(
    "规则层：修正前后文本与原文摘录齐全",
    logs.every((l) => l.before && l.after && l.source_excerpt && l.after !== l.before)
  );
  const missing = F.buildRuleFixLogs(
    [{ ...expansions[0], question: "没匹配到卡片的题" }],
    "tb-1",
    new Map()
  );
  chk("规则层：题干找不到卡片时 card_id 记 null，不丢记录", missing[0].card_id === null);
}

// 2 —— 用户点「答案不全」
{
  const log = F.buildUserFixLog({
    cardId: "card-1",
    textbookId: "tb-1",
    question: "什么是过拟合和欠拟合？",
    reason: "inaccurate",
    before: SUM,
    after: FULL,
    excerpt: FULL,
    knowledgePoints: ["过拟合", "欠拟合"],
    diagnosis: "用户指出答案与原文不符，AI 核对后补全欠拟合",
    grounded: false,
    note: "  漏了欠拟合  ",
  });
  chk("用户修复：trigger=user、原因=inaccurate", log.trigger === "user" && log.reason === "inaccurate");
  chk(
    "用户修复：AI 分析出的知识点被记录",
    log.knowledge_points.length === 2 && log.knowledge_points.includes("欠拟合")
  );
  chk("用户修复：备注去空白、grounded=false 标注需核对", log.note === "漏了欠拟合" && log.grounded === false);
  chk("用户修复：诊断与修正前后文本齐全", !!log.diagnosis && log.before === SUM && log.after === FULL);
}

// 3 —— 检索与汇总
{
  const logs = [
    ...F.buildRuleFixLogs(expansions, "tb-1", new Map([["什么是过拟合和欠拟合？", "card-1"]])),
    F.buildUserFixLog({
      cardId: "card-1",
      question: "什么是过拟合和欠拟合？",
      reason: "truncated",
      before: SUM,
      after: FULL,
      excerpt: FULL,
      knowledgePoints: [],
      diagnosis: "截断",
      grounded: true,
    }),
  ].map((l, i) => ({ ...l, id: `log-${i}`, created_at: `2026-11-08T0${i}:00:00.000Z` }));

  chk("检索：全量 3 条", F.filterFixLogs(logs).length === 3);
  chk("检索：按 cardId 过滤", F.filterFixLogs(logs, { cardId: "card-1" }).length === 2);
  chk("检索：按 trigger=user 过滤", F.filterFixLogs(logs, { trigger: "user" }).length === 1);
  chk("检索：按 trigger=rule 过滤", F.filterFixLogs(logs, { trigger: "rule" }).length === 2);
  chk("检索：limit 生效", F.filterFixLogs(logs, { limit: 1 }).length === 1);
  chk("检索：按时间倒序", F.filterFixLogs(logs)[0].id === "log-2");
  const stat = F.summarizeFixReasons(logs);
  chk(
    "汇总：按原因统计（multi_answer 1 / truncated 2）",
    stat.multi_answer === 1 && stat.truncated === 2
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
