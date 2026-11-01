/**
 * 局部语义关系裁判（Task 3）。
 *
 * 不接收 source/全局 score 作为输入；只消费 unit × candidate 局部证据窗口。
 * 返回三种公开状态之一：
 *   { state:"semantic", evidence, confidence }
 *   { state:"conflict", evidence, confidence, dimension, candidateValue, relation:"scope-restricted-to-candidate-value" }
 *   { state:"missing", evidence:"" }
 *
 * 算法（见计划 Task 3 Step 3）：
 *  1. exactEvidence 存在 → 立即 missing（防止已 exact 的 unit 被误判 conflict）；
 *  2. 从 candidateFinder 获取局部证据窗口；
 *  3. 拒绝低于适配器配置阈值的窗口；
 *  4. 对每个剩余窗口问 relationJudge；
 *  5. conflict 仅当 judge 给 scope-conflict 且维度匹配 unit 维度、候选值 ≠ unit 值、关系为 scope-restricted-to-candidate-value；
 *  6. 否则取最佳 equivalent 为 semantic；无 → missing。
 */

export function createSemanticRelation({ lexicon, candidateFinder, relationJudge, threshold: configThreshold }) {
  if (typeof candidateFinder !== "function") {
    throw new Error("semanticRelation requires candidateFinder");
  }
  if (typeof relationJudge !== "function") {
    throw new Error("semanticRelation requires relationJudge");
  }

  const defaultThreshold = configThreshold ?? 0.5;

  return async function semanticRelation({ unit, text, exactEvidence, threshold }) {
    if (exactEvidence) {
      return { state: "missing", evidence: "" };
    }
    const windows = await candidateFinder({ unit, text });
    const effectiveThreshold = threshold ?? defaultThreshold;
    const judged = [];
    for (const w of windows || []) {
      const similarity = w?.similarity ?? 0;
      if (similarity < effectiveThreshold) continue;
      const r = await relationJudge({ unit, window: w, lexicon });
      if (r) judged.push({ ...r, evidence: r.evidence ?? w.evidence ?? "", similarity });
    }
    // conflict 优先：要求维度匹配 + 候选值不同 + scope-restricted 关系
    let bestConflict = null;
    let bestEquivalent = null;
    for (const j of judged) {
      if (j.kind === "scope-conflict") {
        const dimOk = unit.dimension && j.candidateValue && unit.dimension === (j.dimension || unit.dimension);
        const valOk = j.candidateValue && unit.value && j.candidateValue !== unit.value;
        const relOk = j.relation === "scope-restricted-to-candidate-value";
        if (dimOk && valOk && relOk) {
          if (!bestConflict || j.confidence > bestConflict.confidence) bestConflict = j;
        }
      } else if (j.kind === "equivalent") {
        if (!bestEquivalent || j.confidence > bestEquivalent.confidence) bestEquivalent = j;
      }
    }
    if (bestConflict) {
      return {
        state: "conflict",
        evidence: bestConflict.evidence,
        confidence: bestConflict.confidence,
        dimension: unit.dimension,
        candidateValue: bestConflict.candidateValue,
        relation: "scope-restricted-to-candidate-value",
      };
    }
    if (bestEquivalent) {
      return { state: "semantic", evidence: bestEquivalent.evidence, confidence: bestEquivalent.confidence };
    }
    return { state: "missing", evidence: "" };
  };
}

/**
 * 显式适配器配置（无隐藏回退）。
 * mode: "offline-adapter" | "disabled"；disabled 时非 exact unit 全部 missing。
 */
export function createConfiguredSemanticRelation(config) {
  if (config?.mode === "disabled") {
    return {
      available: false,
      reason: "semantic-provider-unconfigured",
      relation: async ({ exactEvidence }) => (exactEvidence ? { state: "missing", evidence: "" } : { state: "missing", evidence: "" }),
    };
  }
  const rel = createSemanticRelation(config);
  return { available: true, relation: rel };
}
