/**
 * 知识点陈述的「可读化」拆解（纯展示层，不改数据）。
 *
 * 导入时有些知识点是从原文的表格行、题组表头里提炼出来的，statement 会长成：
 *   `# / 题目 / 难度 / 状态：1 / RAG 和微调有什么区别？什么场景该用哪个？ / ⭐⭐ / ✅ 完整`
 * 或者：
 *   `维度 / 传统工作流 / Agentic Workflows：自我修正 / 低，改流程需改代码 / 高，改 Prompt 即可`
 * 原样渲染到手机上就是一条看不出重点的长句，用户只会觉得「乱、累」。
 *
 * 这里把这类陈述拆成三种角色，交给页面分行显示：
 *   main   —— 这一条到底要知道什么（单独一行，正文字号）
 *   fields —— 表头: 值（一行一对，左标签右内容）
 *   meta   —— 难度 / 状态 这类标签，做成小徽标
 *
 * 拆不出来就原样当 main 返回，保证信息不丢。
 */

export type KpField = { label: string; value: string };

export type KpView = {
  main: string;
  fields: KpField[];
  meta: KpField[];
  /** 值得显示的原文依据（与陈述重复时为空） */
  evidence: string;
  /** 这条陈述本身只是出处/抓取信息，不是知识 —— 页面用小字弱化，别占用正文字号 */
  dim: boolean;
};

/** 代表「这一条在问什么 / 讲什么」的表头 */
const MAIN_KEYS = /^(题目|问题|题干|考点|考察点|知识点|内容|主题)$/;
/** 只值一行小标签、不该占正文字号的表头 */
const META_KEYS = /^(#|序号|编号|难度|状态|出现频率|频率|来源|类型|标签|备注|完整度|完整性)$/;

const tidy = (s: string): string => s.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();

/** 去掉空白与省略号后比较，用来判断「原文依据」是不是陈述的复述 */
const bare = (s: string): string => s.replace(/[\s…．.]+/g, "");

/**
 * 把 `表头 / 表头 / 表头：值 / 值 / 值` 形式的陈述拆成两组。
 * 表头与值的段数必须相等，否则说明这只是普通句子里带了斜杠，不动它。
 */
function splitRowStatement(statement: string): { heads: string[]; values: string[] } | null {
  const colon = statement.search(/[：:]/);
  if (colon <= 0) return null;

  const headPart = statement.slice(0, colon);
  const valuePart = statement.slice(colon + 1);
  if (!headPart.includes(" / ") || !valuePart.includes(" / ")) return null;

  const heads = headPart.split(" / ").map(tidy).filter(Boolean);
  const values = valuePart.split(" / ").map(tidy).filter(Boolean);
  if (heads.length < 2 || heads.length !== values.length) return null;
  // 表头都是短词（维度 / 适合 AI / Agentic Workflows）；
  // 带句读的长片段说明这是普通句子里的斜杠，不是表格行
  if (heads.some((h) => h.length > 20 || /[，。；！？]/.test(h))) return null;

  return { heads, values };
}

/** 「难度：⭐⭐ 入门必备 出现频率：极高 - 考察点：能否讲清三者…」里的元信息 */
const META_FIELD =
  /(难度|出现频率|频率|状态|来源|类型|时长|分值|完整度)[：:]\s*([^：:]+?)(?=\s*(?:难度|出现频率|频率|状态|来源|类型|时长|分值|完整度)[：:]|\s+-\s+|$)/g;
const EXAM_FIELD = /(?:考察点|考点|知识点)[：:]\s*([\s\S]+)$/;
/** 整条陈述只是出处信息（导入时把页脚当成了知识点） */
const CITATION = /^(来源|出处|作者|原作者|抓取时间|发布时间|链接|网址)[：:]/;

export function describeKp(rawStatement: string, rawEvidence?: string | null): KpView {
  const statement = tidy(rawStatement ?? "");
  const view: KpView = {
    main: "",
    fields: [],
    meta: [],
    evidence: tidy((rawEvidence ?? "").replace(/^(?:考察点|考点|原文|依据|证据)[：:]\s*/, "")),
    dim: CITATION.test(statement),
  };

  const row = splitRowStatement(statement);
  if (row) {
    row.heads.forEach((head, i) => {
      const value = row.values[i];
      if (!value) return;
      if (META_KEYS.test(head)) {
        // `#：1` 这种序号对读者没有意义；`难度：⭐⭐` 才值得留成徽标
        if (head === "#" || head === "序号" || head === "编号") return;
        if (/^\d+$/.test(value)) return;
        view.meta.push({ label: head, value });
        return;
      }
      if (MAIN_KEYS.test(head)) {
        view.main = view.main || value;
        return;
      }
      view.fields.push({ label: head, value });
    });

    // 表头里没有「题目」这栏、也没有可当正文的键值对时，退回原始陈述
    if (!view.main && view.fields.length === 0) view.main = statement;
  } else {
    const exam = statement.match(EXAM_FIELD);
    if (exam) {
      view.main = tidy(exam[1]);
      META_FIELD.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = META_FIELD.exec(statement)) !== null) {
        const value = tidy(m[2]);
        if (value) view.meta.push({ label: m[1], value });
      }
    } else {
      view.main = statement;
    }
  }

  if (!view.main && view.fields.length === 0) view.main = statement;

  const a = bare(statement);
  const b = bare(view.evidence);
  // 依据就是陈述本身（或只是它的一截）时不重复显示，省一行
  if (!b || a.includes(b) || b.includes(a)) view.evidence = "";

  return view;
}

export function isEmptyKpView(view: KpView): boolean {
  return !view.main && view.fields.length === 0 && view.meta.length === 0;
}
