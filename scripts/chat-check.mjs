// AI 对话纯函数单测：消息校验（9 条）+ SSE 解析（5 条）。
//
// 为什么在 node 里直接跑：validator 与 parser 都刻意写成了不依赖 Request / fetch 的
// 纯函数。如果它们长在 route.ts 里，就只能靠「发一个请求看看」来验证，
// 而流式解析最容易错的地方（半行跨 chunk）恰恰是发请求测不出来的。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* fallthrough */
      }
    }
    return next(specifier, context);
  },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (n) => pathToFileURL(path.join(here, "../src/lib/chat", n)).href;
const { validateChatMessages } = await import(load("guard.ts"));
const { createSSEParser } = await import(load("sse.ts"));

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

/** 调用必须是「正常返回」而不是抛异常 —— 否则空壳实现会被误判成通过。 */
function guard(raw) {
  try {
    return { threw: false, r: validateChatMessages(raw) };
  } catch (e) {
    return { threw: true, r: null, err: e };
  }
}

function pushAll(parser, chunks) {
  const texts = [];
  const errors = [];
  for (const c of chunks) {
    const r = parser.push(c);
    texts.push(...r.texts);
    errors.push(...r.errors);
  }
  return { text: texts.join(""), texts, errors };
}

const mk = (s) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

console.log("— 组 1：消息校验 —");

// 1. 空数组
{
  const g = guard([]);
  chk("空数组 → 拒绝", !g.threw && g.r.ok === false);
}
// 2. 非数组
{
  const g = guard("hi");
  chk("非数组 → 拒绝", !g.threw && g.r.ok === false);
}
// 3. 非法 role
{
  const g = guard([{ role: "tool", content: "x" }, { role: "user", content: "y" }]);
  chk("role=tool → 拒绝", !g.threw && g.r.ok === false);
}
// 4. 空白 content
{
  const g = guard([{ role: "user", content: "   " }]);
  chk("空白 content → 拒绝", !g.threw && g.r.ok === false);
}
// 5. 21 条
{
  const many = Array.from({ length: 21 }, () => ({ role: "user", content: "x" }));
  const g = guard(many);
  chk("21 条 → 拒绝", !g.threw && g.r.ok === false);
}
// 6. 单条 4001 字
{
  const g = guard([{ role: "user", content: "字".repeat(4001) }]);
  chk("单条 4001 字 → 拒绝", !g.threw && g.r.ok === false);
}
// 7. 4 × 3900 字（累计 15600 > 12000）
{
  const four = Array.from({ length: 4 }, () => ({ role: "user", content: "字".repeat(3900) }));
  const g = guard(four);
  chk("累计超 12000 字 → 拒绝", !g.threw && g.r.ok === false);
}
// 8. 末条是 assistant
{
  const g = guard([
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
  ]);
  chk("末条 assistant → 拒绝", !g.threw && g.r.ok === false);
}
// 9. 正常 system + user，且 trim
{
  const g = guard([
    { role: "system", content: " 你是助教 " },
    { role: "user", content: "  什么是 FSRS？ " },
  ]);
  chk(
    "正常输入通过且 trim",
    !g.threw && g.r.ok === true && g.r.messages[0].content === "你是助教" && g.r.messages[1].content === "什么是 FSRS？",
    JSON.stringify(g.r ?? String(g.err))
  );
}

console.log("— 组 2：SSE 解析 —");

// 10. 两段内容 + DONE
{
  try {
    const r = pushAll(createSSEParser(), [mk("你") + mk("好") + DONE]);
    chk("多块内容拼接 → 你好", r.text === "你好", r.text);
  } catch (e) {
    chk("多块内容拼接 → 你好", false, String(e.message));
  }
}
// 11. 整串从中间切两半（核心：半行跨 chunk 不丢字）
{
  try {
    const full = mk("流式") + mk("拼接") + DONE;
    const cut = Math.floor(full.length / 2);
    const r = pushAll(createSSEParser(), [full.slice(0, cut), full.slice(cut)]);
    chk("半行跨 chunk 不丢字 → 流式拼接", r.text === "流式拼接", r.text);
  } catch (e) {
    chk("半行跨 chunk 不丢字 → 流式拼接", false, String(e.message));
  }
}
// 12. 只有 role 没有 content
{
  try {
    const r = pushAll(createSSEParser(), [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n` + mk("在") + DONE,
    ]);
    chk("role-only delta 被忽略且不报错", r.text === "在" && r.errors.length === 0, `text=${r.text}`);
  } catch (e) {
    chk("role-only delta 被忽略且不报错", false, String(e.message));
  }
}
// 13. 上游 error
{
  try {
    const r = pushAll(createSSEParser(), [`data: ${JSON.stringify({ error: { message: "额度不足" } })}\n\n`]);
    chk("上游 error 被提取", r.errors[0] === "额度不足", JSON.stringify(r.errors));
  } catch (e) {
    chk("上游 error 被提取", false, String(e.message));
  }
}
// 14. 注释行 + DONE + 内容
{
  try {
    const r = pushAll(createSSEParser(), [": keep-alive\n\n" + mk("内容") + DONE]);
    chk("注释行 / [DONE] 不产生内容", r.text === "内容", r.text);
  } catch (e) {
    chk("注释行 / [DONE] 不产生内容", false, String(e.message));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
