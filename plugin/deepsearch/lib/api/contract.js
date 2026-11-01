/**
 * Console API 契约（①.8，方案 § 三 总表写者与 Console API 契约 + § 9.1/9.2/9.3/9.4）
 *
 * 三类接口：查询（/search · /next）+ 只读状态（/status）+ 受控任务（POST /sync → jobId · GET /sync/:jobId）。
 * 不变量：Console :6600 是总表唯一写者（V22）；插件 host 只读/转发，绝不写总表。
 * 契约为 Console 与插件 host 共享定义（api-client 校验响应，见 § 三 宿主职责边界）。
 */
/** 唯一写者边界：只读端点之外，任何写路径都被拒绝（V22）；host 不得调用任何写端点 */
export const WRITE_BOUNDARY = "console-only";
/** 校验单个 carry（与 Console guide/carry.js 同规则）；reject 未知源/缺 id/非法 kind/ov_session layered */
export function validateCarryPayload(value) {
    if (!value || typeof value !== "object")
        return { ok: false, reason: "not object" };
    const v = value;
    const { source, id, kind, anchorTerms } = v;
    if (!["mem0", "ov_context", "ov_session", "wiki"].includes(source))
        return { ok: false, reason: "unknown source" };
    if (typeof id !== "string" || !id)
        return { ok: false, reason: "missing id" };
    if (!["flat", "layered"].includes(kind))
        return { ok: false, reason: "invalid kind" };
    if (source === "ov_session" && kind === "layered")
        return { ok: false, reason: "ov_session 永不 layered" };
    if (anchorTerms !== undefined && !Array.isArray(anchorTerms))
        return { ok: false, reason: "anchorTerms 须数组" };
    if (kind === "layered") {
        if (source === "wiki" && typeof v.assetId !== "string")
            return { ok: false, reason: "layered wiki 缺 assetId" };
        if (source === "ov_context" && typeof v.uri !== "string")
            return { ok: false, reason: "layered ov_context 缺 uri" };
    }
    return { ok: true, payload: value };
}
/** 契约校验：api-client 用（超时/畸形 → 规范 ApiError，不重试同步、不自行写总表） */
export function assertSearchResponse(x) {
    const p = x?.page;
    if (!p || !Array.isArray(p.results) || !Array.isArray(p.sources)) {
        throw new Error("malformed /search response");
    }
    // 旧/不完整 carry 形状拒绝（Task 5/6）：carry 存在但非合法 CarryPayload → 畸形
    for (const r of p.results) {
        if (r.carry !== undefined && r.carry !== null) {
            const v = validateCarryPayload(r.carry);
            if (!v.ok)
                throw new Error(`malformed /search response: carry ${v.reason}`);
        }
    }
}
