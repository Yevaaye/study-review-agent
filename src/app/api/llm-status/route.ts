import { getLLMStatus } from "@/lib/llm";

export const dynamic = "force-dynamic";

// AI 网关自检：出问题时直接看这里，而不是靠猜「为什么没生成卡片」。
export async function GET() {
  return Response.json(getLLMStatus());
}
