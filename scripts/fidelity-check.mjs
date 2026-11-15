// 抽取保真 + 原文锚定回归。
// 运行：npm run check:fidelity
//
// 守两条线：
//   1) 抽取出来的题，字面必须来自原文（fidelity.ts）
//   2) AI 出题给的 evidence，必须真能在原文里找到（grounding.ts）
//
// 这两条一旦松掉，用户看到的卡看起来完全正常，但内容可能已经被改写或编造 ——
// 属于「静默错误」，只有自动化断言能守住。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = mkdtempSync(path.join(root, ".tmp-fidelity-check-"));

function compile() {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      path.join("src", "lib", "import", "fidelity.ts"),
      path.join("src", "lib", "cards", "grounding.ts"),
      path.join("src", "lib", "cards", "generate.ts"),
      "--outDir",
      outDir,
      "--module",
      "commonjs",
      "--target",
      "es2020",
      "--moduleResolution",
      "node",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  const req = createRequire(path.join(root, "package.json"));
  const find = (rel) => {
    for (const p of [path.join(outDir, rel), path.join(outDir, "lib", rel)]) {
      if (existsSync(p)) return p;
    }
    throw new Error(`编译产物没找到：${rel} in ${outDir}`);
  };
  return {
    fidelity: req(find("import/fidelity.js")),
    grounding: req(find("cards/grounding.js")),
    generate: req(find("cards/generate.js")),
  };
}

const { fidelity, grounding, generate } = compile();
const { checkFidelity } = fidelity;
const { isGroundedIn, sharesSourceRun, normForMatch } = grounding;
const { sanitize } = generate;

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  }
}

// ---------------------------------------------------------------------------
// 一份贴近真实材料的原文
// ---------------------------------------------------------------------------
const SOURCE = `# 第一章 财政政策

财政政策是指政府通过调整收支来影响总需求的政策。
它主要包括**支出政策**与**税收政策**两类。

## 1. 财政政策的工具

1. 下列哪项属于财政政策的工具？
A. 调整存款准备金率
B. 增加政府购买
C. 公开市场操作
D. 调整再贴现率
答案：B

2. 财政政策的主体是（　）。
答案：政府

## 2. 判断题

3. 财政政策由中央银行制定并执行。
答案：错
解析：财政政策由政府制定，货币政策才由央行负责。

4. 下列说法正确的有几项？①政府购买属于财政支出 ②税收属于财政收入 ③公开市场操作属于财政政策
A.1 项 B.2 项 C.3 项 D.0 项
答案：B`;

console.log("--- 1. 保真核对：正常抽取应判 exact ---");
{
  const r = checkFidelity(
    {
      question_text: "财政政策是指政府通过调整收支来影响总需求的政策。\n它主要包括支出政策与税收政策两类。",
      options: null,
      answer: "",
    },
    SOURCE
  );
  ok(r.status === "exact", "多行题干（去加粗）逐字命中 → exact", r);
  ok(r.front.coverage === 1, "题干 coverage = 1", r.front);
}

console.log("--- 2. 保真核对：选择题（答案=选项文本，不重复计分）---");
{
  const r = checkFidelity(
    {
      question_text: "下列哪项属于财政政策的工具？",
      options: ["A. 调整存款准备金率", "B. 增加政府购买", "C. 公开市场操作", "D. 调整再贴现率"],
      answer: "增加政府购买",
    },
    SOURCE
  );
  ok(r.status === "exact", "选项带字母前缀 + 答案回显选项 → exact", r);
  ok(r.options.exact && r.answer.exact, "选项与答案均为 exact", r);
}

console.log("--- 3. 保真核对：题干被改写应判 missing ---");
{
  const r = checkFidelity(
    {
      question_text: "财政政策指的是国家运用货币政策工具调节经济运行的宏观调控手段。",
      options: null,
      answer: "",
    },
    SOURCE
  );
  ok(r.status === "missing", "整句改写 → missing", r);
  ok(r.front.coverage < 0.6, "改写题 coverage < 0.6", r.front);
}

