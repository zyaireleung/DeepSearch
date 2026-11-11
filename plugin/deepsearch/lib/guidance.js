/**
 * 检索导引注入（⑦.5，方案 § 9.7 会话初始化与懒拉起幂等）
 *
 * 三条铁律：导引只注入一次（稳定 source/id = deep-search/system-guide，同一 sessionId 只一次）；
 *          wake 进程内合并（非阻塞）；Console 不可用不越权（导引照常注入，工具返回 coordinator_down）。
 */
export const GUIDANCE_SOURCE_ID = "deep-search/system-guide";
/**
 * 渲染只读源目录（Task 7）：只输出源 id/label/保存/不保存 + 模板源列表。
 * 绝不输出 carry/向量/导航字段；Agent 只据此选源，不预测未跑模板输出。
 */
export function renderSourceCatalog(catalog) {
    const lines = ["【当前源目录（只读）】"];
    for (const s of catalog.sources) {
        const d = s.description;
        // Wiki 资产（2026-10-30）：单文本说明；固定源：保存什么 / 不保存什么。
        const desc = d && d.text !== undefined
            ? d.text
            : `保存：${d?.contains ?? ""}；不保存：${d?.excludes ?? ""}`;
        lines.push(`- ${s.id}（${s.label}）：${desc}`);
    }
    if (catalog.templates.length) {
        lines.push("【可用模糊模板】");
        for (const t of catalog.templates) {
            lines.push(`- ${t.id}（${t.label}）：源 = ${t.sources.join(", ")}`);
        }
    }
    return lines.join("\n");
}
/** Console 不可达时的回退语：不猜测具体 Wiki 资产范围。 */
export function sourceCatalogFallback() {
    return "Console 暂不可达；不要猜测具体 Wiki 资产范围。可先使用固定源，待 Console 恢复后读取最新目录。";
}
/** 是否已注入（幂等判定：source/id 匹配即已注入，跳过） */
export function isGuidanceInjected(injectedIds) {
    return Array.isArray(injectedIds) && injectedIds.includes(GUIDANCE_SOURCE_ID);
}
/**
 * 构建首轮【检索导引】胶囊（form:"snapshot" 的 user message 注入，非 system prompt）。
 * content = system-guide.md 检索分层指针（三层分工表，详见随工具返回的 routing）。
 */
export function buildGuidanceCapsule(systemGuide, { alreadyInjected } = {}) {
    if (isGuidanceInjected(alreadyInjected))
        return null; // 幂等：同一 session 只注入一次
    return {
        source: GUIDANCE_SOURCE_ID,
        id: GUIDANCE_SOURCE_ID,
        form: "snapshot",
        content: systemGuide,
    };
}
/** § 9.7 时序：注入导引（一次）→ 非阻塞 wake 依赖 → 继续；返回 {guidance, wake} */
export function sessionInitPlan({ systemGuide, alreadyInjected, coordinatorUp }) {
    const guidance = buildGuidanceCapsule(systemGuide, { alreadyInjected });
    return {
        guidance,
        // 非阻塞 wake：只发请求不等 ready；coordinatorUp 只作即时状态参考，不作绿灯
        wake: { mem0: true, ov: true, blocking: false },
        coordinatorUp: coordinatorUp ?? false,
    };
}
// ---- source-routing.md 消费（2026-10-31 沙盒）：deep_search 结果按命中来源裁剪 ----
/** 来源类别归一化：Console SourceId → routing 类别（ov_context_find/search → ov_context）。 */
export function normalizeRoutingSource(s) {
    if (s === "mem0" || s === "ov_context" || s === "ov_session" || s === "wiki")
        return s;
    if (s === "ov_context_find" || s === "ov_context_search")
        return "ov_context";
    return s;
}
/** source-routing.md 中【read 后提示】节名（deep_search_read 兜底用；routing 内条件呈现）。 */
const READ_GUIDE_SECTION = "read 后提示";
/** read 后提示 依赖的类别：只有出现这些被截断、需 read 读全文的源（ov_session/wiki）时才呈现。 */
const READ_GUIDE_NEEDS = ["ov_session", "wiki"];
/** 固定呈现顺序：来源类别在前，通用方法块恒在最后。 */
const ROUTING_ORDER = ["mem0", "ov_context", "ov_session", "wiki", "修改 query 方法", "扩大/更换范围检索方法", READ_GUIDE_SECTION];
/** 恒有方法块（无论命中哪些来源都呈现；read 后提示 不在此列，按条件呈现）。 */
const ROUTING_ALWAYS = ["修改 query 方法", "扩大/更换范围检索方法"];
/** 解析 source-routing.md 分节（## 标题）→ Map<节名, 正文>；标题行自身不入正文。 */
export function parseSourceRouting(text) {
    const sections = new Map();
    let current = null;
    const buf = [];
    const flush = () => {
        if (current !== null)
            sections.set(current, buf.join("\n").trim());
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, "");
        const m = line.match(/^##\s+(.+)$/);
        if (m) {
            flush();
            current = m[1].trim();
            buf.length = 0;
        }
        else if (current !== null) {
            buf.push(line);
        }
    }
    flush();
    return sections;
}
/**
 * 按本轮实际命中的来源类别裁剪 source-routing.md（S1/S2 路线指引）：
 *   - 只保留命中来源的类别行（mem0/ov_context/ov_session/wiki，ov_context_find/search 归一化去重）；
 *   - 恒有【修改 query 方法】与【扩大/更换范围检索方法】两段；
 *   - 【read 后提示】仅在出现需 read 读全文的源（ov_session/wiki）结果时呈现，其余场景不显示；
 *   - 顺序固定（mem0→ov_context→ov_session→wiki→方法块→read 后提示）；未知来源忽略。
 * 由 host 在 deep_search 返回 page 时附加为 page.routing，供 Agent 做下一步决策。
 */
