// lib/llm-presets.js —— 唯一 LLM 模型预设总表 + 资产配置 resolve/合并（2026-10-20 用户拍板）
//
// 语义（与用户确认一致）：
//   1. 8126 上只有一个 LLM 预设总表（console-config.json → model.presets），字段全集：
//      name / baseUrl / apiKey / model / maxTokens / temperature / enable_thinking / no_proxy / timeout。
//      Chat Memory（L1）、Mem0、Wiki 摄入、资产 config.yaml 快照全部引用它。
//      embedding 独立表（model.embeddingPresets），预设互不干涉。
//   2. 总表 = 调用时权威：每次 spawn 前 runner 以总表 resolve 资产 stages → 与 config.yaml 快照 diff
//      → 有差异写回快照（快照永不粘滞）；总表读不到（离线）→ 本次用快照，run-state 标注模型源。
//   3. 资产化前同步：模版 model_templates 并入总表（同名 → 模版参数覆盖总表 + 留痕；新名 → 加入）。
//   4. 快照 = 资产用到的模型工作集 + 参数备份：只在「资产化初始」「应用预设/应用」时增删，
//      参数在每次 spawn 前被总表刷新。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 配置路径：默认 dsh-console/console-config.json；测试可用 LLM_PRESETS_CONFIG_PATH 指向临时文件（绝不碰真实配置）
export const configPath = () => process.env.LLM_PRESETS_CONFIG_PATH || path.join(__dirname, '..', 'console-config.json');

export function loadDiskConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
export function masterPresetsOf(cfg) { return Array.isArray(cfg?.model?.presets) ? cfg.model.presets : []; }
export function embeddingMasterOf(cfg) { return Array.isArray(cfg?.model?.embeddingPresets) ? cfg.model.embeddingPresets : []; }
// 沙盒测试钩子：仅当宿主进程带 LLM_PRESETS_TEST_HOOK=1 时，setMasterAvailable 才能关闭总表读取。
// 生产永不设置该 env → 钩子完全失效，总表始终可用（或按 LLM_PRESETS_FORCE_UNAVAILABLE 注入）。 
let __masterAvailable = true;
export function setMasterAvailable(v) { __masterAvailable = !!v; }
function assertMasterAvailable() {
  const hook = process.env.LLM_PRESETS_TEST_HOOK === '1';
  const forced = process.env.LLM_PRESETS_FORCE_UNAVAILABLE === '1';
  if ((hook && !__masterAvailable) || (!hook && forced)) {
    throw new Error('统一预设总表不可用（沙盒故障注入）');
  }
}
export function readMaster() {
  assertMasterAvailable();
  return masterPresetsOf(loadDiskConfig());
}
export function readEmbeddingMaster() {
  assertMasterAvailable();
  return embeddingMasterOf(loadDiskConfig());
}
export function writeEmbeddingMasterPresets(list) {
  const cfg = loadDiskConfig();
  cfg.model = { ...(cfg.model || {}), embeddingPresets: list };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return list;
}

export function writeMasterPresets(list) {
  const cfg = loadDiskConfig();
  cfg.model = { ...(cfg.model || {}), presets: list };
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return list;
}

/** 旧 Wiki 摄入预设（config.model.wikiModelPresets）并入统一总表 model.presets 的纯函数。
 *  迁移规则（总表权威 + 不静默丢失，2026-10-20 拍板）：
 *    1) 缺失名 → 整体加入总表（normalize 全字段）；
 *    2) 同名   → 只回填总表缺失的字段（总表已有值保持权威，绝不覆盖）；
 *    3) 迁移后删除旧 key wikiModelPresets（防重复合并）。
 *  只修改传入的 cfg 对象；返回 { changed, added[], backfilled{name:[fields]} }。
 *  @param {object} cfg 完整配置对象（含 model.presets / model.wikiModelPresets）
 *  @param {(msg:string)=>void} [log] 留痕回调 */
