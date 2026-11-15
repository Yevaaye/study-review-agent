// 审计台账的纯函数契约：题型画像 / 节点链路 / 归因汇总 / 交叉结论
//
// 守的是这次的需求：
//   监督员拿两本 JSON 要能回答「哪类题反复没好答案」「哪些节点被拒了」，
//   所以分组必须**可复现** —— 同一批记录每次跑出来一样，才能判断改动有没有效。
//
// 用法：npm run check:auditledger

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) {
      try {
        return next(`${spec}.ts`, ctx);
      } catch {
        /* 落回原样 */
      }
    }
    return next(spec, ctx);
  },
});

const root = process.cwd();
const M = await import(pathToFileURL(path.join(root, "src/lib/audit/ledger-model.ts")).href);
const F = await import(pathToFileURL(path.join(root, "src/lib/audit/ledger-file.ts")).href);
const R = await import(pathToFileURL(path.join(root, "src/lib/cards/answer-repair.ts")).href);
const B = await import(pathToFileURL(path.join(root, "src/lib/audit/backfill.ts")).href);

let pass = 0;
let fail = 0;
function chk(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  ← ${extra}` : ""}`);
  }
}

// ---- describeAnswerForm：答案写法决定「是抽取问题还是解析问题」 ----
chk("answer_form：单个字母 → letter", M.describeAnswerForm("A") === "letter");
chk("answer_form：字母连写 → letter", M.describeAnswerForm("A、C") === "letter");
chk("answer_form：圈号 → circled", M.describeAnswerForm("①③") === "circled");
chk("answer_form：纯数字 → numeric", M.describeAnswerForm("12") === "numeric");
chk("answer_form：整段文本 → text", M.describeAnswerForm("先分块再嵌入向量库") === "text");
chk("answer_form：空 → none", M.describeAnswerForm("") === "none" && M.describeAnswerForm(null) === "none");

// ---- describeQuestionType：按题型分组是监督员的第一刀 ----
const single = M.describeQuestionType({
  kind: "choice",
  options: ["a", "b", "c", "d"],
  answers: null,
  is_multi: false,
  answer: "A",
  card_type: null,
});
chk("题型：4 选项无多选标记 → single_choice", single.kind === "single_choice" && single.option_count === 4);
chk("题型：单选 is_multi=false", single.is_multi === false && single.is_choice === true);

const multi = M.describeQuestionType({
  kind: "choice",
  options: ["a", "b", "c", "d"],
  answers: ["a", "c"],
  is_multi: true,
  answer: "A、C",
  card_type: null,
});
chk("题型：answers 两条 → multi_choice", multi.kind === "multi_choice" && multi.is_multi === true);
chk("题型：只靠 answers 长度也能判多选（is_multi 缺省）", M.describeQuestionType({
  kind: "choice",
  options: ["a", "b"],
  answers: ["a", "b"],
  answer: "A、B",
}).kind === "multi_choice");

chk("题型：无选项 + card_type=judge → judge", M.describeQuestionType({
  kind: "qa",
  options: null,
  card_type: "judge",
}).kind === "judge");
chk("题型：无选项无 card_type → qa", M.describeQuestionType({ kind: "qa" }).kind === "qa");
chk("题型：kind=choice 但 options 为空仍算选择题", M.describeQuestionType({
  kind: "choice",
  options: [],
}).is_choice === true);

// ---- describeNode：只记 card_id 等于没记 ----
const bare = M.describeNode({ card: { id: "c1", kp_id: undefined, chapter_path: null } });
chk("节点：全缺时 id 保留、其余为 null", bare.card_id === "c1" && bare.textbook_id === null && bare.kp_id === null);
chk("节点：无片段时 fragment_ids 为空数组", Array.isArray(bare.fragment_ids) && bare.fragment_ids.length === 0);

