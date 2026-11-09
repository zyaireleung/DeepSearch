/**
 * 5 工具（⑦.5，方案 § 9.1/9.2/9.3/9.5）：deep_search / deep_search_next / deep_search_read / deep_search_status / deep_search_sync。
 *
 * 均为薄封装：参数校验（互斥/必填）→ ApiClient 转发 Console → 返回。host 不重造检索/同步逻辑。
 *
 * 真实 DSH 工具契约（2026-10-30 由 host-runner/guard + meow-memory 生产范例核实）：
 *   - 注册走 ctx.tools.register(tool)，tool 形状 = { name, description, parameters, output, execute }。
 *   - parameters 为 JSON-Schema 风格：{ type:'object', additionalProperties:false, required:[…], properties:{…} }，
 *     每个 property 带 type / description（文案来自 tools.md）/ enum / default / items。
 *   - output 必须 { schema, render(args,value): ContentBlock[] }；render 返回 [{type:'text',text}]。
 *   - execute(args, exec) 返回 output.schema 声明的 value。
 * 文案（description/param.*）全部取自 prompts/zh/tools.md（经 loader 校验的 SlotMap），不再硬编码。
 */
import { ApiClientError } from "./api/client.js";
import { renderSourceRouting, renderReadGuide, resolveGuideRoute, extractToolGuide, selectNextTools, renderNextToolGuidance, validateSourceCatalog, validateWebCatalog, validateCrawlCatalog, renderSourceCatalog, renderWebCatalog, renderCrawlCatalog, sourceCatalogFallback, webCatalogFallback, crawlCatalogFallback } from "./guidance.js";
import { runCli } from "./webResearch.js";
import { randomUUID } from "node:crypto";
const CONFLICT = { code: "PARAM_CONFLICT", message: "method 与 sources/precision 互斥", hint: "`method` 与 `sources`/`precision` 互斥，二选一" };
/** Task 6：仅 fuzzy 模板允许覆盖 sources；非 fuzzy 带 sources/precision → 拒绝（Agent 不得组合任意矩阵） */
const FUZZY_METHODS = new Set(["fuzzy_mem0_find", "fuzzy_mem0_search", "fuzzy_full"]);
/** § 9.1 deep_search：S1/S2/S3 由 carry 决定番号；校验 method 与 sources/precision 互斥（§ 9.3）。
 *  sourceRoutingText：source-routing.md 全文（host 加载）；非空时按本轮实际命中来源裁剪为 page.routing。
 */
export async function deepSearch(client, args, sourceRoutingText) {
    if (!args.query || typeof args.query !== "string" || !args.query.trim()) {
        throw new ApiClientError("INVALID_REQUEST", "query 必填", "请提供检索词 query");
    }
    if (args.method && !FUZZY_METHODS.has(String(args.method)) && (args.sources || args.precision))
        throw new ApiClientError(CONFLICT.code, CONFLICT.message, CONFLICT.hint);
    const res = await client.search({
        query: args.query,
        sources: args.sources,
        precision: args.precision || "auto",
        sessionId: args.sessionId,
        includeSearch: args.includeSearch,
        method: args.method,
        carry: args.carry,
        visited: args.visited,
        explain: args.explain,
        anchors: args.anchors,
    });
    const page = res.page;
    if (!sourceRoutingText)
        return page;
    // 本轮实际命中的来源类别（results[].source 去重；ov_context_find/search 归一化在 render 内做）
    const hitSources = [...new Set(page.results.map((r) => r.source))];
    return { ...page, routing: renderSourceRouting(sourceRoutingText, hitSources) };
}
/** § 9.2 deep_search_next：方向导航（与携带轴正交）；id 必填 */
export async function deepSearchNext(client, args) {
    if (!args.id || typeof args.id !== "string")
        throw new ApiClientError("INVALID_REQUEST", "id 必填", "提供当前结果 id 再导航");
    if (!args.direction)
        throw new ApiClientError("INVALID_REQUEST", "direction 必填", "提供 direction（up/across/back/global/root/auto）");
    const res = await client.next({
        id: args.id,
        direction: args.direction,
        step: args.step,
        method: args.method,
        visited: args.visited,
        origin: args.origin,
        query: args.query,
        params: args.params,
        inline: args.inline,
        limit: args.limit,
    });
    return res.next;
}
/** § 9.2+ deep_search_read：读取已返回结果全文（ov_session/wiki 闭环截断；mem0/ov_context 诚实说明）。id 必填。
 *  sourceRoutingText：非空时附 read 后兜底提示（脱离前置检索直接调用场景），不重复整套 routing。
 */
