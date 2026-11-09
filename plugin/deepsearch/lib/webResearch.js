/**
 * 「网络检索」5 工具（deep_search_web / step / reflect / report / crawl）。
 *
 * 甲+：检索编排的 Python 状态机（state/transition/evidence/gateway）原样内化在
 * web-research/scripts/，本文件只做薄封装——execFile 调插件自带 cli.py，绝不本地重造状态机。
 * 唯一例外 deep_search_crawl：直调 MediaCrawler，绕过 gateway/claim 单发抓取。
 *
 * 运行时配置（插件根 deepsearch.config.json / env 覆盖）：
 *   gatewayUrl / gatewayTokenFile / crawlWorkspace / mediacrawlerRoot / python
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { resolveWorkspace } from "./workspace.js";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// webResearch.js 在 <插件根>/lib/ 下，插件根 = lib 上一级（cli.py 在 <插件根>/web-research/scripts/）。
// 旧值 ../.. 多跳一级跑到插件根外，CLI_PATH 指向不存在路径（单测 mock execFile 未暴露）。
const PLUGIN_ROOT = join(MODULE_DIR, "..");
const CLI_PATH = join(PLUGIN_ROOT, "web-research", "scripts", "cli.py");
/** 读 token 文件（token 不入 config/patch 明文）。相对路径按插件根解析，不依赖 Node 进程 CWD。 */
function readTokenFile(path) {
    if (!path)
        return "";
    const expanded = path.replace(/^~/, process.env.HOME ?? "");
    const abs = expanded.startsWith("/") ? expanded : join(PLUGIN_ROOT, expanded);
    try {
        return readFileSync(abs, "utf8").trim();
    }
    catch {
        return "";
    }
}
/**
 * 组装子进程 env（gateway/state/crawl workspace/mediacrawler）。
 *
 * 写入路径跟随当前 DSH 对话工作区（用户定，2026-11-09）：
 *   - DEEPSEARCH_CRAWL_WORKSPACE = 工作区根 → sink.py 落盘 <工作区>/Crawler Result/.tmp/...
 *   - DEEPSEARCH_STATE_DIR       = 工作区/Crawler Result/.deepsearch-state → cli.py run state
 *   工作区由 webExecute 经 resolveWorkspace 解析后传入（跟随对话，兜底 MediaCrawler/data），
 *   不再从 config.crawlWorkspace 读（那等于另造一个工作区目录，与用户要求相悖）。
 *   读取路径（mediacrawlerRoot/tokenFile）不受沙盒限，照旧走系统目录。
 */
export function childEnv(cfg, workspace) {
    const env = { ...process.env };
    if (cfg.gatewayUrl)
        env.GATEWAY_URL = cfg.gatewayUrl;
    const token = readTokenFile(cfg.gatewayTokenFile);
    if (token)
        env.GATEWAY_TOKEN = token;
    if (cfg.gatewayTokenFile)
        env.DEEPSEARCH_GATEWAY_TOKEN_FILE = cfg.gatewayTokenFile;
    if (workspace) {
        env.DEEPSEARCH_CRAWL_WORKSPACE = workspace;
        env.DEEPSEARCH_STATE_DIR = join(workspace, "Crawler Result", ".deepsearch-state");
    }
    if (cfg.mediacrawlerRoot)
        env.MEDIACRAWLER_ROOT = cfg.mediacrawlerRoot;
    return env;
}
/** 调 cli.py 子命令，返回 stdout（JSON 字符串；渲染端原样透出）。workspace=已解析的当前工作区。 */
export function runCli(cfg, sub, args, workspace) {
    const python = cfg.python || "python3";
    return new Promise((resolve, reject) => {
            execFile(python, [CLI_PATH, sub, JSON.stringify(args)], {
            env: childEnv(cfg, workspace),
            cwd: PLUGIN_ROOT,
            timeout: 660_000,
            maxBuffer: 64 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err) {
                const tail = String(stderr || "").split("\n").filter(Boolean).slice(-3).join("\n");
                reject(new Error(`web-research cli ${sub} failed: ${err.message}${tail ? `\n${tail}` : ""}`));
                return;
            }
            // cli.py 以 json.dumps 输出，parse 成对象交给工具层（host 校验工具返回须为 object）。
            // 6 个 web 工具全经 runCli，在此统一转对象，避免每工具各包一层。
            const txt = String(stdout).trim();
            try {
                resolve(JSON.parse(txt));
            } catch {
                resolve({ ok: false, raw: txt, error: "cli returned non-JSON" }); // 异常不吞，恒返对象
            }
            });
        });
}
/**
 * 解析当前工作区（resolveWorkspace 内建兜底：工作区 → MediaCrawler/data，不抛）。
 * 保留此函数名以兼容既有诊断调用。
 */
