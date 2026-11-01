/**
 * score 归一化与跨源可比性（④，方案 § 六）
 *
 * 混排前统一到 cosine：
 *   ov_context_find/search: cos = 2·score − 1        （score=(cos+1)/2）
 *   mem0:                    L2 = 1/score − 1；cos = 1 − L2²/2
 *   ov_session / wiki:       cos 原值（本地直算）
 * 公式校验失败 → rankable=false（只展示不参与跨源混排，不退化比例换算）。
 */
export const NORM_RULES = {
  ov_context: { kind: "linear", a: 2, b: -1 }, // cos = 2·score − 1
  mem0: { kind: "mem0_l2" },
  local: { kind: "identity" }, // ov_session / wiki：cos 原值
};

export function toCosine(source, score, mode = "default") {
  if (source === "ov_context") {
    const s = Number(score);
    if (!Number.isFinite(s)) return { cos: NaN, rankable: false, reason: "score 非有限" };
    return { cos: 2 * s - 1, rankable: true };
  }
  if (source === "mem0") {
    const s = Number(score);
    if (!Number.isFinite(s) || s <= 0) return { cos: NaN, rankable: false, reason: "score 非正" };
    const l2 = 1 / s - 1;
    if (!Number.isFinite(l2) || l2 < 0) return { cos: NaN, rankable: false, reason: "L2 非正" };
    return { cos: 1 - (l2 * l2) / 2, rankable: true };
  }
  // ov_session / wiki（本地）：cos 原值；校验先行（§ 六 1/(1+L2) 需真实样本验证，见待确认项 2）
  const c = Number(score);
  if (!Number.isFinite(c)) return { cos: NaN, rankable: false, reason: "score 非有限" };
  return { cos: c, rankable: true };
}

/** 跨源比较边界：标定前 semanticScore 只作同源内末位排序；跨源 tie-break 只用 tier→exact→hit→ov */
export const CROSS_SOURCE_TIEBREAK = ["tier", "exact", "hit", "ov"];
