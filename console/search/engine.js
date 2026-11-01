/**
 * ⑤ 路由引擎（方案 § 8.2 方法矩阵 / § 8.3 全源边界 / § 8.4 visited / § 8.5 收窄判定）
 *
 * 职责：按 method/sources/sessionId/includeSearch 选能力 → 执行各源（④ 检索层）→
 *      归一化（§ 六）→ tier 链（§ 七）→ 收窄判定（§ 8.5）→ page 组装（verdict/visited/status）。
 * 修订 6：ov_context_search 解析为 find（仅作能力名保留，执行走 ovFind）。
 * Task 4：能力选择唯一权威 search/source-spec.js（capabilitiesForRequest），本模块不再自持矩阵。
 */
import { capabilitiesForRequest } from "./source-spec.js";

/** § 8.2 能力解析：委托唯一能力选择器（throw → {error} 兼容旧断言）。 */
export function selectCapabilities(req, opts) {
  try { return capabilitiesForRequest(req, opts); }
  catch (e) { return { error: e.code || "INVALID_REQUEST" }; }
}

/** § 8.3 全源边界（写死）：无 sessionId 4 条；有 sessionId + includeSearch 则 5 条 */
export function fullSource(req) {
  const base = [
    { source: "mem0", mode: "find", requiresSession: false },
    { source: "ov_context", mode: "find", requiresSession: false },
    { source: "ov_session", mode: "default", requiresSession: false },
    { source: "wiki", mode: "default", requiresSession: false },
  ];
  if (req.sessionId && req.includeSearch) {
    base.push({ source: "ov_context", mode: "search", requiresSession: true });
  }
  return base;
}

/** § 8.5 收窄判定：只使用已按 contentRank 排好的展示结果。 */
export function narrowVerdict(results, { qualityLine = (top1) => Math.max(top1 * 0.85, 0.48) } = {}) {
  if (!results.length) return "miss";
  const [top1, top2] = results;
  const top1Pass = (top1.semanticScore ?? 0) >= qualityLine(top1.semanticScore ?? 0);
  const hardHit = (top1.contentRank?.atomExactCount ?? 0) > 0;
  const distinguish = !top2 || compareContentRank(
    { contentRank: top1.contentRank, candidate: { id: "" } },
    { contentRank: top2.contentRank, candidate: { id: "" } },
  ) < 0;
  return top1Pass && (distinguish || hardHit) ? "narrowed" : "miss";
}

/** 单源结果归一化（§ 六）→ tier 特征（§ 七）→ 统一结果对象（保留源分层身份供 carry/next） */
export function normalizeResult(source, mode, r, cos, text, query = "") {
  const n = source === "ov_context" ? toCosineLocal("ov_context", r.score ?? cos)
    : source === "mem0" ? toCosineLocal("mem0", r.score ?? cos)
    : { cos, rankable: true, reason: "local" };
  // 修复（query 穿传）：tier 链依赖真实 query 计算 hit/ov/exact；此前硬编码 "" 使混排退化为纯 cos。
  const feat = rankFeaturesLocal({ query, text, cos: n.cos });
  return {
    id: r.id,
    source,
    mode,
    rankable: n.rankable,
    tier: feat.tier,
    exact: feat.exact,
    hit: feat.hit,
    ov: feat.ov,
    semanticScore: n.cos,
    title: r.title || "",
    snippet: r.snippet || text || "",
    scope: (r.sessionId || r.session_id) ? { sessionId: r.sessionId || r.session_id } : undefined,
    hierarchy: r.hierarchy || "",
    type: r.type || "",
    // Task 4/5：保留源分层身份（wiki asset/block/entry/board；OV uri/level）供 carry 与 /next 使用
    assetId: r.asset_id,
    blockKey: r.block_key,
    entry: r.entry,
    board: r.board,
    uri: r.uri,
    level: r.level,
    sessionId: r.sessionId || r.session_id,
  };
}

