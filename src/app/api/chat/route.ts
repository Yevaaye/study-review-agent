import { BadRequestError, errorResponse, readJSON } from "@/lib/http";
import { validateChatMessages } from "@/lib/chat/guard";
import { chatStream, getLLMStatus, LLMNotConfiguredError } from "@/lib/llm";

export const dynamic = "force-dynamic";
// 流式对话可能较久（长回答），别用默认超时
export const maxDuration = 60;

/**
 * AI 对话代理。
 *
 * 为什么必须走服务端：Key 一旦进客户端 bundle 就等于公开发布。
 * 另外这条链路还承担三个闸门（条数 / 单条字数 / 累计字数），
 * 浏览器直连模型 API 会绕过它们，账单不可控。
 *
 * 响应约定：
 *   成功 → 200 + text/plain 纯文本流（SSE 在服务端就消化掉了，前端只读 bytes）
 *   失败 → 非 2xx + JSON { error }
 * 这样前端不用给流套信封格式，先判 res.ok 就能分流。
 */
export async function POST(req: Request) {
  try {
    const body = await readJSON<{ messages?: unknown }>(req);
    const guarded = validateChatMessages(body.messages);
    if (!guarded.ok) throw new BadRequestError(guarded.error);

    // 必须在建流之前判 Key：一旦把响应头发出去，就只能往正文里追加标记，
    // 状态码改不了了。前端也拿不到「去配置 Key」这种可行动的错误码。
    if (!getLLMStatus().has_key) throw new LLMNotConfiguredError();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const piece of chatStream(guarded.messages)) {
            controller.enqueue(encoder.encode(piece));
          }
        } catch (e) {
          // 已经吐出去的字收不回来，只能在流尾追加一个可识别的错误标记
          const msg = e instanceof Error ? e.message : String(e);
          controller.enqueue(encoder.encode(`\n\n[错误] ${msg}`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // 反代（scripts/lan-proxy.mjs / tunnel.mjs）默认缓冲响应体，
        // 不加这个头，流式会退化成「等 20 秒一次性蹦出来」。
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof LLMNotConfiguredError) {
      return Response.json(
        { error: "未配置 API Key，请在 .env.local 设置 OPENAI_API_KEY 后重启服务" },
        { status: 503 }
      );
    }
    return errorResponse(e, "AI 对话失败");
  }
}