export function migrateLegacyPresets(cfg, log = () => {}) {
  const old = cfg?.model?.wikiModelPresets;
  if (!Array.isArray(old) || !old.length) return { changed: false, added: [], backfilled: {} };
  const master = masterPresetsOf(cfg);
  const byName = new Map(master.map(p => [p.name, p]));
  const added = [], backfilled = {};
  for (const src of old) {
    if (!src || !src.name) continue;
    const entry = normalizeEntry(src.name, src);
    const existing = byName.get(src.name);
    if (!existing) { master.push(entry); byName.set(src.name, entry); added.push(src.name); continue; }
    const fill = {};
    for (const k of DIFF_KEYS) {
      if (k !== 'name' && existing[k] === undefined && entry[k] !== undefined) fill[k] = entry[k];
    }
    if (Object.keys(fill).length) { Object.assign(existing, fill); backfilled[src.name] = Object.keys(fill); }
  }
  delete cfg.model.wikiModelPresets;
  const changed = added.length > 0 || Object.keys(backfilled).length > 0;
  if (changed) {
    if (added.length) log(`[llm-presets] 旧 Wiki 预设并入总表新增：${added.join('、')}`);
    if (Object.keys(backfilled).length) log(`[llm-presets] 旧 Wiki 预设同名回填总表缺失字段：${Object.entries(backfilled).map(([n, ks]) => `${n}(${ks.join(',')})`).join('、')}`);
  }
  return { changed, added, backfilled };
}

/** 归一化：把任意来源的预设条目（总表字段 或 config.yaml 模板字段）转成总表全集字段条目。
 *  @param {string} name 预设名（唯一键）
 *  @param {object} src 来源对象（支持两套字段名：baseUrl/base_url、apiKey/api_key 等）
 *  @returns {object} 总表条目（含全集字段，未提供的字段为 undefined） */
export function normalizeEntry(name, src) {
  if (!src || typeof src !== 'object') return null;
  const get = (a, b) => (src[a] !== undefined && src[a] !== null ? src[a] : src[b]);
  return {
    name: String(name ?? src.name ?? ''),
    baseUrl: String(get('baseUrl', 'base_url') ?? ''),
    apiKey: String(get('apiKey', 'api_key') ?? ''),
    model: String(get('model', 'name') ?? name ?? ''),
    maxTokens: get('maxTokens', 'max_tokens') ?? undefined,
    temperature: get('temperature', 'temperature') ?? undefined,
    enable_thinking: get('enable_thinking', 'enable_thinking') ?? undefined,
    no_proxy: get('no_proxy', 'no_proxy') ?? undefined,
    timeout: get('timeout', 'timeout') ?? undefined,
  };
}

const DIFF_KEYS = ['baseUrl', 'apiKey', 'model', 'maxTokens', 'temperature', 'enable_thinking', 'no_proxy', 'timeout'];

/** 两总表条目参数差异：完全一致 → null；否则返回差异字段名列表。 */
export function entryDiff(a, b) {
  const d = DIFF_KEYS.filter(k => String(a?.[k] ?? '') !== String(b?.[k] ?? ''));
  return d.length ? d : null;
}

/** 资产化前同步：把模版 model_templates 并入总表。
 *  同名 → 模版参数覆盖总表条目（用户拍板：config.yaml 参数覆盖总表）+ 留痕；新名 → 加入；同值 → 不动。
 *  @param {object} template 模版 model_templates（{名称: 模板字段对象}）
 *  @param {(msg:string)=>void} [log] 留痕回调
 *  @returns {{added:string[], updated:string[], kept:string[]}} */
export function mergeTemplateIntoMaster(template, log = () => {}) {
  if (!template || typeof template !== 'object') return { added: [], updated: [], kept: [] };
  const master = readMaster();
  const byName = new Map(master.map(p => [p.name, p]));
  const added = [], updated = [], kept = [];
  for (const [name, src] of Object.entries(template)) {
    if (!src || typeof src !== 'object' || !name) continue;
    const entry = normalizeEntry(name, src);
    if (!entry.name) continue;
    const existing = byName.get(name);
    if (!existing) { master.push(entry); byName.set(name, entry); added.push(name); continue; }
    const diff = entryDiff(existing, entry);
    if (diff) { Object.assign(existing, entry); updated.push(name); }
    else kept.push(name);
  }
  if (added.length || updated.length) {
    writeMasterPresets(master);
    if (added.length) log(`[llm-presets] 资产化并入总表新增预设：${added.join('、')}`);
    if (updated.length) log(`[llm-presets] 资产化同名覆盖总表预设：${updated.join('、')}（模版参数优先）`);
  }
  return { added, updated, kept };
}