const full = M.describeNode({
  card: { id: "c2", kp_id: "kp1", chapter_path: ["第一章", "1.1", "1.1.1", "1.1.1.1", "超出上限"] },
  textbook: { id: "tb1", title: "系统设计" },
  chapter: { id: "ch1", title: "第一章" },
  kp: { id: "kp1", title: "分块策略", summary: null },
  fragments: [
    { id: "f1", locator: "p.12" },
    { id: "f2", locator: "p.13" },
  ],
});
chk("节点：书/章节/知识点全部落位", full.textbook_title === "系统设计" && full.chapter_title === "第一章" && full.kp_statement === "分块策略");
chk("节点：chapter_path 最多留 4 级", full.chapter_path.length === 4);
chk("节点：locator 取第一个有值的片段", full.locator === "p.12");
chk("节点：片段 id 全量保留", full.fragment_ids.join(",") === "f1,f2");
chk("节点：title 为空时回退 summary", M.describeNode({
  card: { id: "c3" },
  kp: { id: "kp2", title: "", summary: "回退的陈述" },
}).kp_statement === "回退的陈述");

// ---- step：日志字段夹紧，防止单条记录把文件撑爆 ----
const longStep = M.step("x".repeat(100), "y".repeat(500), "reject");
chk("pipeline：step 名截断到 60", longStep.step.length === 60);
chk("pipeline：detail 截断到 240", longStep.detail.length === 240);
chk("pipeline：verdict 原样保留", longStep.verdict === "reject");

// ---- summarizeAnswerGaps：必须指向「被哪个函数拦下」 ----
const gaps = [
  {
    outcome: "fixed",
    symptom: "truncated",
    question_type: { kind: "qa" },
    node: { kp_id: "kp1", textbook_id: "tb1" },
    pipeline: [{ step: "normalizeRepair", verdict: "ok" }],
  },
  {
    outcome: "fixed",
    symptom: "truncated",
    question_type: { kind: "qa" },
    node: { kp_id: "kp1", textbook_id: "tb1" },
    pipeline: [{ step: "normalizeRepair", verdict: "ok" }],
  },
  {
    outcome: "unfixed",
    symptom: "insufficient",
    question_type: { kind: "single_choice" },
    node: { kp_id: null, textbook_id: "tb2" },
    pipeline: [
      { step: "draftAnswerRepair", verdict: "ok" },
      { step: "normalizeRepair", verdict: "reject" },
    ],
  },
];
const gs = M.summarizeAnswerGaps(gaps);
chk("汇总：总数与 outcome 分组", gs.count === 3 && gs.by_outcome.fixed === 2 && gs.by_outcome.unfixed === 1);
chk("汇总：by_symptom 按数量降序", Object.keys(gs.by_symptom)[0] === "truncated");
chk("汇总：未补全归到最后一个 reject 的 step", gs.by_block_step.normalizeRepair === 1);

// 模型调用失败时 writeBack 也是 reject —— 取最后一个会把所有失败都归成 writeBack，
// 让监督员去查写回逻辑（实际是网关挂了）。必须取第一个 reject。
const llmFail = [{
  outcome: "unfixed",
  symptom: "llm_error",
  question_type: { kind: "qa" },
  node: { kp_id: null, textbook_id: "tb1" },
  pipeline: [
    { step: "draftAnswerRepair", verdict: "ok" },
    { step: "chatJSON", verdict: "reject" },
    { step: "normalizeRepair", verdict: "info" },
    { step: "writeBack", verdict: "reject" },
  ],
}];
const llmFailSum = M.summarizeAnswerGaps(llmFail);
chk(
  "汇总：多个 reject 时取第一个（chatJSON），不落到 writeBack",
  llmFailSum.by_block_step.chatJSON === 1 && !("writeBack" in llmFailSum.by_block_step),
  JSON.stringify(llmFailSum.by_block_step)
);
chk("汇总：未绑知识点计数", gs.unbound_kp === 1);
chk("汇总：按书去重计数", gs.textbook_count === 2);

// ---- summarizeRejections：回填记录不能算「新卡被拒」 ----
const rej = [
  {
    question_type: { kind: "qa" },
    context: { source: "cards", fsrs_before: null, batch_size: null, backfilled: true },
    node: { textbook_title: "书A", kp_statement: "知识点1", kp_id: "kp1" },
  },
  {
    question_type: { kind: "qa" },
    context: { source: "batch", fsrs_before: { reps: 3 }, batch_size: 12 },
    node: { textbook_title: "书A", kp_statement: "知识点1", kp_id: "kp1" },
  },
  {
    question_type: { kind: "single_choice" },
    context: { source: "batch", fsrs_before: null, batch_size: 12 },
    node: { textbook_title: "书B", kp_statement: null, kp_id: null },
  },
];
const rs = M.summarizeRejections(rej);
chk("拒绝汇总：总数", rs.count === 3);
chk("拒绝汇总：回填记录不计入 first_time", rs.first_time === 1, `实际 ${rs.first_time}`);
chk("拒绝汇总：批量规模分组", rs.batch_sizes["12"] === 2 && rs.batch_sizes["单张"] === 1);
chk("拒绝汇总：未绑知识点归到「未关联知识点」", rs.by_kp["未关联知识点"] === 1);
chk("拒绝汇总：按书分布", rs.by_textbook["书A"] === 2);

