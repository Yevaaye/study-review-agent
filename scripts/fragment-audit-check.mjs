// 「原文查依据 · 题目识别核对」回归 —— npm run check:fragmentaudit
//
// 现场：用户在原文页发现「这段明明有题，卡却只有一张」。
// 核对面板要能把一段原文按知识点切块、扫出候选、标出「已识别 / 遗漏」，
// 并支持 AI 判定与人工录入两条出口。
// 这里锁住纯函数：分块、候选扫描、对齐、裁决合并、覆盖率、人工录入规整、AI 输出收口。

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
const F = await import(pathToFileURL(`${base}/audit/fragment-questions.ts`).href);

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

const SAMPLE = `## 3.1 RAG 与微调的区别

RAG 是检索增强生成，微调是改模型参数。

问题：RAG 和微调的核心区别是什么？
答案：RAG 不改参数、靠检索；微调改参数、靠训练。

### 3.1.1 怎么选

1. 问题本质是"不知道"还是"做不好"?——决定走 RAG 还是微调。
2. 知识更新有多快?——越快越该用 RAG。
3. 团队有没有持续维护能力?——都没有时把 Prompt 做到极致。

### 3.1.2 选择题

下列哪项属于 RAG 的优点？
A. 知识可实时更新
B. 需要训练算力
C. 无法溯源

答案：A`;

const blocks = F.splitKnowledgeBlocks(SAMPLE);
chk("按标题切成 3 个知识点块", blocks.length === 3, `got ${blocks.length}`);
chk("块标题取小标题原文", blocks[0].heading.includes("RAG 与微调的区别"), blocks[0].heading);
chk("块正文不含标题行", !blocks[0].text.startsWith("#"), blocks[0].text.slice(0, 20));
chk("块正文是原文连续切片", SAMPLE.includes(blocks[0].text.trim()));

const rows = F.scanCandidates(blocks);
const qaRow = rows.find((r) => r.excerpt.includes("RAG 和微调的核心区别"));
chk("扫出「问题：/答案：」字段式的问答题", !!qaRow, rows.map((r) => r.signals.join(",")).join(" | "));
chk("字段式候选识别到 answer 信号", qaRow?.signals.includes("answer") === true);
chk("答案被抽进候选", qaRow?.answer.includes("不改参数") === true, qaRow?.answer);

const choiceRow = rows.find((r) => r.options.length >= 2);
chk("扫出带 A/B/C 选项的选择题", !!choiceRow);
chk("选择题题型判定为 choice", choiceRow?.kind === "choice");
chk("选项数正确（3 项）", choiceRow?.options.length === 3, String(choiceRow?.options.length));

const listRow = rows.find((r) => r.excerpt.includes("问题本质是"));
chk(
  "编号建议清单只作为弱候选进列表（不算已识别）",
  !!listRow && listRow.status === "pending",
  listRow ? JSON.stringify(listRow.signals) : "未扫到"
);

console.log("\n[2] 候选与已有卡片对齐");
{
  const matched = F.matchIdentified(rows, [
    { id: "c_qa", front: "RAG 和微调的核心区别是什么？" },
    { id: "c_choice", front: "**下列哪项属于 RAG 的优点？**" },
  ]);
  const qa = matched.find((r) => r.id === qaRow.id);
  const ch = matched.find((r) => r.id === choiceRow.id);
  chk("题干带 Markdown 强调也能对上", ch?.card_id === "c_choice", JSON.stringify(ch?.card_id));
  chk("对上的标为已识别", qa?.status === "identified");
  chk("没对上的仍是待判定", matched.filter((r) => !r.card_id).every((r) => r.status === "pending"));

  const rematched = F.matchIdentified([{ ...matched[0], status: "identified", card_id: "gone" }], []);
  chk("卡片被删后不会残留「已识别」", rematched[0].status === "missing");
}

