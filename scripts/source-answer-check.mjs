// 原文答案定位器回归：npm run check:sourceanswer
//
// 守的是「答案框里必须是原文标准答案」这条产品规则，而不是某个正则：
//   1. `**参考答案：**` 独占一行的格式（本库最常见）能拿到**整段**答案，不是第一句
//   2. `答案：xxx` 同行 + 后面还有续写段落时，续写不能丢（旧实现丢的就是它）
//   3. 撞到下一题 / 解析小标题就停 —— 答案里不许混进别的题或解析
//   4. 题干对不上就不猜（返回 null，退回 AI 路径）
//   5. 短答案也是答案（「检索增强生成」），但要挡住「把题干抄一遍」
//   6. 答案被切到相邻片段时，能跨片段找到
//   7. **无标签、靠排版表达的问答对**：题干独占一段、答案在紧邻的下一段
//      （《Agent Harness 与编码代理测评》整本书都是这个写法）
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { extractAnswerFromText, findSourceAnswer, findAdjacentAnswer } = await import(
  pathToFileURL(path.join(root, "src/lib/cards/source-answer.ts")).href
);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  ← " + extra : ""}`);
  }
};

// ---- 夹具 1：真实书的格式（《初创公司面试题与面经》） ----
const Q1 = "如何用最小成本快速搭建一个可上线的 Agent 产品？技术选型的核心原则是什么？";
const F1 = `### Q: ${Q1}
**💡 思考逻辑：** 初创公司资源有限，面试官考察你的务实工程能力和成本意识。

**参考答案：**
初创 Agent 快速落地原则：1）能用 API 就不自己训模型——用 OpenAI/Claude API 作为推理引擎；2）能用规则就不用 LLM——简单意图识别用正则匹配，成本可降 80%；3）框架选型——LangChain 快速原型 → 验证 PMF 后再考虑自研；4）MVP 功能集——先做 3-5 个核心工具；5）评估先行——上线前准备 100+ 测试用例；6）基础设施——用 Serverless 部署，按调用量付费；7）存储——对话状态用 Redis，知识库用 Supabase pgvector。整体原则：验证商业价值 > 技术完美。

### Q: Agent 产品的 PMF 怎么验证？
**参考答案：**
留存率 7 日 > 40% 才有价值。`;

const g1 = extractAnswerFromText(Q1, F1);
ok("标准格式能命中", !!g1);
ok("拿到的是整段答案而不是第一句", !!g1 && g1.text.length > 200, `len=${g1?.text.length}`);
ok("七条要点都在（含第 7 条的 Redis / pgvector）", !!g1 && /Redis/.test(g1.text) && /Supabase pgvector/.test(g1.text));
ok("没有把下一题吃进来", !!g1 && !/PMF 怎么验证|留存率/.test(g1.text), g1?.text.slice(-60));
ok("去掉了 markdown 加粗符", !!g1 && !/\*\*/.test(g1.text));
ok("没有把「思考逻辑」混进答案", !!g1 && !/思考逻辑|面试官考察/.test(g1.text));

// ---- 夹具 2：同行答案 + 续写段落（旧实现只抄同行那一句） ----
const Q2 = "什么是过拟合和欠拟合？";
const F2 = `问：${Q2}
答案：过拟合指训练集表现好但测试集差。
欠拟合指模型太简单，连训练集都拟合不好。

解析：这是机器学习最基础的考点。`;
const g2 = extractAnswerFromText(Q2, F2);
ok("同行答案能命中", !!g2);
ok("续写段落不丢（欠拟合那句在）", !!g2 && /欠拟合指模型太简单/.test(g2.text), g2?.text);
ok("遇到「解析：」就停", !!g2 && !/最基础的考点/.test(g2.text), g2?.text);

// ---- 夹具 3：题干对不上 ----
ok("题干不匹配时返回 null", extractAnswerFromText("量子计算的优势是什么？", F1) === null);
ok("片段里没有答案标签时返回 null", extractAnswerFromText(Q1, `### Q: ${Q1}\n只有题干没有答案。`) === null);

// ---- 夹具 4：短答案 / 抄题干 ----
const Q4 = "什么是 RAG？";
const short = extractAnswerFromText(Q4, `Q: ${Q4}\n答案：检索增强生成`);
ok("短答案是答案（不因太短被丢）", !!short && short.text === "检索增强生成", short?.text);
const echo = findSourceAnswer(Q4, [{ id: "f1", content: `Q: ${Q4}\n答案：什么是 RAG`, chapter_id: null }]);
ok("把题干抄一遍不算答案", echo === null, echo?.text);

