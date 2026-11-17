"use client";

import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? "登录失败");
        setPending(false);
        return;
      }
      // 用 replace 而非 push：登录页不该留在浏览器后退栈里。
      window.location.replace(next);
    } catch {
      setError("网络异常，请重试");
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <div className="font-serif text-2xl tracking-wide text-fg">自主复习台</div>
        <p className="mt-2 text-sm text-muted">输入口令后进入</p>
      </div>

      <form onSubmit={submit} className="card p-6">
        <label
          htmlFor="password"
          className="mb-2 block text-xs font-medium tracking-wide text-muted"
        >
          访问口令
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          className="input w-full"
          placeholder="••••••••"
        />

        {error ? (
          <p className="mt-3 text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || password.trim() === ""}
          className="btn btn-primary mt-5 w-full"
        >
          {pending ? "验证中…" : "进入"}
        </button>
      </form>

      <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
        这是一台私人复习工具，口令由部署者设置。
      </p>
    </div>
  );
}
