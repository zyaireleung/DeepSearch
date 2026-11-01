// guide/carry.js —— source-directed carry 契约（Task 5）
// 唯一 carry schema：CarryPayload；Console 与 host 通过 corpus/carry-contract-fixtures.json 双端校验。
// 规则：flat 源（mem0/ov_session）携带回 S1 重搜；layered 源（wiki/ov_context）沿真实关系 /next。
// ov_session 永久 flat，永不暴露方向（V38）。

const SOURCES = ['mem0', 'ov_context', 'ov_session', 'wiki'];
const KINDS = ['flat', 'layered'];

/** 校验 carry payload；接受共享字段/类型，reject 未知源/缺 id/非法 kind/ov_session layered。 */
export function validateCarryPayload(value) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not object' };
  const { source, id, kind, anchorTerms, sessionId, assetId, blockKey, entry, board, title, uri, level } = value;
  if (!SOURCES.includes(source)) return { ok: false, reason: 'unknown source' };
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'missing id' };
  if (!KINDS.includes(kind)) return { ok: false, reason: 'invalid kind' };
  if (source === 'ov_session' && kind === 'layered') return { ok: false, reason: 'ov_session 永不 layered' };
  if (anchorTerms !== undefined && !Array.isArray(anchorTerms)) return { ok: false, reason: 'anchorTerms 须数组' };
  if (kind === 'layered') {
    if (source === 'wiki' && typeof assetId !== 'string') return { ok: false, reason: 'layered wiki 缺 assetId' };
    if (source === 'ov_context' && typeof uri !== 'string') return { ok: false, reason: 'layered ov_context 缺 uri' };
  }
  // 已知字段类型校验（宽松忽略未知字段）
  for (const [k, v] of Object.entries({ sessionId, assetId, blockKey, entry, board, title, uri, level })) {
    if (v !== undefined && typeof v !== 'string') return { ok: false, reason: `${k} 须字符串` };
  }
  return { ok: true, payload: { source, id, kind, anchorTerms: anchorTerms || [], ...(sessionId !== undefined ? { sessionId } : {}), ...(assetId !== undefined ? { assetId } : {}), ...(blockKey !== undefined ? { blockKey } : {}), ...(entry !== undefined ? { entry } : {}), ...(board !== undefined ? { board } : {}), ...(title !== undefined ? { title } : {}), ...(uri !== undefined ? { uri } : {}), ...(level !== undefined ? { level } : {}) } };
}

/** 结果 → CarryPayload：flat（mem0/ov_session）与 layered（wiki/ov_context）按源保留真实身份。 */
export function toCarryPayload(result) {
  const anchorTerms = result?.title ? [String(result.title)] : [];
  const base = { source: result.source, id: result.id, kind: 'flat', anchorTerms };
  if (result.source === 'wiki') {
    return {
      ...base, kind: 'layered',
      assetId: result.assetId, blockKey: result.blockKey,
      ...(result.entry !== undefined ? { entry: result.entry } : {}),
      ...(result.board !== undefined ? { board: result.board } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
    };
  }
  if (result.source === 'ov_context') {
    return {
      ...base, kind: 'layered',
      ...(result.uri !== undefined ? { uri: result.uri } : {}),
      ...(result.level !== undefined ? { level: result.level } : {}),
    };
  }
  if (result.source === 'ov_session') {
    return { ...base, ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}) };
  }
  return base;
}
