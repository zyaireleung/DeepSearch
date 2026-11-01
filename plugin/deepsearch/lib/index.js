/**
 * 插件入口（⑦.5，方案 § 九 工具设计 + § 9.7 导引挂载 + § 9.8 侧边栏卡片）
 *
 * 适配层职责：注册 4 工具（转发 Console）+ 检索导引挂载（systemPrompt.section）+ 侧边栏只读卡片。
 * host 绝不写总表（V22）、绝不自行同步（Console 不可用 → coordinator_down，不越权）。
 *
 * 真实 DSH 契约（2026-10-30 由 host-runner/guard + meow-memory 生产范例核实）：
 *   - ctx.tools.register(tool) 注册工具（tool = { name, description, parameters, output, execute }）。
 *   - ctx.get?.("systemPrompt")?.section({ name, order, text }) 挂载 system-prompt 导引区块（meow 模式）。
 *   - ctx.logger.info/warn 日志；ctx.on/once/provide/effect 生命周期（本插件不额外使用）。
 * 不存在 ctx.registerTool / ctx.registerPanel / ctx.onSessionInit —— 旧假接口已移除。
 */
import { ApiClient, ApiClientError } from "./api/client.js";
import { loadConfigFile } from "./api/routes.js";
import { buildTools } from "./tools.js";
import { loadAndValidate } from "./prompts/loader.js";
import { renderSourceCatalog, sourceCatalogFallback } from "./guidance.js";
import { fileURLToPath } from "node:url";
const PROMPTS_DIR = fileURLToPath(new URL("../prompts", import.meta.url));
/** 导引挂载（meow-memory 模式）：systemPrompt.section 一次；服务未就绪时有限重试，失败不影响工具。 */
function mountGuide(ctx, systemGuide, attempts = 20) {
    const svc = ctx.get?.("systemPrompt");
    if (svc && typeof svc.section === "function") {
        svc.section({ name: "deep-search:guide", order: 130, text: systemGuide });
        ctx.logger?.info?.("deep-search: guide section registered into system prompt");
        return;
    }
    if (attempts > 0) {
        setTimeout(() => mountGuide(ctx, systemGuide, attempts - 1), 1000);
        return;
    }
    ctx.logger?.warn?.("deep-search: systemPrompt 服务 20s 内未就绪，导引未挂载（工具不受影响）");
}
/**
 * cordis 插件依赖声明：等待 `tools` 服务就绪后才执行 apply。
 *
 * 根因（V49 修复）：deep-search 此前不导出 inject，cordis 在 Promise.all 并行加载下
 * 于 dsh-tools（自身 inject:["systemPrompt"]）provide `tools` 之前就调用 apply，
 * `ctx.tools` 属性访问抛 `cannot get property "tools" without inject`，被 apply
 * try/catch 吞掉 → 工具永不注册，只能靠 deepsearch_register_probe 手动注册。
 * 与 dsh-tool-todo/goal/web/fs 一致：工具插件必须声明 inject:["tools"]。
 */
export const inject = ["tools"];
export async function register(ctx) {
    // 生产/沙盒显式模式：读插件根 deepsearch.config.json（生产部署携带 { mode:"production" }）。
    // guard 拒绝不抛于 register（DSH 启动红线），工具调用返回 GUARD_REJECTED。
    const client = new ApiClient({ config: loadConfigFile() });
    if (client.guardRejected) {
        ctx.logger?.warn?.(`deep-search: ${client.guardRejected}（工具调用将返回 GUARD_REJECTED，绝不指向生产）`);
    }
    const prompts = loadAndValidate({ baseDir: PROMPTS_DIR, lang: "zh" });
    // 5 工具（真实契约：ctx.tools.register(tool)）；deep_search 结果按命中来源附 source-routing 路线指引
    const tools = buildTools(client, prompts.tools, prompts.sourceRouting);
    for (const t of tools) {
        ctx.tools.register(t);
    }
    ctx.logger?.info?.("deep-search: deep_search / deep_search_next / deep_search_read / deep_search_status / deep_search_sync registered");
    // 检索导引挂载（§ 9.7）：目录块（动态）+ system-guide.md（静态模板）拼进 system prompt。
    // Console 不可达时只挂回退语，绝不猜测具体 Wiki 资产范围（V37）。
    let catalogBlock;
    try {
        catalogBlock = renderSourceCatalog(await client.sourceCatalog());
    }
    catch (e) {
        catalogBlock = e instanceof ApiClientError ? sourceCatalogFallback() : sourceCatalogFallback();
    }
    const systemGuide = `${catalogBlock}\n\n${prompts.systemGuide}`;
    mountGuide(ctx, systemGuide);
}
/** cordis 插件名：patch 条目 id/name 引用包名，Node 解析到 lib/index.js。 */
export const name = "deep-search";
/**
 * DSH bundle 真实契约入口（cordis 插件 apply）。
 *
 * 与 register 等价，但绝不抛错（DSH 启动红线）：apply 失败只记日志、插件置为 inactive，
 * 不会向上传播导致 DSH 启动失败。工具可能部分注册（降级而非崩溃）。
 */
export async function apply(ctx, config) {
    try {
        await register(ctx);
    }
    catch (e) {
        ctx.logger?.warn?.(`deep-search: apply 失败（工具可能未全部注册，不影响 DSH 启动）: ${e?.message ?? String(e)}`);
    }
}
