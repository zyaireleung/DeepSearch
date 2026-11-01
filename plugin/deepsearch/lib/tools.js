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
import { renderSourceRouting, renderReadGuide } from "./guidance.js";
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
 * 构建 5 个工具定义（真实 DSH 契约 shape）。
 * @param client ApiClient（转发 Console）
 * @param texts tools.md 文案 SlotMap（description + param.* 键；经 loader 校验）
 * @param sourceRoutingText source-routing.md 全文（deep_search 结果附加 routing 用；可缺省）
 */
export function buildTools(client, texts, sourceRoutingText) {
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
    }, (a) => deepSearch(client, a, sourceRoutingText));
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
    }, (a) => deepSearchNext(client, a));
    const statusTool = tool("deep_search_status", texts, {}, () => deepSearchStatus(client));
    const readTool = tool("deep_search_read", texts, {
        id: prop("string", texts["deep_search_read.param.id"] ?? "必填字符串；要读取全文的 deep_search 结果 id", { required: true }),
        source: prop("string", texts["deep_search_read.param.source"] ?? "可选字符串；结果源（ov_session/wiki/ov_context/mem0），缺省由 id 前缀推导", { enum: ["ov_session", "wiki", "ov_context", "mem0"] }),
    }, (a) => deepSearchRead(client, a, sourceRoutingText));
    const syncTool = tool("deep_search_sync", texts, {
        dryRun: prop("boolean", texts["deep_search_sync.param.dryRun"], { default: true }),
        rebuild: prop("boolean", texts["deep_search_sync.param.rebuild"], { default: false }),
    }, (a) => deepSearchSync(client, a));
    return [deepSearchTool, nextTool, readTool, statusTool, syncTool];
}
