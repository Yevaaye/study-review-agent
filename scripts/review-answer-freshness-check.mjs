// 复习卡答案保鲜：会话快照 vs 实时卡片的合并契约
//
// 守的是这次的需求：
//   AI 补全答案后回到这道题，必须看到**补全后的答案**，
//   而不是建会话那一刻冻结的旧答案；同时题干与选项不能被偷偷换掉。
//
// 全是纯函数，不需要起服务：
//   mergeAnswerFields —— 只在 content_revision 前进时覆盖答案侧字段
//
// 用法：npm run check:reviewfresh

import { registerHooks } from "node:module";

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

const { mergeAnswerFields } = await import("../src/lib/review/answer-freshness.ts");

let pass = 0;
let fail = 0;
function chk(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== mergeAnswerFields ==");

const snap = {
  front: "什么是机器学习？",
  back: "机器学习是人工智能的子领域。",
  kind: "qa",
  options: null,
  answer: null,
  answers: null,
  is_multi: false,
  is_choice: false,
  answer_origin: null,
  answer_grounded: null,
  content_revision: 3,
};

const liveEdited = {
  back: "机器学习是人工智能的子领域。目标是构建能从未标注数据中学习的系统。",
  answer: null,
  answers: null,
  is_multi: false,
  answer_origin: "ai",
  answer_grounded: true,
  content_revision: 4,
};

// ① 编辑过 → 答案侧刷新，引用变化
const r1 = mergeAnswerFields(snap, liveEdited);
chk("补全后 back 被替换", r1.back === liveEdited.back);
chk("answer_origin 标为 ai", r1.answer_origin === "ai");
chk("answer_grounded 同步", r1.answer_grounded === true);
chk("content_revision 前进到 4", r1.content_revision === 4);
chk("返回新对象（调用方需要知道有变化）", r1 !== snap);

// ② 题干与选项不许动
chk("front 保持快照原值", r1.front === snap.front);
chk("options 保持快照原值", r1.options === snap.options);
chk("is_choice 保持快照原值", r1.is_choice === snap.is_choice);

// ③ 没编辑过 → 原样返回同一引用
const liveSame = { ...liveEdited, content_revision: 3 };
chk("版本号未前进时返回同一引用", mergeAnswerFields(snap, liveSame) === snap);

// ④ 版本号倒退（历史数据 / 回滚）→ 不覆盖
chk(
  "版本号倒退不覆盖",
  mergeAnswerFields(snap, { ...liveEdited, content_revision: 2 }) === snap
);

// ⑤ 补全失败时 back 为空 → 不能把复习卡变成白板
const r2 = mergeAnswerFields(snap, { ...liveEdited, back: "   " });
chk("空答案不覆盖已有答案", r2.back === snap.back);

// ⑥ 旧快照缺 content_revision → 按 0 处理，允许同步一次
const legacySnap = { front: "x", back: "旧答案" };
const r3 = mergeAnswerFields(legacySnap, { ...liveEdited, content_revision: 1 });
chk("旧快照（无版本号）也能同步", r3.back === liveEdited.back);

// ⑦ 内容其实没变（只 bump 了版本号）→ 不重建对象
const r4 = mergeAnswerFields(snap, {
  back: snap.back,
  answer: null,
  answers: null,
  is_multi: false,
  answer_origin: null,
  answer_grounded: null,
  content_revision: 9,
});
chk("只 bump 版本号、内容未变时返回同一引用", r4 === snap);

// ⑧ 选择题：answers 数组与 is_multi 一并同步
const choiceSnap = {
  front: "以下哪些属于……",
  back: "A、C",
  options: ["A", "B", "C", "D"],
  answer: "A",
  answers: ["A"],
  is_multi: false,
  content_revision: 1,
};
const r5 = mergeAnswerFields(choiceSnap, {
  back: "A、C",
  answer: null,
  answers: ["A", "C"],
  is_multi: true,
  answer_origin: "ai",
  answer_grounded: true,
  content_revision: 2,
});
chk("多选 answers 同步", JSON.stringify(r5.answers) === JSON.stringify(["A", "C"]));
chk("多选 is_multi 同步", r5.is_multi === true);
chk("答案键 answer 被清空（选择题以 answers 为准）", r5.answer === null);

// ⑨ snapshot 为 null 时不炸
const r6 = mergeAnswerFields(null, liveEdited);
chk("空快照不抛异常", typeof r6 === "object" && r6 !== null);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
