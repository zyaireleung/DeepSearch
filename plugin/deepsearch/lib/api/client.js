/**
 * api-client（⑦.5）：插件 host → Console 转发（只读/受控，绝不写总表，V22）。
 *
 * 职责：构造请求 → fetch → 契约校验（assertSearchResponse）→ 规范 ApiError（超时/畸形/拒绝）。
 * 重试策略：检索类不重试（超时即降级）；同步类只转发不本地重试（Console 串行队列幂等）。
 *
 * 生产/沙盒显式模式（2026-10-30）：构造时解析 config/env 并做端口保护；guard 拒绝不抛于构造
 * （避免拖垮 DSH 启动），而是记录 guardRejected，工具调用时返回 GUARD_REJECTED（绝不静默打生产）。
 */
import { consoleBaseUrl, routes, assertConsoleTarget, resolveMode, loadConfigFile } from "./routes.js";
import { assertSearchResponse, WRITE_BOUNDARY } from "./contract.js";
export class ApiClientError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
    }
}
export class ApiClient {
    base;
    /** 端口保护拒绝原因（非 null = 沙盒/开发模式下指向生产 :6600，工具调用返回 GUARD_REJECTED）。 */
    guardRejected = null;
    timeoutMs;
    constructor(opts = {}) {
        const cfg = opts.config ?? loadConfigFile(opts.configPath);
        this.base = consoleBaseUrl(opts.env, cfg);
        const mode = opts.mode ?? resolveMode(opts.env, cfg);
        try {
            assertConsoleTarget(this.base, mode);
        }
        catch (e) {
            this.guardRejected = e.message;
        }
        this.timeoutMs = opts.timeoutMs ?? 8000;
    }
    /** 端口保护红线：guard 激活时工具调用即失败（不静默打生产，也不在 register 抛错拖垮 DSH）。 */
    ensureGuard() {
        if (this.guardRejected) {
            throw new ApiClientError("GUARD_REJECTED", this.guardRejected, "端口保护红线：禁止沙盒/开发模式指向生产 Console :6600（需 DEEP_SEARCH_ENV=production 或 deepsearch.config.json mode=production）");
        }
    }
    async call(method, path, body, validate) {
        this.ensureGuard();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const r = await fetch(path, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            const json = await r.json().catch(() => null);
            if (!r.ok) {
                const err = json?.error;
                throw new ApiClientError(err?.code || "UNKNOWN", err?.message || `Console HTTP ${r.status}`, err?.hint || "Console 暂不可用，稍后重试或检查服务");
            }
            if (validate)
                validate(json);
            return json;
        }
        catch (e) {
            if (e instanceof ApiClientError)
                throw e;
            if (e?.name === "AbortError")
                throw new ApiClientError("TIMED_OUT", `Console 超时（${this.timeoutMs}ms）`, "检索源超时，缩小 query 或减少源后重试");
            throw new ApiClientError("COORDINATOR_DOWN", e?.message || "Console 不可达", "Console 未运行，启动 DeepSearch 服务后重试");
        }
        finally {
            clearTimeout(t);
        }
    }
    search(req) {
        // POST（fetch 禁 GET body；server 接受 GET/POST，契约路径 /search 不变）
        return this.call("POST", routes.search(this.base), req, (x) => assertSearchResponse(x));
    }
    next(req) {
        return this.call("POST", routes.next(this.base), req);
    }
    read(req) {
        return this.call("POST", routes.read(this.base), req);
    }
    status() {
        return this.call("GET", routes.status(this.base));
    }
    /** 只读源目录（Task 6）：同 timeout + production guard；绝不写 Console。 */
    sourceCatalog() {
        return this.call("GET", routes.sourceCatalog(this.base));
    }
    sync(req) {
        return this.call("POST", routes.sync(this.base), req);
    }
    syncJob(jobId) {
        return this.call("GET", routes.syncJob(this.base, jobId));
    }
}
export const writeBoundary = WRITE_BOUNDARY;
