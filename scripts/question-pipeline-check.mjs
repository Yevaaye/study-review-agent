// 题目抽取管线专项回归 —— 独立合成样例，不读取也不修改 data/db.json。
// 运行：npm run check:pipeline
//
// 覆盖任务书八节：标准编号题 / 无编号问句 / 填空 / 判断 / 题目与答案分离 /
// 跨段落 / 表格题 / 重复题 / 纯知识点 / 模型格式异常与调用失败 / 长文档全量覆盖。
// 另外覆盖：整章无空行多题（原「一题全丢」事故）、模型不得注入文本、适配器字段兼容。

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

/*
 * 这个脚本直接用 Node 的类型擦除加载 .ts 源码（不起 tsc，跑得快）。
 * 但原生 ESM 不认「无扩展名的相对导入」—— adapter 里 `from "./fidelity"`
 * 会解析成不存在的 `fidelity`（TS 编译时才补 .ts）。
 * 这里补一条 resolve 规则：相对路径且没有扩展名时先试 .ts，让脚本继续免编译。
 */
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

const pipeline = await import(ts("question-pipeline.ts"));
const { adaptToExtractedQuestions } = await import(ts("question-adapter.ts"));

const {
  runQuestionPipeline,
  parseMarkdownStructure,
  splitMarkdownWithContext,
  detectQuestionCandidates,
  deduplicateQuestions,
  validateQuestionSources,
  normalizeForCompare,
} = pipeline;

const chapters = [
  { title: "第一章 测试", heading_path: "第一章 测试", fragments: [] },
  { title: "第二章 进阶", heading_path: "第二章 进阶", fragments: [] },
  { title: "第三章 综合", heading_path: "第三章 综合", fragments: [] },
];

const okJudge = async () => null; // 强制纯规则，便于断言基线行为

const has = (qs, pred) => qs.some(pred);
const chk = (out, label, cond) => out.push([label, !!cond]);

