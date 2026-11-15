// 答案完整性回归 —— npm run check:answerexpansion
//
// 现场：原文段落里明明写了「过拟合… + 欠拟合…」两个答案，卡片却只有前半句。
// 根因是「答案：」行之后的完整段落被主状态机丢弃。这里锁住：
//   1. 同段落多答案 / 答案截断 → 用完整段落替换摘要句；
//   2. 不该扩的场景（无关正文、下一题、超长、短答案）一律不动；
//   3. 引导语 + 要点列表的截断 → 接上列表，但不能把下一题吞进来；
//   4. 整条管线跑通，题数不变，答案确实写进 q.answer；
//   5. AI 修复返回的 normalizeRepair 只接受可信结构。

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
const E = await import(pathToFileURL(`${base}/import/answer-expansion.ts`).href);
const P = await import(pathToFileURL(`${base}/import/question-pipeline.ts`).href);
const R = await import(pathToFileURL(`${base}/cards/answer-repair.ts`).href);

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

const SUMMARY =
  "过拟合指模型在训练数据上表现很好，但在测试数据上表现不佳，因为模型过于复杂，学习了噪声。";
const FULL = SUMMARY + "欠拟合指模型无法捕获数据中的复杂模式，因为模型太简单或特征不足。";

function q(answer, extra = {}) {
  return {
    question_text: "什么是过拟合和欠拟合？",
    question_type: "qa",
    options: [],
    answer,
    explanation: "",
    chapter_path: ["基础"],
    source_chunk_id: "c1",
    source_start: 0,
    source_end: 0,
    source_evidence: "",
    confidence: 1,
    review_required: false,
    no: null,
    needs_answer: !answer,
    sources: [],
    flags: answer ? [] : ["answer_unverified"],
    ...extra,
  };
}

// 1 —— 同段落两个答案
const mdMulti = `问题：什么是过拟合和欠拟合？\n答案：${SUMMARY}\n\n${FULL}`;
{
  const r = E.expandAnswersFromContext([q(SUMMARY)], mdMulti);
  chk("同段落两个答案：整段写回", r.questions[0].answer === FULL);
  chk("同段落两个答案：reason=multi_answer", r.expansions[0]?.reason === "multi_answer");
  chk("同段落两个答案：needs_answer 变 false", r.questions[0].needs_answer === false);
  chk(
    "同段落两个答案：flags 打 answer_expanded",
    r.questions[0].flags.includes("answer_expanded")
  );
  chk(
    "审计记录含 before/after/excerpt/question",
    r.expansions.length === 1 &&
      r.expansions[0].before === SUMMARY &&
      r.expansions[0].after === FULL &&
      r.expansions[0].excerpt.length > 0 &&
      r.expansions[0].question.includes("过拟合")
  );
}

// 2 —— 答案截断（后半句没形成完整第二句）
{
  const tail = "而模型容量也需要与数据量匹配";
  const r = E.expandAnswersFromContext([q(SUMMARY)], `答案：${SUMMARY}\n\n${SUMMARY}${tail}`);
  chk("答案截断：续写被并入", r.questions[0].answer.endsWith(tail));
  chk("答案截断：reason=truncated", r.expansions[0]?.reason === "truncated");
}

