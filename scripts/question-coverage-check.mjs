// MD 抽题漏题专项回归 —— npm run check:coverage
//
// 守住「规则层只负责高召回、不做终局否决」这条产品规则：
//   1. 面试清单里的「无问号名词短语」必须成题（主因，丢 28 题）
//   2. ### N. / ### Q: / ### QN: 三种标题形态必须成题（4 份文件整篇归零）
//   3. 章节名声明「题目/试题/题库」时，其内编号行必须成题
//   4. **参考答案：** 空内容后的有序列表并入答案，不得误拆成新题
//   5. 纯知识点编号列表必须 0 题（负样本，防止把召回拉到无限大）
//   6. 元信息行（思考逻辑/考点）不得混入题干
//   7. 每道题都必须带可回溯的原文证据
//
// 说明：原始 6 份面试 MD 在本机不存在，fixture 按规格第 4 节描述的
// 「真实形态 + 21 条点名题 + 目标题数」重建；逻辑与断言不受影响。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

// Node 原生 ESM 不认无扩展名的相对导入，补一条 .ts 解析规则（与其他 check 脚本一致）。
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
const ts = (n) => pathToFileURL(path.join(here, "../src/lib/import", n)).href;
const P = await import(ts("question-pipeline.ts"));

const { runQuestionPipeline } = P;

const read = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");

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

const inChapter = (qs, needle) =>
  qs.filter((q) => (q.chapter_path || []).join(">").includes(needle)).length;

async function run(name) {
  const md = read(name);
  return runQuestionPipeline(md, {});
}

// ---------------------------------------------------------------------------
// 组 1：主因 —— 面经清单里的无问号名词短语
// ---------------------------------------------------------------------------
{
  const r = await run("interview-classic.md");
  const qs = r.questions;

  chk("面经 1 应抽满 16 题", inChapter(qs, "面经 1") === 16, `实得 ${inChapter(qs, "面经 1")}`);
  chk("面经 2 应抽满 14 题", inChapter(qs, "面经 2") === 14, `实得 ${inChapter(qs, "面经 2")}`);
  chk("面经 4 应抽满 8 题", inChapter(qs, "面经 4") === 8, `实得 ${inChapter(qs, "面经 4")}`);
  chk(
    "「字节面试关键洞察」是总结，不应抽成题",
    inChapter(qs, "关键洞察") === 0,
    `实得 ${inChapter(qs, "关键洞察")}`
  );
  chk("编号题总数应为 38（16+14+8）", qs.length === 38, `实得 ${qs.length}`);

  // 逐题点名：只有总数会掩盖「抽多了补足数」，必须逐条点名。
  const flat = qs.map((q) => q.question_text.replace(/\s+/g, ""));
  const required = [
    "多模态大模型的具体结构",
    "Agent 项目背景",
    "RAG 系统流程",
    "项目中 AI 贡献的代码占比",
    "大模型微调数据构造",
    "LoRA 秩的选择依据",
    "向量检索召回率优化",
    "长上下文压缩策略",
    "多轮对话状态管理",
    "工具调用失败重试机制",
    "模型幻觉的抑制手段",
    "客服 Agent 的意图识别方案",
    "知识库召回的分层设计",
    "会话超时后的兜底策略",
    "多租户数据隔离实现",
    "Prompt 版本管理与灰度",
    "工具编排的执行引擎",
    "用户反馈闭环设计",
    "线上评测指标定义",
    "冷启动阶段的知识补齐",
    "结构化输出的约束方式",
  ];
  const missing = required.filter((t) => {
    const key = t.replace(/\s+/g, "");
    return !flat.some((f) => f.includes(key));
  });
  chk("逐题点名 21 条全部命中", missing.length === 0, `缺 ${missing.join(" / ")}`);

  chk(
    "不抽取元信息行（思考逻辑/考点/答题思路）",
    qs.every((q) => !/思考逻辑|考点|答题思路/.test(q.question_text)),
    qs
      .filter((q) => /思考逻辑|考点|答题思路/.test(q.question_text))
      .map((q) => q.question_text.slice(0, 30))
      .join(" | ")
  );

  chk(
    "每题都有原文证据（source_evidence 非空且区间有效）",
    qs.every(
      (q) =>
        typeof q.source_evidence === "string" &&
        q.source_evidence.trim().length > 0 &&
        Number.isFinite(q.source_start) &&
        Number.isFinite(q.source_end) &&
        q.source_start < q.source_end
    )
  );
}

// ---------------------------------------------------------------------------
// 组 2：多形态（每类一个 fixture）
// ---------------------------------------------------------------------------
{
  const r = await run("interview-heading-numbered.md");
  chk("标题题号 ### 1. xxx + 子列表 → 应 15 题", r.questions.length === 15, `实得 ${r.questions.length}`);
}
{
  const r = await run("interview-heading-q.md");
  chk("标题问句 ### Q: xxx → 应 8 题", r.questions.length === 8, `实得 ${r.questions.length}`);
}
{
  const r = await run("interview-heading-qn.md");
  chk("标题带序号 ### Q1: xxx → 应 18 题", r.questions.length === 18, `实得 ${r.questions.length}`);
}
{
  const r = await run("interview-q-with-answer-list.md");
  chk(
    "参考答案区有序列表不误拆成新题 → 应 10 题",
    r.questions.length === 10,
    `实得 ${r.questions.length}`
  );
}
{
  const r = await run("knowledge-points-numbered.md");
  chk("编号知识点不误抽成题 → 应 0 题", r.questions.length === 0, `实得 ${r.questions.length}`);
}

// ---------------------------------------------------------------------------
// 组 3：仲裁层不能抹掉规则层的召回（2026-11 实测事故的回归锁）
//
// 事故链路：这批名词短语题通常无选项无答案，恰好落在「模型有权否决」的区间。
// 实测同一份材料连跑 5 次，模型时而响应（把 6 道判掉 4 道）时而超时（保留 6 道），
// 于是同一份材料的导入结果不可复现。现在区块声明的题带 section_question 信号，
// 模型只能标待审、不能删除。
// ---------------------------------------------------------------------------
{
  const md = read("interview-classic.md");
  const vetoAll = async (req) =>
    req.candidates.map((c) => ({ candidateIndex: c.index, is_question: false, confidence: 0.95 }));
  const r = await runQuestionPipeline(md, { judge: vetoAll, maxLlmCalls: 4, batchSize: 50 });

  chk(
    "模型全判非题，面经编号题仍全部保留（不因模型而丢题）",
    r.questions.length === 38,
    `实得 ${r.questions.length}`
  );
  chk(
    "被模型否决的题标记为待审核（model_disagrees），而非静默删除",
    r.questions.some((q) => (q.flags ?? []).includes("model_disagrees")),
    "没有任何题带 model_disagrees 标记"
  );
  chk(
    "被否决的题仍进入 review_required（人来做删除决定）",
    r.questions.filter((q) => q.review_required).length === r.questions.length,
    `待审 ${r.questions.filter((q) => q.review_required).length} / 共 ${r.questions.length}`
  );
}
{
  // 负样本同样要守住：没有题目区块声明的编号知识点，不能被「不删」策略误收。
  const md = read("knowledge-points-numbered.md");
  const vetoAll = async (req) =>
    req.candidates.map((c) => ({ candidateIndex: c.index, is_question: true, confidence: 0.95 }));
  const r = await runQuestionPipeline(md, { judge: vetoAll, maxLlmCalls: 4, batchSize: 50 });
  chk("模型全判是题，编号知识点仍不误抽 → 应 0 题", r.questions.length === 0, `实得 ${r.questions.length}`);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
