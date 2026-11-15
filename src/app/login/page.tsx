import { LoginForm } from "./login-form";

export const metadata = { title: "口令 · 学习复盘" };

/**
 * 登录页。
 * ?next= 只接受站内绝对路径，避免被用来做开放重定向。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : "/";

  return <LoginForm next={target} />;
}
