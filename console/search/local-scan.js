/**
 * 本地 int8 扫描（④，ov_session + wiki 块；§ 四 L2-A/L2-B + § 六 本地原值 cos）
 * 全量精确扫描（免 ANN，同 8810 空间），int8 点积 cosine。
 */
import { int8Cosine } from "./embed.js";

/** 扫描 ov_chunks：返回 [{id, source:'ov_session', session_id, time_ms, role, text, cos}]
 * 仅非空显式 sessionIds 过滤；空数组=不过滤。 */
export function scanOvsession(db, queryFloat, { limit = 20, textMax = 400, sessionIds } = {}) {
  const where = sessionIds?.length ? `WHERE session_id IN (${sessionIds.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`SELECT id, session_id, time_ms, role, text, vec FROM ov_chunks ${where}`).all(...(sessionIds || []));
  const scored = [];
  for (const r of rows) {
    const cos = int8Cosine(queryFloat, r.vec);
    scored.push({
      id: r.id,
      source: "ov_session",
      session_id: r.session_id,
      time_ms: r.time_ms,
      role: r.role,
      text: String(r.text).slice(0, textMax),
      cos,
    });
  }
  return scored.sort((a, b) => b.cos - a.cos).slice(0, limit);
}

/** 扫描 wiki_blocks：返回 [{id, source:'wiki', asset_id, block_key, entry, board, title, text, cos}]
 * 仅非空显式 assetIds 过滤；空数组=不过滤（表仅含 enabled/就绪资产数据）。 */
export function scanWiki(db, queryFloat, { limit = 20, textMax = 400, assetIds } = {}) {
  const where = assetIds?.length ? `WHERE asset_id IN (${assetIds.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`SELECT asset_id, block_key, entry, board, title, text, vec FROM wiki_blocks ${where}`).all(...(assetIds || []));
  const scored = [];
  for (const r of rows) {
    const cos = int8Cosine(queryFloat, r.vec);
    scored.push({
      id: `wiki:${r.asset_id}:${r.block_key}`,
      source: "wiki",
      asset_id: r.asset_id,
      block_key: r.block_key,
      entry: r.entry,
      board: r.board,
      title: r.title,
      text: String(r.text).slice(0, textMax),
      cos,
    });
  }
  return scored.sort((a, b) => b.cos - a.cos).slice(0, limit);
}
