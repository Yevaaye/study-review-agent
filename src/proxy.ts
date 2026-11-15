import { NextResponse, type NextRequest } from "next/server";

import { AUTH_COOKIE, appPassword, authToken, safeEqual } from "@/lib/auth-token";

/**
 * Next 16 的 proxy 文件（等价于旧版 middleware）。
 * 作用：当 APP_PASSWORD 有值时，拦下所有未携带有效 cookie 的请求。
 */
export default async function proxy(req: NextRequest) {
  const password = appPassword();
  if (!password) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  // 登录页与登录接口本身必须放行，否则永远进不去。
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && safeEqual(token, await authToken(password))) {
    return NextResponse.next();
  }

  // 接口调用方拿到 401 JSON 更好排错，页面则跳登录页。
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "需要口令才能访问", code: "unauthenticated" },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // 构建产物与静态文件不进网关：既省 CPU，也免得 dev 模式的 HMR 资源被重定向成 HTML。
  matcher: [
    "/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)",
  ],
};
