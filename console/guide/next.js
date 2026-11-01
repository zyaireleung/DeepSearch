/**
 * deep_search_next 决策（⑥，方案 § 9.2 + § 8.6.2 源类型分权 + 修订 6 decisionCode 结果级信号）
 *
 * 只管"往哪看"（方向导航），不管"第几层"（携带轴，正交）。按 next.available 判断可否调用。
 * mem0 扁平源无方向 → {available:false, reason:"no_direction"}，不静默空。
 */
import { ovDirections, ovJumpPayload, ovDecisionCode } from "./ov-direction.js";

const FLAT_NO_DIRECTION = { available: false, reason: "no_direction", directions: [], decisionCode: null, payload: null, suggest: "" };
const OV_SESSION_NO_DIRECTION = { available: false, reason: "no_direction", directions: [], decisionCode: "no_direction", payload: null, suggest: "" };

/**
 * 计算 next 决策。
 * @param result 当前结果 {source, id, level?, uri?, session_id?, ...}
 * @param req deep_search_next 参数 {direction, step, method, visited, origin, query, params, inline, limit}
 * @param ctx 上下文注入 { wikiNav?:(result,req)=>({directions,decisionCode,payload,suggest}), source?: string }
 */
export function nextDecision(result, req = {}, ctx = {}) {
  const source = result?.source;
  if (!source) return FLAT_NO_DIRECTION;

  if (source === "mem0") return FLAT_NO_DIRECTION; // § 8.6.2：扁平源无 S3 方向

  if (source === "wiki") {
    const nav = ctx.wikiNav ? ctx.wikiNav(result, req) : { directions: [], decisionCode: null, payload: null, suggest: "" };
    return { available: nav.directions.length > 0, directions: nav.directions, decisionCode: nav.decisionCode, payload: nav.payload, suggest: nav.suggest || "" };
  }

  if (source === "ov_context" || source === "ov_context_find" || source === "ov_context_search") {
    const directions = ovDirections(result, { visited: req.visited || [] });
    const available = directions.includes(req.direction) || directions.length > 0;
    const decisionCode = ovDecisionCode(result, req.direction, { visited: req.visited || [] });
    return { available, directions, decisionCode, payload: ovJumpPayload(result, req.direction), suggest: ctx.suggest || "" };
  }

  if (source === "ov_session") {
    // V38：ov_session 永久 flat，绝不暴露方向；链终点仅能携带回 S1 重搜。
    return OV_SESSION_NO_DIRECTION;
  }

  return FLAT_NO_DIRECTION;
}

/** 单结果方向快照（§ 9.1 result.next）：directions 非空 → available */
export function resultNextSnapshot(result, ctx = {}) {
  const d = nextDecision(result, {}, ctx);
  return { available: d.available, directions: d.directions };
}