// ---- 夹具 5：答案被切到相邻片段 ----
const Q5 = "分块大小怎么定？";
const partA = { id: "a", content: `### Q: ${Q5}\n**参考答案：**`, chapter_id: "ch1" };
const partB = { id: "b", content: `256-512 tokens 比较稳妥；太大召回噪声多，太小上下文不完整。`, chapter_id: "ch1" };
const onlyA = findSourceAnswer(Q5, [partA]);
const both = findSourceAnswer(Q5, [partA, partB]);
ok("只有题干所在片段时找不到答案（标签后为空）", onlyA === null);
ok("给了相邻片段就能拿到（跨片段拼接）", !!both && /256-512/.test(both.text), both?.text ?? "null");

// ---- 夹具 6：多片段时优先匹配度高、内容更完整的 ----
const noise = { id: "n", content: "无关段落：服务器部署与网络配置说明。", chapter_id: null };
const pick = findSourceAnswer(Q1, [noise, { id: "g", content: F1, chapter_id: "ch1" }]);
ok("多个片段时挑对的那一个", !!pick && pick.fragment_id === "g", pick?.fragment_id);
ok("命中片段带 chapter_id，便于定位原文", !!pick && pick.chapter_id === "ch1");

// ---- 夹具 7：无标签的问答对排版（《Agent Harness 与编码代理测评》真结构复刻） ----
// 这本书原文是「题干独占一段 + 答案一段（引用块）」，两段之间没有任何「答案：」字样，
// 分片又恰好按题目切开，答案落在下一片。以前只认标签，整本书都被判成「原文未给出」。
const Q7 = "AutoGen 的代码执行器为什么默认本地有风险？生产如何隔离？";
const f7q = { id: "q", content: `**8. ${Q7}**`, chapter_id: "ch7" };
const f7a = {
  id: "a",
  content:
    "> 本地执行器直接以进程身份运行任意代码，等于把宿主机暴露给模型输出。生产应使用 `DockerCommandLineCodeExecutor` / Jupyter 等隔离执行环境，并配合网络与资源限制。",
  chapter_id: "ch7",
};
const f7next = { id: "n", content: "**9. 长任务上下文放不下时有哪些手段？各自取舍？**", chapter_id: "ch7" };

ok("问答对排版：标签路径在该书上落空（原文确实没有「答案：」）", findSourceAnswer(Q7, [f7q, f7a, f7next]) === null);
const adj7 = findAdjacentAnswer(Q7, [f7q, f7a, f7next]);
ok("问答对排版：能拿到下一段的答案", !!adj7);
ok("问答对排版：拿到的是整段而不是空", !!adj7 && adj7.text.length > 60, `len=${adj7?.text.length}`);
ok("问答对排版：保留了原文的关键类名", !!adj7 && /DockerCommandLineCodeExecutor/.test(adj7.text), adj7?.text.slice(0, 40));
ok("问答对排版：去掉了引用符 >", !!adj7 && !/^>/.test(adj7.text), adj7?.text.slice(0, 20));
ok("问答对排版：没把下一题吃进来", !!adj7 && !/长任务上下文/.test(adj7.text), adj7?.text.slice(-40));
ok("问答对排版：命中片段指向答案所在的那一片", !!adj7 && adj7.fragment_id === "a", adj7?.fragment_id);

// 答案里带编号分点时，不能被误判成「下一道题」而截断
const f7steps = { id: "s", content: "> 四步：1. 沙箱隔离 2. 网络限制 3. 资源配额 4. 临时环境", chapter_id: "ch7" };
const adjSteps = findAdjacentAnswer(Q7, [f7q, f7steps, f7next]);
ok("问答对排版：答案里的编号分点不当成下一题", !!adjSteps && /临时环境/.test(adjSteps.text), adjSteps?.text);

// 「解析」之后的内容不属于答案
const f7tail = { id: "t", content: "> 答案正文在这里，这一句本身够长可以过关。\n解析：这段是解析，不该进答案。", chapter_id: "ch7" };
const adjTail = findAdjacentAnswer(Q7, [f7q, f7tail]);
ok("问答对排版：遇到「解析」就停", !!adjTail && !/这段是解析/.test(adjTail.text), adjTail?.text);

// 题干后面本来就是下一个题（这题没给答案）→ 不猜
const adjNoAnswer = findAdjacentAnswer(Q7, [f7q, { id: "x", content: "**9. 完全不相干的问题？**", chapter_id: "ch7" }]);
ok("问答对排版：下一片就是另一道题时不猜", adjNoAnswer === null, adjNoAnswer?.text);

// 答案就在同一片段里（题干后面还跟着大段正文）→ 不走这条路，免得把正文当答案
const f7inline = {
  id: "i",
  content: `**8. ${Q7}**\n这一片段里题干后面还跟着五十来个字的正文，说明答案本来就落在同一片，不该由问答对路径去接。`,
  chapter_id: "ch7",
};
ok("同片段内题干后还有大段正文时不走问答对路径", findAdjacentAnswer(Q7, [f7inline, f7a]) === null);

// 只有题干、后面什么都没有 → 不猜
ok("问答对排版：只有题干片段时返回 null", findAdjacentAnswer(Q7, [f7q]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
