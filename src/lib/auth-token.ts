/**
 * 极简口令门（单用户 / 分享给一两个人用）。
 *
 * 不是账号体系：没有用户表、没有会话存储。设了 APP_PASSWORD 之后，
 * 输入正确口令即种一个 HMAC 化的 cookie；proxy 每次请求重算同一个值比对。
 * 目的只有一个 —— 别让公网上的陌生人能翻开你的书、删你的卡片。
 *
 * 约束：这里必须只用 Web Crypto / 纯 JS，因为 src/proxy.ts 跑在 Edge 运行时。
 */

export const AUTH_COOKIE = "sr_auth";

/** 固定盐：防止有人拿现成的 sha256 彩虹表反推口令。 */
const TOKEN_SALT = "::study-review-v1";

/** 读环境变量里的口令；未设置或全空白 = 不启用口令门（本地开发不受影响）。 */
export function appPassword(): string | null {
  const raw = process.env.APP_PASSWORD;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** 口令 → cookie 里存的值（sha256(password+salt) 前 40 位十六进制）。 */
export async function authToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${password}${TOKEN_SALT}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 40);
}

/** 定长比较，避免按字节提前返回泄露前缀。 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
