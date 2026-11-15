// 集中读取环境变量。当前仅 local（JSON 文件）后端，零依赖、可立即本地运行；
// serverless 部署需自行接入可写持久层后再扩展此文件。
// 注：旧的 supabase 适配器已删除，相关环境变量不再是有效配置。

export const config = {
  // LLM provider 抽象层：默认 OpenAI 兼容接口（用环境现有 OPENAI_API_KEY + OPENAI_BASE_URL），
  // 可切到 DeepSeek。失败一律降级，不阻塞主流程。
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "deepseek",

    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    // 默认模型需与所选服务商的支持列表一致：
    // 大龙虾代理用 gpt-5.5；官方 OpenAI 账号请改为 gpt-4o-mini 等。
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.5",

    /**
     * 是否给请求带 `response_format: {type:"json_object"}`。
     *
     * 默认关：本网关（api.biglongxia.cn）带这个参数会打到一条坏上游 ——
     * 实测同一段提示词，带它 45 秒后 502 upstream_error，不带 6.8 秒 200 返回。
     * 而提示词里已经写死了「只输出 JSON」，本地 extractJSON 也能兜住格式，
     * 所以这个参数对我们是纯负担。
     *
     * 换成支持的网关（如官方 OpenAI）时设 LLM_JSON_MODE=on 即可重新启用。
     */
    jsonMode: (process.env.LLM_JSON_MODE ?? "off") as "on" | "off",

    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
    deepseekBaseUrl: "https://api.deepseek.com/v1",
    deepseekModel: "deepseek-chat",
  },
};
