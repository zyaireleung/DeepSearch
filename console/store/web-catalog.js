// store/web-catalog.js —— 只读 web 站点目录 + crawl 平台目录（渠道页 + deep_search_guide 三类动态目录）
// 沙盒版：web_sites 含 crawl 列（阶段3 插件 catalogBlock crawl 分段用）；crawl_platforms 含 description。
// bool 出站一律 Boolean()。

/** GET /web-catalog：裸目录 JSON，priority 降序；categories 由 sites 聚合去重。 */
export function buildWebCatalog(db, { now = Date.now() } = {}) {
  const rows = db.prepare(
    `SELECT id,name,domain,category,description,priority,query_hint,proxy,crawl,enabled FROM web_sites ORDER BY priority ASC, name ASC`,
  ).all();
  const sites = rows.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    domain: r.domain ?? "",
    category: r.category ?? "",
    description: r.description ?? "",
    priority: Number(r.priority ?? 0),
    queryHint: r.query_hint ?? "",
    proxy: Boolean(r.proxy),
    crawl: Boolean(r.crawl),
    enabled: Boolean(r.enabled),
  }));
  const seen = new Set();
  const categories = [];
  for (const s of sites) {
    if (s.category && !seen.has(s.category)) { seen.add(s.category); categories.push(s.category); }
  }
  return { version: 1, generatedAt: now, sites, categories };
}

/** GET /crawl-catalog：裸目录 JSON，按 sort 排序（含 description 供 mediacrawler 表 NAME+DESCRIPTION+CRAWL）。 */
export function buildCrawlCatalog(db, { now = Date.now() } = {}) {
  const rows = db.prepare("SELECT id,name,description,enabled FROM crawl_platforms ORDER BY sort ASC, id ASC").all();
  const platforms = rows.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    description: r.description ?? "",
    enabled: Boolean(r.enabled),
  }));
  return { version: 1, generatedAt: now, platforms };
}
