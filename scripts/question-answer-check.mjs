// 题目答案匹配专项回归 —— npm run check:answer
//
// 守住「从 MD 完整抽取题目与答案」这条目标，锁定三类此前系统性遗漏：
//   1. 答案引用头 `### Q1:` / `### 第3题:` / `【第3题】` —— 此前 collectAnswerEntries
//      任何正则都不命中，参考答案区整条被漏收（RAG 材料 20 题只救回 3 题）。
//   2. `**参考答案：**` 空内容头之后的答案正文被塞进 explanation 而非 answer，
//      导致 needs_answer 永远 true、审核台误报「缺答案要 AI 补」。
//   3. 去重指纹含 chapter_path，跨章同题（题目清单章 + 参考答案章）不合并，
//      同一个题变两张卡、一张有答案一张没答案。

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const here = path.dirname(fileURLToPath(import.meta.url));
const ts = (name) => pathToFileURL(path.join(here, "../src/lib/import", name)).href;
const P = await import(ts("question-pipeline.ts"));

const { runQuestionPipeline } = P;

let pass = 0;
let fail = 0;
const chk = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? `  ← ${extra}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// 组 1：答案引用头识别（题目区按小节重置编号，答案区用 Q1/Q6/Q11 全局引用）
// ---------------------------------------------------------------------------
{
  const md = `# 基础

1. 什么是向量数据库？
2. RAG 的核心流程是什么？

# 检索

3. 向量检索的召回率如何优化？
4. 什么是 HNSW？

# 参考答案

### Q1: 专门存储与检索向量索引的数据库。
### Q3: 提高索引质量与查询改写。
### Q4: 一种基于图的近似最近邻索引结构。`;

  const r = await runQuestionPipeline(md, {});
  const byText = (needle) =>
    r.questions.find((q) => q.question_text.includes(needle));

  const q1 = byText("向量数据库");
  const q3 = byText("召回率");
  const q4 = byText("HNSW");

  chk("Q1/Q3/Q4 答案头全部被识别", r.questions.length === 4, `实得 ${r.questions.length}`);
  chk("Q1 答案回填到「什么是向量数据库」", (q1?.answer ?? "").includes("向量索引"), `answer=${q1?.answer}`);
  chk("Q3 答案回填到「召回率优化」", (q3?.answer ?? "").includes("索引质量"), `answer=${q3?.answer}`);
  chk("Q4 答案回填到「HNSW」", (q4?.answer ?? "").includes("近似最近邻"), `answer=${q4?.answer}`);
  chk("Q2 无对应答案 → needs_answer=true", byText("RAG 的核心流程")?.needs_answer === true);
}

// ---------------------------------------------------------------------------
// 组 2：### 第N题 / 【第N题】 答案引用头
// ---------------------------------------------------------------------------
{
  const md = `# 面试题

1. 什么是幂等？
2. 缓存穿透如何防御？

# 答案

### 第1题: 多次执行结果一致。
### 第2题: 布隆过滤器 + 空值缓存。`;

  const r = await runQuestionPipeline(md, {});
  chk("第N题答案头回填", r.questions.length === 2 && r.questions[0]?.answer?.includes("结果一致"), `实得 ${r.questions.length}`);
}

{
  const md = `# 面试题

1. 什么是熔断？

# 答案

【第1题】快速失败，避免级联故障。`;

  const r = await runQuestionPipeline(md, {});
  chk("【第N题】答案头回填", r.questions[0]?.answer?.includes("快速失败"), `answer=${r.questions[0]?.answer}`);
}

// ---------------------------------------------------------------------------
// 组 3：参考答案空内容头 → 答案正文进 answer（不再塞 explanation）
// ---------------------------------------------------------------------------
{
  const md = `# 面试题

1. 请简述什么是 AI Agent？

**参考答案：**

AI Agent 是能感知环境、自主决策并采取行动达成目标的智能体。

**💡 思考逻辑：**

从感知、决策、行动三要素回答。`;

  const r = await runQuestionPipeline(md, {});
  const q = r.questions[0];
  chk("参考答案正文写入 answer", (q?.answer ?? "").includes("自主决策"), `answer=${q?.answer}`);
  chk("needs_answer=false（不再误报缺答案）", q?.needs_answer === false, `needs=${q?.needs_answer}`);
  chk("思考逻辑不进题干", !(q?.question_text ?? "").includes("思考逻辑"));
}

// ---------------------------------------------------------------------------
// 组 4：去重指纹去掉 chapter_path → 跨章同题合并
// ---------------------------------------------------------------------------
{
  const md = `# 题目清单

1. 什么是 RAG？

# 参考答案

1. 什么是 RAG？
答：检索增强生成，外挂知识库后由大模型作答。`;

  const r = await runQuestionPipeline(md, {});
  // 同题在「题目清单」与「参考答案」各出现一次，题干归一后相同 → 合并为 1 题
  chk("跨章同题合并为 1 题", r.questions.length === 1, `实得 ${r.questions.length}`);
  chk("合并后保留有答案的那份", (r.questions[0]?.answer ?? "").includes("检索增强生成"), `answer=${r.questions[0]?.answer}`);
}

// ---------------------------------------------------------------------------
// 组 5：同题号跨章冲突（题目区/答案区都按小节重置）—— 题号直配不误配
// ---------------------------------------------------------------------------
{
  const md = `# 基础

1. 第一题是 A 吗？
2. 第二题是 B 吗？

# 高级

1. 第三题是 C 吗？
2. 第四题是 D 吗？

# 答案

| 题号 | 答案 |
| 1 | 甲答案 |
| 2 | 乙答案 |
| 1 | 丙答案 |
| 2 | 丁答案 |`;

  const r = await runQuestionPipeline(md, {});
  // 题号「1」「2」在答案表出现两次（基础/高级各一组），此时题号直配不可信，
  // 不允许把「第三题」配到「甲答案」—— 应标 needs_answer（交由后续复盘/AI 兜底）。
  const q3 = r.questions.find((q) => q.question_text.includes("第三题"));
  chk("题号冲突时不做硬配（不把第三题配给甲答案）", !(q3?.answer ?? "").includes("甲答案"), `answer=${q3?.answer}`);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
