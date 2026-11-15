// 「答案里的表格 / 清单要整理成结构」回归：npm run check:answerformat
//
// 起点是用户截图里那条答案 —— 模型给的是 Markdown 表格，落库时换行被压成空格，
// 复习页按纯文本渲染，用户看到的是一整串「|框架|执行权限|...|」。
//
// 守住的六条：
//   1. 被压扁的表格能还原成逐行，列数、行数与原文一致；
//   2. 标准 Markdown 表格（含对齐冒号）也照收，列数不齐的行要补齐；
//   3. 不丢字：所有单元格的文字都要原样保留（只是加了换行）；
//   4. 幂等：normalize(normalize(x)) 必须等于 normalize(x)；
//   5. 不误判：普通段落、含竖线的句子、单列竖线都不能被当成表格；
//   6. 普通答案一个字都不改（这是显示层，不是编辑器）。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const {
  normalizeAnswerText,
  parseAnswerBlocks,
  hasAnswerStructure,
  tidyModelText,
  tidyInline,
} = await import(pathToFileURL(path.join(root, "src/lib/cards/answer-format.ts")).href);

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
const strip = (s) => String(s).replace(/\s/g, "");

// ---- 1) 用户截图里那条：整张表被压成一行 ----
const GLUED =
  "|框架|执行权限|审批|OS隔离| |---|---|---|---| |Codex CLI、Claude Code|本机用户|支持审批|默认非必然| |LangGraph、CrewAI、AutoGen|工具所在进程|由应用配置|框架不提供| |OpenHands|容器内|按配置|Docker沙箱| |Agent Canvas|被调起代理|继承代理设置|继承代理设置|";
{
  const blocks = parseAnswerBlocks(GLUED);
  ok("压扁的表格被认出来（只有 1 个块）", blocks.length === 1, `got ${blocks.length}`);
  const t = blocks[0];
  ok("解析成表格", t?.type === "table", t?.type);
  if (t?.type === "table") {
    ok("表头 4 列", t.header.length === 4, JSON.stringify(t.header));
    ok("表头内容对得上", t.header.join("/") === "框架/执行权限/审批/OS隔离", JSON.stringify(t.header));
    ok("数据 4 行", t.rows.length === 4, `got ${t.rows.length}`);
    ok(
      "第一行 4 格且内容完整",
      t.rows[0]?.length === 4 && t.rows[0][0] === "Codex CLI、Claude Code" && t.rows[0][3] === "默认非必然",
      JSON.stringify(t.rows[0])
    );
    ok(
      "最后一行也在（没被截断）",
      t.rows[3]?.[0] === "Agent Canvas" && t.rows[3][3] === "继承代理设置",
      JSON.stringify(t.rows[3])
    );
    ok("默认左对齐", t.align.every((a) => a === "left"), JSON.stringify(t.align));
  }

  const norm = normalizeAnswerText(GLUED);
  // 表头 1 + 分隔 1 + 数据 4
  ok("整形成逐行 Markdown（6 行）", norm.split("\n").length === 6, String(norm.split("\n").length));
  ok("分隔行独立成行", norm.split("\n")[1] === "|---|---|---|---|", norm.split("\n")[1]);
  ok("不丢字：所有可见字符都在", strip(norm) === strip(GLUED), "字符集不一致");
  ok(
    "粘在一行的段落不再出现「| |」",
    !/\|[ \t]+\|/.test(norm),
    JSON.stringify(norm.slice(0, 80))
  );
}

