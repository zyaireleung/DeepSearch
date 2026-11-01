// search/source-spec.js —— DeepSearch 源规格单一权威
// 模板常量与源→mode 默认只存在这里；store/source-catalog.js 与 search/engine.js 均从此导入，
// 禁止维护第二份 source→mode 矩阵。
// Wiki 资产源（2026-10-30 用户定）：sources 里的 `wiki:<code>` 用 code（工具参数），
// capabilitiesForRequest 经 enabledWikiAssets（code→assetId）解析为内部 assetId；carry 用内部 assetId。
import { validateCarryPayload } from '../guide/carry.js';

/** 每个源未在模板中显式指定时的默认执行 mode。 */
export const SOURCE_MODE_DEFAULTS = Object.freeze({
  mem0: 'find',
  ov_context: 'find',
  ov_session: 'default',
  wiki: 'default',
});

/** 可执行源组合模板。fuzzy_* 是源组合模板，不是搜索阶段。 */
export const FUZZY_TEMPLATES = Object.freeze([
  {
    id: 'fuzzy_mem0_find',
    label: '优先回忆',
    sources: ['mem0', 'ov_context'],
    modes: { mem0: 'find', ov_context: 'find' },
    requiresSession: false,
  },
  {
    id: 'fuzzy_mem0_search',
    label: '会话聚焦回忆',
    sources: ['mem0', 'ov_context'],
    modes: { mem0: 'find', ov_context: 'search' },
    requiresSession: true,
  },
  {
    id: 'fuzzy_full',
    label: '全源补充',
    sources: ['mem0', 'ov_context', 'ov_session', 'wiki'],
    modes: { mem0: 'find', ov_context: 'find', ov_session: 'default', wiki: 'default' },
    requiresSession: false,
  },
]);

export function templateFor(id) {
  return FUZZY_TEMPLATES.find((t) => t.id === id);
}

export function catalogTemplates() {
  return FUZZY_TEMPLATES.map((t) => ({ ...t, modes: { ...t.modes }, sources: [...t.sources] }));
}

/** 解析 sources 数组 → { base:[非 wiki: 前缀源], wikiCodes: null(聚合/全部) | string[] }。 */
export function parseSourceSpec(sources) {
  const base = [];
  const wikiCodes = [];
  let hasAggregateWiki = false;
  for (const s of sources || []) {
    if (s === 'wiki') {
      hasAggregateWiki = true;
      if (!base.includes('wiki')) base.push('wiki');
    } else if (typeof s === 'string' && s.startsWith('wiki:')) {
      const code = s.slice('wiki:'.length);
      if (!wikiCodes.includes(code)) wikiCodes.push(code);
      if (!base.includes('wiki')) base.push('wiki');
    } else if (typeof s === 'string' && !base.includes(s)) {
      base.push(s);
    }
  }
  return { base, wikiCodes: hasAggregateWiki ? null : (wikiCodes.length ? wikiCodes : null) };
}

function invalid(code, message, hint = '') {
  const e = new Error(message);
  e.code = code;
  e.message = message;
  e.hint = hint;
  return e;
}

/**
 * 唯一能力选择器（Task 4：engine 不得自持第二矩阵）。
 * 返回 Array<{source, mode, assetIds?, sessionIds?}>；错误 throw {code,message,hint}。
 * @param {{method?:string,sources?:string[],sessionId?:string,includeSearch?:boolean}} req
 * @param {{enabledWikiAssetIds?:Set<string>, enabledWikiAssets?:Record<string,string>}} opts
 *   enabledWikiAssetIds = 内部 assetId 集合（carry 校验）；
 *   enabledWikiAssets     = code → assetId（sources 显式 wiki:<code> 解析）。
 */
