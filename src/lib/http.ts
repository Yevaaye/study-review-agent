import { NextRequest } from "next/server";

// 统一的请求解析与错误响应。
//
// 为什么单独抽出来：
// 1) 每个路由各自 `try { await req.json() } catch { 500 }`，会把手误造成的畸形 JSON
//    误报成服务端故障（500），语义错误 —— 客户端问题应该是 400。
// 2) 错误处理散落在 11 个路由里，改一处要改 11 遍，面试也没什么可讲的；
//    收敛成一个入口后，「可预期的入参错误 → 400，其余 → 500」成了系统级约定。

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** 解析 JSON 请求体；不是合法 JSON 时抛 BadRequestError（→ 400） */
export async function readJSON<T = Record<string, unknown>>(
  req: Request | NextRequest
): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new BadRequestError("请求体不是合法 JSON");
  }
}

/** 统一错误响应：入参错误 → 400，其余 → 500 */
export function errorResponse(e: unknown, fallback: string): Response {
  if (e instanceof BadRequestError) {
    return Response.json({ error: e.message }, { status: 400 });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg || fallback }, { status: 500 });
}

/** 必填字段检查，任一为空即抛 400 */
export function requireFields(
  obj: Record<string, unknown>,
  fields: string[]
): void {
  const missing = fields.filter((f) => {
    const v = obj[f];
    return v === undefined || v === null || v === "";
  });
  if (missing.length) {
    throw new BadRequestError(`缺少必填字段: ${missing.join(", ")}`);
  }
}
