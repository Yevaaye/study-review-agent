// 多选/单选答案解析回归 —— npm run check:answerkeys
//
// 现场：截图里的题只有 3 个选项，正确答案标了 A，用户问「为什么不是多选」。
// 排查发现两件事要一起解决：
//   1) 原文答案写成「①②③」「A、C」「AC」时，旧逻辑整串当答案，一个选项都高亮不了；
//   2) 复习页用「整串等于选项」判题，多选必然判错。
// 这里锁住解析（单选/多选/圈号/数字/文本）+ 集合判定 + 落库序列化。

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
const K = await import(pathToFileURL(`${base}/cards/answer-keys.ts`).href);
const O = await import(pathToFileURL(`${base}/cards/option-match.ts`).href);

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

const OPTS = [
  "A. 知识更新有多快?——越快越该用 RAG,微调维护成本会拖垮团队。",
  "B. 团队有没有持续维护能力?——都没有时,把 Prompt 做到极致往往性价比最高。",
  "C. 要不要给用户看引用来源?——合规、医疗、法律场景,RAG 几乎是唯一选项。",
];
const FOUR = ["A. 红", "B. 绿", "C. 蓝", "D. 黄"];

console.log("\n[1] 单选解析");
{
  const a = K.parseAnswerKeys("A", FOUR);
  chk("字母 A → 下标 0", JSON.stringify(a.keys) === "[0]" && a.multi === false, JSON.stringify(a));
  const b = K.parseAnswerKeys("（C）", FOUR);
  chk("全角括号（C）→ 下标 2", JSON.stringify(b.keys) === "[2]", JSON.stringify(b));
  const c = K.parseAnswerKeys("C. 蓝", FOUR);
  chk("带序号前缀的选项全文 → 下标 2", JSON.stringify(c.keys) === "[2]", JSON.stringify(c));
  const d = K.parseAnswerKeys("蓝", FOUR);
  chk("选项正文（无前缀）→ 下标 2", JSON.stringify(d.keys) === "[2]", JSON.stringify(d));
  const e = K.parseAnswerKeys("2", FOUR);
  chk("数字 2 → 下标 1", JSON.stringify(e.keys) === "[1]", JSON.stringify(e));
}

console.log("\n[2] 多选解析");
{
  const cases = [
    ["A、C", "[0,2]"],
    ["A,C", "[0,2]"],
    ["AC", "[0,2]"],
    ["A C", "[0,2]"],
    ["A和C", "[0,2]"],
    ["A/C", "[0,2]"],
  ];
  for (const [raw, want] of cases) {
    const r = K.parseAnswerKeys(raw, FOUR);
    chk(`「${raw}」→ ${want}（multi）`, JSON.stringify(r.keys) === want && r.multi === true, JSON.stringify(r));
  }
  const circled = K.parseAnswerKeys("①②", FOUR);
  chk("圈号 ①② → [0,1]", JSON.stringify(circled.keys) === "[0,1]" && circled.multi, JSON.stringify(circled));
  const digits = K.parseAnswerKeys("12", FOUR);
  chk("数字连写 12（越界）→ 拆成 [0,1]", JSON.stringify(digits.keys) === "[0,1]", JSON.stringify(digits));
  const texts = K.parseAnswerKeys("红；蓝", FOUR);
  chk("多段选项正文（分号）→ [0,2]", JSON.stringify(texts.keys) === "[0,2]", JSON.stringify(texts));
}

console.log("\n[3] 不该误判的形态");
{
  const bad = K.parseAnswerKeys("bad", ["A. 红", "B. 绿", "C. 蓝", "D. 黄"]);
  chk("英文单词 bad 不被拆成 B+A+D", bad.keys.length === 0, JSON.stringify(bad));
  const empty = K.parseAnswerKeys("", FOUR);
  chk("空答案 → 空下标、form=none", empty.keys.length === 0 && empty.form === "none");
  const noOpts = K.parseAnswerKeys("A", []);
  chk("没有选项时不瞎猜", noOpts.keys.length === 0);
  const outOfRange = K.parseAnswerKeys("Z", FOUR);
  chk("字母越界 → 空", outOfRange.keys.length === 0);
  const longText = K.parseAnswerKeys("越快越该用 RAG", OPTS);
  chk("答案只是选项的一部分 → 靠包含兜底命中", longText.keys.length === 1, JSON.stringify(longText));
}

console.log("\n[4] 集合判定（少选/多选都算错）");
{
  chk("完全一致 → 对", K.judgeSelection([0, 2], [0, 2]) === true);
  chk("顺序无关 → 对", K.judgeSelection([2, 0], [0, 2]) === true);
  chk("少选一个 → 错", K.judgeSelection([0], [0, 2]) === false);
  chk("多选一个 → 错", K.judgeSelection([0, 1, 2], [0, 2]) === false);
  chk("完全选错 → 错", K.judgeSelection([1], [0]) === false);
  chk("空选 → 错", K.judgeSelection([], [0]) === false);
  chk("无标准答案 → 错（不能默认放行）", K.judgeSelection([0], []) === false);
}

console.log("\n[5] 落库序列化");
{
  const single = K.buildAnswerFields(FOUR, [2]);
  chk("单选存选项全文", single.answer === "C. 蓝" && single.answers === null && !single.is_multi);
  const multi = K.buildAnswerFields(FOUR, [2, 0]);
  chk(
    "多选：answer 存字母、answers 存全文",
    multi.answer === "A、C" && JSON.stringify(multi.answers) === JSON.stringify(["A. 红", "C. 蓝"]) && multi.is_multi
  );
  chk("字母顺序稳定", K.answerLabels([2, 0]) === "A、C");
  chk("非法下标被丢掉", K.buildAnswerFields(FOUR, [9]).answer === null);
}

console.log("\n[6] correctKeysOf：旧数据也能还原");
{
  const fromAnswers = K.correctKeysOf({ options: FOUR, answer: "A、C", answers: ["A. 红", "C. 蓝"] });
  chk("answers 优先", JSON.stringify(fromAnswers) === "[0,2]", JSON.stringify(fromAnswers));
  const fromText = K.correctKeysOf({ options: OPTS, answer: OPTS[0], answers: null });
  chk("单选全文 → [0]", JSON.stringify(fromText) === "[0]", JSON.stringify(fromText));
  const legacy = K.correctKeysOf({ options: FOUR, answer: "①②" });
  chk("旧数据圈号多选 → [0,1]", JSON.stringify(legacy) === "[0,1]", JSON.stringify(legacy));
}

console.log("\n[7] 高亮口径与判题口径一致");
{
  chk("isCorrectOption 命中多选第一项", O.isCorrectOption(FOUR[0], "A、C", 0, 4, FOUR) === true);
  chk("isCorrectOption 命中多选第二项", O.isCorrectOption(FOUR[2], "A、C", 2, 4, FOUR) === true);
  chk("isCorrectOption 不误标第三项", O.isCorrectOption(FOUR[1], "A、C", 1, 4, FOUR) === false);
  chk(
    "截图里那张卡（选项为三条建议）仍能命中 A",
    O.isCorrectOption(OPTS[0], OPTS[0], 0, 3, OPTS) === true
  );
  const parsed = K.parseAnswerKeys(OPTS[0], OPTS);
  chk("截图那张卡解析为单选 1 项（不是多选）", parsed.keys.length === 1 && parsed.multi === false, JSON.stringify(parsed));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
