// store/source-catalog.js —— 只读固定源 + 启用/就绪 Wiki 资产源目录（V31/V33/V37）
// 来源：唯一权威 search/source-spec.js 的模板；本模块不维护第二份 source→mode 矩阵。
// Wiki 资产源（2026-10-30 用户定）：id = `wiki:<code>`（code 是工具调用参数标识），
// description = 单文本；code/assetId 供 search-api 解析 code→内部 id（查库用）。
import fs from 'node:fs';
import { catalogTemplates } from '../search/source-spec.js';
import { codeOf, descriptionOf } from '../lib/wiki-assets.js';

/** 固定源范围描述：只写“保存什么 / 不保存什么”，不写 carry/向量/导航机制。 */
const FIXED_SOURCE_DESCRIPTIONS = {
  mem0: {
    contains: '从全部历史对话抽取出的场景记忆和长期记忆。',
    excludes: '不保存逐句原始对话，也不保证保留完整上下文。',
  },
  ov_context: {
    contains: '已提交会话蒸馏出的结构化上下文记忆。',
    excludes: '不等于全部历史对话原文；未完成 commit 的会话不会在此出现。',
  },
  ov_session: {
    contains: '已同步历史会话的原文块。',
    excludes: '不等于经过蒸馏的长期结论或完整外部文档库。',
  },
  wiki: {
    contains: '当前已启用且可用全部 Wiki 资产的正文块。',
    excludes: '不含已禁用或未就绪的资产，也不含记忆类内容。',
  },
};

const FIXED_LABELS = {
  mem0: 'Mem0 记忆',
  ov_context: 'OV 上下文',
  ov_session: 'OV 会话原文',
  wiki: '全部 Wiki 资产',
};

function loadRegistry(wikiAssetsJsonPath) {
  try { return JSON.parse(fs.readFileSync(wikiAssetsJsonPath, 'utf8')); } catch { return { assets: [] }; }
}

/** 空文本显示为“未填写”，不编造范围。 */
function scopeText(v) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : '未填写';
}

/**
 * 构建只读源目录。
 * @param {string} wikiAssetsJsonPath registry JSON 路径（缺省回退空）
 * @param {{now?:number}} opts
 */
export function buildSourceCatalog(wikiAssetsJsonPath, { now = Date.now() } = {}) {
  const reg = loadRegistry(wikiAssetsJsonPath);
  const sources = [];
  for (const id of ['mem0', 'ov_context', 'ov_session', 'wiki']) {
    sources.push({ id, label: FIXED_LABELS[id], description: FIXED_SOURCE_DESCRIPTIONS[id], enabled: true });
  }
  for (const a of (reg.assets || [])) {
    if (!(a.enabled && a.state === 'ready')) continue;   // V33：禁用/未就绪不入目录
    const code = codeOf(a);
    sources.push({
      id: `wiki:${code}`,
      label: a.name || code,
      code,
      assetId: a.id,
      description: { text: scopeText(descriptionOf(a)) },
      enabled: true,
    });
  }
  return { version: 1, sources, templates: catalogTemplates(), generatedAt: now };
}
