// 「这本书现在到底在不在导入」的判定（纯函数）。
//
// 为什么不能只看 import_jobs.finished_at：
//   · 导入是后台任务，import_job 行在解析一开始就落库了（stage=parsing、
//     finished_at=null），卡片要等到 88% 才批量写入 —— 这段窗口里 0 张卡是
//     **真实状态**，说「正在解析」没错；
//   · 但反过来，进程如果在 parsing 阶段被重启/崩溃，这一行会永远停在
//     finished_at=null，资料库就会**永远**显示「正在解析」，用户等不到头。
// 所以判据是「库里没写完」+「内存任务表里确实还有这本书的活任务」两条同时成立。
// 内存任务只在同一进程里存在，进程一死它就没了 —— 这正好就是我们要的探针。

import type { ImportJob } from "@/lib/db/types";
import type { Job } from "@/lib/jobs";

/** 导入任务的标题形态：`导入《材料标题》`（见 /api/import 的 createJob） */
const IMPORT_TITLE = /^导入《(.+)》$/;

export type BookImportState = "idle" | "processing" | "interrupted";

/** 从内存任务表取出「正在导入的材料标题」集合 */
export function importingTitles(
  jobs: Array<Pick<Job, "kind" | "status" | "title">>
): Set<string> {
  const out = new Set<string>();
  for (const j of jobs) {
    if (j.kind !== "import-parse" || j.status !== "running") continue;
    const m = IMPORT_TITLE.exec(j.title);
    if (m) out.add(m[1]);
  }
  return out;
}

export function bookImportState(
  lastJob: Pick<ImportJob, "finished_at"> | null | undefined,
  importing: Set<string>,
  title: string
): BookImportState {
  // 材料行先于 import_job 行落库（createTextbook → createImportJob 之间有个毫秒级窗口），
  // 这几百毫秒里 lastJob 还是空的。此时若有同名活任务，仍然算「正在解析」，
  // 否则资料库会先闪一句「这份材料是知识点正文」，再跳成「正在解析」。
  if (!lastJob) return importing.has(title) ? "processing" : "idle";
  if (lastJob.finished_at) return "idle";
  return importing.has(title) ? "processing" : "interrupted";
}
