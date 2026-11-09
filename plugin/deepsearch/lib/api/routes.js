/**
 * Console API 路由（①.8 骨架，方案 § 三 三类接口 + § 十七）
 *
 * 端点：GET /search · GET /next · GET /status · POST /sync · GET /sync/:jobId
 * Console 端点可配置：DEEP_SEARCH_CONSOLE_URL（env 覆盖，默认 http://127.0.0.1:6600）。
 * 沙盒镜像时同一插件 build 指向沙盒 Console（如 6601），绝不指向生产 6600。
 *
 * 生产/沙盒显式模式（用户拍板，2026-10-30）：
 *  - 默认 sandbox：拒绝生产 Console :6600（保护开发误配，绝不静默打生产）。
 *  - 显式 production（DEEP_SEARCH_ENV=production 或 插件根 deepsearch.config.json 的 mode=production）：放行 :6600。
 *  - 生产插件必须携带 deepsearch.config.json { "mode": "production" }，否则 guard 在工具调用时返回 GUARD_REJECTED。
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const DEFAULT_CONSOLE_URL = "http://127.0.0.1:6600";
/** 模块所在目录（src/api 或 lib/api）；插件根 = ../../。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件根配置文件路径（src 与 lib 同构：均位于 api/ 下，../../ 即插件根）。 */
export function defaultConfigPath() {
    return join(MODULE_DIR, "..", "..", "deepsearch.config.json");
}
/** 读取插件根 deepsearch.config.json（不存在/畸形 → undefined，绝不抛）。 */
export function loadConfigFile(configPath) {
    const p = configPath ?? defaultConfigPath();
    try {
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 解析显式模式：env DEEP_SEARCH_ENV 优先 → config.mode → 默认 sandbox。
 * 只认 production/prod 为生产，其余一律 sandbox（默认安全）。
 */
export function resolveMode(env = process.env, cfg) {
    const v = String(env.DEEP_SEARCH_ENV || cfg?.mode || "").trim().toLowerCase();
    return v === "production" || v === "prod" ? "production" : "sandbox";
}
/** 解析 Console 基址（env DEEP_SEARCH_CONSOLE_URL → config.consoleUrl → 默认 6600）。 */
export function consoleBaseUrl(env = process.env, cfg) {
    const u = env.DEEP_SEARCH_CONSOLE_URL || cfg?.consoleUrl || DEFAULT_CONSOLE_URL;
    return u.replace(/\/+$/, "");
}
export const routes = {
    search: (base) => `${base}/search`,
    next: (base) => `${base}/next`,
    read: (base) => `${base}/read`,
    status: (base) => `${base}/status`,
    sync: (base) => `${base}/sync`,
    syncJob: (base, jobId) => `${base}/sync/${encodeURIComponent(jobId)}`,
    sourceCatalog: (base) => `${base}/source-catalog`,
    /** deep_search_guide 三类动态目录：设备外综合（Wigolo 站点）/ 社媒单发（MediaCrawler 平台）。 */
    webCatalog: (base) => `${base}/web-catalog`,
    crawlCatalog: (base) => `${base}/crawl-catalog`,
    /** agent/pre-step 记忆召回：Console 侧唯一实现（evokeRecall），插件薄转发，绝不本地重造判定/检索。 */
    evokeRecall: (base) => `${base}/api/evoke/recall`,
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/**
 * 端口保护（生产/沙盒显式模式）：
 *  - 非生产 Console 目标（非 loopback:6600）一律放行。
 *  - loopback:6600 且 mode!==production → 抛（禁止沙盒/开发静默打生产）。
 *  - loopback:6600 且 mode=production → 放行（生产部署，插件根必须带 deepsearch.config.json mode=production）。
 */
export function assertConsoleTarget(url, mode = "sandbox", prodPort = "6600") {
    const target = new URL(url);
    const isProd = target.port === prodPort && LOOPBACK.has(target.hostname);
    if (!isProd)
        return;
    if (mode !== "production") {
        throw new Error(`[routes] 拒绝指向生产 Console :${prodPort}（当前模式=${mode}；需 DEEP_SEARCH_ENV=production 或 插件根 deepsearch.config.json 的 mode=production 才允许）`);
    }
}
/** 兼容别名：默认 sandbox 语义（沙盒镜像拒生产 6600）。 */
export function assertNotProduction(url, prodPort = "6600") {
    assertConsoleTarget(url, "sandbox", prodPort);
}
