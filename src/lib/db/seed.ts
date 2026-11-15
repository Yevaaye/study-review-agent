// 种子数据的「静态导入」版本。
//
// 为什么不用运行时 fs 读 db/seed-data.json：
// 1) 部署到 Vercel 等 serverless 环境时，只有被打包器静态分析到的文件才会进入产物；
//    运行时动态拼路径 fs.readFile，文件可能不存在。
// 2) 静态 import 由打包器保证可用，本地与线上行为一致。
//
// db/seed-data.json 仍是唯一数据源（single source of truth），这里只做类型断言转发。
import raw from "../../../db/seed-data.json";

import type {
  Card,
  Chapter,
  KnowledgePoint,
  SourceFragment,
  Textbook,
} from "./types";

export interface SeedCardSource {
  card_id: string;
  source_fragment_id: string;
  role: string;
}

export interface SeedData {
  textbooks: Textbook[];
  chapters: Chapter[];
  knowledgePoints: KnowledgePoint[];
  source_fragments: SourceFragment[];
  cards: Card[];
  card_sources: SeedCardSource[];
}

export const seed = raw as unknown as SeedData;
