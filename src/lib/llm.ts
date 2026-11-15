import { config } from "./config";
import { createSSEParser } from "./chat/sse";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatJSONOptions {
  system: string;
  user: string;
  temperature?: number;
  // 超时（毫秒），默认 20s
  timeoutMs?: number;
}

// ---- 失败原因留痕 ----------------------------------------------------------
// 早期版本在这里 `if (!res.ok) return null` 就结束了，导致「AI 为什么不生效」
// 完全不可观测（只能看到降级到题库，看不到 403 额度不足 / 503 模型不存在）。
// 现在把状态码与错误摘要打到服务端日志，排查成本从「猜」变成「看」。
//
// 状态必须挂在 globalThis 上：Next.js 会把每个 API 路由 / 页面编译成独立的模块
// 实例，模块级变量于是「每个路由一份」。之前 /api/llm-status 永远显示
// json_mode_broken=false，而导入路由早就降级过了 —— 因为看到的是两份内存。
type LLMState = {
  lastError: string | null;
  lastOkAt: string | null;
  /** 网关是否已被判定为不支持 response_format=json_object */
  jsonModeBroken: boolean;
  /**
   * 降级状态的过期时间戳。
   *
   * 「永久标记网关不支持 JSON 模式」是个陷阱：本网关只是**间歇性**把
   * JSON 模式打到坏上游，一旦被标记，整个进程生命周期都会走纯提示词路径，
   * 而那条路更慢（无格式约束时模型会多说废话），长章节直接 100 秒超时。
   * 实测新进程带 JSON 模式 1.7 秒返回、15.9 秒出完整知识点 —— 
   * 所以这里给降级加 10 分钟冷却，过点后重新试一次好路径。
   */
  jsonModeBrokenUntil: number;
  /** JSON 模式是否已实测成功过 —— 成功后就不再用「探测用短超时」，避免大章节被误杀 */
  jsonModeOk: boolean;
};

const globalForLLM = globalThis as typeof globalThis & {
  __studyReviewLLMState?: LLMState;
};

const state: LLMState = (globalForLLM.__studyReviewLLMState ??= {
  lastError: null,
  lastOkAt: null,
  jsonModeBroken: false,
  jsonModeBrokenUntil: 0,
  jsonModeOk: false,
});

/** 当前是否处于「跳过 JSON 模式」的降级窗口内 */
function jsonModeDisabled(): boolean {
  return state.jsonModeBroken && Date.now() < state.jsonModeBrokenUntil;
}

export function getLLMStatus() {
  const llm = config.llm;
  const useDeepseek = llm.provider === "deepseek";
  return {
    provider: llm.provider,
    model: useDeepseek ? llm.deepseekModel : llm.openaiModel,
    base_url: useDeepseek ? llm.deepseekBaseUrl : llm.openaiBaseUrl,
    has_key: Boolean(useDeepseek ? llm.deepseekApiKey : llm.openaiApiKey),
    last_ok_at: state.lastOkAt,
    last_error: state.lastError,
    // 该网关（api.biglongxia.cn）带 response_format=json_object 会间歇性 502，
    // 探测到之后进程内自动降级；这里暴露出来便于确认降级是否已生效。
    json_mode_broken: jsonModeDisabled(),
    json_mode_ok: state.jsonModeOk,
  };
}

function fail(stage: string, detail: string): null {
  state.lastError = `${stage}: ${detail}`.slice(0, 300);
  console.warn(`[llm] ${state.lastError}`);
  return null;
}

// GPT-5 / o 系列属于推理模型：只接受默认 temperature（传 0.7 会 400）。
const REASONING_MODEL = /^(gpt-5|o[1-9])/i;