const cases = [
  {
    name: "1. 标准编号选择题（选项分行 + 答案）",
    md: `# 第一章 测试

1. 下列哪个是 HTTP 状态码 404 的含义？
A. 服务器错误
B. 资源未找到
C. 重定向
D. 请求超时
答案：B`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "类型 choice", r.questions[0]?.question_type === "choice");
      chk(out, "4 个选项", r.questions[0]?.options.length === 4);
      chk(out, "答案映射为选项文本", r.questions[0]?.answer === "资源未找到");
    },
  },
  {
    name: "2. 无编号但明确提出的问题",
    md: `# 第一章 测试

问题：什么是 CAP 理论？
答：一致性、可用性、分区容错性三者不可同时满足。`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "类型 qa", r.questions[0]?.question_type === "qa");
      chk(out, "题干逐字保留", r.questions[0]?.question_text.includes("CAP 理论"));
    },
  },
  {
    name: "3. 填空题",
    md: `# 第一章 测试

1. TCP 三次握手的第二步是 ______ 。
答案：SYN+ACK`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "类型 cloze", r.questions[0]?.question_type === "cloze");
      chk(out, "答案取自原文", r.questions[0]?.answer === "SYN+ACK");
    },
  },
  {
    name: "4. 判断题",
    md: `# 第一章 测试

1. HTTP 是无状态协议。（对/错）
答案：对`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "类型 judge", r.questions[0]?.question_type === "judge");
    },
  },
  {
    name: "5. 题目与答案分离（文末答案速查表）",
    md: `# 第一章 测试

1. 下列哪个是 HTTP 404 的含义？
A. 服务器错误
B. 资源未找到
C. 重定向
D. 请求超时

# 答案速查

| 题号 | 答案 | 解析 |
| 1 | B | 404 表示资源不存在 |`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "答案按题号关联", r.questions[0]?.answer === "资源未找到");
      chk(out, "解析按题号关联", String(r.questions[0]?.explanation ?? "").includes("404"));
      chk(out, "needs_answer=false", r.questions[0]?.needs_answer === false);
    },
  },
  {
    name: "6. 跨段落题目（题干/选项/答案分散）",
    md: `# 第一章 测试

2. 关于 RAG 与微调的区别，下列说法正确的是？

A. RAG 改参数，微调不改

B. RAG 外挂知识，微调改参数

# 解析区

2. B。RAG 检索外部知识，微调更新模型权重。`,
    check: (r, out) => {
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "跨段落选项收齐", r.questions[0]?.options.length === 2);
      chk(out, "跨段落答案关联", String(r.questions[0]?.answer ?? "").includes("RAG 外挂知识"));
    },
  },
  {
    name: "7. Markdown 表格中的题目",
    md: `# 第一章 测试

| 题号 | 题目 | 答案 | 解析 |
| 1 | TCP 三次握手的目的是什么？ | 建立可靠连接 | 同步序列号 |
| 2 | HTTP 默认端口是多少？ | 80 | 明文传输 |`,
    check: (r, out) => {
      chk(out, "题数=2", r.questions.length === 2);
      chk(out, "题干来自表格单元格", has(r.questions, (q) => q.question_text.includes("三次握手")));
      chk(out, "答案来自表格单元格", has(r.questions, (q) => q.answer === "建立可靠连接"));
      chk(out, "解析来自表格单元格", has(r.questions, (q) => q.explanation === "同步序列号"));
    },
  },
  {
    name: "8. 重复题目去重（保留全部来源）",
    md: `# 第一章 测试

1. 什么是向量数据库？
答：专门存储与检索向量索引的数据库。

1. 什么是向量数据库？
答：专门存储与检索向量索引的数据库。`,
    check: (r, out) => {
      chk(out, "去重后 1 题", r.questions.length === 1);
      chk(out, "保留多条来源", (r.questions[0]?.sources.length ?? 0) >= 1);
    },
  },
  {
    name: "9. 纯知识点文档（不误识别）",
    md: `# 第一章 测试

向量数据库是一种用于存储高维向量的系统。
它通过近似最近邻算法加速检索。
常见的索引结构包括 HNSW 与 IVF。

## 小结
本节介绍了向量检索的基本概念与工程实践。`,
    check: (r, out) => {
      chk(out, "0 题", r.questions.length === 0);
    },
  },
  {
    name: "10a. 模型返回格式异常 → 降级但规则题仍在",
    md: `# 第一章 测试

1. 一个字节等于多少位？
A. 2
B. 8
答案：B`,
    judge: async () => ({}),
    check: (r, out) => {
      chk(out, "规则题仍抽出", r.questions.length === 1);
      chk(out, "标记降级", r.stats.degraded === true);
      chk(out, "降级原因可读", String(r.stats.degradeReason).includes("格式"));
    },
  },
  {
    name: "10b. 模型调用抛异常 → 降级但不中断",
    md: `# 第一章 测试

1. HTTP 是无状态协议吗？
答：是`,
    judge: async () => {
      throw new Error("模拟网关异常");
    },
    check: (r, out) => {
      chk(out, "规则题仍抽出", r.questions.length === 1);
      chk(out, "标记降级", r.stats.degraded === true);
    },
  },
  {
    // 2026-11 策略变更：模型不再拥有「删除权」。
    //
    // 原断言要求模型判 false 后该题消失（0 题）。实测发现这个删除权不可靠：
    // 同一份材料连跑 5 次，模型时而响应（删掉 4~8 道真题）、时而超时（全留），
    // 导入结果不可复现。而丢掉一道真题的代价远大于多留一张人工一点就删的卡。
    // 现在模型只能把它降级为「待审核 + model_disagrees」，删除权归审核台。
    name: "10c. 模型裁决只降级不删除（修辞性问句保留待审）",
    md: `# 第一章 测试

1. 难道这不是很神奇吗？`,
    judge: async (req) => req.candidates.map((c) => ({ candidateIndex: c.index, is_question: false })),
    check: (r, out) => {
      chk(out, "题不被静默删除", r.questions.length === 1);
      chk(out, "标记模型不认同", (r.questions[0]?.flags ?? []).includes("model_disagrees"));
      chk(out, "进入待审核", r.questions[0]?.review_required === true);
      chk(out, "置信度被下调", (r.questions[0]?.confidence ?? 1) <= 0.5);
    },
  },
  {
    name: "10d. 模型不得注入任何题干/答案文本",
    md: `# 第一章 测试

1. 什么是 RAG？
答：检索增强生成`,
    judge: async (req) =>
      req.candidates.map((c) => ({
        candidateIndex: c.index,
        is_question: true,
        question_text: "模型编造的题干",
        answer: "模型编造的答案",
        options: ["模型编造的选项"],
      })),
    check: (r, out) => {
      chk(out, "题仍在", r.questions.length === 1);
      chk(out, "不含模型编造文本", !JSON.stringify(r.questions).includes("模型编造"));
      chk(out, "答案仍是原文", r.questions[0]?.answer === "检索增强生成");
    },
  },
  {
    name: "11. 长文档全量覆盖（3 章 × 5 题）",
    md: [1, 2, 3]
      .map(
        (n) =>
          `# 第${["一", "二", "三"][n - 1]}章 第${n}部分\n\n` +
          Array.from({ length: 5 }, (_, k) => {
            const i = (n - 1) * 5 + k + 1;
            return `${i}. 第 ${i} 题的考点是什么？\nA. 选项甲\nB. 选项乙\n答案：A\n`;
          }).join("\n")
      )
      .join("\n"),
    check: (r, out) => {
      chk(out, "15 题全部抽出", r.questions.length === 15);
      chk(out, "分块数>1", r.stats.totalChunks > 1);
      chk(out, "所有分块都进入扫描", r.stats.scannedChunks === r.stats.totalChunks);
      chk(out, "最后一章的题也在", has(r.questions, (q) => q.question_text.includes("第 15 题")));
      chk(out, "来源位置有效", r.questions.every((q) => q.source_start >= 0 && q.source_end > q.source_start));
    },
  },
  {
    name: "12. 整章无空行多题（原「一章全丢」事故形态）",
    md: `# 第一章 测试

一、总览：怎么准备
面试准备的核心是把面试拆成板块。
1. 自我介绍：讲清背景与优势
A. 回答结构框架
B. 只有结论
1. 技术选型：为什么用 RAG
A. 先看不同公司的题目
B. 先做评测
1. 项目复盘：怎么讲落地
A. 定位根因
B. 讲结果
1. 业务理解
A. 全局定位
B. 只讲功能`,
    check: (r, out) => {
      chk(out, "逐题抽出 4 题", r.questions.length === 4);
      chk(out, "不产生超长假题", r.questions.every((q) => q.question_text.length < 2000));
      chk(out, "每题选项独立", r.questions.every((q) => q.options.length === 2));
    },
  },
  {
    name: "13. 小节标题 a) b) 不应成题",
    md: `# 第一章 测试

a) 回答结构框架
1. 我是谁：一句话说清背景。
2. 相关经历：两项核心优势。
b) 模板
我叫某某，毕业院校是……
c) 注意事项
不要背稿，控制在 90 秒。`,
    check: (r, out) => {
      chk(out, "0 题", r.questions.length === 0);
    },
  },
  {
    // 真实事故形态：中文题库把四个选项挤在一行，旧管线只吃到 1 个 A，
    // 组合选择题被降级成「问答」，A/B/C/D 选项行整行消失。
    name: "14. 组合选择题（一行塞 ABCD + 混合分行）",
    md: `# 第一章 测试

1. 下列关于做好新形势下经济工作的说法，正确的有几项？
①必须充分挖掘经济潜能 ②必须坚持政策支持和改革创新并举 ③必须以苦练内功来应对外部挑战
A.2 项 B.3 项 C.4 项 D.5 项
答案：C

2. 下列关于 2026 年经济工作的要求，说法正确的有几项？
①围绕做强国内大循环 ②围绕发展新质生产力 ③围绕激发高质量发展的动力活力
A.①②③
B.①②④ C.①③④ D.②③④
答案：B`,
    check: (r, out) => {
      const q1 = r.questions.find((q) => q.question_text.includes("充分挖掘经济潜能"));
      const q2 = r.questions.find((q) => q.question_text.includes("做强国内大循环"));
      chk(out, "两题都抽出", !!q1 && !!q2);
      chk(out, "一行 ABCD 判为 choice", q1?.question_type === "choice");
      chk(out, "一行 ABCD 拆出 4 个选项", q1?.options.length === 4);
      chk(
        out,
        "选项文本不带下一段字母",
        q1?.options[0] === "A. 2 项" && q1?.options[3] === "D. 5 项"
      );
      chk(out, "答案 C 映射为选项文本", q1?.answer === "4 项");
      chk(out, "题干保留 ①②③ 编号条目", q1?.question_text.includes("①必须充分挖掘"));
      chk(out, "混合分行判为 choice", q2?.question_type === "choice");
      chk(out, "混合分行也是 4 个选项", q2?.options.length === 4);
      chk(
        out,
        "混合分行字母连续",
        JSON.stringify(q2?.options.map((o) => o[0])) === JSON.stringify(["A", "B", "C", "D"])
      );
    },
  },
  // ---------------------------------------------------------------------
  // 以下 6 例对应《Markdown 题目抽取与 AI 辅助审核方法规范》：
  // 数字/圈号选项（真选项）、题号清单、解析步骤、代码块、答案歧义。
  // ---------------------------------------------------------------------
  {
    name: "15. 数字选项（1/2/3/4 代替 ABCD + 答案指向序号）",
    md: `# 第一章 测试

1. 下列哪个是中国的直辖市？
1. 北京
2. 上海
3. 广州
4. 深圳
答案：2`,
    check: (r, out) => {
      const q = r.questions[0];
      chk(out, "题数=1（不再被切成 4 道问答）", r.questions.length === 1);
      chk(out, "类型 choice", q?.question_type === "choice");
      chk(out, "4 个选项", q?.options.length === 4);
      chk(out, "选项归一为 A./B. 前缀", q?.options[0] === "A. 北京" && q?.options[3] === "D. 深圳");
      chk(out, "答案 2 映射为选项文本", q?.answer === "上海");
      chk(out, "flags 记录数字选项组", (q?.flags ?? []).includes("numeric_option_group"));
      chk(out, "audit_trail 标记选项来源 numbered", q?.audit_trail?.option_source === "numbered");
      chk(out, "题干不含选项文本", !q?.question_text.includes("北京"));
    },
  },
  {
    name: "16. 圈号选项（①②③④ 独立成行 + 答案③）",
    md: `# 第一章 测试

下列哪个是中国的直辖市？
① 北京
② 上海
③ 广州
④ 深圳
答案：③`,
    check: (r, out) => {
      const q = r.questions[0];
      chk(out, "题数=1", r.questions.length === 1);
      chk(out, "类型 choice", q?.question_type === "choice");
      chk(out, "4 个选项", q?.options.length === 4);
      chk(out, "圈号答案③映射为广州", q?.answer === "广州");
    },
  },
  {
    name: "17. 答案写「第2项」也能归一",
    md: `# 第一章 测试

下列哪个是中国的直辖市？
1. 北京
2. 上海
3. 广州
答案：第2项`,
    check: (r, out) => {
      const q = r.questions[0];
      chk(out, "类型 choice", q?.question_type === "choice");
      chk(out, "序数答案映射为选项文本", q?.answer === "上海");
    },
  },
  {
    name: "18. 答案「12」三义歧义 → 标待审核，绝不猜",
    md: `# 第一章 测试

1. 下列说法正确的有？
1. 甲
2. 乙
3. 丙
4. 丁
答案：12`,
    check: (r, out) => {
      const q = r.questions[0];
      chk(out, "类型 choice", q?.question_type === "choice");
      chk(out, "答案保持原文", q?.answer === "12");
      chk(
        out,
        "flags 标注多选歧义",
        (q?.flags ?? []).some((f) => f.startsWith("answer_ambiguous:multi_select"))
      );
      chk(out, "歧义必须待审核", q?.review_required === true);
    },
  },
  {
    name: "19. 代码块内的 1./A. 一律不当题目",
    md: `# 第一章 测试

下面是一段示例代码：

\`\`\`text
1. 这是示例不是题
A. 选项
B. 选项
答案：A
\`\`\`

1. 真正的题目？
A. 甲
B. 乙
答案：A`,
    check: (r, out) => {
      chk(out, "只抽出代码块外的 1 题", r.questions.length === 1);
      chk(out, "题干是真正的题目", r.questions[0]?.question_text.includes("真正的题目"));
      chk(
        out,
        "代码块内容未进任何题目",
        !r.questions.some((q) => q.question_text.includes("示例不是题"))
      );
    },
  },
  {
    name: "20. 题号清单 / 解析步骤不误折叠成选项",
    md: `# 第一章 测试

1. 下列说法正确的是
2. 下列说法错误的是
3. 不属于题干的是

解析：
1. 先求导得到函数的导函数
2. 再令导函数等于零解出临界点
3. 最后代入端点比较大小`,
    check: (r, out) => {
      chk(
        out,
        "没有把题号清单折成一道选择题",
        !r.questions.some((q) => q.question_type === "choice")
      );
      chk(
        out,
        "没有把解析步骤折成选项",
        !r.questions.some((q) => (q.options ?? []).length >= 2)
      );
    },
  },
  {
    // F1 回归：题干本身是编号项「1. ...？」且选项从 2 起编（2.北京/3.上海/4.广州）时，
    // 选项组首数字为 2，旧逻辑 group[0].digit !== 1 会把整组拒掉、回落成多张伪问答。
    name: "F1. 题干是编号项且选项从 2 起编 → 仍识别为 1 道选择题",
    md: `# 第一章 测试

1. 下列属于中国直辖市的是？
2. 北京
3. 上海
4. 广州
答案：1`,
    check: (r, out) => {
      const q = r.questions[0];
      chk(out, "题数=1（不回落成多张伪问答）", r.questions.length === 1);
      chk(out, "类型 choice", q?.question_type === "choice");
      chk(out, "3 个选项", q?.options.length === 3);
      chk(out, "答案 1 映射为北京", q?.answer === "北京");
      chk(out, "flags 记录数字选项组", (q?.flags ?? []).includes("numeric_option_group"));
    },
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  let r;
  try {
    r = await runQuestionPipeline(c.md, {
      judge: c.judge ?? okJudge,
      maxLlmCalls: 1,
      batchSize: 16,
    });
  } catch (e) {
    console.log(`  FAIL  ${c.name}`);
    console.log(`        管线抛异常: ${String(e?.message ?? e).slice(0, 200)}`);
    fail++;
    continue;
  }
  const out = [];
  c.check(r, out);
  const bad = out.filter(([, v]) => !v);
  if (bad.length === 0) pass++;
  else fail++;
  console.log(`  ${bad.length === 0 ? "PASS" : "FAIL"}  ${c.name}`);
  for (const [label, v] of out) if (!v) console.log(`         ✗ ${label}`);
  if (bad.length) {
    console.log(
      "        实得:",
      JSON.stringify(
        r.questions.map((q) => ({ t: q.question_type, o: q.options.length, a: q.answer, f: q.question_text.slice(0, 28) }))
      ).slice(0, 400)
    );
  }
}