console.log("--- 4. 保真核对：少半句应判 partial ---");
{
  // 原文第一句逐字 + 第二句改写 → 覆盖度居中
  const r = checkFidelity(
    {
      question_text: "财政政策是指政府通过调整收支来影响总需求的政策。它涵盖支出与税收两个方面。",
      options: null,
      answer: "",
    },
    SOURCE
  );
  ok(r.status === "partial", "一半逐字一半改写 → partial", r);
  ok(r.front.coverage > 0.6 && r.front.coverage < 0.99, "coverage 落在 (0.6, 0.99)", r.front);
}

console.log("--- 5. 保真核对：判断/填空答案不参与字面校验 ---");
{
  const judge = checkFidelity(
    { question_text: "财政政策由中央银行制定并执行。", options: ["对", "错"], answer: "错" },
    SOURCE
  );
  ok(judge.status === "exact", "判断题答案「错」不触发不匹配", judge);

  const cloze = checkFidelity(
    { question_text: "财政政策的主体是（　）。", options: null, answer: "政府" },
    SOURCE
  );
  ok(cloze.status === "exact", "填空题答案「政府」在原文 → exact", cloze);
}

console.log("--- 6. 保真核对：编造的选项应被抓出 ---");
{
  const r = checkFidelity(
    {
      question_text: "下列哪项属于财政政策的工具？",
      options: ["A. 调整存款准备金率", "B. 增加政府购买", "C. 量化宽松购买国债", "D. 调整再贴现率"],
      answer: "增加政府购买",
    },
    SOURCE
  );
  ok(r.status !== "exact", "有一个选项是编的 → 不再 exact", r);
  ok(r.options.coverage < 1, "选项 coverage < 1", r.options);
}

console.log("--- 7. 归一化只抹排版，不动措辞 ---");
{
  const a = normForMatch("财政政策**是指**政府（调整）收支，　影响总需求。");
  const b = normForMatch("财政政策是指政府(调整)收支,影响总需求.");
  ok(a === b, "加粗/全角括号/全角空格/中文标点 → 归一一致", { a, b });
  ok(!normForMatch("财政政策").includes(normForMatch("货币政策")), "不同措辞不会被抹平");
}

console.log("--- 8. 原文锚定：逐字命中 ---");
{
  const hay = normForMatch(SOURCE);
  ok(isGroundedIn("财政政策是指政府通过调整收支来影响总需求的政策", hay), "整句逐字 → true");
  ok(
    isGroundedIn("政府通过调整收支来影响总需求", hay),
    "原文的子片段 → true"
  );
}

console.log("--- 9. 原文锚定：编造应被拒 ---");
{
  const hay = normForMatch(SOURCE);
  ok(
    !isGroundedIn("财政政策的核心目标是实现国际收支平衡与汇率稳定", hay),
    "原文没有的说法 → false"
  );
  ok(!isGroundedIn("", hay), "空 evidence → false");
}

console.log("--- 10. 原文锚定：跨行拼接仍算有据 ---");
{
  const hay = normForMatch(SOURCE);
  // 模型把两行拼成一句：单看整段查不到，但有 ≥12 字连续片段逐字命中
  ok(
    isGroundedIn("财政政策是指政府通过调整收支来影响总需求的政策，它主要包括支出政策与税收政策两类", hay),
    "跨行拼接（有 12 字连续命中）→ true"
  );
  // 「原文：」前缀（真实存在的写法：模型爱这么标来源）
  ok(
    isGroundedIn("原文：财政政策是指政府通过调整收支来影响总需求的政策", hay),
    "带「原文：」前缀 → true"
  );
}

console.log("--- 11. 同源判断：挡挂错知识点 ---");
{
  const kpA = "财政政策是指政府通过调整收支来影响总需求的政策";
  const kpB = "财政政策由中央银行制定并执行";
  ok(
    sharesSourceRun("政府通过调整收支来影响总需求", kpA),
    "同一段落的 evidence（子串）→ true"
  );
  ok(sharesSourceRun(kpB, kpA), "同一段落的两句话（共享主题词）→ true");
  ok(
    !sharesSourceRun("光的折射率由介质的密度决定", kpA),
    "完全不同话题 → false"
  );
  ok(
    !sharesSourceRun("货币政策由中央银行负责，主要工具包括存款准备金率", kpA),
    "相邻但不同主题（货币政策 vs 财政政策）→ false"
  );
  ok(sharesSourceRun("财政政策", kpA), "极短 evidence 是子串 → true");
  ok(sharesSourceRun("", kpA), "空 evidence 不做否定判断 → true");
}

