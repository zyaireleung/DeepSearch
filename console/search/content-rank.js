import { matchQueryPlan } from "./content-match.js";
import { computeAnchorSignature } from "./anchor-resolve.js";

/** Span lengths sorted for lexicographic comparison: [4] > [3,3] > [3]. */
export function spanSignature(spans) {
  return (spans || []).map(({ len }) => len).sort((a, b) => b - a);
}

function compareSpanSignature(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** Create the evidence tuple consumed by the content-ranking comparator. */
export function classifyContentMatch({ plan, match }) {
  const spans = match.spans || [];
  const anchorHits = (match.anchorHits || []).filter(({ state }) => state === "exact").length;
  const confs = (match.semanticHits || []).map(({ confidence }) => confidence ?? 0);

  return {
    spanSignature: spanSignature(spans),
    anchorHits,
    atomExactCount: spans.reduce((sum, { len }) => sum + len, 0) + anchorHits,
    atomTotal: plan.atoms.length,
    minimumSemanticConfidence: confs.length ? Math.min(...confs) : 0,
    meanSemanticConfidence: confs.length ? confs.reduce((sum, value) => sum + value, 0) / confs.length : 0,
  };
}

/** Compare only evidence, then use the candidate id as the stable final tiebreaker. */
export function compareContentRank(a, b) {
  const ca = a.classification || a.contentRank;
  const cb = b.classification || b.contentRank;
  // 强锚点签名前置：required 完整 → required 命中数 → optional 命中数（对象范围优先）。
  const asig = a.anchorSignature;
  const bsig = b.anchorSignature;
  if (asig || bsig) {
    const d = compareAnchorSignature(asig || [0, 0, 0], bsig || [0, 0, 0]);
    if (d) return d;
  }
  const signatureOrder = compareSpanSignature(ca.spanSignature || [], cb.spanSignature || []);
  if (signatureOrder) return signatureOrder;

  for (const key of ["anchorHits", "atomExactCount", "minimumSemanticConfidence", "meanSemanticConfidence"]) {
    const delta = (cb[key] ?? 0) - (ca[key] ?? 0);
    if (delta) return delta;
  }

  const ia = a.candidate?.id ?? a.id ?? "";
  const ib = b.candidate?.id ?? b.id ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function compareAnchorSignature(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export async function rankContentCandidates({ plan, candidates, semanticRelation, strongAnchors }) {
  const ranked = [];
  for (const candidate of candidates || []) {
    const text = candidate.text ?? `${candidate.title ?? ""} ${candidate.snippet ?? ""}`.trim();
    const match = await matchQueryPlan(plan, text, { semanticRelation });
    ranked.push({
      id: candidate.id,
      candidate,
      match,
      classification: classifyContentMatch({ plan, match }),
      text,
      anchorSignature: strongAnchors?.length ? computeAnchorSignature(text, strongAnchors) : undefined,
    });
  }
  return ranked.sort(compareContentRank);
}