// 从模型输出里尽力提取 JSON。
// 兼容三种情况：纯 JSON、被 ```json 包裹、前后夹了解释性文字。
function extractJSON<T>(raw: string): T | null {
  const text = raw.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    /* 继续尝试 */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* 继续尝试 */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

type Attempt = {
  ok: boolean;
  status: number;
  text: string;
  /** 本次尝试耗时，用来识别「上游空等到超时才报错」这种坏路径 */
  ms: number;
};

/**
 * 网关是否支持 response_format=json_object —— 实测结论见 state.jsonModeBroken。
 *
 * 实测（api.biglongxia.cn）：同一个提示词
 *   · 带 json_object  → 502 upstream_error，空等 55~61 秒才报错
 *   · 不带            → 200，3.8 秒，返回合法 JSON
 * 也就是说 JSON 模式在这个网关上会把请求打到一条坏掉的上游。
 *
 * 早期版本只在收到 400 时才去掉该参数重试，502 时又把带参数的原请求重发一遍，
 * 结果必然是「导入成功、一张卡都没有」。现在改成探测式降级：
 * 一旦发现是 JSON 模式导致的失败，就记进全局状态，后续请求不再携带它。
 */

/** 每次尝试独立计时：旧实现所有重试共用一个 AbortController，
 *  第一次尝试耗掉大半预算后，重试几乎立刻被 abort，等于没有重试。 */
async function post(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Attempt> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text(), ms: Date.now() - startedAt };
  } catch (err) {
    const e = err as Error;
    const reason =
      e.name === "AbortError" ? `timeout ${timeoutMs}ms` : `${e.name}: ${e.message}`;
    return { ok: false, status: 0, text: reason, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** 判断失败是否「可能由 JSON 模式引起」——用于决定要不要降级重试 */
function looksLikeJsonModeIssue(attempt: Attempt, reason: string): boolean {
  if (/response_format|json_object|json mode|json mode is not supported|unsupported/i.test(reason))
    return true;
  // 4xx 语义拒绝：参数不被接受
  if ([400, 404, 415, 422].includes(attempt.status)) return true;
  // 5xx 且长时间空等：本网关 JSON 模式的典型表现（upstream_error）
  if ([500, 502, 503, 504].includes(attempt.status) && attempt.ms > 15000) return true;
  if (/upstream_error|Upstream service temporarily unavailable/i.test(reason)) return true;
  return false;
}

function errorReason(text: string): string {
  let reason = text.slice(0, 200);
  try {
    const j = JSON.parse(text);
    reason = j?.error?.message ?? j?.message ?? j?.error?.code ?? reason;
  } catch {
    /* 保持原始文本 */
  }
  return String(reason).replace(/\s+/g, " ");
}

export async function chatJSON<T>(
  opts: ChatJSONOptions
): Promise<T | null> {
  const llm = config.llm;
  const useDeepseek = llm.provider === "deepseek";
  const apiKey = useDeepseek ? llm.deepseekApiKey : llm.openaiApiKey;
  const baseUrl = (useDeepseek ? llm.deepseekBaseUrl : llm.openaiBaseUrl).replace(
    /\/+$/,
    ""
  );
  const model = useDeepseek ? llm.deepseekModel : llm.openaiModel;

  if (!apiKey) return fail("config", "缺少 API key");

  const url = `${baseUrl}/chat/completions`;
  const messages = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  const baseBody: Record<string, unknown> = {
    model,
    messages,
  };
  // 推理模型不接受自定义 temperature，传了反而报 400
  if (!REASONING_MODEL.test(model)) {
    baseBody.temperature = opts.temperature ?? 0.7;
  }
  const skipJsonMode = config.llm.jsonMode !== "on" || jsonModeDisabled();
  const withJsonMode: Record<string, unknown> = skipJsonMode
    ? baseBody
    : { ...baseBody, response_format: { type: "json_object" } };

  const timeoutMs = opts.timeoutMs ?? 20000;

  /** 统一的「解析响应 → 提取 JSON」收尾 */
  const finish = (attempt: Attempt): T | null => {
    // status=0 表示请求根本没拿到响应（超时 / 网络中断），单独标记便于排查
    if (attempt.status === 0) return fail("network", attempt.text);
    if (!attempt.ok) return fail(`HTTP ${attempt.status} (${model})`, errorReason(attempt.text));

    let data: { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    try {
      data = JSON.parse(attempt.text);
    } catch {
      return fail("response", "响应体不是合法 JSON");
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return fail(
        "empty",
        `模型返回空内容 (finish_reason=${data?.choices?.[0]?.finish_reason ?? "?"})`
      );
    }

    const parsed = extractJSON<T>(content);
    if (parsed === null) {
      return fail("json", `无法从输出中提取 JSON: ${content.slice(0, 120)}`);
    }
    return parsed;
  };

  // 第一次尝试：带 JSON 模式（若网关还没被判定为不支持）。
  // 首次探测只给较短窗口：正常的 JSON 模式调用都是秒级返回，拖到 20 秒以上
  // 基本就是打到了坏上游（本网关实测会空等 55~61 秒才报 upstream_error）。
  // 一旦成功过一次就记下来，后续用完整超时，避免大章节被探测用短超时误杀。
  const jsonModeTimeout = state.jsonModeOk || skipJsonMode
    ? timeoutMs
    : Math.min(timeoutMs, 20000);
  const sentJsonMode = !skipJsonMode;
  let attempt = await post(url, apiKey, withJsonMode, jsonModeTimeout);

  if (attempt.ok && sentJsonMode) state.jsonModeOk = true;

  // JSON 模式失败 → 立刻改用「纯提示词」重试。
  // 成功（或错误码发生变化）即判定该网关暂时不认 json_object，进入 10 分钟降级窗口。
  if (!attempt.ok && !skipJsonMode && looksLikeJsonModeIssue(attempt, errorReason(attempt.text))) {
    const retry = await post(url, apiKey, baseBody, timeoutMs);
    // 只要「带 json_object 的这条路」失败了，就先停用它 —— 不管重试是否成功。
    // 旧逻辑要求「重试成功或错误码变了」才降级，重试也 502 时状态不会变，
    // 下一次请求又要先白等 45 秒才走到同样的结论。
    state.jsonModeBroken = true;
    state.jsonModeBrokenUntil = Date.now() + 10 * 60 * 1000;
    state.jsonModeOk = false;
    console.warn(
      `[llm] JSON 模式失败（${attempt.status || "timeout"} / ${attempt.ms}ms），10 分钟内改用提示词约束 + 本地提取`
    );
    attempt = retry;
  } else if (
    !attempt.ok &&
    // status=0 是超时/网络中断 —— 这恰恰是最常见的失败，也必须重试一次。
    // 早期只对 429/5xx 重试，于是「探测用 20 秒超时」一旦打慢，整章就直接失败，
    // 而同样的请求给足 100 秒往往 20 秒内就回来了。
    (attempt.status === 0 || [429, 500, 502, 503, 504].includes(attempt.status))
  ) {
    // 纯瞬态错误：等一拍再试一次。
    // 请求体必须与首次一致（withJsonMode）—— 旧实现这里传的是 baseBody，
    // 等于「悄悄降级掉了 json 模式」却没记进 state.jsonModeBroken：
    // 本次失败看不出原因，下次请求又会把 json_object 带回去，行为不可复现。
    await new Promise((r) => setTimeout(r, 400));
    attempt = await post(url, apiKey, withJsonMode, timeoutMs);
  }

  const parsed = finish(attempt);
  if (parsed !== null) {
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
  }
  return parsed;
}

/** 未配置 Key —— 单独一个类型，route 层据此回 503 而不是 500「服务端故障」 */
export class LLMNotConfiguredError extends Error {
  constructor() {
    super("未配置 API Key");
    this.name = "LLMNotConfiguredError";
  }
}

/**
 * 流式对话（纯文本增量）。
 *
 * 为什么不能复用上面的 chatJSON()：它在收尾处强制 extractJSON()，
 * 普通问答的自然语言会被判「无法提取 JSON」→ 返回 null，前端只能拿到空。
 * 为什么也不能复用 post()：那里 `await res.text()` 会把整个响应读完才返回，
 * 流式直接退化成「等 20 秒一次性蹦出来」。所以这里自己 getReader() 逐块读。
 *
 * 不传 response_format：本网关带 JSON 模式会间歇性打到坏上游（见 state.jsonModeBroken）。
 */
export async function* chatStream(
  turns: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature?: number; timeoutMs?: number } = {}
): AsyncGenerator<string> {
  const llm = config.llm;
  const useDeepseek = llm.provider === "deepseek";
  const apiKey = useDeepseek ? llm.deepseekApiKey : llm.openaiApiKey;
  const baseUrl = (useDeepseek ? llm.deepseekBaseUrl : llm.openaiBaseUrl).replace(/\/+$/, "");
  const model = useDeepseek ? llm.deepseekModel : llm.openaiModel;

  if (!apiKey) throw new LLMNotConfiguredError();

  const body: Record<string, unknown> = { model, messages: turns, stream: true };
  // 推理模型（gpt-5 / o1~o9）只接受默认 temperature，传了 400
  if (!REASONING_MODEL.test(model)) body.temperature = opts.temperature ?? 0.6;

  const timeoutMs = opts.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 非 2xx 时上游返回的是 JSON 错误体，可以整体读
      const text = await res.text();
      const reason = `HTTP ${res.status}: ${errorReason(text)}`;
      state.lastError = `chat: ${reason}`.slice(0, 300);
      console.warn(`[llm] ${state.lastError}`);
      throw new Error(reason);
    }
    if (!res.body) throw new Error("上游未返回响应体");

    const parser = createSSEParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { texts, errors } = parser.push(decoder.decode(value, { stream: true }));
      if (errors.length) throw new Error(errors[0]);
      for (const t of texts) yield t;
    }

    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
  } finally {
    clearTimeout(timer);
  }
}
