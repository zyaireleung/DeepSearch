/**
 * 强锚点候选解析（2026-11-01 用户定稿）。
 *
 * 边界（首版，用户已确认）：
 *  - anchors 可选，不传保持旧排序；禁止空数组（schema minItems=1）。
 *  - 身份目录只读现有 wiki 结构化元数据（entry/title）+ 技术标识规则；
 *    不从 mem0/ov_session 自动造目录，不镜像 ov_context。
 *  - 匹配仅做安全格式归一（大小写/空白/连字符/下划线），不引入人工或语义别名表。
 *  - 复合锚点必须整体命中；组件词（如 Skill）不算复合锚点命中。
 *  - 排序签名：required 完整 → required 命中数 → optional 命中数 → 既有 span 链。
 */

import { normSpanText } from "./content-match.js";

/** 技术标识规则（无模型）：命令/文件/参数/会话 ID/端口/带连字符下划线标识符。 */
const TECHNICAL_RE = [
  /^--[a-z0-9][a-z0-9-]*$/i,            // --once
  /^-[a-z0-9]$/i,                       // -f
  /\.(jsonl|zstd|json|md|ts|js|py|db|conf|yml|yaml|toml|log)$/i, // 文件扩展名结尾
  /^session[-.]?[0-9a-f]{8,}/i,         // session-xxxx / session.xxxx
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9]{2,5}$/,                       // 端口
  /^[a-z0-9]+[-_][a-z0-9_-]+$/i,        // dsh-session-ingest / EGO_LINUX_CHROME
  /^[a-z0-9]+(\.[a-z0-9]+)+$/i,         // session.v4.jsonl.zstd
];

export function isTechnicalIdentifier(text) {
  const s = String(text ?? "").trim();
  if (!s || /^[0-9]{2,5}$/.test(s)) return false;
  const normalized = s.replace(/[\s_-]+/g, "-");
  return TECHNICAL_RE.some((re) => re.test(s) || re.test(normalized));
}

/** API-boundary validation: omitted anchors keep legacy behavior; supplied anchors must be non-empty and well-formed. */
export function validateAnchors(anchors) {
  if (anchors === undefined) return;
  if (!Array.isArray(anchors) || anchors.length === 0) throw new Error("anchors 必须是至少含一项的数组");
  for (const anchor of anchors) {
    if (!anchor || typeof anchor !== "object" || typeof anchor.text !== "string" || !anchor.text.trim()) {
      throw new Error("anchors[].text 必须是非空字符串");
    }
    if (typeof anchor.required !== "boolean") throw new Error("anchors[].required 必须是布尔值");
  }
}

/**
 * 从 wiki_blocks 行构建目录：normString → { count, canonical }。
 * count>1 = 多记录同名标题（ambiguous），>1 不升格。
 */
export function buildAnchorCatalogFromRows(rows) {
  const catalog = new Map();
  for (const row of rows || []) {
    for (const value of [row?.entry, row?.title]) {
      if (!value) continue;
      const norm = normSpanText(value);
      if (!norm) continue;
      if (catalog.has(norm)) {
        const e = catalog.get(norm);
        e.count += 1;
      } else {
        catalog.set(norm, { count: 1, canonical: value });
      }
    }
  }
  return catalog;
}

/** 直接从总表 db 构建目录（只读 SELECT，调用方保证有 wiki_blocks 表）。 */
export function buildAnchorCatalog(db) {
  let rows = [];
  try {
    rows = db.prepare("SELECT asset_id, entry, title FROM wiki_blocks").all();
  } catch {
    rows = [];
  }
  return buildAnchorCatalogFromRows(rows);
}

/**
 * 解析锚点候选 → { resolution, strong }。
 * status: resolved（唯一 wiki 绑定）/ technical（技术标识）/ ambiguous（多记录）/ unresolved（未解析）。
 * strong 仅含 resolved/technical，供排序签名使用。
 */
export function resolveAnchors(candidates, catalog) {
  const resolution = [];
  const strong = [];
  for (const c of candidates || []) {
    const text = String(c?.text ?? "").trim();
    const required = c?.required === true;
    if (!text) {
      resolution.push({ text, required, status: "unresolved" });
      continue;
    }
    const norm = normSpanText(text);
    let entry = catalog && catalog.get(norm);
    if (entry && entry.count === 1) {
      const canonical = entry.canonical;
      resolution.push({ text, required, status: "resolved", canonical, catalogId: canonical });
      strong.push({ text, required, canonical });
    } else if (entry && entry.count > 1) {
      resolution.push({ text, required, status: "ambiguous" });
    } else if (isTechnicalIdentifier(text)) {
      resolution.push({ text, required, status: "technical", canonical: text });
      strong.push({ text, required, canonical: text });
    } else {
      resolution.push({ text, required, status: "unresolved" });
    }
  }
  return { resolution, strong };
}

/**
 * 排序签名：[allRequiredExact, requiredExactCount, optionalExactCount]。
 * 强锚点只保护对象范围（完整命中优先），不按字数加权。
 */
export function computeAnchorSignature(text, strongAnchors) {
  const normText = normSpanText(text || "");
  let requiredExact = 0;
  let optionalExact = 0;
  let allRequired = true;
  let hasRequired = false;
  for (const a of strongAnchors || []) {
    const target = normSpanText(a.canonical ?? a.text ?? "");
    if (!target) continue;
    const hit = normText.includes(target);
    if (a.required) {
      hasRequired = true;
      if (hit) requiredExact += 1;
      else allRequired = false;
    } else if (hit) {
      optionalExact += 1;
    }
  }
  const allRequiredExact = (!hasRequired || allRequired) ? 1 : 0;
  return [allRequiredExact, requiredExact, optionalExact];
}
