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
import { ApiClient } from "./api/client.js";
import { loadConfigFile, routes } from "./api/routes.js";
import { buildTools } from "./tools.js";
import { loadAndValidate } from "./prompts/loader.js";
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
// ── agent/pre-step 记忆召回（联动 Console；召回逻辑全在 Console 侧 evokeRecall，插件薄转发）──
/** 取 decision.messages 最后一条真实 user 消息的纯文本（照 tdai getLastUserText 语义）。 */
function lastUserText(messages) {
    if (!Array.isArray(messages))
        return "";
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.source?.kind !== "user")
            continue;
        const c = m.content;
        if (typeof c === "string")
            return c;
        if (Array.isArray(c)) {
            return c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
        }
    }
    return "";
}
/**
 * 挂载 agent/pre-step 钩子：每轮取最后一条 user 文本 → 转发 Console /api/evoke/recall →
 * 命中且非空则构造独立 snapshot user 消息，插到最后一条 user 消息之前。
 *
 * 插入契约（照 tdai v0.3.1 已验证形态）：独立 id + 独立 source(plugin=form:snapshot)，绝不复制用户消息字段
 * （复制 id/rpcId 会导致 host 把胶囊与真实用户消息合并渲染、用户正文被覆盖丢失）。Console 不可达/未命中/异常
 * 一律原样放行 decision，绝不阻断对话。
 */
function mountEvokePrestep(ctx, client) {
    if (typeof ctx.on !== "function")
        return;
    ctx.on("agent/pre-step", async (payload, next) => {
        let decision;
        try {
            decision = await next();
        }
        catch {
            return undefined;
        }
        try {
            if (!decision || decision.kind !== "enter" || payload?.signal?.aborted)
                return decision;
            if (!Array.isArray(decision.messages) || decision.messages.length === 0)
                return decision;
            if (decision.agent?.session?.header?.origin === "subagent")
                return decision;
            const text = lastUserText(decision.messages);
            if (!text.trim())
                return decision;
            // 薄转发 Console 召回（召回/判定/准入/渲染全在 Console 侧 evokeRecall，插件不重造）
            const base = client.base;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), client.timeout ?? 8000);
            let r;
            try {
                const resp = await fetch(routes.evokeRecall(base), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                    signal: ctrl.signal,
                });
                r = await resp.json().catch(() => null);
            }
            finally {
                clearTimeout(t);
            }
            const block = r?.hit ? String(r.block || "") : "";
            if (!r?.ok || !block.trim())
                return decision;
            // 全新构造独立消息，插到最后一条 user 之前（对齐 meow createUserMessage 形态）
            const lastUser = [...decision.messages].reverse().find((m) => m?.source?.kind === "user");
            if (lastUser === undefined)
                return decision;
            const evokeMsg = {
                id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
                role: "user",
                content: [{ type: "text", text: block }],
                source: {
                    kind: "deep-search",
                    plugin: "deep-search",
                    form: "snapshot",
                    sections: [{ name: "__meta__", text: JSON.stringify({ kind: "hit", mode: r.mode, query: r.query }) }],
                },
            };
            const rewritten = [...decision.messages];
            rewritten.splice(rewritten.indexOf(lastUser), 0, evokeMsg);
            ctx.logger?.info?.(`deep-search: evoke mode=${r.mode} query=${JSON.stringify(r.query)} capsule=${block.length}chars injected`);
            return { ...decision, messages: rewritten };
        }
        catch (e) {
            ctx.logger?.warn?.(`deep-search: pre-step evoke 失败（不阻断）: ${e?.message ?? String(e)}`);
            return decision;
        }
    });
    ctx.logger?.info?.("deep-search: agent/pre-step 记忆召回钩子已挂载（Console 侧 evokeRecall）");
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
    // 12 工具（5 记忆 + 6 网络检索 + 1 route 引导）；guideTexts 附带 __toolsGuide 供被动呈现方法小节、__resultDecision 供执行结果后决策胶囊
    const webConfig = loadConfigFile() ?? {};
    const guideTexts = { ...prompts.tools, __toolsGuide: prompts.toolsGuide, __resultDecision: prompts.resultDecision };
    const tools = buildTools(client, guideTexts, prompts.sourceRouting, prompts.webRouting, webConfig);
    for (const t of tools) {
        ctx.tools.register(t);
    }
    ctx.logger?.info?.("deep-search: 5 记忆 + 6 网络检索 + deep_search_guide（三 route 被动引导）registered");
    // 检索导引挂载（§ 9.7）：system-guide.md 只做 query→route。
    // deep_search_guide 返回入口方法，目录随后由 deferred context 被动呈现。
    mountGuide(ctx, prompts.systemGuide);
    // agent/pre-step 记忆召回钩子（联动 Console evokeRecall）：Console 不可达/未命中时静默放行，不影响工具
    mountEvokePrestep(ctx, client);
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
