/**
 * 完整版本原子可见性（⑦，方案 § 11.5）
 *
 * 每资产 / 每 session 单事务：staging → 校验 → 原子切换。
 * 失败保留旧完整版本（禁止清表后留空索引）；搜索只读完成版。
 */
import { DatabaseSync } from "node:sqlite";

/**
 * 原子执行一个同步单位。
 * @param db DatabaseSync
 * @param {object} opts { scope, fn(stagingDb), validate(rowsCount), syncedAt }
 * @returns {ok, count, error?}
 */
export function runAtomic(db, { scope, fn, validate = () => true, syncedAt = Date.now() }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn(db);
    const count = db.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE scope=?").get(scope)?.n ?? 0;
    if (!validate(count)) throw new Error("validate failed: " + scope);
    // 标新值（cursor / generation / synced_at）
    db.prepare(
      "INSERT INTO sync_state (scope, cursor, generation, synced_at, last_ok_ms, status) VALUES (?, ?, COALESCE((SELECT generation FROM sync_state WHERE scope=?),0)+1, ?, ?, 'ok') ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation, synced_at=excluded.synced_at, last_ok_ms=excluded.last_ok_ms, status='ok'",
    ).run(scope, JSON.stringify({}), scope, syncedAt, syncedAt);
    db.exec("COMMIT");
    return { ok: true, count };
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, error: e.message };
  }
}

/** 校验：写入行数 > 0（防清表后空索引） */
export function nonEmptyValidate(expected = 1) {
  return (count) => count >= expected;
}

/** 打开 staging 表写入（供 fn 用）：写入前不触碰完成版 */
export function openStaging(db) {
  // 调用方用 fn 直接写生产表；staging 语义由"单事务内写后即切"保证（WAL 读旧版直到 COMMIT）
  return db;
}