export function resolveWorkspaceSafe() {
    return resolveWorkspace();
}
/**
 * 检测拉起：工具调用前查 plugin-service-manager，断开的服务组自动 start。
 * sub→组映射：web/step/reflect/report/fanout 走 n8n gateway(→wigolo)=websearch+n8n；crawl 直调 MediaCrawler=websearch。
 * service-manager 不可达不抛（fire-and-forget）——真断时 cli.py 会报真实后端错误，这里只尽力拉起。
 * fetchImpl 注入便于测试；生产用全局 fetch。service-manager 宿主 3080 固定、回环无鉴权，URL 写死常量。
 */
const SERVICE_MANAGER_BASE = "http://127.0.0.1:3080";
const SUB_GROUPS = {
    web: ["websearch", "n8n"],
    step: ["websearch", "n8n"],
    reflect: ["websearch", "n8n"],
    report: ["websearch", "n8n"],
    fanout: ["websearch", "n8n"],
    crawl: ["websearch"],
};

export async function ensureServices(sub, fetchImpl = globalThis.fetch) {
    const groups = SUB_GROUPS[sub] || ["websearch", "n8n"];
    const result = { checked: groups, started: [], failed: [] };
    let runningIds = [];
    try {
        const res = await fetchImpl(`${SERVICE_MANAGER_BASE}/tdai-svc/status`);
        const data = await res.json();
        runningIds = (data.services || []).filter((s) => s.running).map((s) => s.id);
    } catch (e) {
        result.failed.push(`status: ${e?.message || e}`);
        return result; // 查不到状态就不盲目拉起，交由 cli.py 报真实错误
    }
    const groupSvcs = { websearch: ["wigolo-direct", "wigolo-restricted", "mediacrawler"], n8n: ["n8n-server"] };
    for (const gid of groups) {
        const need = (groupSvcs[gid] || []).filter((id) => !runningIds.includes(id));
        if (need.length === 0) continue; // 组内全 running，跳过
        try {
            await fetchImpl(`${SERVICE_MANAGER_BASE}/tdai-svc/control`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "start", groupId: gid }),
            });
            result.started.push(gid);
        } catch (e) {
            result.failed.push(`${gid}: ${e?.message || e}`);
        }
    }
    return result;
}

/**
 * 5 工具的 execute（由 tools.ts 用 tool() helper 包装注册）。
 * 每次调用解析当前工作区（跟随 DSH 对话，兜底 MediaCrawler/data），传给 runCli 注入子进程 env。
 * 绝不静默回退到插件根（老 bug 已根治——兜底是 MediaCrawler/data，非插件根）。
 * 调用前 ensureServices 检测拉起后端（wigolo/mediacrawler/n8n 断开自动 start，不阻塞工具调用）。
 */
export function webExecute(cfg, sub) {
    return async (a) => {
        await ensureServices(sub).catch(() => {}); // 拉起尽力而为，不阻塞
        const workspace = resolveWorkspace();
        return runCli(cfg, sub, a, workspace);
    };
}
