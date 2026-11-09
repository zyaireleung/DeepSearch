/**
 * 「上次同步時間」載體（用戶定義語義 2026-11-04）：
 *   = 數據源更新 → 同步寫入總表**成功** → 總表變化的時刻。
 *   持久保留（斷開不清、仍顯示斷開前最後一次成功同步時間）；只有同步成功才更新。
 *
 * 為何不用 sync_jobs：sync_jobs 只有手動 POST /sync 才寫，而真實同步
 * （syncOvsession 寫 ov_chunks、syncWiki/importAllWiki 寫 wiki_blocks）從不經它，
 * 導致 /source-stats 的 lastSync 恆 null → 前端顯示「待後端」。
 *
 * 載體 = sync_state.last_ok_ms（持久、成功才更新、斷開重連仍在）。
 * 列安全：只用實際存在的列（scope/source_version/cursor/last_ok_ms/last_err/generation），
 *         不碰 schema 裡不存在的 synced_at/status。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** 目標名（/source-stats 口徑）→ sync_state.scope */
const SCOPE_MAP = { session: "ov_session", wiki: "wiki" };

/**
 * 廉價探測 ov_session 數據源的「變化簽名」= { count, maxTimeMs }。
 * 學 ingest_dsh_sessions 的 fingerprint 範式：先算簽名比對，**沒變就不全量同步**（省資源）。
 * 成本：COUNT(*) ~5ms + MAX(time_ms) ~40ms（源 chunks 表無索引，但 60s 一次完全無壓力）。
 * @param {string} sourceDbPath OV ingest 狀態庫路徑（只讀打開）
 * @returns {{count:number, maxTimeMs:number}|null} 簽名；源不可讀 → null
 */
export function probeOvSource(sourceDbPath) {
  let src;
  try { src = new DatabaseSync(sourceDbPath, { readOnly: true }); }
  catch { return null; }
  try {
    const r = src.prepare("SELECT COUNT(*) n, COALESCE(MAX(time_ms),0) t FROM chunks").get();
    return { count: Number(r.n), maxTimeMs: Number(r.t) };
  } catch { return null; }
  finally { try { src.close(); } catch {} }
}

/**
 * 判定 ov_session 源相對上次成功同步是否變化。
 * 對比 sync_state.cursor（{count,maxTimeMs}）：count 或 maxTimeMs 任一不同 → 變了。
 * 無 cursor（從未同步）→ 視為變了（需首次同步）。
 * @returns {boolean} true=源變了（需同步）；false=沒變（只監測，跳過同步）
 */
export function ovSourceChanged(db, sig) {
  if (!sig) return false;               // 源不可讀 → 不動
  const st = db.prepare("SELECT cursor FROM sync_state WHERE scope='ov_session'").get();
  if (!st || !st.cursor) return true;   // 從未同步 → 同步
  try {
    const cur = JSON.parse(st.cursor || "{}");
    return Number(cur.count) !== sig.count || Number(cur.maxTimeMs || 0) !== sig.maxTimeMs;
  } catch { return true; }
}

/**
 * 廉價探測 wiki 各資產的「變化指紋」= 每資產 .vectors.json 的 { size, mtimeNs }。
 * 同 ingest fingerprint 範式：文件沒變（size+mtime 相同）→ 跳過該資產，不全量重導。
 * 成本：每資產一次 fs.stat（~0ms）；不讀文件內容、不解析 JSON。
 * @param {Array<{id:string,path:string}>} mounted 已掛載資產
 * @returns {{assets:Object<string,{size:number,mtimeNs:number}>}} 指紋表
 */
export function probeWikiAssets(mounted) {
  const assets = {};
  for (const a of mounted || []) {
    try {
      const st = fs.statSync(path.join(a.path, ".vectors.json"));
      assets[a.id] = { size: st.size, mtimeNs: st.mtimeNs };
    } catch { /* 無 .vectors.json → 不記指紋（syncWiki 會跳過它） */ }
  }
  return { assets };
}

/**
 * 判定 wiki 源相對上次成功同步是否變化（整體層面：任一資產指紋變了就算變）。
 * 對比 sync_state.cursor（{assets:{id:{size,mtimeNs}}}）。
 * @returns {boolean} true=有資產變了（需同步）
 */
export function wikiSourceChanged(db, sig) {
  if (!sig || !sig.assets) return false;
  const st = db.prepare("SELECT cursor FROM sync_state WHERE scope='wiki'").get();
  if (!st || !st.cursor) return true;
  try {
    const cur = JSON.parse(st.cursor || "{}");
    const prev = cur.assets || {};
    const now = sig.assets;
    const keys = new Set([...Object.keys(prev), ...Object.keys(now)]);
    for (const k of keys) {
      const p = prev[k], n = now[k];
      if (!p || !n) return true;                                    // 新增/移除資產
      if (p.size !== n.size || p.mtimeNs !== n.mtimeNs) return true; // 內容變了
    }
    return false;
  } catch { return true; }
}

/**
 * 把 wiki 當前源指紋寫進 sync_state.cursor（對齊 syncOvsession 會寫 cursor 的範式）。
 * 必須在每個 wiki tick 探測後調用——否則 cursor 恆 null → wikiSourceChanged 每 tick 誤判「首次同步」→ 無限自觸發。
 * @param {DatabaseSync} db
 * @param {{assets:Object}} sig probeWikiAssets 的返回
 */
