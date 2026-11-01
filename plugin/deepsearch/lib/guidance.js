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
 * content = system-guide.md 三段（源与层级 / 工具手册 / 判据准则，已在 ①.5 文案层定型）。
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
