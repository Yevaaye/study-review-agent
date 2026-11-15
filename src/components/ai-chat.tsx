"use client";

// 右下角的 AI 对话悬浮窗。
//
// 三个约束决定了这里的写法：
//   1. 只在服务端持有 Key —— 前端只 POST /api/chat，绝不直连模型。
//   2. 必须是流式 —— 非流式在 10~30 秒里只有一个转圈，用户不知道是慢还是死。
//   3. 进度条与全站一致 —— 复用 <AiProgress>，不要在这里再写一根 div。
//
// 位置：手机抬到底部导航之上（.ai-fab），桌面右下角；面板打开时把按钮藏起来，
// 避免和面板的关闭按钮重复。打开后由 .ai-panel-mask 盖住页面，Esc / 点遮罩 /
// 关闭按钮三种方式都能退出。

import { useCallback, useEffect, useRef, useState } from "react";

import { MarkdownInline } from "./fragment-body";
import { AiProgress } from "./ai-progress";
import { MAX_TOTAL, MAX_TURNS, type ChatTurn } from "@/lib/chat/guard";
import { formatDuration } from "@/lib/ui/progress";

type Phase = "idle" | "sending" | "streaming" | "error";

/**
 * 只保留最近若干轮再发出去。
 *
 * 服务端有 20 条 / 12000 字的硬闸门，长对话迟早会撞上。撞上时用户看到的是
 * 「累计超过 12000 字」这种话 —— 他并不知道该怎么办。这里主动丢最早的上下文，
 * 让对话能继续，而不是突然报错。
 */
function trimForSend(turns: ChatTurn[]): ChatTurn[] {
  const list = [...turns];
  const size = () => list.reduce((a, t) => a + t.content.length, 0);
  while (list.length > 1 && (list.length > MAX_TURNS - 1 || size() > MAX_TOTAL)) {
    list.shift();
  }
  return list;
}

