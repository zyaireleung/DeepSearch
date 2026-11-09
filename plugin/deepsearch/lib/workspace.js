/**
 * 解析「当前 DSH 对话工作区」——供 crawl 落盘/state 跟随对话工作区。
 *
 * 解析链（优先级从高到低）：
 *   1. override（显式传入，仅内部/测试用；config 不再暴露 crawlWorkspace 字段）。
 *   2. DSH_SESSION_ID → ~/.dsh/storages/workspace.json 里查所属 workspace 的 path。
 *   3. 兜底：/Users/zyaire/MediaCrawler/data（MediaCrawler 原生输出目录，读取不受沙盒限）。
 *
 * 设计铁律（用户定，2026-11-09）：
 *   - 写入目录优先落在当前对话工作区内，绝不写插件根。
 *     老实现 sink.py 兜底 os.getcwd()（DSH web 宿主 cwd=/），会把数据写到工作区外/插件根——已根治。
 *   - 解析不到工作区 → 兜底 MediaCrawler/data，不再抛错、绝不静默写插件根。
 *
 * 读取不受沙盒限；此处只读 workspace.json（DSH 内部注册表），不写。
 */
import { readFileSync } from "node:fs";

/** 兜底落盘根：MediaCrawler 原生 data 目录（非"另造的 crawlWorkspace"，是其自带输出地）。 */
export const FALLBACK_WORKSPACE = "/Users/zyaire/MediaCrawler/data";

/** workspace.json 默认位置：$DSH_HOME/storages/workspace.json（DSH_HOME 缺省 ~/.dsh）。 */
function defaultRegistryFile() {
    const dshHome = process.env.DSH_HOME || joinPath(process.env.HOME || "", ".dsh");
    return joinPath(dshHome, "storages", "workspace.json");
}

function joinPath(...parts) {
    return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/**
 * 解析当前对话工作区路径。
 * @param {object} opts
 * @param {string} [opts.sessionId]   - DSH 会话 id；缺省读 process.env.DSH_SESSION_ID。
 * @param {string} [opts.registryFile]- workspace.json 路径；缺省按 DSH_HOME 解析（测试注入）。
 * @param {string} [opts.override]    - 显式覆盖；非空时直接返回。
 * @returns {string} 工作区绝对路径（解析不到→FALLBACK_WORKSPACE，不抛）。
 */
export function resolveWorkspace(opts = {}) {
    const override = opts.override?.trim();
    if (override)
        return override.replace(/\/+$/, "") || override;

    const sessionId = opts.sessionId ?? process.env.DSH_SESSION_ID ?? "";
    const registryFile = opts.registryFile ?? defaultRegistryFile();

    let workspaces;
    try {
        const raw = readFileSync(registryFile, "utf8");
        workspaces = JSON.parse(raw)?.tables?.workspaces;
    }
    catch {
        return FALLBACK_WORKSPACE; // registry 读不到 → 兜底，不抛
    }
    if (!workspaces || typeof workspaces !== "object")
        return FALLBACK_WORKSPACE;

    if (sessionId) {
        for (const w of Object.values(workspaces)) {
            if (Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId) && w.path)
                return String(w.path).replace(/\/+$/, "");
        }
    }

    return FALLBACK_WORKSPACE; // session 未归属任何 workspace → 兜底
}
