/**
 * prompts 槽位 loader（方案 § 9.6，修订 4/6）
 *
 * 三级回退：实例覆盖目录 → 该语言包 → 默认语言。
 * 缺键报错：tools/labels/notices 的关键字集合必须与代码注册/引用一致（V21/V25/V29）。
 *
 * 槽位文件格式（tools/labels/notices）：
 *   - 每行一条 `key: value`（冒号后一个空格；value 为该行剩余）
 *   - 续行：以 2+ 空格开头或空行的行，追加到上一 key 的 value（换行连接）
 *   - 注释：`#` 开头行；分隔：`---` 行（均忽略）
 *   - 首行 YAML frontmatter（`---` 包围）被跳过
 *
 * system-guide.md 是整段文档槽位（检索分层指针），按原始文本读取，不做 key-value 解析。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const DEFAULT_LANG = "zh";
/** 解析 key-value 槽位文本 → 键值对象（续行合并；注释/分隔/frontmatter 跳过） */
export function parseSlot(text) {
    const lines = text.split(/\r?\n/);
    const out = {};
    let currentKey = null;
    let inFrontmatter = false;
    let frontmatterSeen = false;
    for (const raw of lines) {
        // 跳过 YAML frontmatter（首行 --- 起，第二个 --- 止）
        const line = raw.replace(/\r$/, "");
        if (!frontmatterSeen && line.trim() === "---") {
            inFrontmatter = !inFrontmatter;
            if (!inFrontmatter)
                frontmatterSeen = true;
            continue;
        }
        if (inFrontmatter)
            continue;
        if (frontmatterSeen && line.trim() === "---")
            continue;
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---")
            continue;
        const m = line.match(/^(\S[^:]*?):\s*(.*)$/);
        if (m && !line.startsWith(" ")) {
            currentKey = m[1].trim();
            out[currentKey] = m[2].trim();
        }
        else if (currentKey !== null && line.startsWith(" ")) {
            // 续行：追加到上一 value
            out[currentKey] = (out[currentKey] ? out[currentKey] + "\n" : "") + line.trim();
        }
    }
    return out;
}
/** 槽位候选路径（三级：overrideDir → lang 包 → 默认语言），从低到高 */
function slotCandidates(name, opts) {
    const out = [];
    const lang = opts.lang || DEFAULT_LANG;
    out.push(resolve(opts.baseDir, DEFAULT_LANG, `${name}.md`));
    if (lang !== DEFAULT_LANG)
        out.push(resolve(opts.baseDir, lang, `${name}.md`));
    if (opts.overrideDir)
        out.push(resolve(opts.overrideDir, `${name}.md`));
    return out;
}
/** 读取单个槽位文本（三级回退：overrideDir → lang 包 → 默认语言；整段文档槽位用） */
export function readSlotText(name, opts) {
    const candidates = slotCandidates(name, opts);
    for (let i = candidates.length - 1; i >= 0; i--) {
        if (existsSync(candidates[i]))
            return readFileSync(candidates[i], "utf8");
    }
    throw new Error(`[prompts] slot "${name}" 缺失：尝试了 ${candidates.join(", ")}（覆盖→语言包→默认语言均无）`);
}
/**
 * 读取键值槽位（三级回退 + **按键合并**：默认语言 → 语言包 → 覆盖目录，后者覆盖前者）。
 * V28：实例只覆盖单个槽位/部分键 → 其余键回退语言包→默认语言，不丢文案。
 */
export function readSlotMerged(name, opts) {
    const merged = {};
    let found = false;
    for (const p of slotCandidates(name, opts)) {
        if (!existsSync(p))
            continue;
        found = true;
        const parsed = parseSlot(readFileSync(p, "utf8"));
        for (const [k, v] of Object.entries(parsed))
            merged[k] = v; // 后者覆盖前者
    }
    if (!found) {
        throw new Error(`[prompts] slot "${name}" 缺失：覆盖→语言包→默认语言均无`);
    }
    return merged;
}
/** 加载全部槽位：system-guide/tools-guide/source-routing/web-routing/result-decision 原样文本（整段文档，覆盖即替换），其余按键合并 */
export function loadSlots(opts) {
    return {
        systemGuide: readSlotText("system-guide", opts),
        toolsGuide: readSlotText("tools-guide", opts),
        sourceRouting: readSlotText("source-routing", opts),
        webRouting: readSlotText("web-routing", opts),
        resultDecision: readSlotText("result-decision", opts),
        tools: readSlotMerged("tools", opts),
        labels: readSlotMerged("labels", opts),
        notices: readSlotMerged("notices", opts),
    };
}
/** 缺键报错：required 集合必须全部存在，否则 throw（V21/V25/V29 的加载即报错不变式） */
export function requireKeys(map, required, slotName) {
    const missing = required.filter((k) => !(k in map) || map[k].trim() === "");
    if (missing.length > 0) {
        throw new Error(`[prompts] slot "${slotName}" 缺键：${missing.join(", ")}（缺键加载即报错；新增键须同步注册集合）`);
    }
}
/**
 * 工具文案键集合（tools.md 必须满足；与 src/tools.ts 注册的工具/参数一致——V21）
 * 注：host 工具注册在 ⑦.5，届时 src/tools.ts 应 import 本集合做双向校验。
 */
