// 对话入参校验。
//
// 为什么单独一个文件：校验写在 route.ts 里就只能「发请求试试」，而它其实是
// 整个对话接口唯一的成本闸门。抽成纯函数后 scripts/chat-check.mjs 能直接
// 断言 20 条 / 4000 字 / 12000 字这三道闸门，改坏立刻红。
export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

/** 最多 20 轮（含 system）。再多就该开新会话了。 */
export const MAX_TURNS = 20;
/** 单条上限：4000 字 ≈ 2k token，够贴一整节正文。 */
export const MAX_ONE = 4000;
/** 累计上限：12000 字 ≈ 6k token。/api/chat 无状态，每轮都会把历史重发一遍，不设总闸门就会线性烧钱。 */
export const MAX_TOTAL = 12000;

const ROLES = new Set(["system", "user", "assistant"]);

export type GuardResult =
  | { ok: true; messages: ChatTurn[] }
  | { ok: false; error: string };

export function validateChatMessages(raw: unknown): GuardResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "messages 必须是非空数组" };
  }
  if (raw.length > MAX_TURNS) {
    return { ok: false, error: `messages 超过 ${MAX_TURNS} 条` };
  }

  let total = 0;
  const out: ChatTurn[] = [];

  for (const m of raw) {
    if (!m || typeof m !== "object") return { ok: false, error: "消息格式非法" };
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !ROLES.has(role)) {
      return { ok: false, error: `非法 role: ${String(role)}` };
    }
    if (typeof content !== "string") return { ok: false, error: "content 必须是字符串" };
    const t = content.trim();
    if (!t) return { ok: false, error: "content 不能为空" };
    if (t.length > MAX_ONE) return { ok: false, error: `单条超过 ${MAX_ONE} 字` };
    total += t.length;
    if (total > MAX_TOTAL) return { ok: false, error: `累计超过 ${MAX_TOTAL} 字` };
    out.push({ role: role as ChatTurn["role"], content: t });
  }

  // 末条必须是 user：否则模型只是在续写自己的上一句，用户会以为「点了没反应」。
  if (out[out.length - 1].role !== "user") {
    return { ok: false, error: "最后一条必须是 user" };
  }
  return { ok: true, messages: out };
}
