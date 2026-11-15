// 资料库「这本书现在到底在不在导入」的判定单测。
//
// 现场回归：导入其实已经完成、库里 3 本书 63 张卡一张不少，
// 但资料库某本书一直挂着「正在解析这份材料…0 张卡」，
// 而导入页同时说「进度查不到了」。根因之一是这里只看了
// import_jobs.finished_at —— 进程在 parsing 阶段一崩，那行永远是 null，
// 于是这本书永远显示「正在解析」。
//
// 现在判据是两条同时成立：库里没写完 + 内存任务表里确实还有这本书的导入任务。
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
const J = await import(
  pathToFileURL(path.join(here, "../src/lib/import/job-status.ts")).href
);

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

console.log("— 资料库导入状态 —");

const importing = J.importingTitles([
  { kind: "import-parse", status: "running", title: "导入《系统设计面试题-进阶篇》" },
  { kind: "import-parse", status: "done", title: "导入《已完成的材料》" },
  { kind: "chapter-generate", status: "running", title: "导入《不是导入任务》" },
]);

// 1
chk(
  "只把「正在跑的 import-parse」算作正在导入",
  importing.size === 1 && importing.has("系统设计面试题-进阶篇")
);

// 2 —— 真实现场：任务在内存里 ⇒ 确实在处理（0 张卡是还没写完，不是失败）
chk(
  "库里没写完 + 有活任务 = processing",
  J.bookImportState({ finished_at: null }, importing, "系统设计面试题-进阶篇") ===
    "processing"
);

// 3 —— 崩溃现场：库里没写完、内存里没任务 ⇒ 中断，不能再假装在跑
chk(
  "库里没写完 + 没有活任务 = interrupted（不会永远显示正在解析）",
  J.bookImportState({ finished_at: null }, importing, "另一本没在跑的书") ===
    "interrupted"
);

// 4
chk(
  "已写完 = idle（不管内存里有没有任务）",
  J.bookImportState({ finished_at: "2026-11-07T12:16:47.980Z" }, importing, "另一本") ===
    "idle"
);

// 5
chk(
  "从没导入过 = idle",
  J.bookImportState(null, importing, "另一本") === "idle"
);

// 6 —— 材料行先落库、import_job 行后落库，中间的毫秒窗口不能闪「知识点正文」
chk(
  "还没写 import_job 时，同名活任务仍算处理中（不闪错误文案）",
  J.bookImportState(null, importing, "系统设计面试题-进阶篇") === "processing"
);

console.log(`\n${pass} passed, ${fail} failed`);
// 不用 process.exit：Windows 上带着未关闭的 async handle 强退会触发 libuv 断言
process.exitCode = fail === 0 ? 0 : 1;