// 局部注入（避免循环依赖）：由 engine 自持，实际实现见 normalize/rank
import { toCosine as toCosineLocal } from "./normalize.js";
import { rankFeatures as rankFeaturesLocal } from "./rank.js";
import { compileQueryPlan } from "./query-plan.js";
import { loadQueryLexicon } from "./query-lexicon.js";
import { classifyContentMatch, compareContentRank } from "./content-rank.js";
import { matchQueryPlan } from "./content-match.js";
import { resolveAnchors, computeAnchorSignature, validateAnchors } from "./anchor-resolve.js";
import { createConfiguredSemanticRelation } from "./semantic-relation.js";
import { createRuleBasedSemanticRelation } from "./semantic-relation-rule-based.js";

// 语义适配器：Task 5 显式配置（无隐藏回退）。离线逻辑层默认用规则表（确定性同义词/冲突）；
// 若上层显式提供 semanticRelation（经 sandbox 配置），则优先用它做局部语义判定。
let _semanticConfig = { mode: "offline-adapter", relation: createRuleBasedSemanticRelation() };
export function configureSemanticRelation(config) {
  _semanticConfig = config || { mode: "offline-adapter", relation: createRuleBasedSemanticRelation() };
  return _semanticConfig;
}
export function getSemanticConfig() { return _semanticConfig; }

/**
 * 执行搜索编排：选能力 → 执行 → 归一化 → 混排 → 收窄判定 → page。
 * deps 注入真实检索函数（④），便于 fixture 测试。
 */
