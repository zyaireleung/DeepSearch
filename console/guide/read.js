// guide/read.js —— /read 全文读取：按结果身份（source+id）取回全文内容。
// 诚实范围（2026-10-31 沙盒实测）：ov_session/wiki 全文在 DB，scan 只把 textMax=400 截断进结果，
// 全文可再取 → available=true（真正闭环"取全文缺口"）。
// mem0/ov_context：内容已全量在检索结果（engine 不截断 text/abstract），且无独立
// get-by-id/get-by-uri 端点 → available=false + 诚实 reason（不虚构可用性）。
export function readResult(db, { source, id }, _ovCfg = {}) {
  if (!id || typeof id !== "string" || !id.trim()) {
    return { id, source, available: false, reason: "id 必填" };
  }
  const src = source || (id.includes(":") ? id.slice(0, id.indexOf(":")) : "");

  if (src === "ov_session") {
    const row = db.prepare("SELECT id, session_id, time_ms, role, text FROM ov_chunks WHERE id = ?").get(id);
    if (!row) return { id, source: src, available: false, reason: "not found" };
    return {
      id, source: src, available: true,
      text: String(row.text || ""),
      title: null,
      meta: { session_id: row.session_id, time_ms: row.time_ms, role: row.role },
    };
  }

  if (src === "wiki") {
    // id = wiki:<asset_id>:<block_key>；block_key 可能含冒号 → 只拆首段为 asset
    const rest = String(id).slice(5);
    const sep = rest.indexOf(":");
    const assetId = sep < 0 ? rest : rest.slice(0, sep);
    const blockKey = sep < 0 ? "" : rest.slice(sep + 1);
    if (!assetId || !blockKey) return { id, source: src, available: false, reason: "wiki id 应为 wiki:<asset>:<block>" };
    const row = db.prepare("SELECT asset_id, block_key, entry, board, title, text FROM wiki_blocks WHERE asset_id = ? AND block_key = ?").get(assetId, blockKey);
    if (!row) return { id, source: src, available: false, reason: "not found" };
    return {
      id, source: src, available: true,
      text: String(row.text || ""),
      title: row.title || "",
      meta: { asset_id: row.asset_id, block_key: row.block_key, entry: row.entry, board: row.board },
    };
  }

  if (src === "ov_context") {
    return { id, source: src, available: false, reason: "ov_context 内容（abstract）已在检索结果中返回；无独立 get-by-uri 端点，/next 为关系导航" };
  }
  if (src === "mem0") {
    return { id, source: src, available: false, reason: "mem0 内容已全量在检索结果中返回；搜索结果无稳定 id（无 id/uri 字段），无法按 id 再取" };
  }
  return { id, source: src, available: false, reason: `unknown source: ${src}` };
}
