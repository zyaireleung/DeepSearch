/**
 * wiki 块导入（⑧）：从已挂载 wiki 资产的 .vectors.json → wiki_blocks（int8 驻留）。
 *
 * 块格式：.vectors.json[block_key] = {hash, embedding(float[]1024), entry, title, board, updated}
 * block_key 即表主键（sha1(entry|board|title)[:16]，资产侧已生成）；text 回源 entities/<entry>.md 或 title 兜底。
 */
import fs from "node:fs";
import path from "node:path";
import { quantizeInt8 } from "../search/embed.js";
import { markSynced } from "./last-sync.js";

export function importWikiAsset(db, asset, assetDir) {
  const vecPath = path.join(assetDir, ".vectors.json");
  if (!fs.existsSync(vecPath)) return { assetId: asset.id, imported: 0, note: "no .vectors.json" };
  const blocks = JSON.parse(fs.readFileSync(vecPath, "utf8"));
  const upsert = db.prepare("INSERT OR REPLACE INTO wiki_blocks (asset_id, block_key, hash, entry, board, title, text, vec, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  let imported = 0;
  for (const [blockKey, b] of Object.entries(blocks)) {
    const text = readBlockText(assetDir, b.entry, b.title, b.board);
    const vec = quantizeInt8(b.embedding);
    upsert.run(asset.id, blockKey, b.hash || null, b.entry || null, b.board || null, b.title || null, text, vec, Date.now());
    imported++;
  }
  return { assetId: asset.id, imported, note: `blocks=${Object.keys(blocks).length}` };
}

/** entry 名 → 实体页文件路径（llm-wiki 资产文件名规则：非法字符 ':' '/' → '-'）。 */
function entityFile(assetDir, entry) {
  const candidates = [entry, entry.replace(/[:/]/g, "-"), entry.replace(/[:\s/]+/g, "-")];
  for (const c of candidates) {
    const p = path.join(assetDir, "entities", `${c}.md`);
    if (fs.existsSync(p)) return p;
  }
  // 兜底：归一化忽略 ':' '/' '-' 空白后精确匹配（覆盖资产侧任意命名变体）
  try {
    const dir = path.join(assetDir, "entities");
    const files = fs.readdirSync(dir);
    const norm = (s) => s.replace(/[:\/\s-]+/g, "").toLowerCase();
    const target = norm(entry);
    const f = files.find((x) => norm(x.replace(/\.md$/, "")) === target);
    if (f) return path.join(dir, f);
  } catch { /* ignore */ }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 提取该块对应 section 正文：定位 ## board（若有）→ ##### title → 截到下一个标题（#{2,6}）。 */
function extractSection(body, board, title) {
  if (!title) return null;
  let startIdx = 0;
  if (board) {
    const bm = body.match(new RegExp(`^##\\s+${escapeRegExp(board)}\\s*$`, "m"));
    if (!bm) return null;
    startIdx = bm.index;
  }
  const slice = body.slice(startIdx);
  const tm = slice.match(new RegExp(`^#####\\s+${escapeRegExp(title)}\\s*$`, "m"));
  if (!tm) return null;
  const nl = slice.indexOf("\n", tm.index);
  const contentStart = nl < 0 ? tm.index : nl + 1;
  const rest = slice.slice(contentStart);
  const next = rest.match(/^#{2,6}\s/m);
  const content = next ? rest.slice(0, next.index) : rest;
  return content.trim().slice(0, 3000);
}

/** 块 text 回源：entry 归一化定位实体页 → 按 (board,title) 提取该 section 正文；回源失败降级 title。 */
function readBlockText(assetDir, entry, title, board) {
  if (entry) {
    const p = entityFile(assetDir, entry);
    if (p) {
      const body = fs.readFileSync(p, "utf8");
      const sec = extractSection(body, board, title);
      if (sec) return sec;
      // 兜底：标题在正文则取前 600 字，否则前 400 字
      return (title && body.includes(title)) ? body.slice(0, 600) : body.slice(0, 400);
    }
  }
  return title || entry || "";
}

/** §8.8.1 wiki_toc 条目池：index=条目名（entry），sources_index=来源（board）。只存名称/来源，不存正文/向量/分类树。 */
export function populateWikiToc(db, asset, assetDir) {
  const vecPath = path.join(assetDir, ".vectors.json");
  if (!fs.existsSync(vecPath)) return 0;
  const blocks = JSON.parse(fs.readFileSync(vecPath, "utf8"));
  const upsert = db.prepare("INSERT OR REPLACE INTO wiki_toc (asset_id, toc_kind, entry_name, ref_key, ord) VALUES (?,?,?,?,?)");
  const seen = { index: new Set(), sources_index: new Set() };
  let n = 0;
  for (const [blockKey, b] of Object.entries(blocks)) {
    if (b.entry && !seen.index.has(b.entry)) { seen.index.add(b.entry); upsert.run(asset.id, "index", b.entry, blockKey, seen.index.size); n++; }
    if (b.board && !seen.sources_index.has(b.board)) { seen.sources_index.add(b.board); upsert.run(asset.id, "sources_index", b.board, blockKey, seen.sources_index.size); n++; }
  }
  return n;
}

/** 读 entity 页 frontmatter 的 sources/related（wikilink [[...]] 列表），供 wiki_nav across 链。 */
function readEntityMeta(assetDir, entry) {
  const p = path.join(assetDir, "entities", `${entry}.md`);
  if (!fs.existsSync(p)) return { sources: [], related: [] };
  const body = fs.readFileSync(p, "utf8");
  const end = body.indexOf("\n---", 3); // frontmatter 结束（第二段 ---）
  const fm = end > 0 ? body.slice(0, end) : "";
  const listLinks = (key) => {
    const m = fm.match(new RegExp(`^\\s*${key}:\\s*([\\s\\S]*?)(?=^\\S|$)`, "m"));
    if (!m) return [];
    const body = m[1] || "";
    // 内联 [ [..], [..] ] 或 块式 - "[[..]]"
    const inline = [...body.matchAll(/\[\[(.+?)\]\]/g)].map((x) => (x[1].split("|")[0]).trim());
    if (inline.length) return inline;
    return [...body.matchAll(/^\s*-\s*["']?\[\[(.+?)\]\]/gm)].map((x) => (x[1].split("|")[0]).trim());
  };
  return { sources: listLinks("sources"), related: [...listLinks("related"), ...listLinks("related_entities")] };
}

/**
 * §8.8 wiki_nav 四层深挖链：内容块 → entities 页 → related/sources → 资产总览（index/sources_index）。
 * wiki_nav 表存显式双链（up/across/back/global_json），无推断。节点：block(block_key)/entity(entry)/source(board/来源)/overview(index|sources_index)。
 * block：up→entity / across→related/sources / back→board / global→overview。
 * entity：up→overview / across→sources / back→blocks / global→overview。
 * source：up→overview / back→blocks / global→overview。overview：back→blocks / global→index。
 */
export function populateWikiNav(db, asset, assetDir) {
  const vecPath = path.join(assetDir, ".vectors.json");
  if (!fs.existsSync(vecPath)) return 0;
  const blocks = JSON.parse(fs.readFileSync(vecPath, "utf8"));
  const upsert = db.prepare("INSERT OR REPLACE INTO wiki_nav (asset_id, node_key, node_kind, up_json, across_json, back_json, global_json) VALUES (?,?,?,?,?,?,?)");
  const overview = JSON.stringify({ kind: "overview" });
  const meta = {};
  let n = 0;
  for (const [blockKey, b] of Object.entries(blocks)) {
    if (b.entry && !meta[b.entry]) {
      const m = readEntityMeta(assetDir, b.entry);
      meta[b.entry] = m;
      const across = (m.sources.length || m.related.length) ? JSON.stringify({ kind: "sources", entry: b.entry, sources: m.sources, related: m.related }) : null;
      upsert.run(asset.id, b.entry, "entity", overview, across, JSON.stringify({ kind: "blocks", entry: b.entry }), overview); n++;
      for (const s of m.sources) { upsert.run(asset.id, s, "source", overview, null, JSON.stringify({ kind: "blocks", entry: b.entry }), overview); n++; }
    }
    const m = meta[b.entry];
    const across = (m && (m.sources.length || m.related.length)) ? JSON.stringify({ kind: "related", entry: b.entry, sources: m.sources, related: m.related }) : null;
    upsert.run(asset.id, blockKey, "block",
      b.entry ? JSON.stringify({ kind: "entity", entry: b.entry, title: b.title }) : null,
      across,
      b.board ? JSON.stringify({ kind: "board", board: b.board }) : null,
      overview); n++;
  }
  upsert.run(asset.id, "index", "overview", null, null, JSON.stringify({ kind: "blocks" }), overview); n++;
  upsert.run(asset.id, "sources_index", "overview", null, null, JSON.stringify({ kind: "blocks" }), overview); n++;
  return n;
}

/** 导入全部已挂载资产（幂等：已存在且同 hash 跳过；空表则全量）。wiki_toc/wiki_nav 始终填充（不随 wiki_blocks skip）。 */
export function importAllWiki(db, mounted, { force = false } = {}) {
  const results = [];
  for (const a of mounted) {
    const tocN = populateWikiToc(db, a, a.path); // 8.8.1 条目池（index/sources_index）
    const navN = populateWikiNav(db, a, a.path); // 8.8 四层深挖链（wiki_nav）
    const existing = db.prepare("SELECT COUNT(*) AS n FROM wiki_blocks WHERE asset_id=?").get(a.id).n;
    if (existing > 0 && !force) { results.push({ assetId: a.id, imported: 0, toc: tocN, nav: navN, note: `skip(existing=${existing})` }); continue; }
    const r = importWikiAsset(db, a, a.path);
    results.push({ ...r, toc: tocN, nav: navN });
  }
  // 有掛載資產且同步循環成功完成（未拋錯）→ **只有實際導入了 blocks（總表真的變了）才標記**「上次同步時間」。
  // 純重啟（已存在 skip、imported=0）不 mark——對齊「源變化+寫總表成功才推時間」，避免啟動旁路誤推。
  if (mounted.length && results.some(r => (r.imported || 0) > 0)) markSynced(db, "wiki");
  return results;
}

/** V11 删除对账：移除不在当前 .vectors.json 的块 + 重导变更块（幂等） */
export function syncWiki(db, mounted, { force = false } = {}) {
  const results = [];
  for (const a of mounted) {
    const vecPath = path.join(a.path, ".vectors.json");
    let keys = [];
    try { keys = Object.keys(JSON.parse(fs.readFileSync(vecPath, "utf8"))); } catch { results.push({ assetId: a.id, note: "no .vectors.json" }); continue; }
    // 删除已不在源里的块（对账）
    const del = db.prepare("DELETE FROM wiki_blocks WHERE asset_id=? AND block_key NOT IN (" + keys.map(() => "?").join(",") + ")");
    const removed = keys.length ? del.run(a.id, ...keys).changes : 0;
    // 重导（INSERT OR REPLACE 幂等）
    const res = importWikiAsset(db, a, a.path);
    const tocN = populateWikiToc(db, a, a.path); // 8.8.1 条目池
    const navN = populateWikiNav(db, a, a.path); // 8.8 四层深挖链
    results.push({ assetId: a.id, imported: res.imported, removed, toc: tocN, nav: navN, note: `blocks=${keys.length}` });
  }
  // 同步寫總表完成 → **只有真實導入/刪除（總表真的變了）才標記**「上次同步時間」。
  // 純對賬 0 塊變化（源沒變、冪等重跑）不 mark，避免鏡像調度器把「總表回寫」誤當「源變化」而自觸發。
  if (mounted.length && results.some(r => (r.imported || 0) > 0 || (r.removed || 0) > 0)) markSynced(db, "wiki");
  return results;
}