export function AiChat() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [lastMeta, setLastMeta] = useState<{ ms: number; chars: number } | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = phase === "sending" || phase === "streaming";

  // 打开时确认 Key 是否配置：没配就直接说清楚，别让用户发一条再看到 503
  useEffect(() => {
    if (!open || hasKey !== null) return;
    let alive = true;
    void fetch("/api/llm-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { has_key?: boolean } | null) => {
        if (alive) setHasKey(d?.has_key !== false);
      })
      .catch(() => {
        if (alive) setHasKey(true); // 探测失败不拦人，交给发送时报错
      });
    return () => {
      alive = false;
    };
  }, [open, hasKey]);

  // Esc 关闭（生成中先停生成，再按一次才关）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (busy) {
        abortRef.current?.abort();
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  // 打开即聚焦输入框：少一次点击
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  // 新内容到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, phase]);

  // 组件卸载时中断请求，避免 setState on unmounted
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    const next: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setInput("");
    setError(null);
    setLastMeta(null);
    const t0 = Date.now();
    setStartedAt(t0);
    setEndedAt(null);
    setPhase("sending");

    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: trimForSend(next) }),
        signal: ac.signal,
      });

      // 失败是 JSON、成功是纯文本流 —— 先判状态码再分流
      if (!res.ok) {
        const j = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error?: string;
        };
        setError(j.error ?? `HTTP ${res.status}`);
        if (res.status === 503) setHasKey(false);
        setPhase("error");
        setEndedAt(Date.now());
        return;
      }
      if (!res.body) {
        setError("响应体为空");
        setPhase("error");
        setEndedAt(Date.now());
        return;
      }

      setPhase("streaming");
      setTurns((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setTurns((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      }

      // 服务端在流尾追加的错误标记：头已发出，改不了状态码
      const bad = acc.indexOf("[错误]");
      if (bad >= 0) {
        setError(acc.slice(bad).trim());
        setTurns((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: acc.slice(0, bad).trim() };
          }
          return copy;
        });
        setPhase("error");
        setEndedAt(Date.now());
        return;
      }

      setPhase("idle");
      setEndedAt(Date.now());
      setLastMeta({ ms: Date.now() - t0, chars: acc.length });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setPhase("idle");
        setEndedAt(Date.now());
        if (acc) {
          setLastMeta({ ms: Date.now() - t0, chars: acc.length });
        }
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      setEndedAt(Date.now());
    } finally {
      abortRef.current = null;
    }
    // startedAt 不进依赖：它在 send 开头就被 set，进依赖会让 send 每次重建成新引用
  }, [input, busy, turns]);

  function stop() {
    abortRef.current?.abort();
  }

  function clear() {
    if (busy) abortRef.current?.abort();
    setTurns([]);
    setError(null);
    setLastMeta(null);
    setStartedAt(null);
    setEndedAt(null);
    setPhase("idle");
  }

  const canSend = !busy && input.trim().length > 0 && hasKey !== false;

  return (
    <>
      <button
        type="button"
        className="ai-fab"
        data-hidden={open}
        aria-label="打开 AI 对话"
        onClick={() => setOpen(true)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21 12a8 8 0 0 1-8 8H8l-4.5 3v-5.2A8 8 0 0 1 3 12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="9" cy="12" r="1.15" fill="currentColor" />
          <circle cx="12.5" cy="12" r="1.15" fill="currentColor" />
          <circle cx="16" cy="12" r="1.15" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <>
          <div className="ai-panel-mask" onClick={() => (busy ? undefined : setOpen(false))} />
          <section
            className="ai-panel"
            role="dialog"
            aria-modal="true"
            aria-label="AI 对话"
            onClick={(e) => e.stopPropagation()}
            // 面板内的 pointerdown 不外泄：某些浏览器在拖动选择文字时
            // 会让 mouseup 落到 mask 上，导致「选着选着弹窗没了」
            onPointerDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
              <span className="text-[13px] font-medium">AI 对话</span>
              <span className="micro">AI 生成 · 仅供参考</span>
              <div className="ml-auto flex items-center gap-1">
                {turns.length > 0 && (
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-[11px] text-muted transition hover:text-fg"
                    onClick={clear}
                  >
                    清空
                  </button>
                )}
                <button
                  type="button"
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-white/[0.06] hover:text-fg"
                  aria-label="关闭"
                  onClick={() => {
                    if (busy) abortRef.current?.abort();
                    setOpen(false);
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {turns.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
                  <p className="text-[13px] text-fg/80">有问题直接问</p>
                  <p className="micro max-w-[15rem]">
                    回答由模型生成，可能出错；涉及你库里的材料时请以原文为准。
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {turns.map((t, i) => {
                    const isUser = t.role === "user";
                    const last = i === turns.length - 1;
                    return (
                      <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[92%] whitespace-pre-wrap rounded-[var(--radius-md)] px-3 py-2 text-[13.5px] leading-relaxed ${
                            isUser
                              ? "bg-white/[0.10] text-fg"
                              : "bg-white/[0.035] text-fg/90"
                          }`}
                        >
                          {isUser ? t.content : <MarkdownInline text={t.content} />}
                          {!isUser && last && phase === "streaming" && !t.content && (
                            <span className="inline-block h-3 w-[2px] animate-pulse bg-fg/60 align-middle" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {lastMeta && phase === "idle" && (
                    <p className="micro text-right">
                      用时 {formatDuration(lastMeta.ms)} · {lastMeta.chars} 字
                    </p>
                  )}
                </div>
              )}
            </div>

            {(busy || phase === "error") && (
              <div className="border-t border-border/60 px-4 py-2.5">
                <AiProgress
                  startedAt={startedAt}
                  endedAt={endedAt}
                  percent={null}
                  status={phase === "error" ? "error" : "running"}
                  phase={
                    phase === "sending"
                      ? "等待模型响应"
                      : phase === "streaming"
                        ? "正在回答"
                        : "未完成"
                  }
                  note={
                    phase === "error"
                      ? "已生成的部分不会丢，可以重发一次。"
                      : "已收到内容前也可以点停止，不会丢已生成的部分。"
                  }
                />
              </div>
            )}

            {(error || hasKey === false) && (
              <div className="border-t border-border/60 px-4 py-2">
                <p className={`text-[11px] leading-relaxed ${error ? "text-danger" : "text-warning"}`}>
                  {error ??
                    "未配置 API Key：请在 .env.local 设置 OPENAI_API_KEY 后重启服务（前端不会接触 Key）。"}
                </p>
              </div>
            )}

            <footer className="flex items-end gap-2 border-t border-border/60 px-3 py-2.5">
              <textarea
                ref={inputRef}
                className="max-h-32 min-h-[38px] flex-1 resize-none rounded-[var(--radius-md)] border border-border bg-white/[0.04] px-3 py-2 text-[13.5px] leading-relaxed outline-none placeholder:text-muted/70 focus:border-white/20"
                rows={1}
                placeholder={hasKey === false ? "未配置 API Key" : "问点什么…（Enter 发送 / Shift+Enter 换行）"}
                value={input}
                disabled={hasKey === false}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {busy ? (
                <button type="button" className="btn-ghost btn-sm h-[38px] shrink-0" onClick={stop}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary h-[38px] w-[38px] shrink-0 p-0"
                  aria-label="发送"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 19V5M12 5l-6 6M12 5l6 6"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </footer>
          </section>
        </>
      )}
    </>
  );
}
