/**
 * tier 链排序（④，方案 § 七 排序规则，沿用 TDAI 定稿）
 *
 * 多级字典序：tier → exact → hit → ov → semanticScore（禁加权 Score）。
 * tier: 1=强重合(ov≥0.8 | hit≥6 | hit≥4且ov≥0.5)
 *       2=多处部分匹配(hit≥3且ov≥0.45)  3=少量(hit≥1)  4=纯语义
 * exact = query 归一化整段连续子串；hit = 分词命中绝对数；ov = hit/query 分词占比。
 * rankable=false 的源排到末尾但完整展示（不丢结果）。
 */

/** 分词：中文按 2-gram + 英文按词；供 hit/ov/exact 计算 */
export function tokenize(q) {
  const s = String(q ?? "").toLowerCase().trim();
  if (!s) return [];
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  const latin = s.match(/[a-z0-9_]+/g) || [];
  const tokens = [];
  for (const run of cjk) {
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  for (const w of latin) tokens.push(w);
  return tokens;
}

/** query 归一化（去空白/标点/小写），供 exact 整段连续子串判定 */
export function normQuery(q) {
  return String(q ?? "").toLowerCase().replace(/[\s,.，。！？、；：""''（）()《》【】·\-_/\\]/g, "");
}

function contains(t, sub) {
  return t.includes(sub);
}

/** 计算一条结果的 tier 链特征（tier/exact/hit/ov），text 为结果正文（title+snippet+text） */
export function rankFeatures({ query, text, cos, contentRanking = false }) {
  if (contentRanking) {
    // 新的内容相关性排序（Task 5 接入 compareContentRank）不得回退到 legacy tier 链。
    throw new Error("rankFeatures is legacy explain provenance; use content-rank.js compareContentRank for content ranking");
  }
  const qTokens = tokenize(query);
  const qNorm = normQuery(query);
  const tNorm = normQuery(text || "");
  const hit = qTokens.filter((t) => contains(tNorm, t)).length;
  const ov = qTokens.length ? hit / qTokens.length : 0;
  const exact = qNorm.length > 0 ? tNorm.includes(qNorm) : false;
  let tier;
  if (ov >= 0.8 || hit >= 6 || (hit >= 4 && ov >= 0.5)) tier = 1;
  else if (hit >= 3 && ov >= 0.45) tier = 2;
  else if (hit >= 1) tier = 3;
  else tier = 4;
  return { tier, exact, hit, ov };
}

/** 多级字典序比较：tier→exact→hit→ov→semanticScore（返回 -1/0/1） */
export function compareRanked(a, b) {
  if (a.rankable !== b.rankable) return a.rankable ? -1 : 1; // rankable=false 排末尾
  for (const k of ["tier", "exact", "hit", "ov", "semanticScore"]) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (k === "tier") return Number(av) - Number(bv); // tier 升序（1 在前）
    if (typeof av === "boolean") return av ? -1 : 1; // exact true 在前
    return Number(bv) - Number(av); // hit/ov/semanticScore 降序
  }
  return 0;
}

/** 混排：对已带 rankFeatures + semanticScore(cos) + rankable 的结果排序 */
export function rankSort(results) {
  return [...results].sort(compareRanked);
}
