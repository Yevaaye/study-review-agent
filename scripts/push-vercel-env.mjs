#!/usr/bin/env node
// 把 .env.local 里的 LLM 运行时变量同步到 Vercel 项目（生产/预览环境）。
//
// v3 说明（重要）：
//   · 当前只有 LocalStore（JSON 文件）一个后端，supabaseStore.ts 已删除；
//     DATA_BACKEND / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 不再是有效配置，
//     本脚本不再推送它们。
//   · 部署前提是「单实例 + 可写持久磁盘」。Vercel 默认的 serverless 文件系统
//     是只读的，LocalStore.save() 会直接抛错、所有写接口返回 500 —— 不存在
//     「降级为内存态」这回事。若没有挂载可写卷，请不要用 Vercel 部署本项目，
//     改用 README 里的「本机 + 隧道」或「容器 + 持久卷」。
//
// 为什么用 API 而不是 `vercel env add`：
//   CLI 的 env add 是交互式命令，管道喂值容易踩 shell 引号/换行的坑；
//   REST API 一次 POST 一条，且能直接读到已有变量做覆盖判断。
//
// 用法：
//   VERCEL_TOKEN=xxx node scripts/push-vercel-env.mjs
//   VERCEL_TOKEN=xxx node scripts/push-vercel-env.mjs --target production,preview
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = process.env.VERCEL_TOKEN ?? "";
if (!token) {
  console.error("缺少 VERCEL_TOKEN 环境变量");
  process.exit(1);
}

const argTarget = process.argv.find((a) => a.startsWith("--target"));
const targets = (argTarget?.split("=")[1] ?? "production").split(",").map((s) => s.trim());

function envLocal() {
  const out = {};
  for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = envLocal();
const project = JSON.parse(readFileSync(join(root, ".vercel/project.json"), "utf8"));

// 只同步 LLM 运行时变量。APP_PASSWORD 属于实例级口令，不该跨实例共用；
// 本地调试开关也不该带进生产。
const SYNC_KEYS = [
  "LLM_PROVIDER",
  "LLM_JSON_MODE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "DEEPSEEK_API_KEY",
];

const api = (path, init = {}) =>
  fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const qs = `?teamId=${project.orgId}`;

// 先取现有变量，避免重复 key 冲突（同名同 target 会 409）
const listRes = await api(`/v9/projects/${project.projectId}/env${qs}`);
if (!listRes.ok) {
  console.error(`读取现有变量失败：${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const existing = (await listRes.json()).envs ?? [];
const findExisting = (key) =>
  existing.find((e) => e.key === key && e.target?.some((t) => targets.includes(t)));

let created = 0;
let updated = 0;
const failed = [];
for (const key of SYNC_KEYS) {
  const value = env[key];
  if (!value) {
    console.log(`  SKIP  ${key}（.env.local 中为空）`);
    continue;
  }
  const old = findExisting(key);
  const res = old
    ? await api(`/v9/projects/${project.projectId}/env/${old.id}${qs}`, {
        method: "PATCH",
        body: JSON.stringify({ value, target: targets }),
      })
    : await api(`/v9/projects/${project.projectId}/env${qs}`, {
        method: "POST",
        body: JSON.stringify({ key, value, type: "encrypted", target: targets }),
      });
  if (!res.ok) {
    console.log(`  FAIL  ${key}  ${res.status} ${(await res.text()).slice(0, 160)}`);
    failed.push(key);
    continue;
  }
  if (old) updated++;
  else created++;
  console.log(`  ${old ? "UPDATE" : "CREATE"}  ${key}`);
}

console.log(`\n完成：新增 ${created} 条，更新 ${updated} 条，目标环境 ${targets.join("/")}`);
console.log("提醒：确认目标实例有可写持久磁盘，且只跑一个进程（多实例会各自持有独立内存副本）。");
if (failed.length) process.exitCode = 1;