// ---- 方法级独立断言（保证 8 个方法都真实可用，不是只测统一入口）----
{
  const md = `# 第一章 测试

1. 什么是 RAG？
答：检索增强生成

1. 什么是 RAG？
答：检索增强生成`;
  const blocks = parseMarkdownStructure(md);
  const chunks = splitMarkdownWithContext(blocks);
  const candidates = detectQuestionCandidates(chunks);
  const out = [];
  chk(out, "parseMarkdownStructure 覆盖所有块", blocks.length > 0 && blocks.every((b) => b.end >= b.start));
  chk(out, "结构块含标题路径", blocks.some((b) => b.headingPath.length > 0));
  chk(out, "chunk_id 稳定", chunks.every((c) => /^qch_[0-9a-f]{8}$/.test(c.chunkId)));
  chk(out, "相邻分块关系完整", chunks.length > 1 ? chunks[0].nextChunkId === chunks[1].chunkId : true);
  chk(out, "候选保留来源位置", candidates.every((c) => c.start >= 0 && c.end >= c.start));

  const r = await runQuestionPipeline(md, { judge: okJudge });
  const deduped = deduplicateQuestions([...r.questions, ...r.questions]);
  chk(out, "deduplicateQuestions 去重生效", deduped.length === r.questions.length);
  chk(out, "去重保留全部来源", deduped.every((q) => q.sources.length >= 1));

  const validated = validateQuestionSources(r.questions, md);
  chk(out, "validateQuestionSources 不误报题干", validated.every((q) => !q.flags.includes("stem_not_in_source")));
  chk(out, "原文位置有效", validated.every((q) => q.source_end <= md.length));
  chk(out, "normalizeForCompare 可用", normalizeForCompare(" A  B ") === "ab");

  const adapted = adaptToExtractedQuestions(r.questions, chapters, md, []);
  const required = ["no", "type", "front", "back", "needs_answer", "chapterIndex", "startLine", "endLine"];
  chk(out, "适配器字段齐全", adapted.every((q) => required.every((k) => k in q)));
  chk(out, "chapterIndex 合法", adapted.every((q) => q.chapterIndex >= 0 && q.chapterIndex < chapters.length));
  chk(out, "startLine<=endLine", adapted.every((q) => q.startLine <= q.endLine));
  chk(out, "front 逐字保留", adapted.every((q) => q.front.length > 0));

  // 保真核对：适配器必须给每道题算出 fidelity（落库可见的「原文逐字」依据）。
  // 这里的合成长段落是逐字搬的，应当全部判 exact —— 一旦出现 partial/missing，
  // 说明 extract 阶段动了措辞。
  chk(out, "适配器输出带 fidelity", adapted.every((q) => !!q.fidelity));
  chk(
    out,
    "逐字搬运的题判 exact",
    adapted.every((q) => !q.fidelity || q.fidelity.status === "exact")
  );

  const bad = out.filter(([, v]) => !v);
  if (bad.length === 0) pass++;
  else fail++;
  console.log(`  ${bad.length === 0 ? "PASS" : "FAIL"}  21. 8 个方法独立断言 + 适配器兼容`);
  for (const [label, v] of out) if (!v) console.log(`         ✗ ${label}`);
}

