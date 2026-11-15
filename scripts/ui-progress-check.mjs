// 进度条口径单测。
//
// 用户要求「所有等 AI 的场景统一显示进度条 + 实时已用时间」。
// 统一不能靠自觉：这里既测算法，也测「谁真的用了同一个组件」——
// 以后有人在某个页面手写一根 div，这条会红。
import fs from "node:fs";
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
const P = await import(pathToFileURL(path.join(here, "../src/lib/ui/progress.ts")).href);
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");

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

console.log("— 进度算法 —");

chk("elapsed=0 → 起始值 8%", P.estimatePercent(0, 10000) === 8);
chk("预估一半 → 50%", P.estimatePercent(5000, 10000) === 50, String(P.estimatePercent(5000, 10000)));
chk("到预估时长 → 92%（不提前显示 100%）", P.estimatePercent(10000, 10000) === 92);
chk(
  "超时继续爬但不超过 96%",
  P.estimatePercent(60000, 10000) > 92 && P.estimatePercent(600000, 10000) <= 96,
  String(P.estimatePercent(600000, 10000))
);

const samples = [0, 1000, 3000, 6000, 9000, 12000, 30000].map((t) => P.estimatePercent(t, 10000));
chk(
  "单调不减（进度条不会倒退）",
  samples.every((v, i) => i === 0 || v >= samples[i - 1]),
  samples.join(",")
);

chk("eta 非法也不炸（返回 4~96 之间的有限值）", Number.isFinite(P.estimatePercent(NaN, 0)));
chk("clampPercent(NaN) → 下界", P.clampPercent(NaN, 0, 100) === 0);

console.log("— 时间文案 —");
chk(
  "时长格式：0s / 7s / 1:05 / 12:03",
  P.formatDuration(0) === "0s" &&
    P.formatDuration(7000) === "7s" &&
    P.formatDuration(65000) === "1:05" &&
    P.formatDuration(723000) === "12:03",
  [P.formatDuration(0), P.formatDuration(7000), P.formatDuration(65000), P.formatDuration(723000)].join("|")
);
chk("「已用 12s」", P.elapsedText(12345) === "已用 12s", P.elapsedText(12345));
chk("剩余秒数不为负", P.remainSeconds(2000, 10000) === 8 && P.remainSeconds(99999, 10000) === 0);
chk("还需约 8s", P.remainLabel(2000, 10000) === "还需约 8s", P.remainLabel(2000, 10000));
chk("超时未到 1.5× → 快好了", P.remainLabel(12000, 10000) === "快好了", P.remainLabel(12000, 10000));
chk("超过 1.5× → 模型响应较慢", P.remainLabel(20000, 10000) === "模型响应较慢");
chk("可自定义起止（导入链路用 6→88）", P.estimatePercent(0, 10000, 6, 88) === 6);

console.log("— 谁在用同一个组件 —");

const jobCenter = read("src/components/job-center.tsx");
chk("任务浮层的 JobProgress 只是 AiProgress 的包装", /<AiProgress[\s\S]{0,200}job\.started_at/.test(jobCenter));
chk(
  "任务浮层不再自己算「已用 ${elapsed}s」",
  !jobCenter.includes("已用 ${elapsed}s") && !jobCenter.includes("还需约 ${remain}s")
);

chk("导入页用 AiProgress", read("src/app/import/page.tsx").includes("AiProgress"));
chk("对话窗用 AiProgress", read("src/components/ai-chat.tsx").includes("AiProgress"));
chk("卡片页「AI 补答案」用 AiProgress", read("src/app/cards/page.tsx").includes("AiProgress"));

const css = read("src/app/globals.css");
chk("进度条样式只有一处定义（.ai-bar）", (css.match(/\.ai-bar\s*\{/g) ?? []).length === 1);
chk("不确定进度条有不间断动画", css.includes(".ai-bar-indeterminate") && css.includes("@keyframes ai-bar-slide"));
chk("层级：按钮 55 < 任务 60 < 遮罩 65 < 面板 70", /\.ai-fab[\s\S]*?z-index:\s*55;/.test(css) && /\.ai-panel[\s\S]*?z-index:\s*70;/.test(css) && /\.ai-panel-mask[\s\S]*?z-index:\s*65;/.test(css));
chk("手机上面板用 dvh（键盘不顶出屏幕）", /\.ai-panel\s*\{[\s\S]*?max-height:\s*82dvh/.test(css));
chk("任务浮层给右下角按钮让位（桌面 right: 5.5rem）", /\.job-dock\s*\{\s*right:\s*5\.5rem/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
