// 上游 SSE → 文本增量。
//
// 这是整条流式链路最容易写错的地方：上游按 `data: {...}\n\n` 分块返回，
// 而 TCP 的分块边界**不会对齐行边界** —— 一行的后半截可能落在下一个 chunk 里。
// 按 chunk 直接 JSON.parse 会在「回答越长越容易断」的位置丢字，
// 表现出来是答案里随机少几个词，几乎无法归因。所以必须带缓冲区。
export function createSSEParser() {
  let buf = "";

  return {
    push(chunk: string): { texts: string[]; errors: string[] } {
      buf += chunk;
      const texts: string[] = [];
      const errors: string[] = [];

      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break; // 不完整行：留在缓冲区等下一块
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);

        if (!line || line.startsWith(":")) continue; // 空行 / keep-alive 注释
        if (!line.startsWith("data:")) continue; // event: / id: 等非内容行

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const j = JSON.parse(payload) as {
            error?: { message?: string };
            choices?: { delta?: { content?: string } }[];
          };
          if (j.error) {
            errors.push(j.error.message ?? "upstream error");
            continue;
          }
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) texts.push(delta.content);
        } catch {
          // 解析失败：把这行放回去，等下一块凑齐（宁可等，不要丢）
          buf = `${line}\n${buf}`;
          break;
        }
      }

      return { texts, errors };
    },
  };
}