/** 以总表 resolve 资产 stages：计算每个被引用模型名的有效参数。
 *  @param {object|null} assetCfg 资产 config.yaml 解析结果（含 stages / model_templates）
 *  @param {Array} master 总表预设
 *  @returns {{templates:object, from:object, missing:string[], source:'master'|'mixed'|'snapshot'}} */
export function resolveStageTemplates(assetCfg, master) {
  const stages = (assetCfg && assetCfg.stages) || {};
  const snapshot = (assetCfg && assetCfg.model_templates) || {};
  const names = [...new Set(Object.values(stages).map(s => (s && s.model) || '').filter(Boolean))];
  const masterOk = Array.isArray(master) && master.length > 0;   // 空表/非数组 = 不可用 → 快照兜底
  const templates = {}; const from = {}; const missing = [];
  for (const n of names) {
    const mp = masterOk ? master.find(p => p.name === n) : null;
    if (mp) {
      templates[n] = normalizeEntry(n, mp);
      // 转成 runtime.py 消费的模板字段（config.yaml 侧命名）
      templates[n] = {
        name: mp.model || n,
        base_url: mp.baseUrl || '',
        api_key: mp.apiKey || '',
        max_tokens: mp.maxTokens ?? undefined,
        temperature: mp.temperature ?? undefined,
        enable_thinking: mp.enable_thinking ?? undefined,
        no_proxy: mp.no_proxy ?? undefined,
        timeout: mp.timeout ?? undefined,
      };
      from[n] = 'master';
    } else if (snapshot[n]) {
      templates[n] = snapshot[n];
      from[n] = 'snapshot';
      missing.push(n);
    } else {
      templates[n] = { name: n, base_url: '', api_key: '' };
      from[n] = 'snapshot';
      missing.push(n);
    }
  }
  const source = !masterOk ? 'snapshot' : (names.length && Object.values(from).every(x => x === 'master') ? 'master' : 'mixed');
  return { templates, from, missing, source };
}

/** 快照对齐：把 resolve 结果写回资产 config.yaml 的 model_templates（保留 stages 与其他键）。
 *  仅当被引用名的参数与现快照不一致时才写（避免无谓重写、丢注释）。
 *  @param {string} assetPath 资产目录绝对路径
 *  @param {object} resolved resolveStageTemplates 的返回值
 *  @returns {{changed:boolean, source:string}} */
export function syncAssetSnapshot(assetPath, resolved) {
  const cfgFile = path.join(assetPath, 'config.yaml');
  if (!fs.existsSync(cfgFile)) return { changed: false, source: resolved?.source || 'master' };
  const assetCfg = readAssetConfig(assetPath);
  if (!assetCfg) return { changed: false, source: resolved?.source || 'master' };
  const oldTpl = (assetCfg.model_templates || {});
  // 只覆盖被引用的名字；未引用的快照模板保留（工作集只增不删，避免误删用户预留）
  const changedNames = Object.keys(resolved.templates).filter(n => {
    const o = oldTpl[n]; const nt = resolved.templates[n];
    if (!o || !nt) return true;
    const diffs = ['name', 'base_url', 'api_key', 'temperature', 'enable_thinking', 'no_proxy', 'timeout', 'max_tokens']
      .filter(k => String(o[k] ?? '') !== String(nt[k] ?? ''));
    return diffs.length > 0;
  });
  if (!changedNames.length) return { changed: false, source: resolved.source };
  const newTpl = { ...oldTpl, ...resolved.templates };
  const next = { ...assetCfg, model_templates: newTpl };
  return { changed: writeYaml(cfgFile, next), source: resolved.source, changedNames };
}