export async function executeSearch(req, deps) {
  try { validateAnchors(req.anchors); }
  catch (e) {
    return { page: { level: "S1", method: req.method || "fuzzy_full", isFullSource: false, complete: false, verdict: "invalid_request", error: { code: "INVALID_REQUEST", message: e.message, hint: "anchors 须为至少一项的 {text, required} 数组，或完全省略" }, visited: req.visited || [], sources: [], results: [] } };
  }
  let sel;
  try {
    sel = capabilitiesForRequest(req, { enabledWikiAssetIds: req.enabledWikiAssetIds, enabledWikiAssets: req.enabledWikiAssets });
  } catch (e) {
    return { page: { level: "S1", method: req.method || "fuzzy_full", isFullSource: false, complete: false, verdict: "invalid_request", error: { code: e.code || "INVALID_REQUEST", message: e.message, hint: e.hint || "" }, visited: req.visited || [], sources: [], results: [] } };
  }
  const visited = new Set(req.visited || []);
  const sourcesState = [];
  const allResults = [];

  // 入口处编译一次 QueryPlan；词表仅保留语义裁判元数据，不参与拆词。
  const lexicon = req.lexicon || (typeof req.__lexicon === "object" ? req.__lexicon : null);
  const plan = compileQueryPlan(req.query || "", { lexicon: lexicon || { version: "none", byText: new Map(), entries: [] } });
  const semanticAdapter = getSemanticConfig();
  const semanticRelation = semanticAdapter.mode === "disabled" ? null : semanticAdapter.relation;

  // 强锚点候选：仅 resolved/technical 进入排序签名；ambiguous/unresolved 保留普通 query 匹配。
  const anchorResolution = Array.isArray(req.anchors) && req.anchors.length
    ? resolveAnchors(req.anchors, req.anchorCatalog || null)
    : null;
  const strongAnchors = anchorResolution?.strong || [];

  for (const cap of sel) {
    const key = `${cap.source}:${cap.mode}`;
    // carry 收窄 cap（ignoreVisited）即使 visited 已含也要执行（继续同一证据面）；其余源受 visited 防重复保护。
    if (visited.has(key) && !cap.ignoreVisited) {
      sourcesState.push({ id: cap.source, mode: cap.mode, status: "skipped", count: 0, elapsed_ms: 0, note: "visited" });
      continue;
    }
    visited.add(key);
    const t0 = Date.now();
    try {
      let raw;
      if (cap.source === "mem0") raw = await deps.mem0Search(req.query, { limit: req.limit || 20 });
      else if (cap.source === "ov_context") {
        // V4：会话过滤时先判定 OV 会话是否已 commit；未就绪 → unavailable(session_not_ready)
        if (req.sessionId && deps.sessionReady && !(await deps.sessionReady(req.sessionId))) {
          sourcesState.push({ id: cap.source, mode: cap.mode, status: "unavailable", count: 0, elapsed_ms: Date.now() - t0, error: { code: "session_not_ready", message: "session 未完成 commit，暂无蒸馏记忆", hint: "先触发该会话 commit 后再检索" } });
          continue;
        }
        raw = await deps.ovFind(req.query, { sessionId: req.sessionId });
      }
      else if (cap.source === "ov_session") raw = await deps.scanOvsession(req.query, { sessionIds: cap.sessionIds });
      else if (cap.source === "wiki") raw = await deps.scanWiki(req.query, { assetIds: cap.assetIds });
      else raw = [];

      if (raw && (raw.status === "unavailable" || raw.ok === false)) {
        sourcesState.push({ id: cap.source, mode: cap.mode, status: "unavailable", count: 0, elapsed_ms: Date.now() - t0, error: raw.error || raw.source || `HTTP ${raw.status}` });
        continue;
      }
      const items = Array.isArray(raw) ? raw : (raw.results || []);
      for (const r of items) {
        const cos = r.cos ?? (r.semanticScore ?? 0);
        const bodyText = r.text || r.abstract || r.snippet || "";
        const title = r.title || (cap.source === "ov_session" ? "" : r.uri || "");
        const text = `${title} ${bodyText}`.trim();
        const normalized = normalizeResult(cap.source, cap.mode, { ...r, id: r.id || `${cap.source}:${r.uri || r.session_id || Math.random()}`, title }, cos, text, req.query);
        // Task 5 v2：结构化 contentRank（span 签名规则，只消费 QueryPlan/matchResult，不读 source/上游 score/长度）
        const matchResult = await matchQueryPlan(plan, text, { semanticRelation });
        normalized.contentRank = classifyContentMatch({ plan, match: matchResult });
        if (strongAnchors.length) normalized.anchorSignature = computeAnchorSignature(text, strongAnchors);
        allResults.push(normalized);
      }
      sourcesState.push({ id: cap.source, mode: cap.mode, status: "searched", count: items.length, elapsed_ms: Date.now() - t0 });
    } catch (e) {
      sourcesState.push({ id: cap.source, mode: cap.mode, status: "timed_out", count: 0, elapsed_ms: Date.now() - t0, error: { code: "TIMED_OUT", message: e.message, hint: "" } });
    }
  }

  // Task 5：混排用 compareContentRank（结构化分类字典序）。legacy tier/exact/hit/ov/semanticScore
  // 仅作 explain provenance 保留，不作为新混合排序键。
  allResults.sort((a, b) => compareContentRank({ ...a, candidate: { id: a.id } }, { ...b, candidate: { id: b.id } }));
  const verdict = narrowVerdict(allResults);
  const isFullSource = JSON.stringify(sel.map((c) => `${c.source}:${c.mode}`).sort()) === JSON.stringify(fullSource(req).map((c) => `${c.source}:${c.mode}`).sort());
  const complete = sourcesState.every((s) => ["searched", "skipped", "unavailable"].includes(s.status));

  return {
    page: {
      level: "S1",
      method: req.method || "fuzzy_full",
      isFullSource,
      complete,
      verdict,
      visited: [...visited],
      sources: sourcesState,
      ...(req.explain === true && anchorResolution ? { anchorResolution: anchorResolution.resolution } : {}),
      results: allResults.slice(0, req.limit || 20),
    },
  };
}