export function capabilitiesForRequest(req, { enabledWikiAssetIds = new Set(), enabledWikiAssets = {} } = {}) {
  const method = req.method || 'fuzzy_full';
  const sources = req.sources || [];
  const hasSession = Boolean(req.sessionId);
  const template = templateFor(method);

  const validateWiki = (spec) => {
    for (const code of (spec.wikiCodes || [])) {
      if (!enabledWikiAssets || !enabledWikiAssets[code])
        throw invalid('INVALID_REQUEST', `wiki 资产 ${code} 不可用`, '仅启用且就绪的 Wiki 资产可作源；code 见 /source-catalog');
    }
  };
  const attachWiki = (caps, spec) => {
    for (const c of caps) {
      if (c.source === 'wiki')
        c.assetIds = spec.wikiCodes ? spec.wikiCodes.map((code) => enabledWikiAssets[code]) : Object.values(enabledWikiAssets);
    }
  };

  // ── carry = 已验证检索证据/上下文（2026-10-30 用户：跨源携带必须支持，不再是来源过滤器）──
  // 带显式 sources：按 sources 执行（carry 仅作上下文，允许跨源，不与 sources 求交集/拒绝）。
  // 无 sources：按 carry 来源默认收窄（继续同一证据面的便捷行为）。
  const carry = req.carry || [];
  if (carry.length) {
    // 无论如何先校验 carry 合法性（上下文契约），但不据此限定检索范围
    for (const c of carry) {
      const v = validateCarryPayload(c);
      if (!v.ok) throw invalid('INVALID_REQUEST', v.reason, 'carry 不合法，须为 CarryPayload 契约');
    }
    if (!sources.length) {
      // carry 收窄 = 继续同一证据面的便捷行为：即使 visited 已含该源也要执行（ignoreVisited），
      // 同源多条 carry 合并为一次执行（去重，避免重复请求）。
      const caps = [];
      const bySource = new Map();
      for (const c of carry) {
        const p = validateCarryPayload(c).payload;
        if (p.source === 'wiki') {
          if (!enabledWikiAssetIds.has(p.assetId)) throw invalid('INVALID_REQUEST', `wiki 资产 ${p.assetId} 不可用`, '仅启用且就绪的 Wiki 资产可作源');
          const ex = bySource.get('wiki');
          if (ex) { if (!ex.assetIds.includes(p.assetId)) ex.assetIds.push(p.assetId); continue; }
          const cap = { source: 'wiki', mode: 'default', assetIds: [p.assetId], ignoreVisited: true };
          bySource.set('wiki', cap); caps.push(cap);
        } else if (p.source === 'ov_session') {
          const ex = bySource.get('ov_session');
          if (ex) { if (p.sessionId && !(ex.sessionIds || []).includes(p.sessionId)) (ex.sessionIds = ex.sessionIds || []).push(p.sessionId); continue; }
          const cap = { source: 'ov_session', mode: 'default', ignoreVisited: true, ...(p.sessionId ? { sessionIds: [p.sessionId] } : {}) };
          bySource.set('ov_session', cap); caps.push(cap);
        } else if (p.source === 'ov_context') {
          if (bySource.has('ov_context')) continue; // ov_context 单 uri 语义：同源去重保留第一个
          const cap = { source: 'ov_context', mode: 'find', ignoreVisited: true, ...(p.uri ? { uri: p.uri } : {}) };
          bySource.set('ov_context', cap); caps.push(cap);
        } else {
          if (bySource.has('mem0')) continue; // mem0 扁平单源：同源去重保留第一个
          const cap = { source: 'mem0', mode: 'find', ignoreVisited: true };
          bySource.set('mem0', cap); caps.push(cap);
        }
      }
      return caps;
    }
    // 有 sources：不 return，落到下方通用构建路径按显式 sources 执行（跨源允许）
  }

  // exact 别名：必须显式 sources
  if (method === 'exact_single' || method === 'exact_hybrid') {
    if (!sources.length) throw invalid('INVALID_REQUEST', 'exact 需要显式 sources', '精确模式必须给出源列表');
    const spec = parseSourceSpec(sources);
    validateWiki(spec);
    const caps = spec.base.map((s) => ({ source: s, mode: 'find' }));
    attachWiki(caps, spec);
    return caps;
  }

  if (!template) throw invalid('INVALID_REQUEST', `未知方法 ${method}`, 'method 必须是已知 fuzzy/exact 模板');
  if (method === 'fuzzy_mem0_search' && !hasSession) throw invalid('SESSION_ID_REQUIRED', 'fuzzy_mem0_search 需要 sessionId', '会话聚焦回忆需提供 sessionId');

  // fuzzy 无 sources → 模板默认；有 sources → 精确执行 supplied selectors
  const execSources = sources.length ? sources : template.sources;
  const spec = parseSourceSpec(execSources);
  validateWiki(spec);
  const caps = [];
  for (const s of spec.base) {
    const mode = template.modes[s] || SOURCE_MODE_DEFAULTS[s];
    if (!mode) throw invalid('INVALID_REQUEST', `源 ${s} 无可用 mode`, '');
    caps.push({ source: s, mode });
  }
  attachWiki(caps, spec);
  return caps;
}