/** 用 python3 yaml 回写（保留 stages/其他键；sort_keys=False 尽量维持顺序）。 */
export function writeYaml(cfgFile, data) {
  try {
    const script = `import yaml,sys,json; d=json.loads(sys.stdin.read()); open(sys.argv[1],'w').write(yaml.safe_dump(d, allow_unicode=True, sort_keys=False, default_flow_style=False))`;
    const r = spawnSync('python3', ['-c', script, cfgFile], { input: JSON.stringify(data), encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

/** 读取资产 config.yaml 解析结果（stages/model_templates/embedding 等）。 */
export function readAssetConfig(assetPath) {
  try {
    const cfgFile = path.join(assetPath, 'config.yaml');
    if (!fs.existsSync(cfgFile)) return null;
    const r = spawnSync('python3', ['-c', 'import yaml,sys,json;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', cfgFile], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout);
  } catch { return null; }
}

/** 一键 resolve + 快照对齐（runner 每次 spawn 前调用）。
 *  @param {string} assetPath 资产目录绝对路径
 *  @returns {{source:string, changed:boolean, missing:string[], templates:object}} */
export function resolveAssetConfig(assetPath) {
  const assetCfg = readAssetConfig(assetPath);
  let master = null;
  try { master = readMaster(); } catch { master = null; }
  const resolved = resolveStageTemplates(assetCfg, master && master.length ? master : null);
  // A master outage is a read-only fallback: never rewrite a usable snapshot with it.
  const sync = resolved.source === 'snapshot'
    ? { changed: false, source: resolved.source }
    : syncAssetSnapshot(assetPath, resolved);
  return { source: sync.source || resolved.source, changed: sync.changed, missing: resolved.missing, templates: resolved.templates };
}

// ══════════════ Embedding 总表（model.embeddingPresets）——与 LLM 同一套逻辑（2026-10-20 用户拍板）══════════════
// 语义与 LLM 对齐：8126 Embedding 总表=调用时权威；资产 config.yaml embedding 段=快照（工作集+离线兜底）；
// 每次 spawn 前 resolve：总表可用且按 name/model 匹配到 → 覆盖 base_url/api_key/dimensions 写回快照；
// 总表不可用/未匹配 → 快照兜底（不改写），run-state 记 embeddingSource。
// 2026-10-20：与 LLM 总表字段全集对齐，embedding 总表也含 timeout/no_proxy（重试参数 max_retries/backoff 属资产运行参数，不进总表）
const EMB_DIFF_KEYS = ['provider', 'baseUrl', 'apiKey', 'model', 'dimensions', 'timeout', 'no_proxy'];

/** 归一化 Embedding 预设条目（总表字段 baseUrl/apiKey 与 config.yaml base_url/api_key 双命名兼容）。
 *  preset 为资产 config.yaml 新增的「总表预设引用」字段（预设名），name 恒为实际模型名。 */
export function normalizeEmbeddingEntry(name, src) {
  if (!src || typeof src !== 'object') return null;
  const get = (a, b) => (src[a] !== undefined && src[a] !== null ? src[a] : src[b]);
  const e = { name: String(name ?? src.name ?? '') };
  if (get('provider', 'provider') !== undefined) e.provider = String(get('provider', 'provider'));
  if (get('baseUrl', 'base_url') !== undefined) e.baseUrl = String(get('baseUrl', 'base_url'));
  if (get('apiKey', 'api_key') !== undefined) e.apiKey = String(get('apiKey', 'api_key'));
  const m = get('model', 'name');
  if (m !== undefined && String(m) !== e.name) e.model = String(m);
  if (get('dimensions', 'dimensions') !== undefined) e.dimensions = Number(get('dimensions', 'dimensions'));
  if (get('timeout', 'timeout') !== undefined) e.timeout = Number(get('timeout', 'timeout'));
  if (get('no_proxy', 'no_proxy') !== undefined) e.no_proxy = Boolean(get('no_proxy', 'no_proxy'));
  return e;
}

/** 资产化前同步：config.yaml 的 embedding 段并入 Embedding 总表（同名覆盖+留痕、新名加入、同值不动）。
 *  2026-10-20：模板有 preset 字段（总表预设引用）→ 按 preset 名定位总表条目并入（模板参数优先，含 timeout/no_proxy）；
 *  无 preset → 回退按 name 合并（旧资产兼容）。
 *  @param {object} embCfg config.yaml 的 embedding 段
 *  @param {(msg:string)=>void} [log]
 *  @returns {{added:string[], updated:string[], kept:string[]}} */
export function mergeEmbeddingTemplateIntoMaster(embCfg, log = () => {}) {
  if (!embCfg || typeof embCfg !== 'object' || !String(embCfg.name || '').trim()) {
    return { added: [], updated: [], kept: [] };
  }
  const presetName = String(embCfg.preset || '').trim();
  const name = String(embCfg.name).trim();
  const master = readEmbeddingMaster();
  // preset 字段显式指向总表预设名：严格按该名定位（找不到 → 按 preset 名新增，不做 model 兜底）；
  // 无 preset（旧资产）→ 按 name 匹配，回退 model 匹配
  const existing = presetName
    ? master.find(p => p.name === presetName) || null
    : (master.find(p => p.name === name) || master.find(p => p.model === name) || null);
  const entryKey = existing ? existing.name : (presetName || name);
  const entry = normalizeEmbeddingEntry(entryKey, embCfg);
  if (!existing) {
    master.push(entry);
    writeEmbeddingMasterPresets(master);
    log(`[llm-presets] 资产化并入 Embedding 总表新增预设：${entryKey}`);
    return { added: [entryKey], updated: [], kept: [] };
  }
  const changed = EMB_DIFF_KEYS.filter(k => entry[k] !== undefined && String(existing[k] ?? '') !== String(entry[k]));
  if (changed.length) {
    for (const k of changed) existing[k] = entry[k];
    writeEmbeddingMasterPresets(master);
    log(`[llm-presets] 资产化同名覆盖 Embedding 总表预设：${existing.name}(${changed.join(',')})（模版参数优先）`);
    return { added: [], updated: [existing.name], kept: [] };
  }
  return { added: [], updated: [], kept: [existing.name] };
}

/** 一键 resolve + 快照对齐（runner 每次 spawn 前调用，与 LLM resolveAssetConfig 同构）。
 *  匹配规则（2026-10-20）：
 *    - 资产 embedding 有 preset 字段（显式引用总表预设名）→ 严格按该名匹配；找不到 → 快照兜底（与 LLM 引用缺失预设同语义）
 *    - 无 preset（旧资产）→ 按 name 匹配，回退总表条目 model 字段匹配
 *  总表覆盖 base_url/api_key/dimensions/timeout/no_proxy（有值才覆盖）；max_retries/retry_backoff 等运行参数保留在快照。
 *  @returns {{source:'master'|'snapshot', changed:boolean, name:string, preset:string, matched:string|null}} */
export function resolveAssetEmbedding(assetPath) {
  const assetCfg = readAssetConfig(assetPath);
  const embCfg = (assetCfg && assetCfg.embedding) || null;
  const embName = embCfg && String(embCfg.name || '').trim();
  const embPreset = embCfg && String(embCfg.preset || '').trim();
  let master = null;
  try { master = readEmbeddingMaster(); } catch { master = null; }
  const masterOk = Array.isArray(master) && master.length > 0;
  let matched = null;
  let source = 'snapshot';
  if (embName && masterOk) {
    if (embPreset) {
      matched = master.find(p => p.name === embPreset) || null;   // 显式引用：严格匹配
    } else {
      matched = master.find(p => p.name === embName) || master.find(p => p.model === embName) || null;   // 旧资产：name → model
    }
    if (matched) source = 'master';
  }
  let changed = false;
  if (matched && embCfg) {
    const next = { ...embCfg };
    if (matched.baseUrl !== undefined) next.base_url = matched.baseUrl;
    if (matched.apiKey !== undefined) next.api_key = matched.apiKey;
    if (matched.dimensions !== undefined) next.dimensions = Number(matched.dimensions);
    if (matched.timeout !== undefined) next.timeout = Number(matched.timeout);
    if (matched.no_proxy !== undefined) next.no_proxy = Boolean(matched.no_proxy);
    const diffKeys = ['base_url', 'api_key', 'dimensions', 'timeout', 'no_proxy'].filter(k => String(embCfg[k] ?? '') !== String(next[k] ?? ''));
    if (diffKeys.length) {
      const cfgFile = path.join(assetPath, 'config.yaml');
      changed = writeYaml(cfgFile, { ...assetCfg, embedding: next });
    }
  }
  return { source, changed, name: embName, preset: embPreset, matched: matched ? matched.name : null };
}