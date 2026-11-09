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
import { randomUUID } from "node:crypto";

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
CREATE TABLE IF NOT EXISTS web_sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER DEFAULT 0,
  query_hint TEXT NOT NULL DEFAULT '',
  proxy INTEGER DEFAULT 0,
  crawl INTEGER DEFAULT 0,       -- 阶段3 插件 catalogBlock crawl 分段用
  enabled INTEGER DEFAULT 1,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS crawl_platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',  -- mediacrawler 表 NAME+DESCRIPTION+CRAWL 三列
  enabled INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
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

/** web/crawl 目录表（阶段2 接通；crawl 列供阶段3 插件 catalogBlock 用） */
export function initWebCatalogSchema(db) {
  db.exec(SCHEMA);
  seedWebSites(db);
  seedCrawlPlatforms(db);
}

/** Wigolo 站点定稿种子（14 条，2026-11-08 用户定稿；wigolo 无登录态，只收公开可 URL 检索站） */
const SEED_WEB_SITES = [
  { name:"Google", domain:"google.com", category:"search_engine", priority:10, proxy:1, crawl:0, queryHint:"", description:"全网与英文技术内容检索；查跨站资料、最新信息，或用 site: 精确锁站" },
  { name:"Bing 国际版", domain:"bing.com", category:"search_engine", priority:11, proxy:1, crawl:0, queryHint:"", description:"通用全网检索；Google 结果不足或需另一套索引时用" },
  { name:"Bing 国内版", domain:"cn.bing.com", category:"search_engine", priority:99, proxy:0, crawl:0, queryHint:"", description:"免代理的全网检索兜底；代理未开或国际搜索不可达时用" },
  { name:"GitHub", domain:"github.com", category:"developer_community", priority:20, proxy:1, crawl:0, queryHint:"site:github.com", description:"开源仓库源码、Issues/Discussions、版本发布与更新记录；查项目实现、报错解法、版本变化时用" },
  { name:"LiblibAI", domain:"liblib.art", category:"aigc", priority:40, proxy:0, crawl:0, queryHint:"", description:"模型与 LoRA、参考图、提示词与参数、ComfyUI 工作流，可在线生图；国内网络下找灵感、反查提示词/参数、试跑工作流时用" },
  { name:"Civitai", domain:"civitai.com", category:"aigc", priority:41, proxy:1, crawl:0, queryHint:"", description:"模型与 LoRA、图片/视频参考、提示词与参数、工作流、教程；要海外模型与风格、按作品反查资源时用" },
  { name:"Comfy 工作流库", domain:"comfy.org/workflows", category:"aigc", priority:42, proxy:1, crawl:0, queryHint:"", description:"ComfyUI 官方与社区工作流模板；不想从零连线、要抄成熟模板时用" },
  { name:"Pixabay Music", domain:"pixabay.com/music", category:"audio", priority:70, proxy:0, crawl:0, queryHint:"", description:"可商用背景音乐与通用音效；短剧/视频快速选 BGM 时用" },
  { name:"Freesound", domain:"freesound.org", category:"audio", priority:71, proxy:1, crawl:0, queryHint:"", description:"具体拟音与环境音；找脚步/开门/雨声等细节音效时用，需核对许可证" },
  { name:"Pexels", domain:"pexels.com", category:"image", priority:80, proxy:0, crawl:0, queryHint:"", description:"免费实拍照片、视频空镜与 B-roll；短剧/封面/视频背景素材时用" },
  { name:"Pixabay", domain:"pixabay.com", category:"image", priority:81, proxy:0, crawl:0, queryHint:"", description:"摄影、插画、矢量与 AI 图；Pexels 缺插画或矢量素材时补位" },
  { name:"抖音短剧创作者中心", domain:"shortdramas.com", category:"script", priority:90, proxy:0, crawl:0, queryHint:"", description:"官方题材趋势、IP、投稿与分账；了解平台需求或走官方投稿时用" },
  { name:"咔咔猩", domain:"kakaxing.com", category:"script", priority:91, proxy:0, crawl:0, queryHint:"", description:"AI 编剧、剧本供给、质量评估与视频拉片；生成、评估或买可拍剧本时用" },
  { name:"33 台词", domain:"33.agilestudio.cn", category:"script", priority:94, proxy:0, crawl:0, queryHint:"", description:"按台词反查影片与时间点；找原片桥段、拉片定位时用" },
  // 6 个社媒站：有登录态、经 mediacrawler 抓取；crawl=1 表示进插件 catalogBlock 的 crawl 分段
  { name:"知乎", domain:"zhihu.com", category:"social", priority:30, proxy:0, crawl:1, queryHint:"", description:"中文问答社区，技术讨论与经验帖深度高；查中文技术问题、行业经验时用" },
  { name:"B站", domain:"bilibili.com", category:"social", priority:31, proxy:0, crawl:1, queryHint:"", description:"综合视频平台，教程与实操演示密集；要跟着视频操作、看演示时用" },
  { name:"微博", domain:"weibo.com", category:"social", priority:32, proxy:0, crawl:1, queryHint:"", description:"中文社交平台，热点与实时讨论集中；追最新动态、看大众反应时用" },
  { name:"抖音", domain:"douyin.com", category:"social", priority:33, proxy:0, crawl:1, queryHint:"", description:"短视频平台，内容传播广；看短视频教程/演示、查热门内容时用" },
  { name:"小红书", domain:"xiaohongshu.com", category:"social", priority:34, proxy:0, crawl:1, queryHint:"", description:"笔记型内容社区，生活方式与实操经验多；找图文教程、真实使用体验时用" },
  { name:"快手", domain:"kuaishou.com", category:"social", priority:35, proxy:0, crawl:1, queryHint:"", description:"短视频平台，下沉与生活类内容多；查生活类实操、大众向内容时用" },
];

