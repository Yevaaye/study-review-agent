/**
 * 生成 UUID v4（浏览器 / Node 通用）。
 *
 * 为什么要自己写一层：`crypto.randomUUID()` 属于**安全上下文专属** API ——
 * 只在 https 或 localhost 下存在。手机通过 `http://192.168.x.x:3000` 打开时
 * `window.crypto` 还在，但 `crypto.randomUUID` 是 `undefined`，直接调用就会抛
 * `crypto.randomUUID is not a function`（复习页评分按钮因此整条不可用）。
 *
 * `crypto.getRandomValues()` 没有这个限制（非安全上下文也保留），
 * 所以退化路径用它自己拼一个标准 v4；实在没有才用 Math.random 兜底。
 * 幂等键的用途只需要「同一轮作答内稳定 + 全局不撞」，不要求密码学强度。
 */
export function uuid(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  if (typeof c?.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // 某些老实现会抛错，落到下面的兜底
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122：version 4 + variant 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