export async function deepSearchRead(client, args, sourceRoutingText) {
    if (!args.id || typeof args.id !== "string")
        throw new ApiClientError("INVALID_REQUEST", "id 必填", "提供当前结果 id 再读取全文");
    const res = await client.read({ source: args.source, id: args.id });
    const guide = sourceRoutingText ? renderReadGuide(sourceRoutingText) : undefined;
    return guide ? { ...res.read, guide } : res.read;
}
/** § 9.5 deep_search_status：只读 Console /status（host 不本地统计） */
export async function deepSearchStatus(client) {
    const res = await client.status();
    return res.status;
}
/** § 9.5 deep_search_sync：受控任务；dryRun 默认 true（先量化后决策），真实写必须显式 false */
export async function deepSearchSync(client, args) {
    const res = await client.sync({
        dryRun: args.dryRun !== false, // 默认 true
        rebuild: args.rebuild === true,
        target: args.target || "all",
    });
    return res;
}
/**
 * JSON-Schema 风格 property（meow-memory 生产范例同构）。
 * type 为 string|number|integer|boolean|array|object；extra 携带 enum/items/default。
 */
function prop(type, description, extra = {}) {
    return { type, description, ...extra };
}
/** 工具输出 schema + render（宽松 object：检索返回值是动态 page/next/status/result）。 */
function outputOf(label) {
    return {
        schema: { type: "object", additionalProperties: true, properties: {} },
        render: (_args, value) => [
            { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
        ],
    };
}
function deferredSnapshot(text, name, meta) {
    return {
        id: `m-deep-search-${randomUUID()}`,
        role: "user",
        content: [{ type: "text", text }],
        source: {
            kind: "deep-search",
            plugin: "deep-search",
            form: "snapshot",
            sections: [{ name, text: JSON.stringify(meta) }],
        },
    };
}
function withNextGuidance(currentTool, toolsGuide, execute, resultDecisionText) {
    return async (a, exec) => {
        const result = await execute(a, exec);
        // 决策胶囊无条件先发（在 next 为空的提前 return 之前）——"结果为空/narrowed 仍不足"恰是最需决策的时刻
        if (resultDecisionText && exec?.deferContext) {
            await exec.deferContext(deferredSnapshot(resultDecisionText, "result-decision", { currentTool }));
        }
        const nextTools = selectNextTools(currentTool, result);
        if (nextTools.length === 0)
            return result;
        const text = renderNextToolGuidance(toolsGuide, nextTools);
        if (!exec?.deferContext)
            throw new Error("ToolRunContext.deferContext unavailable");
        await exec.deferContext(deferredSnapshot(text, "next-method", { currentTool, nextTools }));
        return result;
    };
}
/** 组装一个注册就绪的工具对象（name/description/parameters/output/execute）。 */
function tool(name, texts, parameters, execute) {
    const descKey = `${name}.description`;
    // 顶层 required 数组从 property 的 required===true 标记生成后，必须从每个
    // property 里删掉这个非标准布尔标记：JSON Schema（DSH 子集 + OpenAI/Codex）
    // 里 required 是对象级关键字（值须为 string[]），property 内残留的
    // required:true 会触发 Codex backend "Invalid schema ... true is not of type array"。
    const requiredKeys = Object.keys(parameters).filter((k) => parameters[k].required === true);
    for (const p of Object.values(parameters))
        delete p.required;
    return {
        name,
        description: texts[descKey] ?? "",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: requiredKeys,
            properties: parameters,
        },
        output: outputOf(name),
        execute,
    };
}
/**
 * 构建工具定义（真实 DSH 契约 shape）。
 * 5 记忆工具（转发 Console）+ 6 网络检索工具（薄封装自带 web-research/scripts/cli.py）。
 * @param client ApiClient（转发 Console）
 * @param texts tools.md 文案 SlotMap（description + param.* 键；经 loader 校验）
 * @param sourceRoutingText source-routing.md 全文（deep_search 结果附加 routing 用；可缺省）
 * @param webConfig 网络检索运行时配置（gateway/crawl workspace/mediacrawler/python；可缺省→cli 默认）
 * @param webRoutingText web-routing.md 全文（deep_search_web 结果附加 routing 用；可缺省）
 */