export function renderSourceRouting(text, hitSources) {
    const sections = parseSourceRouting(text);
    const wanted = new Set();
    for (const s of hitSources) {
        const norm = normalizeRoutingSource(s);
        if (ROUTING_ORDER.includes(norm))
            wanted.add(norm);
    }
    const layeredHit = READ_GUIDE_NEEDS.some((n) => wanted.has(n));
    const selected = ROUTING_ORDER.filter((n) => wanted.has(n) || ROUTING_ALWAYS.includes(n) || (n === READ_GUIDE_SECTION && layeredHit));
    const lines = ["# 来源路线（S1/S2）"];
    for (const n of selected) {
        const body = sections.get(n);
        if (body === undefined)
            continue;
        lines.push("", `## ${n}`, body);
    }
    return lines.join("\n");
}
/**
 * 提取 read 后提示（极短兜底）：正常链路 deep_search 结果已带 routing，
 * 仅当 Agent 脱离前置检索直接调用 deep_search_read 时，附一句下一步指引。
 * 找不到节则返回 undefined（不虚构）。
 */
export function renderReadGuide(text) {
    const body = parseSourceRouting(text).get(READ_GUIDE_SECTION);
    return body && body.trim() ? body.trim() : undefined;
}
// ==== deep_search_guide 三类动态目录（Task 2/3）====
/** 有限数值型 version/generatedAt（三类目录共同要求）。 */
function assertTopLevel(x, label) {
    const o = x;
    if (!o || typeof o !== "object")
        throw new Error(`malformed ${label}: 非对象`);
    if (typeof o.version !== "number" || !Number.isFinite(o.version))
        throw new Error(`malformed ${label}: version 非有限数值`);
    if (typeof o.generatedAt !== "number" || !Number.isFinite(o.generatedAt))
        throw new Error(`malformed ${label}: generatedAt 非有限数值`);
}
/** device 目录：sources 非空 + 每项必填字段齐；templates 数组（可空）+ 每项 id/label/sources。 */
export function validateSourceCatalog(x) {
    assertTopLevel(x, "/source-catalog");
    const o = x;
    if (!Array.isArray(o.sources) || o.sources.length === 0)
        throw new Error("malformed /source-catalog: sources 空或非数组");
    if (!Array.isArray(o.templates))
        throw new Error("malformed /source-catalog: templates 非数组");
    for (const s of o.sources) {
        if (!s || typeof s.id !== "string" || typeof s.label !== "string")
            throw new Error("malformed /source-catalog: source 缺 id/label");
        if (typeof s.enabled !== "boolean")
            throw new Error("malformed /source-catalog: source.enabled 非 boolean");
        if (!s.description || typeof s.description !== "object")
            throw new Error("malformed /source-catalog: source.description 非对象");
    }
    for (const t of o.templates) {
        if (!t || typeof t.id !== "string" || typeof t.label !== "string")
            throw new Error("malformed /source-catalog: template 缺 id/label");
        if (!Array.isArray(t.sources))
            throw new Error("malformed /source-catalog: template.sources 非数组");
    }
}
/** web 目录：sites 非空 + 每项字段齐（priority number + proxy/enabled boolean；crawl 可选，true=登录态社媒站归 crawl 分段）；categories 数组。 */
export function validateWebCatalog(x) {
    assertTopLevel(x, "/web-catalog");
    const o = x;
    if (!Array.isArray(o.sites) || o.sites.length === 0)
        throw new Error("malformed /web-catalog: sites 空或非数组");
    if (!Array.isArray(o.categories))
        throw new Error("malformed /web-catalog: categories 非数组");
    for (const s of o.sites) {
        if (!s || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.domain !== "string" || typeof s.category !== "string" || typeof s.description !== "string")
            throw new Error("malformed /web-catalog: site 缺字符串字段");
        if (typeof s.priority !== "number" || !Number.isFinite(s.priority))
            throw new Error("malformed /web-catalog: priority 非有限数值");
        if (typeof s.queryHint !== "string")
            throw new Error("malformed /web-catalog: queryHint 非字符串");
        if (typeof s.proxy !== "boolean" || typeof s.enabled !== "boolean")
            throw new Error("malformed /web-catalog: proxy/enabled 非 boolean");
        if (s.crawl !== undefined && typeof s.crawl !== "boolean")
            throw new Error("malformed /web-catalog: crawl 非 boolean");
    }
}
/** crawl 目录：platforms 非空 + 每项 id/name/description + enabled boolean。 */
export function validateCrawlCatalog(x) {
    assertTopLevel(x, "/crawl-catalog");
    const o = x;
    if (!Array.isArray(o.platforms) || o.platforms.length === 0)
        throw new Error("malformed /crawl-catalog: platforms 空或非数组");
    for (const p of o.platforms) {
        if (!p || typeof p.id !== "string" || typeof p.name !== "string")
            throw new Error("malformed /crawl-catalog: platform 缺 id/name");
        if (typeof p.description !== "string")
            throw new Error("malformed /crawl-catalog: description 非字符串");
        if (typeof p.enabled !== "boolean")
            throw new Error("malformed /crawl-catalog: enabled 非 boolean");
    }
}
/** 内置静态快照：与 Console 种子逐项一致（分属两代码库无法共用，验收断言兜底）。 */
export const STATIC_WEB_SITES = [
    { id: "static-bing", name: "Bing", domain: "bing.com", category: "search_engine", description: "Bing 网页搜索，无站点过滤时作通用入口", priority: 90, queryHint: "", proxy: false, enabled: true },
    { id: "static-mdn", name: "MDN Web Docs", domain: "developer.mozilla.org", category: "official_docs", description: "Web 标准/JS/CSS 官方文档", priority: 85, queryHint: "site:developer.mozilla.org", proxy: false, enabled: true },
    { id: "static-github", name: "GitHub", domain: "github.com", category: "developer_community", description: "开源仓库与代码", priority: 80, queryHint: "site:github.com", proxy: false, enabled: true },
    { id: "static-so", name: "Stack Overflow", domain: "stackoverflow.com", category: "developer_community", description: "编程问答", priority: 75, queryHint: "site:stackoverflow.com", proxy: false, enabled: true },
    { id: "static-pg", name: "PostgreSQL Docs", domain: "postgresql.org", category: "official_docs", description: "PostgreSQL 官方文档", priority: 70, queryHint: "site:postgresql.org", proxy: false, enabled: true },
    { id: "static-wiki", name: "Wikipedia", domain: "wikipedia.org", category: "encyclopedia", description: "多语言百科全书，走代理", priority: 60, queryHint: "site:wikipedia.org", proxy: true, enabled: true },
    { id: "static-yt", name: "YouTube", domain: "youtube.com", category: "video", description: "视频站点，走代理", priority: 50, queryHint: "site:youtube.com", proxy: true, enabled: true },
    { id: "static-hn", name: "Hacker News", domain: "news.ycombinator.com", category: "news", description: "技术新闻讨论", priority: 45, queryHint: "site:news.ycombinator.com", proxy: false, enabled: true },
];
/** 内置静态 crawl 快照：与 Console crawl_platforms 逐项一致（6 平台，登录态可抓；仅 NAME+DESCRIPTION，无 DOMAIN/PRIORITY）。 */
export const STATIC_CRAWL_PLATFORMS = [
    { id: "zhihu", name: "知乎", description: "中文问答社区，技术讨论与经验帖深度高；查中文技术问题、行业经验时用", enabled: true },
    { id: "bilibili", name: "B站", description: "综合视频平台，教程与实操演示密集；要跟着视频操作、看演示时用", enabled: true },
    { id: "weibo", name: "微博", description: "中文社交平台，热点与实时讨论集中；追最新动态、看大众反应时用", enabled: true },
    { id: "douyin", name: "抖音", description: "短视频平台，内容传播广；看短视频教程/演示、查热门内容时用", enabled: true },
    { id: "xiaohongshu", name: "小红书", description: "笔记型内容社区，生活方式与实操经验多；找图文教程、真实使用体验时用", enabled: true },
    { id: "kuaishou", name: "快手", description: "短视频平台，下沉与生活类内容多；查生活类实操、大众向内容时用", enabled: true },
];
/** 渲染 web 目录：priority 降序，滤 disabled，滤掉 crawl=true（登录态社媒站归 crawl 分段），末附 categories 词表。 */
export function renderWebCatalog(res) {
    const lines = ["【设备外综合 · Wigolo 站点目录（只读）】"];
    for (const s of [...res.sites].sort((a, b) => b.priority - a.priority)) {
        if (!s.enabled)
            continue;
        if (s.crawl)
            continue; // crawl=true 走 mediacrawler crawl 分段，不进 wigolo web 目录
        const proxy = s.proxy ? " · 代理" : "";
        const hint = s.queryHint ? ` · ${s.queryHint}` : "";
        lines.push(`- ${s.name}｜${s.domain}｜${s.category}｜优先级 ${s.priority}${proxy}${hint}：${s.description}`);
    }
    if (res.categories.length)
        lines.push(`【类别】${[...new Set(res.categories)].join(", ")}`);
    return lines.join("\n");
}
/** 渲染 crawl 目录：滤 disabled，仅 NAME+DESCRIPTION+固定引导（不出现 DOMAIN/PRIORITY，登录态社媒站用不上）。 */
export function renderCrawlCatalog(res) {
    const lines = [
        "【登录态社媒 · MediaCrawler 平台目录（只读）】",
        "以下平台需登录态、经 MediaCrawler 抓取（非 Wigolo）；用 deep_search_crawl 传入 platform id 调用。仅列平台与用途，无 DOMAIN/PRIORITY（调用用不上）。",
    ];
    for (const p of res.platforms) {
        if (!p.enabled)
            continue;
        const desc = p.description ? `：${p.description}` : "";
        lines.push(`- ${p.name}（platform id: ${p.id}）${desc}`);
    }
    return lines.join("\n");
}
/** fallback：用 STATIC_* 渲染并标静态快照。 */
export function webCatalogFallback() {
    const categories = [...new Set(STATIC_WEB_SITES.map((s) => s.category))];
    return renderWebCatalog({ sites: STATIC_WEB_SITES.map((s) => ({ ...s })), categories }) + "\n（Console 暂不可达；以上为插件内置静态快照，恢复后以 Console 为准）";
}
export function crawlCatalogFallback() {
    return renderCrawlCatalog({ platforms: STATIC_CRAWL_PLATFORMS.map((p) => ({ ...p })) }) + "\n（Console 暂不可达；以上为插件内置静态快照，恢复后以 Console 为准）";
}
/** query route → 唯一入口工具与目录类别。 */
export const GUIDE_ROUTES = {
    local: { tool: "deep_search", catalog: "device" },
    web: { tool: "deep_search_web", catalog: "web" },
    social: { tool: "deep_search_crawl", catalog: "crawl" },
};
export function resolveGuideRoute(value) {
    if (typeof value !== "string" || !(value in GUIDE_ROUTES))
        throw new Error(`invalid guide route: ${String(value)}`);
    return GUIDE_ROUTES[value];
}
/** 按 `^## ${tool}$` 切 tools-guide 完整小节；无则 undefined（不虚构）。 */
export function extractToolGuide(text, toolName) {
    if (!text)
        return undefined;
    const body = parseSourceRouting(text).get(toolName)?.trim();
    return body ? `## ${toolName}\n\n${body}` : undefined;
}
/**
 * 按**数据源**提取 deep_search_next 的导航指引小节（`## deep_search_next:<source>`）。
 * 与通用 `## deep_search_next`（调用方法，deep_search 后引导时注入）分层：
 *   - 通用段：讲 id/direction 必填等跨来源共性，由 withNextGuidance 在前置检索后注入；
 *   - 来源段：讲该源可用方向/参数（ov_context 有 tree/list/glob/grep+pattern，wiki 只有 up/across/back/global），
 *     由 deep_search_next execute 在**调用时**按 id 前缀的 source 提取并随结果返回——此刻 source 已确定。
 * 找不到对应来源段则返回 undefined（不虚构；mem0/ov_session 等扁平源可不设段）。
 */