console.log("\n[3] AI 裁决合并");
{
  const ids = [qaRow.id, choiceRow.id];
  const merged = F.applyVerdicts(
    rows.map((r) => ({ ...r, card_id: null, status: "pending" })),
    [
      { id: ids[0], is_question: true, kind: "qa", reason: "一问一答", confidence: 0.9 },
      { id: ids[1], is_question: false, kind: null, reason: "只是选项罗列" },
    ]
  );
  const qa = merged.find((r) => r.id === ids[0]);
  const ch = merged.find((r) => r.id === ids[1]);
  chk("AI 说是题 → 标为遗漏", qa?.status === "missing");
  chk("AI 说不是题 → 标为非题目", ch?.status === "rejected");
  chk("非题目保留理由", ch?.verdict.includes("选项罗列"));

  const unsure = F.applyVerdicts(rows.slice(0, 1), [{ id: rows[0].id, is_question: null, reason: "拿不准" }]);
  chk("AI 拿不准 → 仍是待判定（交人工）", unsure[0].status === "pending" && unsure[0].verdict === "拿不准");

  const withCard = F.applyVerdicts([{ ...rows[0], card_id: "c1", status: "identified" }], [
    { id: rows[0].id, is_question: false, reason: "x" },
  ]);
  chk("已有卡片时 AI 说不是题也不撤销（人工再决定）", withCard[0].status === "identified");
}

console.log("\n[4] 覆盖率");
{
  const cov = F.coverage([
    { ...rows[0], status: "identified" },
    { ...rows[0], status: "missing" },
    { ...rows[0], status: "rejected" },
    { ...rows[0], status: "pending" },
  ]);
  chk("四类计数", cov.identified === 1 && cov.missing === 1 && cov.rejected === 1 && cov.pending === 1);
  chk("比率 = 已识别/总数", cov.ratio === 0.25);
  chk("空列表比率为 1（没有候选就不算遗漏）", F.coverage([]).ratio === 1);
}

console.log("\n[5] 人工录入规整");
{
  const choice = F.normalizeManualCard({
    front: "下列哪项属于 RAG 的优点？",
    options: "A. 可实时更新\nB. 需要训练\nC. 无法溯源",
    answer: "A",
    back: "",
  });
  chk("按行拆选项", choice?.options.length === 3 && choice.kind === "choice");
  chk("答案写到 answer", choice?.answer === "A");

  const qa = F.normalizeManualCard({ front: "什么是 RAG？", back: "检索增强生成" });
  chk("没选项 → 问答题", qa?.kind === "qa" && qa.back === "检索增强生成");

  const single = F.normalizeManualCard({ front: "只有一个选项的题", options: "A. 唯一" });
  chk("只有一项选项 → 退化成问答题（一项选项没意义）", single?.kind === "qa" && single.options.length === 0);

  chk("题干过短拒绝", F.normalizeManualCard({ front: "题?" }) === null);
  chk("畸形入参拒绝", F.normalizeManualCard(null) === null);
  chk("选项数组也支持", F.normalizeManualCard({ front: "哪项对？", options: ["A. 甲", "B. 乙"] })?.options.length === 2);
}

console.log("\n[6] 无标题原文也能分块");
{
  const plain = "第一段讲 RAG 的原理。\n\n第二段讲微调的代价。\n\n第三段讲两者怎么选。";
  const bs = F.splitKnowledgeBlocks(plain);
  chk("短的无标题段落保持一块（不硬切）", bs.length === 1, `got ${bs.length}`);
  chk("块标题用首句摘要", bs[0].heading.length > 0 && bs[0].heading.length <= 24, bs[0].heading);

  // 超长无标题正文必须切：单块 2000 字会让「段落级」候选扫描和「再次识别」都失去精度
  const longParas = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段说明。${"内容".repeat(120)}`);
  const longBlocks = F.splitKnowledgeBlocks(longParas.join("\n\n"), 900);
  chk("超长无标题正文按长度切块", longBlocks.length >= 2, `got ${longBlocks.length}`);
  chk("切出来的每块不超限太多", longBlocks.every((b) => b.text.length <= 1100));

  chk("空文本返回空数组", F.splitKnowledgeBlocks("   ").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