/** MediaCrawler 固定 6 平台（有登录态；NAME+DESCRIPTION+CRAWL，无编辑入口） */
const SEED_CRAWL_PLATFORMS = [
  { id:"zhihu",       name:"知乎",   description:"中文问答社区，技术讨论与经验帖深度高；查中文技术问题、行业经验时用" },
  { id:"bilibili",    name:"B站",    description:"综合视频平台，教程与实操演示密集；要跟着视频操作、看演示时用" },
  { id:"weibo",       name:"微博",   description:"中文社交平台，热点与实时讨论集中；追最新动态、看大众反应时用" },
  { id:"douyin",      name:"抖音",   description:"短视频平台，内容传播广；看短视频教程/演示、查热门内容时用" },
  { id:"xiaohongshu", name:"小红书", description:"笔记型内容社区，生活方式与实操经验多；找图文教程、真实使用体验时用" },
  { id:"kuaishou",    name:"快手",   description:"短视频平台，下沉与生活类内容多；查生活类实操、大众向内容时用" },
];

/** 幂等 seed：表空才灌。 */
export function seedWebSites(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM web_sites").get().c;
  if (n > 0) return;
  const ins = db.prepare(
    `INSERT INTO web_sites (id,name,domain,category,description,priority,query_hint,proxy,crawl,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
  );
  const now = Date.now();
  for (const s of SEED_WEB_SITES) {
    ins.run(randomUUID(), s.name, s.domain, s.category, s.description, s.priority, s.queryHint, s.proxy, s.crawl, now, now);
  }
}

export function seedCrawlPlatforms(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM crawl_platforms").get().c;
  if (n > 0) return;
  const ins = db.prepare("INSERT INTO crawl_platforms (id,name,description,enabled,sort) VALUES (?,?,?,1,?)");
  SEED_CRAWL_PLATFORMS.forEach((p, i) => ins.run(p.id, p.name, p.description, i + 1));
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