export function extractNextSourceGuide(text, source) {
    if (!text || !source)
        return undefined;
    // 数据源方向收在通用段 `## deep_search_next` 的【沿什么展开】五级子块（`##### **<source>**：`）里，
    // 不再是独立 `## deep_search_next:<source>` 段。本函数取该段，再按 source 切出对应五级子块。
    const section = parseSourceRouting(text).get("deep_search_next");
    if (!section)
        return undefined;
    const blocks = new Map();
    let current = null;
    const buf = [];
    const flush = () => { if (current) blocks.set(current, buf.join("\n").trim()); };
    for (const raw of section.split(/\r?\n/)) {
        const m = raw.match(/^#####\s+\*\*(.+?)\*\*[：:]/); // 形如 `##### **ov_context**：`
        if (m) { flush(); current = m[1].trim(); buf.length = 0; }
        else if (current && /^###\s/.test(raw)) { flush(); current = null; } // 三级小节（展开后怎么走等）结束五级块
        else if (current) { buf.push(raw); }
    }
    flush();
    const body = blocks.get(source);
    return body ? `##### **${source}**\n\n${body}` : undefined;
}
const NEXT_TOOL_ORDER = [
    "deep_search_next", "deep_search_read", "deep_search_status", "deep_search_sync",
    "deep_search_step", "deep_search_reflect", "deep_search_report",
];
/** 解析工具结果为对象（字符串/对象；数组与非对象返回 undefined）。 */
export function resultObject(value) {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return undefined;
        }
    }
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** 只依据真实上游结果信号选择后续工具；未知/失败输出不猜。 */
export function selectNextTools(currentTool, result) {
    const value = resultObject(result);
    if (!value)
        return [];
    const selected = new Set();
    if (currentTool === "deep_search") {
        const results = Array.isArray(value.results) ? value.results : [];
        const sources = Array.isArray(value.sources) ? value.sources : [];
        if (results.some((r) => r?.next?.available === true))
            selected.add("deep_search_next");
        if (results.some((r) => r?.source === "ov_session" || r?.source === "wiki" || String(r?.source || "").startsWith("wiki:")))
            selected.add("deep_search_read");
        if (sources.some((s) => ["unavailable", "timed_out", "degraded"].includes(s?.status)))
            selected.add("deep_search_status");
    }
    else if (currentTool === "deep_search_status") {
        if (Array.isArray(value.sources) && value.sources.some((s) => s?.status === "stale"))
            selected.add("deep_search_sync");
    }
    else if (currentTool === "deep_search_web") {
        if (value.ok === false || !("next_pending_claim" in value))
            return [];
        selected.add(value.next_pending_claim ? "deep_search_step" : "deep_search_report");
    }
    else if (currentTool === "deep_search_step") {
        if (value.ok === false || "stop_reason" in value || !("evidence_added" in value))
            return [];
        selected.add("deep_search_reflect");
    }
    else if (currentTool === "deep_search_reflect") {
        if (value.ok === false || typeof value.should_stop !== "boolean")
            return [];
        selected.add(value.should_stop ? "deep_search_report" : "deep_search_step");
    }
    return NEXT_TOOL_ORDER.filter((name) => selected.has(name));
}
export function renderNextToolGuidance(toolsGuide, toolNames, sources) {
    return toolNames.map((name) => {
        const section = extractToolGuide(toolsGuide, name);
        if (!section)
            throw new Error(`missing tools-guide section: ${name}`);
        if (name === "deep_search_next" && Array.isArray(sources))
            return cropNextSourceBlocks(section, sources);
        return section;
    }).join("\n\n");
}
/** 从 deep_search_next 小节裁掉本轮没有可展开结果的来源块，避免把未命中源的方向/参数一起呈现。 */
function cropNextSourceBlocks(section, sources) {
    const wanted = new Set(sources.map(normalizeRoutingSource));
    const lines = [];
    let current = null;
    let keepCurrent = false;
    for (const raw of section.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, "");
        const block = line.match(/^#####\s+\*\*(.+?)\*\*\s*[：:]?\s*$/);
        if (block) {
            if (keepCurrent)
                lines.push("");
            current = block[1].trim();
            keepCurrent = wanted.has(current);
            if (keepCurrent)
                lines.push(line);
            continue;
        }
        if (current === null) {
            lines.push(line);
        }
        else if (keepCurrent) {
            lines.push(line);
        }
    }
    return lines.join("\n").trim();
}