export const TOOL_KEYS = [
    // deep_search
    "deep_search.description",
    "deep_search.param.query",
    "deep_search.param.sources",
    "deep_search.param.precision",
    "deep_search.param.sessionId",
    "deep_search.param.includeSearch",
    "deep_search.param.method",
    "deep_search.param.carry",
    "deep_search.param.visited",
    "deep_search.param.explain",
    "deep_search.param.anchors",
    "deep_search.out.page",
    "deep_search.out.verdict",
    "deep_search.out.complete",
    "deep_search.out.sources",
    "deep_search.out.results",
    "deep_search.out.anchorResolution",
    // deep_search_next
    "deep_search_next.description",
    "deep_search_next.param.id",
    "deep_search_next.param.direction",
    "deep_search_next.param.step",
    "deep_search_next.param.method",
    "deep_search_next.param.visited",
    "deep_search_next.param.origin",
    "deep_search_next.param.query",
    "deep_search_next.param.pattern",
    "deep_search_next.param.params",
    "deep_search_next.param.inline",
    "deep_search_next.param.limit",
    "deep_search_next.out.next",
    // deep_search_status
    "deep_search_status.description",
    "deep_search_status.out.status",
    // deep_search_sync
    "deep_search_sync.description",
    "deep_search_sync.param.dryRun",
    "deep_search_sync.param.rebuild",
    "deep_search_sync.out.result",
    // deep_search_read
    "deep_search_read.description",
    "deep_search_read.param.id",
    "deep_search_read.param.source",
    "deep_search_read.out.read",
    // deep_search_web（网络检索）
    "deep_search_web.description",
    "deep_search_web.param.run_id",
    "deep_search_web.param.question",
    "deep_search_web.param.intent",
    "deep_search_web.param.claims",
    "deep_search_web.out.state",
    "deep_search_web.out.next_pending_claim",
    // deep_search_step（网络检索）
    "deep_search_step.description",
    "deep_search_step.param.run_id",
    "deep_search_step.out.state",
    "deep_search_step.out.evidence_added",
    "deep_search_step.out.next_pending_claim",
    "deep_search_step.out.diagnostics",
    // deep_search_reflect（网络检索）
    "deep_search_reflect.description",
    "deep_search_reflect.param.run_id",
    "deep_search_reflect.param.decisions",
    "deep_search_reflect.param.new_claims",
    "deep_search_reflect.out.should_stop",
    "deep_search_reflect.out.state",
    // deep_search_report（网络检索）
    "deep_search_report.description",
    "deep_search_report.param.run_id",
    "deep_search_report.out.markdown",
    // deep_search_crawl（网络检索单发）
    "deep_search_crawl.description",
    "deep_search_crawl.param.platform",
    "deep_search_crawl.param.type",
    "deep_search_crawl.param.creator_id",
    "deep_search_crawl.param.specified_id",
    "deep_search_crawl.param.keywords",
    "deep_search_crawl.out.raw_records",
    "deep_search_crawl.out.new_files",
    "deep_search_crawl.out.count",
    // deep_search_guide（query route → 入口工具方法；目录由 deferred context 呈现）
    "deep_search_guide.description",
    "deep_search_guide.param.route",
    "deep_search_guide.param.include_fanout",
    "deep_search_guide.out.result",
    // deep_search_fanout（path-1 并行编排：web 多站点真并行 + crawl 平台串行队列）
    "deep_search_fanout.description",
    "deep_search_fanout.param.branches",
    "deep_search_fanout.out.branches",
    "deep_search_fanout.out.summary",
];
/** 文案引用键集合（labels/notices 必须满足；V25 决策注册表双向闭合） */
export const LABEL_KEYS = [
    "error.invalid_request",
    "error.session_id_required",
    "error.session_not_ready",
    "error.param_conflict",
    "error.coordinator_down",
    "error.timed_out",
    "error.mem0_rank_uncomparable",
    "error.session_filter_no_match",
    "direction.up",
    "direction.across",
    "direction.back",
    "direction.global",
    "direction.root",
    "direction.auto",
    "source.ov_context_find",
    "source.ov_context_search",
    "source.ov_session",
    "source.mem0",
    "source.wiki",
    "verdict.narrowed",
    "verdict.miss",
    "verdict.invalid_request",
];
/** 便捷校验：加载 + 全键集合检查（供自检 / 注册时调用） */
export function loadAndValidate(opts) {
    const slots = loadSlots(opts);
    requireKeys(slots.tools, TOOL_KEYS, "tools");
    requireKeys(slots.labels, LABEL_KEYS, "labels");
    return slots;
}