export function buildTools(client, texts, sourceRoutingText, webRoutingText, webConfig = {}, webRunner = runCli) {
    const deepSearchTool = tool("deep_search", texts, {
        query: prop("string", texts["deep_search.param.query"], { required: true }),
        sources: prop("array", texts["deep_search.param.sources"], { items: { type: "string" } }),
        precision: prop("string", texts["deep_search.param.precision"], { enum: ["auto", "literal", "semantic"], default: "auto" }),
        sessionId: prop("string", texts["deep_search.param.sessionId"]),
        includeSearch: prop("boolean", texts["deep_search.param.includeSearch"], { default: false }),
        method: prop("string", texts["deep_search.param.method"]),
        carry: prop("array", texts["deep_search.param.carry"], { items: { type: "object" } }),
        visited: prop("array", texts["deep_search.param.visited"], { items: { type: "string" } }),
        explain: prop("boolean", texts["deep_search.param.explain"], { default: false }),
        anchors: prop("array", texts["deep_search.param.anchors"], { items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, required: { type: "boolean" } }, required: ["text", "required"] }, minItems: 1 }),
    }, withNextGuidance("deep_search", texts["__toolsGuide"], (a) => deepSearch(client, a, sourceRoutingText), texts["__resultDecision"]));
    const nextTool = tool("deep_search_next", texts, {
        id: prop("string", texts["deep_search_next.param.id"], { required: true }),
        direction: prop("string", texts["deep_search_next.param.direction"], { required: true, enum: ["up", "across", "back", "global", "root", "auto"] }),
        step: prop("string", texts["deep_search_next.param.step"], { enum: ["S1", "S2", "S3"] }),
        method: prop("string", texts["deep_search_next.param.method"]),
        visited: prop("array", texts["deep_search_next.param.visited"], { items: { type: "string" } }),
        origin: prop("string", texts["deep_search_next.param.origin"]),
        query: prop("string", texts["deep_search_next.param.query"]),
        params: prop("object", texts["deep_search_next.param.params"]),
        inline: prop("boolean", texts["deep_search_next.param.inline"], { default: false }),
        limit: prop("integer", texts["deep_search_next.param.limit"]),
    }, withNextGuidance("deep_search_next", texts["__toolsGuide"], (a) => deepSearchNext(client, a), texts["__resultDecision"]));
    const statusTool = tool("deep_search_status", texts, {}, withNextGuidance("deep_search_status", texts["__toolsGuide"], () => deepSearchStatus(client), texts["__resultDecision"]));
    const readTool = tool("deep_search_read", texts, {
        id: prop("string", texts["deep_search_read.param.id"] ?? "必填字符串；要读取全文的 deep_search 结果 id", { required: true }),
        source: prop("string", texts["deep_search_read.param.source"] ?? "可选字符串；结果源（ov_session/wiki/ov_context/mem0），缺省由 id 前缀推导", { enum: ["ov_session", "wiki", "ov_context", "mem0"] }),
    }, withNextGuidance("deep_search_read", texts["__toolsGuide"], (a) => deepSearchRead(client, a, sourceRoutingText), texts["__resultDecision"]));
    const syncTool = tool("deep_search_sync", texts, {
        dryRun: prop("boolean", texts["deep_search_sync.param.dryRun"], { default: true }),
        rebuild: prop("boolean", texts["deep_search_sync.param.rebuild"], { default: false }),
    }, (a) => deepSearchSync(client, a));
    // ── 「网络检索」6 工具（薄封装自带 web-research/scripts/cli.py，甲+ 不重写状态机）──
    // deep_search_web start：cli 返回 JSON 字符串；附加 routing（web-routing.md 全文），
    //   与 deep_search 的 source-routing 同构——指引随工具结果返回，不污染公共 system-guide。
    const webStartExecute = async (a) => {
        // runCli 已把 cli.py 的 JSON 输出 parse 成对象（见 webResearch.js runCli）
        const result = await webRunner(webConfig, "start", a);
        if (result && typeof result === "object" && !Array.isArray(result) && webRoutingText) {
            return { ...result, routing: webRoutingText };
        }
        return result;
    };
    const webTool = tool("deep_search_web", texts, {
        run_id: prop("string", texts["deep_search_web.param.run_id"], { required: true }),
        question: prop("string", texts["deep_search_web.param.question"], { required: true }),
        intent: prop("string", texts["deep_search_web.param.intent"], { enum: ["technical", "social", "code", "general"] }),
        claims: prop("array", texts["deep_search_web.param.claims"], {
            items: {
                type: "object", additionalProperties: false,
                properties: {
                    id: { type: "string" },
                    question: { type: "string" },
                    required_evidence: { type: "array", items: { type: "string", enum: ["general_web", "official_docs", "restricted_web"] } },
                    priority: { type: "string", enum: ["high", "medium", "low"] },
                    depends_on: { type: "array", items: { type: "string" } },
                },
            },
        }),
    }, withNextGuidance("deep_search_web", texts["__toolsGuide"], webStartExecute, texts["__resultDecision"]));
    const webStepTool = tool("deep_search_step", texts, {
        run_id: prop("string", texts["deep_search_step.param.run_id"], { required: true }),
    }, withNextGuidance("deep_search_step", texts["__toolsGuide"], (a) => webRunner(webConfig, "step", a), texts["__resultDecision"]));
    const webReflectTool = tool("deep_search_reflect", texts, {
        run_id: prop("string", texts["deep_search_reflect.param.run_id"], { required: true }),
        decisions: prop("array", texts["deep_search_reflect.param.decisions"], {
            required: true,
            items: {
                type: "object", additionalProperties: false,
                properties: { claim_id: { type: "string" }, verdict: { type: "string", enum: ["supported", "refuted", "uncertain"] } },
            },
        }),
        new_claims: prop("array", texts["deep_search_reflect.param.new_claims"], { items: { type: "object" } }),
    }, withNextGuidance("deep_search_reflect", texts["__toolsGuide"], (a) => webRunner(webConfig, "reflect", a), texts["__resultDecision"]));
    const webReportTool = tool("deep_search_report", texts, {
        run_id: prop("string", texts["deep_search_report.param.run_id"], { required: true }),
    }, withNextGuidance("deep_search_report", texts["__toolsGuide"], (a) => webRunner(webConfig, "report", a), texts["__resultDecision"]));
    const webCrawlTool = tool("deep_search_crawl", texts, {
        platform: prop("string", texts["deep_search_crawl.param.platform"], { required: true, enum: ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu", "douyin", "bilibili", "weibo", "kuaishou"] }),
        type: prop("string", texts["deep_search_crawl.param.type"], { required: true, enum: ["search", "detail", "creator"] }),
        creator_id: prop("string", texts["deep_search_crawl.param.creator_id"]),
        specified_id: prop("string", texts["deep_search_crawl.param.specified_id"]),
        keywords: prop("string", texts["deep_search_crawl.param.keywords"]),
    }, async (a, exec) => {
        const result = await webRunner(webConfig, "crawl", a);
        if (texts["__resultDecision"] && exec?.deferContext) {
            await exec.deferContext(deferredSnapshot(texts["__resultDecision"], "result-decision", { currentTool: "deep_search_crawl" }));
        }
        return result;
    });
    // ── deep_search_fanout：path-1 并行编排（web 多站点真并行 + crawl 平台串行队列）──
    const webFanoutTool = tool("deep_search_fanout", texts, {
        branches: prop("array", texts["deep_search_fanout.param.branches"], { required: true, items: { type: "object" } }),
    }, withNextGuidance("deep_search_fanout", texts["__toolsGuide"], (a) => webRunner(webConfig, "fanout", a), texts["__resultDecision"]));
    // ── deep_search_guide：query route → 入口方法；匹配目录只进 deferred context ──
    const guideExecute = async (a, exec) => {
        const route = String(a.route || "");
        const selected = resolveGuideRoute(route);
        const entryGuide = extractToolGuide(texts["__toolsGuide"], selected.tool);
        if (!entryGuide)
            throw new Error(`missing tools-guide section: ${selected.tool}`);
        const includeFanout = route === "local" ? false : (a.include_fanout === undefined ? true : Boolean(a.include_fanout));
        const fanoutGuide = includeFanout ? extractToolGuide(texts["__toolsGuide"], "deep_search_fanout") : undefined;
        if (includeFanout && !fanoutGuide)
            throw new Error("missing tools-guide section: deep_search_fanout");
        const guide = [entryGuide, fanoutGuide].filter(Boolean).join("\n\n");
        let catalog;
        try {
            if (selected.catalog === "web") {
                const raw = await client.webCatalog();
                validateWebCatalog(raw);
                catalog = renderWebCatalog(raw);
            }
            else if (selected.catalog === "crawl") {
                const raw = await client.crawlCatalog();
                validateCrawlCatalog(raw);
                catalog = renderCrawlCatalog(raw);
            }
            else {
                const raw = await client.sourceCatalog();
                validateSourceCatalog(raw);
                catalog = renderSourceCatalog(raw);
            }
        }
        catch {
            catalog = selected.catalog === "web" ? webCatalogFallback()
                : selected.catalog === "crawl" ? crawlCatalogFallback()
                    : sourceCatalogFallback();
        }
        if (!exec?.deferContext)
            throw new Error("ToolRunContext.deferContext unavailable");
        await exec.deferContext(deferredSnapshot(catalog, "catalog", { route, tool: selected.tool, catalog: selected.catalog }));
        return { route, tool: selected.tool, guide };
    };
    const guideTool = tool("deep_search_guide", texts, {
        route: prop("string", texts["deep_search_guide.param.route"], { enum: ["local", "web", "social"] }),
        include_fanout: prop("boolean", texts["deep_search_guide.param.include_fanout"]),
    }, guideExecute);
    guideTool.parameters.required = ["route"];
    return [deepSearchTool, nextTool, readTool, statusTool, syncTool,
        webTool, webStepTool, webReflectTool, webReportTool, webCrawlTool, webFanoutTool, guideTool];
}
