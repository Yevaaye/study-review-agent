import { getStore } from "@/lib/db/store";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// 部署自检端点：一眼看出「后端是否连通、有没有数据、AI 有没有配」。
// 只暴露「布尔与枚举」，不回显任何密钥。
export async function GET() {
  // 唯一后端就是 LocalStore（JSON 文件），如实上报，不读环境变量
  const backend = "local" as const;

  let db: "ok" | "error" = "ok";
  let dbError: string | undefined;
  let textbookCount: number | undefined;
  let cardCount: number | undefined;
  let empty = false;
  try {
    const store = await getStore();
    textbookCount = (await store.listTextbooks()).length;
    cardCount = (await store.listCards()).length;
    // 空库是正常起点（分享出去的实例就是空库），不算故障。
    if (textbookCount === 0) empty = true;
  } catch (e) {
    db = "error";
    dbError = e instanceof Error ? e.message : String(e);
  }

  const body = {
    ok: db === "ok",
    backend,
    db,
    ...(empty ? { empty: true } : {}),
    ...(dbError ? { dbError: dbError.slice(0, 200) } : {}),
    ...(textbookCount !== undefined ? { textbooks: textbookCount } : {}),
    ...(cardCount !== undefined ? { cards: cardCount } : {}),
    llm: Boolean(
      config.llm.provider === "deepseek"
        ? config.llm.deepseekApiKey
        : config.llm.openaiApiKey
    ),
    node: process.version,
  };

  return Response.json(body, {
    status: body.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
