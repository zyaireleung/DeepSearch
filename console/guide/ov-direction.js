/**
 * OV 方向与跳转载荷（⑥，方案 § 8.7 OV 深挖语义 + § 9.2 params）
 *
 * OV 内部走法不可控：deep_search 只给方向可用性 + 跳转载荷（context_type/category/level/detail + uri/score），
 * 无 query_plan（修订 6）。会话关系由 Console 确定性过滤/重排承担。
 * 方向：up（沿架构上溯 L2→L1→L0）/ back（回源 uri）/ global（全局域）/ root（L0 根）。
 */
export const OV_LEVELS = ["L0", "L1", "L2"];

/** OV 结果方向可用性：按 level 判断（L0=根、L2=原文最深）；back/global 恒可用（回源/全局域） */
export function ovDirections(result, { visited = [] } = {}) {
  const level = result.level || "L1";
  const dirs = [];
  if (level !== "L0") dirs.push("up"); // 上溯到更浅层（L2→L1→L0）
  dirs.push("back"); // 回源（uri/provenance 展开）
  dirs.push("global"); // 全局域（跨会话）
  if (level === "L0") dirs.push("root"); // 已到根，root 指示
  // 结构化查看方向（ov-context 专用）：tree/list 按位置浏览，glob/grep 按 pattern 查询——直连 OV 返回真实数据
  dirs.push("tree", "list", "glob", "grep");
  return dirs.filter((d) => !visited.includes(`ov_context:${d}`));
}

/** OV 跳转载荷（§ 9.2 params：context_type/category/level/detail + uri/score），无 query_plan */
export function ovJumpPayload(result, direction) {
  return {
    contextType: result.contextType || result.context_type || undefined,
    category: result.category || undefined,
    level: result.level || "L1",
    detail: direction === "up" ? "full" : "overview",
    uri: result.uri || undefined,
    pattern: result.pattern || undefined, // glob/grep 查询模式（ov-context 专用）
    score: typeof result.score === "number" ? result.score : undefined,
  };
}

/** 修订 6：decisionCode 从结果级信号派生（source/uri/level/score/visited 关系），非 query_plan */
export function ovDecisionCode(result, direction, { visited = [] } = {}) {
  const parts = ["ov_context", direction, result.level || "L1"];
  if (result.uri) parts.push(`uri:${result.uri}`);
  if (visited.length) parts.push(`v:${visited.length}`);
  return parts.join(":");
}
