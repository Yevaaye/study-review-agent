/**
 * 答案来源标注的文案。
 *
 * 抽成纯函数是为了能被 `npm run check:note` 直接断言 —— 文案属于产品规则
 * （「越危险越短」「不写劝导语」），不该只靠人眼守着。
 *
 * 这里有两个**必须分开**的维度，别再揉成一句话：
 *   · origin   ：这段答案文字**谁写的**。`ai` = AI 写的，**不等于原文没答案**。
 *   · grounded ：原文**有没有依据**。true 有据 / false 没据 / null 未核对。
 *
 * 旧实现把 `origin === "ai"` 直接当成「原文未给出」，于是「AI 依据原文整理」的
 * 答案也被打上「原文未给出」——同一屏上还并排显示「已补全 · 源自原文」，
 * 用户看到的正是这个自相矛盾（库里 457 张 ai 答案中 271 张 grounded=true 全中）。
 * 因此文案只按 grounded 分档；`null`（历史数据未核对）不断言原文有没有。
 */

/** 标注主体文案。只有 `grounded === false` 才是真的「原文没有」。 */
export function answerNoteText(grounded?: boolean | null): string {
  // 金色档只留事实：越危险越短，警示交给颜色，不靠字数堆。
  if (grounded === false) return "原文未给出";
  if (grounded === true) return "AI 整理，依据原文";
  // 未核对：只说文字是谁写的，不替原文表态
  return "AI 提供";
}

/** 悬停解释。短文案放不下的信息（怎么补的、要不要核对）都收在这里。 */
export function answerNoteHint(grounded?: boolean | null): string {
  if (grounded === false) {
    return "原文没有这条答案，AI 用专业知识补充；建议核对后再通过";
  }
  if (grounded === true) {
    return "原文有这段内容，答案文字由 AI 整理（不是逐字摘录）；可点「看原文」对照";
  }
  return "答案文字由 AI 生成，尚未核对原文是否有对应内容";
}

/** 是否转金色（风险档）。只有「原文确实没给、AI 自己补」才配这个颜色。 */
export function answerNoteIsWarn(grounded?: boolean | null): boolean {
  return grounded === false;
}
