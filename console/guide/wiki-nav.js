/**
 * wiki 深挖指引（⑥，方案 § 8.8 四层链 + § 8.8.1 index/sources_index 切片）
 *
 * 四层链：内容块 → entities 页 → related_entities/sources → 资产总览（index/sources_index 切片）。
 * wiki_nav 表存显式双链（up/across/back/global_json），无推断；一次只选一个目标（V15）。
 */
import { readFileSync } from "node:fs";
import { tokenize } from "../search/rank.js";

/** 从 wiki_nav 读一条结果的方向（json 非空即可用）；返回 nav json 供 payload 回填。 */
export function wikiDirections(db, assetId, nodeKey) {
  const row = db.prepare("SELECT node_kind, up_json, across_json, back_json, global_json FROM wiki_nav WHERE asset_id=? AND node_key=?").get(assetId, nodeKey);
  if (!row) return { directions: [], node_kind: null, nav: null };
  const dirs = [];
  if (row.up_json) dirs.push("up");
  if (row.across_json) dirs.push("across");
  if (row.back_json) dirs.push("back");
  if (row.global_json) dirs.push("global");
  return { directions: dirs, node_kind: row.node_kind, nav: { up: row.up_json, across: row.across_json, back: row.back_json, global: row.global_json } };
}

/** 读 wiki 资产目录树（entities/*.md，供回源/切片） */
export function readAssetIndex(assetPath) {
  try {
    const entries = readFileSync(`${assetPath}/entities/index.json`, "utf8");
    return JSON.parse(entries);
  } catch {
    return [];
  }
}

/**
 * § 8.8.1 screenToc 切片：字面/分词命中（S2 精确词优先），只返回名称（不含正文），限 N。
 * 池 = wiki_toc 表的 index（条目名）/ sources_index（文档/来源名）。
 * 命中序：①字面命中（S2 精确词 includes）→ ②分词命中（query 分词，条目名含词计数降序）→ ③整池（限 N）。
 */
export function screenToc(db, assetId, tocKind, s2Info, { limit = 50 } = {}) {
  const rows = db.prepare("SELECT entry_name, ref_key, ord FROM wiki_toc WHERE asset_id=? AND toc_kind=? ORDER BY ord").all(assetId, tocKind);
  if (!s2Info) return rows.slice(0, limit).map((r) => ({ name: r.entry_name, refKey: r.ref_key }));
  const q = String(s2Info).toLowerCase();
  const hit = rows.filter((r) => String(r.entry_name).toLowerCase().includes(q));
  let pool = hit;
  if (!pool.length) {
    // ② 分词命中：query 分词（中文 2-gram + 英文词），条目名含词计数降序（多词命中优先）
    const tokens = tokenize(q);
    if (tokens.length) {
      const scored = rows.map((r) => {
        const name = String(r.entry_name).toLowerCase();
        const n = tokens.reduce((acc, t) => acc + (name.includes(t) ? 1 : 0), 0);
        return { ...r, n };
      }).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
      if (scored.length) pool = scored;
    }
  }
  return pool.slice(0, limit).map((r) => ({ name: r.entry_name, refKey: r.ref_key }));
}