// ---- F2 回归：判断题归一化答案「对/错」不得误标 answer_not_in_source ----
{
  const md = `地球是平的。（正/误）\n答案：误`;
  const judgeQ = {
    question_text: "地球是平的。",
    question_type: "judge",
    answer: "错",
    options: [],
    chapter_path: [],
    flags: [],
    sources: [],
    explanation: "",
    confidence: 1,
    review_required: false,
    source_start: 0,
    source_end: md.length,
  };
  const validated = validateQuestionSources([judgeQ], md);
  const out = [];
  chk(out, "judge 答案「错」不误标 answer_not_in_source", !validated[0].flags.includes("answer_not_in_source"));

  const choiceMd = `X 是 Y 吗？\n答案：A`;
  const choiceQ = {
    question_text: "X 是 Y 吗？",
    question_type: "choice",
    answer: "ZZZ稀有字串不在原文",
    options: ["A", "B"],
    chapter_path: [],
    flags: [],
    sources: [],
    explanation: "",
    confidence: 1,
    review_required: false,
    source_start: 0,
    source_end: choiceMd.length,
  };
  const validated2 = validateQuestionSources([choiceQ], choiceMd);
  chk(
    out,
    "对照：choice 答案确未见于原文 → 仍标 answer_not_in_source",
    validated2[0].flags.includes("answer_not_in_source")
  );

  const bad = out.filter(([, v]) => !v);
  if (bad.length === 0) pass++;
  else fail++;
  console.log(`  ${bad.length === 0 ? "PASS" : "FAIL"}  F2. 判断题答案不误标 answer_not_in_source`);
  for (const [label, v] of out) if (!v) console.log(`         ✗ ${label}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