console.log("--- 12. 出题闸门：编造的 evidence 会被丢弃 ---");
{
  const material =
    "财政政策是指政府通过调整收支来影响总需求的政策。财政政策的主体是政府。" +
    "货币政策由中央银行负责，主要工具包括存款准备金率与公开市场操作。";
  const raw = {
    knowledge_points: [],
    cards: [
      {
        kp_index: 0,
        card_type: "qa",
        front: "财政政策的主体是谁？",
        back: "政府",
        evidence: "财政政策的主体是政府", // 逐字命中
      },
      {
        kp_index: 0,
        card_type: "qa",
        front: "财政政策的传导时滞有多长？",
        back: "约 6 个月",
        evidence: "财政政策的传导时滞通常在六个月左右", // 原文没有 → 编造
      },
    ],
  };
  const out = sanitize(raw, 1, material, ["财政政策是指政府通过调整收支来影响总需求的政策"]);
  ok(out.cards.length === 1, "只保留有原文依据的卡", out.cards.length);
  ok(out.cards[0]?.front === "财政政策的主体是谁？", "保留的是有依据那张", out.cards[0]?.front);
  ok(
    (out.rejected.card_evidence_not_in_source ?? 0) === 1,
    "编造卡记入 card_evidence_not_in_source",
    out.rejected
  );
}

console.log("--- 13. 出题闸门：挂错知识点会被丢弃 ---");
{
  const material =
    "财政政策是指政府通过调整收支来影响总需求的政策。货币政策由中央银行负责，主要工具包括存款准备金率。";
  const raw = {
    knowledge_points: [],
    cards: [
      {
        kp_index: 1, // 指向「货币政策」那条
        card_type: "qa",
        front: "财政政策的定义是什么？",
        back: "政府通过调整收支影响总需求",
        evidence: "财政政策是指政府通过调整收支来影响总需求的政策", // 出自第 0 条
      },
    ],
  };
  const out = sanitize(raw, 2, material, [
    "财政政策是指政府通过调整收支来影响总需求的政策",
    "货币政策由中央银行负责，主要工具包括存款准备金率",
  ]);
  ok(out.cards.length === 0, "证据与所属知识点不同源 → 丢弃", out.cards.length);
  ok((out.rejected.card_kp_mismatch ?? 0) === 1, "记入 card_kp_mismatch", out.rejected);
}

console.log("--- 14. 出题闸门：知识点依据也必须出自原文 ---");
{
  const material = "财政政策是指政府通过调整收支来影响总需求的政策。";
  const raw = {
    knowledge_points: [
      { statement: "财政政策通过收支影响总需求", evidence: "财政政策是指政府通过调整收支来影响总需求的政策" },
      { statement: "国债收益率曲线倒挂预示衰退", evidence: "国债收益率曲线倒挂通常预示经济衰退" },
    ],
    cards: [],
  };
  const out = sanitize(raw, 0, material, []);
  ok(out.kps.length === 1, "只保留有原文依据的知识点", out.kps.length);
  ok((out.rejected.kp_evidence_not_in_source ?? 0) === 1, "记入 kp_evidence_not_in_source", out.rejected);
}

console.log("--- 15. 出题闸门：选择答案不在选项里会被丢弃 ---");
{
  const material = "财政政策的主要工具包括政府购买与转移支付。";
  const raw = {
    knowledge_points: [],
    cards: [
      {
        kp_index: 0,
        card_type: "choice",
        front: "下列哪项属于财政政策工具？",
        options: ["A. 政府购买", "B. 存款准备金率", "C. 公开市场操作"],
        answer: "再贴现率", // 不在选项中 → 无法判分
        evidence: "财政政策的主要工具包括政府购买与转移支付",
      },
    ],
  };
  const out = sanitize(raw, 1, material, ["财政政策的主要工具包括政府购买与转移支付"]);
  ok(out.cards.length === 0, "答案不在选项 → 丢弃", out.cards.length);
  ok((out.rejected.choice_answer_not_in_options ?? 0) === 1, "记入 choice_answer_not_in_options", out.rejected);
}

rmSync(outDir, { recursive: true, force: true });

console.log("");
console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 条）`);
process.exit(fail === 0 ? 0 : 1);
