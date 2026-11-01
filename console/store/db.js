/**
 * deep_search 总表 DB（② 骨架，方案 § 四 总表 Schema）
 *
 * 唯一写者：Console :6600 独占写总表（修订 5，V22）。本模块只在 Console 进程内使用；
 * 插件 host 永不打开本 DB 写连接（api-client 只调 GET 端点 + POST /sync 经 Console 串行队列）。
 * 存储：SQLite WAL + int8 向量 BLOB（1024 字节/条）。用 Node 内置 node:sqlite（无外部依赖）。
 */
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/** 唯一写者边界（V22：插件写被拒；仅 Console 可写） */
export const WRITE_OWNER = "console";

/** § 四 schema：10 表（路由注册 + 内容分区 + 导航 + 状态/健康/任务） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,          -- mem0 / ov_context / ov_session / wiki
  kind TEXT NOT NULL,           -- api | local
  layered INTEGER NOT NULL,     -- 1=层级源 0=扁平源
  endpoint TEXT,                -- 1933 / 8915 / 文件路径
  state TEXT NOT NULL,          -- ready | stale | down | disabled
  enabled INTEGER NOT NULL DEFAULT 1,
  stats_json TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS source_modes (
  source_id TEXT NOT NULL,
  mode TEXT NOT NULL,           -- find | search | default
  requires_session INTEGER NOT NULL DEFAULT 0,
  scope TEXT,                   -- global | session | asset
  layered INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source_id, mode)
);
CREATE TABLE IF NOT EXISTS wiki_blocks (
  asset_id TEXT NOT NULL,
  block_key TEXT NOT NULL,      -- sha1(entry|board|title)[:16]
  hash TEXT,
  entry TEXT, board TEXT, title TEXT,
  text TEXT,
  vec BLOB,
  updated_at INTEGER,
  PRIMARY KEY (asset_id, block_key)
);
CREATE TABLE IF NOT EXISTS ov_chunks (
  id TEXT PRIMARY KEY,          -- chunks.id
  session_id TEXT NOT NULL,
  time_ms INTEGER, role TEXT, text TEXT,
  vec BLOB,
  index_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ov_chunks_session ON ov_chunks(session_id);
CREATE TABLE IF NOT EXISTS wiki_nav (
  asset_id TEXT, node_key TEXT NOT NULL, node_kind TEXT,
  up_json TEXT, across_json TEXT, back_json TEXT, global_json TEXT,
  PRIMARY KEY (asset_id, node_key)
);
CREATE TABLE IF NOT EXISTS wiki_toc (
  asset_id TEXT NOT NULL,
  toc_kind TEXT NOT NULL,       -- index | sources_index
  entry_name TEXT NOT NULL,
  ref_key TEXT,
  ord INTEGER,
  PRIMARY KEY (asset_id, toc_kind, entry_name)
);
CREATE INDEX IF NOT EXISTS idx_wiki_toc_kind ON wiki_toc(asset_id, toc_kind);
CREATE TABLE IF NOT EXISTS sync_state (
  scope TEXT PRIMARY KEY,       -- wiki:<asset_id> | ov_session:<session_id> | mem0 | ov_context
  source_version TEXT,
  cursor TEXT,
  last_ok_ms INTEGER,
  last_err TEXT,
  generation INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS embedding_profile (
  id TEXT PRIMARY KEY,
  model TEXT, dim INTEGER, quant TEXT, vec_version INTEGER,
  calibrated_at INTEGER
);
CREATE TABLE IF NOT EXISTS health_snapshot (
  source_id TEXT PRIMARY KEY,   -- mem0 / ov_context / ov_session / wiki
  state TEXT NOT NULL,          -- ok | unavailable | unsynced | partial | down
  detail_code TEXT,
  detail TEXT,
  ok_count INTEGER,
  total_count INTEGER,
  last_ok_ms INTEGER,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,         -- wiki | session | all
  dry_run INTEGER NOT NULL DEFAULT 1,
  rebuild INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,          -- queued | running | done | failed
  progress TEXT,
  result_json TEXT,
  created_at INTEGER, finished_at INTEGER
);
`;

/** 打开总表 DB（WAL；建 schema；幂等） */
export function openDb(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** 源注册（§ 四 L1 种子；kind=api 或 local；layered 见修订 6——ov_context 唯一入口 find） */
const SOURCES = [
  { id: "ov_context", kind: "api", layered: 1, endpoint: "1933", state: "ready" },
  { id: "ov_session", kind: "local", layered: 0, endpoint: "ov_chunks", state: "ready" },
  { id: "mem0", kind: "api", layered: 0, endpoint: "8915", state: "ready" },
  { id: "wiki", kind: "local", layered: 1, endpoint: "wiki_blocks", state: "ready" },
];

/** 能力注册（§ 四 L1-B；修订 6：ov_context 唯一有效能力 find，search 解析为 find） */
const MODES = [
  { source_id: "ov_context", mode: "find", requires_session: 0, scope: "global", layered: 1 },
  { source_id: "ov_context", mode: "search", requires_session: 1, scope: "session", layered: 1 }, // 修订 6 别名
  { source_id: "ov_session", mode: "default", requires_session: 0, scope: "global", layered: 0 },
  { source_id: "mem0", mode: "find", requires_session: 0, scope: "global", layered: 0 },
  { source_id: "wiki", mode: "default", requires_session: 0, scope: "asset", layered: 1 },
];

/** 种子 sources + source_modes（幂等 upsert） */
export function seedSources(db) {
  const upsertSource = db.prepare(
    `INSERT INTO sources (id,kind,layered,endpoint,state,enabled,updated_at) VALUES (?,?,?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, layered=excluded.layered,
       endpoint=excluded.endpoint, state=excluded.state, updated_at=excluded.updated_at`,
  );
  const upsertMode = db.prepare(
    `INSERT INTO source_modes (source_id,mode,requires_session,scope,layered,enabled) VALUES (?,?,?,?,?,1)
     ON CONFLICT(source_id,mode) DO UPDATE SET requires_session=excluded.requires_session,
       scope=excluded.scope, layered=excluded.layered`,
  );
  const now = Date.now();
  for (const s of SOURCES) upsertSource.run(s.id, s.kind, s.layered, s.endpoint, s.state, now);
  for (const m of MODES) upsertMode.run(m.source_id, m.mode, m.requires_session, m.scope, m.layered);
}

/** 唯一写者断言：任何非 Console 写路径都应经过这里（V22；插件 host 侧由 api-client 层拒绝） */
export function assertWriteOwner(owner = WRITE_OWNER) {
  if (owner !== "console") {
    throw new Error(`[store] 总表唯一写者是 Console（WRITE_OWNER=console），拒绝 ${owner} 写入（V22）`);
  }
  return true;
}
