// 把两本审计台账压成一份「监督员包」，供学习复盘 Agent 直接读。
//
// 为什么不直接让它读 data/audit/rejected-cards.json：
//   那份是全量（817 条约 2MB，含每题完整题干+答案+选项快照），
//   塞进上下文既贵又会把注意力分散到单张卡的细节上。
//   监督员要的是**分布和归因**，不是逐题复述 —— 所以这里只留
//   节点标题、题型、成因、卡点函数、交叉结论。
//
// 用法：
//   npm run audit:export                # 写 data/audit/supervisor-pack.json
//   BASE=http://127.0.0.1:3102 npm run audit:export
//
// 产物结构：{ generated_at, source, summary, cross_findings, answer_gaps[], rejections[] }

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const OUT = path.join(DATA_DIR, "audit", "supervisor-pack.json");

const res = await fetch(`${BASE}/api/audit/ledgers?format=agent`);
if (!res.ok) {
  console.error(`拉取失败：${res.status} ${await res.text().catch(() => "")}`);
  process.exitCode = 1;
  process.exit();
}
const data = await res.json();

const pack = {
  generated_at: data.generated_at ?? new Date().toISOString(),
  purpose:
    "学习复盘监督员用的紧凑台账包：两本台账的分布统计 + 逐条归因要点。直接读本文件即可，不必再打开全量台账。",
  how_to_read: [
    "answer_gaps：用户点「补答案」的记录。outcome=unfixed 表示没补上，block_step 指被哪个函数拦下；block_reason 是人话解释。",
    "rejections：审核点「拒绝 / 不熟」推进复习队列的节点。first_time=true 表示拒绝时是从没学过的新卡。",
    "cross_findings：两本台账交叉后的规则结论，优先级最高，先看这个。",
    "totals 里的分组计数是判断「改哪里最划算」的主依据，不要只看单条样本。",
  ],
  summary: {
    answer_gaps: data.answer_gaps?.totals ?? {},
    rejections: data.rejections?.totals ?? {},
    counts: {
      answer_gaps: data.answer_gaps?.items?.length ?? 0,
      rejections: data.rejections?.items?.length ?? 0,
    },
  },
  cross_findings: data.cross_findings ?? [],
  // 再收一刀：id（台账内部 uuid）对归因没用，知识点陈述截到 80 字。
  // 817 条 × 每条省百余字节，最终从 ~445KB 降到 ~250KB，监督员读得起。
  answer_gaps: (data.answer_gaps?.items ?? []).map(({ id, ...rest }) => ({
    ...rest,
    kp: rest.kp ? String(rest.kp).slice(0, 80) : null,
  })),
  rejections: (data.rejections?.items ?? []).map(({ id, ...rest }) => ({
    ...rest,
    kp: rest.kp ? String(rest.kp).slice(0, 80) : null,
  })),
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
const stat = await fs.stat(OUT);
console.log(`已写入 ${OUT}`);
console.log(
  `  缺口 ${pack.summary.counts.answer_gaps} 条 · 拒绝 ${pack.summary.counts.rejections} 条 · ${kb(stat.size)}`
);
if (pack.cross_findings.length) {
  console.log("\n交叉结论：");
  for (const f of pack.cross_findings) console.log(`  - ${f}`);
}
