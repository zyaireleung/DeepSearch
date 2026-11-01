import { normalizeChineseDigits } from "./query-plan.js";

export function normSpanText(s) {
  return normalizeChineseDigits(String(s ?? "").toLowerCase())
    .replace(/[\s,，。！？、；：""''（）()《》【】·\-_/\\]/g, "");
}

/** Greedily consume the longest ordered, non-overlapping exact phrase spans. */
async function greedyPhraseSpans(run, normText, semanticRelation, text) {
  const spans = [];
  const states = Array(run.length).fill(null);
  let k = 0;
  let lastEnd = 0;

  while (k < run.length) {
    let best = null;
    for (let end = run.length - 1; end >= k; end--) {
      const joined = normSpanText(run.slice(k, end + 1).map(({ text }) => text).join(""));
      const pos = joined ? normText.indexOf(joined, lastEnd) : -1;
      if (pos >= 0) {
        best = { end, pos, textLength: joined.length };
        break;
      }
    }
    if (!best) {
      k++;
      continue;
    }

    spans.push({ start: k, end: best.end, len: best.end - k + 1, pos: best.pos });
    for (let idx = k; idx <= best.end; idx++) states[idx] = { state: "exact", evidence: run[idx].text };
    lastEnd = best.pos + best.textLength;
    k = best.end + 1;
  }

  for (let idx = 0; idx < run.length; idx++) {
    if (states[idx]) continue;
    states[idx] = semanticRelation
      ? await semanticRelation({ unit: run[idx], text: text || "", exactEvidence: null })
      : { state: "missing", evidence: "" };
  }
  return { spans, states };
}

/**
 * Match a compiled plan against a candidate.
 * Spans contain only exact phrase evidence; anchor and semantic evidence stay separate.
 */
export async function matchQueryPlan(plan, text, { semanticRelation } = {}) {
  const normText = normSpanText(text || "");
  const spans = [];
  const anchorHits = [];
  const semanticHits = [];
  let atomGlobal = 0;

  for (let segIdx = 0; segIdx < plan.segments.length; segIdx++) {
    const segAtoms = plan.segments[segIdx].atoms;
    let i = 0;
    while (i < segAtoms.length) {
      const atom = segAtoms[i];
      if (atom.kind === "anchor") {
        const atext = normSpanText(atom.text);
        const state = atext && normText.includes(atext)
          ? { state: "exact", evidence: atom.text }
          : semanticRelation
            ? await semanticRelation({ unit: atom, text: text || "", exactEvidence: null })
            : { state: "missing", evidence: "" };
        const hit = { atomIdx: atomGlobal, state: state.state, evidence: state.evidence, confidence: state.confidence };
        anchorHits.push(hit);
        if (state.state === "semantic") semanticHits.push({ atomIdx: atomGlobal, evidence: state.evidence, confidence: state.confidence ?? 0 });
        atomGlobal++;
        i++;
        continue;
      }

      let j = i;
      while (j < segAtoms.length && segAtoms[j].kind === "phrase") j++;
      const run = segAtoms.slice(i, j);
      const matched = await greedyPhraseSpans(run, normText, semanticRelation, text);
      for (const span of matched.spans) {
        spans.push({ segmentIdx: segIdx, start: i + span.start, end: i + span.end, len: span.len });
      }
      for (let ri = 0; ri < run.length; ri++) {
        const state = matched.states[ri];
        if (state.state === "semantic") {
          semanticHits.push({ atomIdx: atomGlobal + ri, evidence: state.evidence, confidence: state.confidence ?? 0 });
        }
      }
      atomGlobal += run.length;
      i = j;
    }
  }

  return { text, spans, anchorHits, semanticHits };
}
