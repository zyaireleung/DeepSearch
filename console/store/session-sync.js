/**
 * OV session 分区同步（③，方案 § 四 L2-B ov_chunks）
 *
 * 源：OV ingest 状态库 chunks 表（id/session_id/time_ms/role/text/embedding BLOB float32/index_version）。
 * 目标：deep_search.db 的 ov_chunks（总表镜像，int8 驻留）。
 * 同步：float32→int8 量化导入 + 差集对账（源不在 → 删）+ 游标（sync_state scope=ov_session）。
 * 唯一写者：Console（本模块只在 Console 进程调用；见 db.js WRITE_OWNER）。
 */
import { DatabaseSync } from "node:sqlite";
import { float32ToInt8 } from "../search/embed.js";
import { storeRowidCursor } from "./last-sync.js";

/** 从源 chunks 表读取全部行（id/session_id/time_ms/role/text/embedding/index_version） */
export function readSourceChunks(sourceDbPath, { where = "", params = [] } = {}) {
  const src = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    return src
      .prepare(
        `SELECT id, session_id, time_ms, role, text, embedding, index_version
         FROM chunks ${where} ORDER BY time_ms`,
      )
      .all(...params);
  } finally {
    src.close();
  }
}

/** 差集对账：删除 ov_chunks 中不在源 id 集合的行（源删除跟进） */
function reconcileDeleted(db, sourceIds) {
  // 分批 NOT IN 防 SQLite 参数上限
  const all = db.prepare("SELECT id FROM ov_chunks").all().map((r) => r.id);
  const sourceSet = new Set(sourceIds);
  const deleted = all.filter((id) => !sourceSet.has(id));
  const del = db.prepare("DELETE FROM ov_chunks WHERE id = ?");
  let n = 0;
  for (const id of deleted) {
    del.run(id);
    n++;
  }
  return n;
}

/**
 * 镜像源 chunks → ov_chunks（int8 导入 + 差集对账 + 游标）。
 * 返回 { upserted, deleted, total, cursor }。
 */
export function syncOvsession(db, sourceDbPath) {
  const upsert = db.prepare(
    `INSERT INTO ov_chunks (id, session_id, time_ms, role, text, vec, index_version)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, time_ms=excluded.time_ms,
       role=excluded.role, text=excluded.text, vec=excluded.vec, index_version=excluded.index_version`,
  );
  const rows = readSourceChunks(sourceDbPath);
  let upserted = 0;
  for (const r of rows) {
    upsert.run(r.id, r.session_id, r.time_ms, r.role, r.text, float32ToInt8(r.embedding), r.index_version);
    upserted++;
  }
  const deleted = reconcileDeleted(db, rows.map((r) => r.id));

  const maxTime = rows.length ? rows[rows.length - 1].time_ms : 0;
  const cursor = { count: rows.length, maxTimeMs: maxTime, at: Date.now() };
  db.prepare(
    `INSERT INTO sync_state (scope, source_version, cursor, last_ok_ms, generation)
     VALUES ('ov_session', ?, ?, ?, 1)
     ON CONFLICT(scope) DO UPDATE SET source_version=excluded.source_version,
       cursor=excluded.cursor, last_ok_ms=excluded.last_ok_ms, generation=generation+1`,
  ).run(String(rows.length), JSON.stringify(cursor), Date.now());

  return { upserted, deleted, total: rows.length, cursor };
}

/**
 * 真·增量同步（用戶 A 定稿 2026-11-04）：只讀「源 rowid > fromRowid」的新行 → upsert → 寫新遊標。
 * 不掃舊表、不重寫舊 ov_chunks、**不做刪除對賬**（A：刪除/歷史回寫=異常路徑，僅 rebuild 全量 syncOvsession 對齊）。
 * 成本 ∝ 新行數，與源總量無關；無新行時調用方應先 probeMaxRowid 比對 cursor 再決定是否調用。
 * @param {DatabaseSync} db 總表
 * @param {string} sourceDbPath 源庫
 * @param {number} fromRowid 已同步到的 rowid（exclusive）
 * @param {number} toRowid 探測到的源 MAX(rowid)
 * @returns {{processed:number, toRowid:number}} processed=本次 upsert 行數
 */
export function syncOvsessionIncremental(db, sourceDbPath, fromRowid, toRowid) {
  if (!(toRowid > fromRowid)) return { processed: 0, toRowid: Number(fromRowid) || 0 };
  const upsert = db.prepare(
    `INSERT INTO ov_chunks (id, session_id, time_ms, role, text, vec, index_version)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, time_ms=excluded.time_ms,
       role=excluded.role, text=excluded.text, vec=excluded.vec, index_version=excluded.index_version`,
  );
  const rows = readSourceChunks(sourceDbPath, {
    where: "WHERE rowid > ?",           // 走 rowid INTEGER PRIMARY KEY seek；ORDER BY 由 readSourceChunks 統一追加
    params: [Number(fromRowid)],
  });
  for (const r of rows) {
    upsert.run(r.id, r.session_id, r.time_ms, r.role, r.text, float32ToInt8(r.embedding), r.index_version);
  }
  storeRowidCursor(db, toRowid);
  return { processed: rows.length, toRowid: Number(toRowid) };
}

/** 只读统计（deep_search_status 用）：chunks 数 / 会话数 / 游标 */
export function ovsessionStats(db) {
  const total = Number(db.prepare("SELECT COUNT(*) c FROM ov_chunks").get().c);
  const sessions = Number(db.prepare("SELECT COUNT(DISTINCT session_id) c FROM ov_chunks").get().c);
  const st = db.prepare("SELECT cursor, last_ok_ms, generation FROM sync_state WHERE scope='ov_session'").get();
  return { total, sessions, cursor: st ? JSON.parse(st.cursor || "{}") : null, lastOkMs: st?.last_ok_ms ?? null, generation: st?.generation ?? 0 };
}
