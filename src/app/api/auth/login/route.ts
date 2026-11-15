import { NextResponse } from "next/server";

import { AUTH_COOKIE, appPassword, authToken, safeEqual } from "@/lib/auth-token";

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

interface Attempt {
  fails: number;
  lockedUntil: number;
}

// 进程内计数即可：单机两个实例，各锁各的，够挡住脚本爆破。
const globalStore = globalThis as unknown as {
  __srLoginAttempts?: Map<string, Attempt>;
};
const attempts: Map<string, Attempt> = (globalStore.__srLoginAttempts ??= new Map());

function clientKey(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local"
  );
}

export async function POST(req: Request) {
  const password = appPassword();
  // 没配口令 = 口令门未启用，直接放行，前端据 noPassword 直接跳转。
  if (!password) return NextResponse.json({ ok: true, noPassword: true });

  const key = clientKey(req);
  const now = Date.now();
  const record = attempts.get(key);
  if (record && record.lockedUntil > now) {
    const wait = Math.ceil((record.lockedUntil - now) / 1000);
    return NextResponse.json(
      { error: `尝试次数过多，请 ${wait} 秒后再试` },
      { status: 429 },
    );
  }

  let payload: { password?: unknown };
  try {
    payload = (await req.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const input = typeof payload.password === "string" ? payload.password : "";
  if (input === "") {
    return NextResponse.json({ error: "请输入口令" }, { status: 400 });
  }

  if (!safeEqual(input, password)) {
    const fails = (record?.fails ?? 0) + 1;
    attempts.set(key, {
      fails,
      lockedUntil: fails >= MAX_FAILS ? now + LOCK_MS : 0,
    });
    return NextResponse.json(
      { error: fails >= MAX_FAILS ? "错误次数过多，已锁定 5 分钟" : "口令不正确" },
      { status: 401 },
    );
  }

  attempts.delete(key);

  const res = NextResponse.json({ ok: true });
  // 不设 secure：隧道是 https，但本机直连 http 时 secure cookie 不会写入。
  // SameSite=Lax 已能挡住跨站表单提交，单用户场景足够。
  res.cookies.set(AUTH_COOKIE, await authToken(password), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
