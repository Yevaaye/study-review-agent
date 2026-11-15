// 答案补全「原文搜索」回归 —— npm run check:answerfill
//
// 守住「缺答案时先在原文上下文搜索补全、找不到才 AI 生成」这条链路：
//   1. 答案与题目不在同一章（题目在「高频面试题」、答案在「参考答案要点」）时，
//      buildAnswerRequest 必须扩展到整本书检索，把答案章节的原文带进材料，
//      让 AI 有机会 grounded=true 回填，而不是只检索题目所在章节、被迫编答案。
//   2. 答案就在题目同章时，不应无谓地做整本书检索（材料已足够，行为不变）。

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
const fill = await import(
  pathToFileURL(path.join(here, "../src/lib/cards/answer-fill.ts")).href
);
const { buildAnswerRequest } = fill;

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

// mock 片段工厂
const frag = (id, textbook_id, chapter_id, index, content) => ({
  id,
  textbook_id,
  chapter_id,
  fragment_index: index,
  heading_path: null,
  paragraph_index: null,
  page_start: null,
  page_end: null,
  char_start: null,
  char_end: null,
  locator: id,
  content,
  content_hash: null,
  fragment_type: null,
  question_no: null,
});

// mock store：只实现 buildAnswerRequest 用到的几个方法
function mockStore(overrides = {}) {
  return {
    listCardSources: async () => [],
    getKnowledgePoint: async () => null,
    getChapter: async () => null,
    listFragments: async () => [],
    ...overrides,
  };
}

// 卡片（无 kp，靠 card_sources 定位章节）
const card = (front) => ({
  id: "card-1",
  kind: "qa",
  front,
  back: "",
  options: null,
  answer: null,
  is_choice: false,
  status: "draft",
  content_revision: 1,
  content_hash: null,
  generation_job_id: null,
  reviewed_at: null,
  rejected_at: null,
  deleted_at: null,
  source: "original",
  card_type: "qa",
  kp_id: null,
  needs_answer: true,
  chapter_path: null,
  evidence: null,
  question_no: null,
  explanation: null,
});

// ---------------------------------------------------------------------------
// 场景 1：答案在另一章 —— 必须整本书检索，把答案章节原文带进材料
// ---------------------------------------------------------------------------
{
  const qFrag = frag("f1", "tb1", "ch-question", 0, "什么是向量数据库？这是一个常见面试题。");
  const aFrag = frag(
    "f2",
    "tb1",
    "ch-answer",
    1,
    "向量数据库是专门存储与检索向量索引的数据库，通过近似最近邻算法加速检索。"
  );
  const otherFrag = frag("f3", "tb1", "ch-answer", 2, "常见的索引结构包括 HNSW 与 IVF。");

  const store = mockStore({
    listCardSources: async () => [qFrag],
    listFragments: async (textbookId, chapterId) => {
      if (chapterId) return [qFrag]; // 题目所在章只有题干，没有答案
      return [qFrag, aFrag, otherFrag]; // 整本书才有答案章节
    },
  });

  const req = await buildAnswerRequest(store, card("什么是向量数据库？"));
  chk("题目/答案跨章时 material 非空", !!req, "req 为 null");
  chk(
    "跨章检索带回了答案章节原文",
    (req?.material ?? "").includes("专门存储与检索向量索引"),
    `material=${(req?.material ?? "").slice(0, 60)}`
  );
}

// ---------------------------------------------------------------------------
// 场景 2：答案就在同章 —— 材料已足够，不应无谓整本书检索（行为不变）
// ---------------------------------------------------------------------------
{
  const qFrag = frag(
    "f1",
    "tb1",
    "ch1",
    0,
    "什么是幂等？幂等指同一操作的多次执行结果与单次执行完全一致，常用于接口重试、消息重复投递、支付回调等需要保证最终一致性的场景。"
  );

  const store = mockStore({
    listCardSources: async () => [qFrag],
    listFragments: async (textbookId, chapterId) => {
      if (chapterId) return [qFrag];
      return [qFrag];
    },
  });

  const req = await buildAnswerRequest(store, card("什么是幂等？"));
  chk("同章答案材料非空", !!req);
  chk("同章材料包含答案原文", (req?.material ?? "").includes("多次执行结果与单次执行完全一致"));
}

// ---------------------------------------------------------------------------
// 场景 3：全书都没有答案线索 —— 材料不足返回 null（宁可留空不编）
// ---------------------------------------------------------------------------
{
  const qFrag = frag("f1", "tb1", "ch1", 0, "简述你对分布式系统的理解。");

  const store = mockStore({
    listCardSources: async () => [qFrag],
    listFragments: async (textbookId, chapterId) => {
      if (chapterId) return [qFrag];
      return [qFrag];
    },
  });

  const req = await buildAnswerRequest(store, card("简述你对分布式系统的理解。"));
  // 只有一句题干、没有答案正文，材料长度不足 → 返回 null（不硬编）
  chk("无答案线索时返回 null（不硬编）", req === null, `req=${JSON.stringify(req)}`);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