// 3 —— 不该动的情况
{
  const only = `问题：什么是过拟合和欠拟合？\n答案：${SUMMARY}`;
  const r = E.expandAnswersFromContext([q(SUMMARY)], only);
  chk("没有后续扩展段落：原答案不动、无记录", r.questions[0].answer === SUMMARY && r.expansions.length === 0);
}
{
  const r = E.expandAnswersFromContext([q(SUMMARY)], `答案：${SUMMARY}\n\n另一段完全无关的正文。`);
  chk("后续段落不以答案为前缀：不扩", r.questions[0].answer === SUMMARY && r.expansions.length === 0);
}
{
  const r = E.expandAnswersFromContext(
    [q(SUMMARY)],
    `答案：${SUMMARY}\n\n${SUMMARY}欠拟合指…\n\n问题：下一题问什么？\n答案：别的答案`
  );
  chk("不把下一题的题目行吞进答案", !r.questions[0].answer.includes("下一题问什么"));
}
{
  const huge = SUMMARY + "很长的内容".repeat(200);
  const r = E.expandAnswersFromContext([q(SUMMARY)], `答案：${SUMMARY}\n\n${huge}`);
  chk("超长续段（>500 字）不扩，避免吞进整章正文", r.questions[0].answer === SUMMARY);
}
{
  const r = E.expandAnswersFromContext([q("B")], `答案：B\n\nB. 某个选项文本`);
  chk("选择题字母答案不参与回填", r.questions[0].answer === "B" && r.expansions.length === 0);
}
{
  const r = E.expandAnswersFromContext([q("")], "答案：\n\n一些正文");
  chk("本来就没答案的题不参与回填（交给 AI 补）", r.questions[0].answer === "" && r.expansions.length === 0);
}
{
  const r = E.expandAnswersFromContext(
    [q(SUMMARY)],
    `答案：${SUMMARY}\n\n**难度**：⭐⭐\n\n${FULL}`
  );
  chk("元信息段落不算答案，仍能找到后面的完整段落", r.questions[0].answer === FULL);
}

// 4 —— 引导语 + 要点列表的截断
{
  const intro = SUMMARY + "主要有以下几类：";
  const list = "- 监督学习：用标注数据训练\n- 无监督学习：从无标注数据中发现结构";
  const r = E.expandAnswersFromContext([q(SUMMARY)], `答案：${SUMMARY}\n\n${intro}\n\n${list}`);
  chk("冒号引导 + 下一段列表：列表被接上", r.questions[0].answer.includes("无监督学习"));
}
{
  const intro = SUMMARY + "它分为以下几类：";
  const next = "**二、描述深度学习与传统机器学习的区别。**";
  const r = E.expandAnswersFromContext([q(SUMMARY)], `答案：${SUMMARY}\n\n${intro}\n\n${next}`);
  chk("冒号引导但下一段是下一题标题：不合并", !r.questions[0].answer.includes("描述深度学习"));
}

// 5 —— 整条管线
{
  const md = `## 一、基础\n\n问题：什么是过拟合和欠拟合？\n答案：${SUMMARY}\n\n${FULL}\n\n问题：请解释什么是神经网络。\n答案：神经网络是一种受人脑结构启发的计算模型。`;
  const r = await P.runQuestionPipeline(md, {});
  const target = r.questions.find((x) => x.question_text.includes("过拟合"));
  chk("管线集成：答案写进 q.answer 且完整", target?.answer === FULL);
  chk("管线集成：题数不因回填而增加", r.questions.length === 2);
  chk("管线集成：expansions 随结果返回", (r.expansions ?? []).length === 1);
  chk("管线集成：第二题（无扩展段落）保持原答案", r.questions.some((x) => x.question_text.includes("神经网络") && x.answer.includes("受人脑结构启发")));
}

// 6 —— AI 修复返回结构
{
  const good = R.normalizeRepair({
    knowledge_points: ["过拟合", "欠拟合"],
    diagnosis: "原答案只写了过拟合，漏了欠拟合",
    answer: FULL,
    grounded: true,
    basis: FULL,
  });
  chk(
    "normalizeRepair：合法 payload 保留知识点/诊断/grounded",
    !!good && good.answer === FULL && good.knowledge_points.length === 2 && good.grounded === true
  );
  chk(
    "normalizeRepair：knowledge_points 非数组时降级为空数组",
    R.normalizeRepair({ answer: FULL, knowledge_points: "不是数组" })?.knowledge_points.length === 0
  );
  chk("normalizeRepair：空答案拒绝", R.normalizeRepair({ answer: "" }) === null);
  chk(
    "normalizeRepair：敷衍答复（材料未提及）拒绝",
    R.normalizeRepair({ answer: "材料未提及该内容" }) === null
  );
  chk(
    "normalizeRepair：畸形对象拒绝",
    R.normalizeRepair(null) === null && R.normalizeRepair("x") === null
  );
  chk(
    "修复原因枚举覆盖缺失/截断/不准",
    JSON.stringify(R.REPAIR_REASONS) === JSON.stringify(["missing", "truncated", "inaccurate"])
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