export function storeWikiCursor(db, sig) {
  if (!sig || !sig.assets) return;
  db.prepare(
    `INSERT INTO sync_state (scope, source_version, cursor, last_ok_ms, generation)
     VALUES ('wiki', 'ok', ?, COALESCE((SELECT last_ok_ms FROM sync_state WHERE scope='wiki'), 0), 1)
     ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor`,
  ).run(JSON.stringify(sig));
}

/**
 * OV session 真·增量遊標（用戶 A 定稿 2026-11-04）：源只追加，用源 rowid 作遊標。
 * 每 tick 只探測 MAX(rowid)（O(1)，SQLite INTEGER PRIMARY KEY）；前進才讀「rowid>cursor」的新行。
 * 刪除/歷史回寫=異常路徑，僅 rebuild 全量對賬，不進 60s 熱路徑。
 */

/** O(1) 探測源當前最大 rowid（只追加時即最新行）；源不可讀 → null。實測 0ms。 */
export function probeMaxRowid(sourceDbPath) {
  let src;
  try { src = new DatabaseSync(sourceDbPath, { readOnly: true }); }
  catch { return null; }
  try {
    const r = src.prepare("SELECT COALESCE(MAX(rowid),0) m FROM chunks").get();
    return Number(r.m);
  } catch { return null; }
  finally { try { src.close(); } catch {} }
}

/**
 * 讀已同步到的源 rowid（增量遊標）。
 * @returns {number|null} 已同步 rowid；null=從未同步 或 舊 legacy cursor（{count,maxTimeMs}，需一次全量遷移）
 */
export function readSyncedRowid(db) {
  const st = db.prepare("SELECT cursor FROM sync_state WHERE scope='ov_session'").get();
  if (!st || !st.cursor) return null;
  try {
    const c = JSON.parse(st.cursor || "{}");
    return Number.isFinite(c.sourceRowid) ? Number(c.sourceRowid) : null;  // legacy cursor 無此欄 → null
  } catch { return null; }
}

/**
 * Gap 2 fix（2026-11-04）：返回具體哪些資產變了（不只 boolean），讓 mirror tick 只同步變化資產。
 * .vectors.json 可達 56MB——只讀變化資產的 JSON，不全量重寫所有掛載資產。
 */
export function wikiSourceChangedAssets(db, sig) {
  if (!sig || !sig.assets) return { changed: false, changedAssets: [] };
  const st = db.prepare("SELECT cursor FROM sync_state WHERE scope='wiki'").get();
  if (!st || !st.cursor) return { changed: true, changedAssets: Object.keys(sig.assets) };
  try {
    const cur = JSON.parse(st.cursor || "{}");
    const prev = cur.assets || {};
    const now = sig.assets;
    const changedAssets = [];
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(now)]);
    for (const k of allKeys) {
      const p = prev[k], n = now[k];
      if (!p || !n || p.size !== n.size || p.mtimeNs !== n.mtimeNs) changedAssets.push(k);
    }
    return { changed: changedAssets.length > 0, changedAssets };
  } catch { return { changed: true, changedAssets: Object.keys(sig.assets) }; }
}

/** 寫增量遊標（只更新 cursor，不動 last_ok_ms——時間由 markSynced 在成功後單獨推）。 */
export function storeRowidCursor(db, rowid) {
  db.prepare(
    `INSERT INTO sync_state (scope, source_version, cursor, last_ok_ms, generation)
     VALUES ('ov_session', 'ok', ?, COALESCE((SELECT last_ok_ms FROM sync_state WHERE scope='ov_session'), 0), 1)
     ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor`,
  ).run(JSON.stringify({ sourceRowid: Number(rowid), at: Date.now() }));
}

/**
 * 標記一次「同步寫總表成功」。只在成功路徑調用；失敗/未變化不調 → 時間不動。
 * @param {DatabaseSync} db
 * @param {string} scope sync_state.scope（'wiki' | 'ov_session' ...）
 * @param {number} [ms] 成功時刻（默認 Date.now()）
 */
export function markSynced(db, scope, ms = Date.now()) {
  db.prepare(
    `INSERT INTO sync_state (scope, source_version, last_ok_ms, generation)
     VALUES (?, 'ok', ?, 1)
     ON CONFLICT(scope) DO UPDATE SET
       source_version='ok',
       last_ok_ms=excluded.last_ok_ms,
       generation=sync_state.generation+1`,
  ).run(scope, ms);
  return ms;
}

/**
 * 讀某目標最近一次成功同步時間（ISO 字符串；無則 null → 前端誠實顯示「待後端」）。
 * @param {DatabaseSync} db
 * @param {string} target /source-stats 口徑目標名（'session' | 'wiki'，也容忍 'ov_session'）
 */
export function resolveLastSyncMs(db, target) {
  const scope = SCOPE_MAP[target] || target;
  try {
    const r = db.prepare("SELECT last_ok_ms FROM sync_state WHERE scope=?").get(scope);
    return r && r.last_ok_ms ? new Date(r.last_ok_ms).toISOString() : null;
  } catch { return null; }
}