// ---- 2) 标准 Markdown 表格 + 对齐冒号 ----
const ALIGNED = `| 维度 | 说明 | 分数 |
| :--- | :---: | ---: |
| 速度 | 快 | 9 |
| 成本 | 低 | 7 |`;
{
  const t = parseAnswerBlocks(ALIGNED)[0];
  ok("标准表格解析成功", t?.type === "table", t?.type);
  if (t?.type === "table") {
    ok("对齐方式解析正确（左/中/右）", JSON.stringify(t.align) === '["left","center","right"]', JSON.stringify(t.align));
    ok("列数 3 行数 2", t.header.length === 3 && t.rows.length === 2, `${t.header.length}x${t.rows.length}`);
    ok("单元格去掉了两侧空格", t.rows[0][0] === "速度", JSON.stringify(t.rows[0]));
  }
  // 标准表格只做「去空格 + 统一分隔行写法」，列数与单元格内容必须原样
  const normA = normalizeAnswerText(ALIGNED);
  ok("标准表格规范化后仍是 4 行", normA.split("\n").length === 4, String(normA.split("\n").length));
  ok(
    "标准表格的内容一格不差",
    strip(normA) === "|维度|说明|分数||---|:---:|---:||速度|快|9||成本|低|7|",
    JSON.stringify(strip(normA))
  );
  ok("显式左对齐折叠成默认写法（语义不变）", /\|---\|:---:\|---:\|/.test(strip(normA)));
  ok("标准表格重复规范化不再变化", normalizeAnswerText(normA) === normA, JSON.stringify(normalizeAnswerText(normA)));
}

// ---- 3) 列数不齐 / 空单元格 ----
const RAGGED = `| A | B | C |
|---|---|---|
| 1 | 2 |
| 1 | 2 | 3 | 4 |
| x |  | z |`;
{
  const t = parseAnswerBlocks(RAGGED)[0];
  ok("列数不齐也能解析", t?.type === "table", t?.type);
  if (t?.type === "table") {
    ok("每行都补齐到 3 列", t.rows.every((r) => r.length === 3), JSON.stringify(t.rows));
    ok("少的那行补空串", t.rows[0][2] === "", JSON.stringify(t.rows[0]));
    ok("多的一列被截掉", t.rows[1].length === 3, JSON.stringify(t.rows[1]));
    ok("中间空单元格保留为空", t.rows[2][1] === "", JSON.stringify(t.rows[2]));
  }
}

// ---- 4) 表格前后有正文：不能被表格吞掉 ----
const MIXED = `下面把四个框架横向对比一下。

| 框架 | 隔离 |
|---|---|
| Codex | 本机 |

结论：只有 OpenHands 提供容器级隔离。`;
{
  const blocks = parseAnswerBlocks(MIXED);
  ok("切成 3 块（正文/表格/正文）", blocks.length === 3, blocks.map((b) => b.type).join(","));
  ok("第一块是正文", blocks[0]?.type === "text" && blocks[0].text.includes("横向对比"));
  ok("第二块是表格", blocks[1]?.type === "table");
  ok("第三块是结论", blocks[2]?.type === "text" && blocks[2].text.includes("容器级隔离"));
}

// ---- 5) 列表 / 引用 / 标题 ----
const LISTY = `## 结论

- 能用 API 就不训模型
- MVP 先做 3 个工具
- 存储用 Redis

> 面试官更看重取舍，不是清单。`;
{
  const blocks = parseAnswerBlocks(LISTY);
  ok("分块：标题/列表/引用", blocks.map((b) => b.type).join(",") === "heading,list,quote", blocks.map((b) => b.type).join(","));
  ok("标题文本正确", blocks[0]?.type === "heading" && blocks[0].text === "结论");
  ok("无序列表 3 条", blocks[1]?.type === "list" && blocks[1].items.length === 3 && blocks[1].ordered === false);
  ok("引用内容去掉了 > 号", blocks[2]?.type === "quote" && blocks[2].text === "面试官更看重取舍，不是清单。", JSON.stringify(blocks[2]));
}

