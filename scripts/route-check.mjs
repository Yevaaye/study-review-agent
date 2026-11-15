// 路由层回归：import/route.ts 的死三元 `q.type === "judge" ? q.back : q.back`
// 两分支完全相同，属于无意义的等价写法，必须清除。
// 运行：npm run check:route
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.join(here, "../src/app/api/import/route.ts");
const src = readFileSync(routePath, "utf8");

// 死三元：条件 q.type==="judge"，但两个分支都是 q.back。
const deadPattern = /q\.type\s*===\s*["']judge["']\s*\?\s*q\.back\s*:\s*q\.back/;

let fail = 0;

if (deadPattern.test(src)) {
  console.log('  FAIL  import/route.ts 仍存在死三元 q.type==="judge" ? q.back : q.back');
  fail++;
} else {
  console.log("  PASS  import/route.ts 死三元已清除");
}

if (!/const back = q\.back;/.test(src)) {
  console.log('  FAIL  import/route.ts 未找到预期写法 `const back = q.back;`');
  fail++;
} else {
  console.log("  PASS  import/route.ts 使用 `const back = q.back;`");
}

console.log(`\n${fail ? fail + " failed" : "0 failed"}`);
process.exit(fail ? 1 : 0);
