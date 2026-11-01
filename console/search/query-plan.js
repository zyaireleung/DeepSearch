/**
 * QueryPlan 编译器 v2（span 签名规则版）。
 *
 * 相对 v1（词表枚举拆词）的关键变化：
 *  1. 保留 query 自带空格作为段边界（agent/用户给的天然短语边界，不得删除）；
 *  2. 段内按 run（Latin / CJK）原子化：
 *     - 英文/代号/数字串 → 1 个 anchor 原子（不拆）；
 *     - 中文 2~3 字段 → 1 个 anchor 原子（最小词组，不拆）；
 *     - 中文 4 字段及以上 → 细化为 2 字原子（奇数字尾 3 字）的 phrase 原子序列；
 *  3. 段间不要求连续（并列约束）；span 只在同一段内的连续 phrase 原子间计算。
 *
 * 词表（lexicon）不再承担"拆词"，仅保留元数据供语义裁判（SYNONYMS/scope）。
 */

const CJK = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z0-9_]/;
const SEG_SPLIT = /\s+/;

function isCjk(ch) { return CJK.test(ch); }
function isLatin(ch) { return LATIN.test(ch); }

/** 中文数字 → 阿拉伯（通用归一：七阶段 ≡ 7阶段；供匹配层 normSpanText 使用）。 */
const CN_DIGIT = { 零: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
export function normalizeChineseDigits(s) {
  return String(s ?? "").replace(/[零一二三四五六七八九]/g, (c) => CN_DIGIT[c] ?? c);
}

/**
 * 把一段（已去空白）拆成有序原子。
 * 返回 [{ text, kind: "anchor"|"phrase" }]。
 */
function atomizeSegment(segText) {
  const runs = [];
  let i = 0;
  while (i < segText.length) {
    const ch = segText[i];
    if (isLatin(ch)) {
      let j = i;
      while (j < segText.length && isLatin(segText[j])) j++;
      runs.push({ type: "latin", text: segText.slice(i, j) });
      i = j;
    } else if (isCjk(ch)) {
      let j = i;
      while (j < segText.length && isCjk(segText[j])) j++;
      runs.push({ type: "cjk", text: segText.slice(i, j) });
      i = j;
    } else {
      i++; // 跳过一般标点（格式符号在归一化层处理）
    }
  }

  const atoms = [];
  for (const run of runs) {
    if (run.type === "latin") {
      atoms.push({ text: run.text, kind: "anchor" });
      continue;
    }
    const len = run.text.length;
    if (len <= 3) {
      // 2~3 字（含 1 字）最小词组：不拆
      atoms.push({ text: run.text, kind: "anchor" });
    } else {
      // 4 字及以上：细化为 2 字原子；奇数时最后一组 3 字（2/3 字均为最小词组）
      let k = 0;
      while (k < len) {
        let take = 2;
        if (len - k === 3) take = 3;
        else if (len - k === 1) take = 1; // 理论不可达（偶数步长），防御
        atoms.push({ text: run.text.slice(k, k + take), kind: "phrase" });
        k += take;
      }
    }
  }
  return atoms;
}

/**
 * compileQueryPlan(query, { lexicon })
 * lexicon 保留但仅作元数据参考（不再决定拆词）；缺省仍可编译。
 * Returns {
 *   raw, normalizedPhrase, lexiconVersion,
 *   segments: [{ text, atoms:[{text,kind}] }],
 *   atoms:    [{ text, kind, segmentIdx, segAtomIdx }],
 *   anchorCount,
 * }
 */
export function compileQueryPlan(query, { lexicon } = {}) {
  const raw = String(query ?? "");
  const segments = [];
  const atoms = [];
  const rawSegs = raw.split(SEG_SPLIT).map((s) => s.trim()).filter(Boolean);

  for (const segText of rawSegs) {
    const segAtoms = atomizeSegment(segText);
    const seg = { text: segText, atoms: segAtoms };
    segments.push(seg);
    const segIdx = segments.length - 1;
    for (let si = 0; si < segAtoms.length; si++) {
      atoms.push({ ...segAtoms[si], segmentIdx: segIdx, segAtomIdx: si });
    }
  }

  const anchorCount = atoms.filter((a) => a.kind === "anchor").length;
  return {
    raw,
    normalizedPhrase: raw.replace(/\s+/g, "").toLowerCase(),
    lexiconVersion: lexicon?.version || "none",
    segments,
    atoms,
    anchorCount,
  };
}