const ORDERED = `1. 先对齐目标
2. 再拆里程碑
3. 最后排期`;
{
  const b = parseAnswerBlocks(ORDERED);
  ok("有序列表被识别", b.length === 1 && b[0].type === "list" && b[0].ordered === true, JSON.stringify(b.map((x) => x.type)));
  ok("条目文本去掉了序号", b[0]?.items?.join("/") === "先对齐目标/再拆里程碑/最后排期", JSON.stringify(b[0]?.items));
}

// ---- 6) 不该被误判的情况 ----
{
  const plain = "落地原则：先用现成 API；再补评测集；最后才谈自研。";
  ok("普通答案只有一个文本块", parseAnswerBlocks(plain).length === 1 && parseAnswerBlocks(plain)[0].type === "text");
  ok("普通答案未触发结构化", hasAnswerStructure(plain) === false);
  ok("普通答案规范化后一字不改", normalizeAnswerText(plain) === plain);

  const pipeProse = "用 A | B 表示二选一，用 C || D 表示都不选。";
  ok("含竖线的句子不当作表格", hasAnswerStructure(pipeProse) === false, JSON.stringify(parseAnswerBlocks(pipeProse)));

  const oneCol = "| 项目 |\n|---|\n| 缓存 |";
  const blocks = parseAnswerBlocks(oneCol);
  ok("单列表格退化成文本（不做假表格）", blocks.every((b) => b.type !== "table"), blocks.map((b) => b.type).join(","));

  const twoColNoSep = "| a | b |\n| c | d |";
  ok("缺分隔行的两列表也能整理成表格", hasAnswerStructure(twoColNoSep) === true, JSON.stringify(parseAnswerBlocks(twoColNoSep)));
}

// ---- 7) 幂等（多份样本） ----
for (const [name, sample] of [
  ["压扁表格", GLUED],
  ["标准表格", ALIGNED],
  ["列数不齐", RAGGED],
  ["混排", MIXED],
  ["列表", LISTY],
  ["普通答案", "一句话答案，没有结构。"],
]) {
  const once = normalizeAnswerText(sample);
  const twice = normalizeAnswerText(once);
  ok(`幂等：${name}`, once === twice, JSON.stringify({ once: once.slice(0, 60), twice: twice.slice(0, 60) }));
}

// ---- 8) 收口函数：正文留换行、单行字段压平 ----
{
  const raw = "第一行\n\n\n第二行\n   缩进内容";
  const t = tidyModelText(raw, 500);
  ok("tidyModelText 保留换行", t.includes("\n"), JSON.stringify(t));
  ok("tidyModelText 压掉多余空行（最多 1 个空行）", !/\n{3,}/.test(t), JSON.stringify(t));
  ok("tidyModelText 保留表格行", tidyModelText(GLUED, 2000).includes("|"), "竖线没了");

  const inline = tidyInline("诊断：\n漏了\n\n两处", 100);
  ok("tidyInline 压成一行", !/\n/.test(inline), JSON.stringify(inline));
  ok("tidyInline 保留文字", inline.replace(/\s/g, "") === "诊断：漏了两处", inline);
}

// ---- 9) 长表格：10 行 5 列不能串位 ----
{
  const header = "| 框架 | 权限 | 审批 | 隔离 | 备注 |";
  const sep = "|---|---|---|---|---|";
  const rows = Array.from({ length: 10 }, (_, i) => `| f${i} | p${i} | a${i} | i${i} | n${i} |`);
  const glued = [header, sep, ...rows].join(" ").replace(/\| \|/g, "| |");
  const t = parseAnswerBlocks(glued)[0];
  ok("10 行长表解析成功", t?.type === "table", t?.type);
  if (t?.type === "table") {
    ok("行数 10", t.rows.length === 10, `got ${t.rows.length}`);
    ok("每行 5 列且首位对得上", t.rows.every((r, i) => r.length === 5 && r[0] === `f${i}`), JSON.stringify(t.rows.map((r) => r[0])));
    ok("末尾列没串位", t.rows[9][4] === "n9", JSON.stringify(t.rows[9]));
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