// ---- crossFindings：两本合起来才能定位根因 ----
const emptyEnv = (kind) => ({
  schema_version: 1,
  ledger: kind,
  purpose: "",
  updated_at: "",
  totals: kind === "answer-gaps" ? M.summarizeAnswerGaps([]) : M.summarizeRejections([]),
  legend: {},
  items: [],
});
const emptyTip = F.crossFindings(emptyEnv("answer-gaps"), emptyEnv("rejected-cards"));
chk("交叉结论：无样本时给出明确提示", emptyTip.length === 1 && emptyTip[0].includes("还没有样本"));

const gapEnv = { ...emptyEnv("answer-gaps"), totals: gs, items: gaps };
const rejEnv = { ...emptyEnv("rejected-cards"), totals: rs, items: rej };
const findings = F.crossFindings(gapEnv, rejEnv);
chk("交叉结论：非空且是字符串数组", Array.isArray(findings) && findings.length > 0 && findings.every((f) => typeof f === "string"));
chk(
  "交叉结论：未补全比例高时点名卡点函数",
  findings.some((f) => f.includes("normalizeRepair")),
  findings.join(" | ")
);

const heavyUnfixed = {
  ...gapEnv,
  totals: { ...gs, count: 10, by_outcome: { unfixed: 6, fixed: 4 }, by_block_step: { normalizeRepair: 6 } },
  items: [],
};
const f2 = F.crossFindings(heavyUnfixed, emptyEnv("rejected-cards"));
chk("交叉结论：60% 没补上时给出「先修判定」的建议", f2.some((f) => f.includes("60%") && f.includes("先")));

// ---- mapFixReason / blockReasonOf：把代码原因翻成人话 ----
chk("回填映射：multi_answer → truncated", B.mapFixReason("multi_answer") === "truncated");
chk("回填映射：rule_expanded → truncated", B.mapFixReason("rule_expanded") === "truncated");
chk("回填映射：missing 原样保留", B.mapFixReason("missing") === "missing");

chk("未补全说明：模型答「材料未提及」时点名抽取阶段", R.blockReasonOf({
  reason: "insufficient",
  reject: "dodged",
  materialChars: 800,
  sourceChars: 500,
  rawAnswerChars: 6,
  emptyQuestion: false,
}).includes("材料未提及"));
chk("未补全说明：没给 answer 字段时说「等于没答」", R.blockReasonOf({
  reason: "insufficient",
  reject: "answer_too_short",
  materialChars: 800,
  sourceChars: 500,
  rawAnswerChars: 0,
  emptyQuestion: false,
}).includes("没有给出 answer"));
chk("未补全说明：原文 0 字时点明「没绑原文片段」", R.blockReasonOf({
  reason: "no-material",
  reject: null,
  materialChars: 12,
  sourceChars: 0,
  rawAnswerChars: 0,
  emptyQuestion: false,
}).includes("没有绑定原文片段"));

// ---- normalizeRepairDetailed：只在多回一个 reject，不改变原有接受/拒绝 ----
chk("收口：合法 payload 仍被接受", !!(
  R.normalizeRepairDetailed({
    answer: "分块按语义边界切，256-512 tokens",
    knowledge_points: ["分块"],
    diagnosis: "原答案只写了半句",
    grounded: true,
  })?.draft
));
chk("收口：敷衍答复被拒且成因是 dodged", R.normalizeRepairDetailed({ answer: "材料未提及该内容" }).reject === "dodged");
chk("收口：非对象被拒且成因是 not_object", R.normalizeRepairDetailed(null).reject === "not_object");
chk("收口：答案过短被拒且成因是 answer_too_short", R.normalizeRepairDetailed({ answer: "好" }).reject === "answer_too_short");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
