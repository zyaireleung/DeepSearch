// lib/wiki-assets.js —— LLM WIKI 资产注册表（独立 JSON 文件，不动 console-config.json）
// ESM（生产 package.json type=module，server.js 用 import 加载本模块）
//
// 资产说明模型（2026-10-30 用户定）：每个资产 = { code, description }。
//   code        工具调用参数标识（source id = `wiki:<code>`，如 wiki:history），唯一、字符集受限；
//   description 单文本说明（纯文本编辑框）。
// 旧模型 { contains, excludes }（保存什么/不保存什么）读取时自动迁移为单文本（取 contains）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = () => process.env.WIKI_ASSETS_FILE || path.join(__dirname, '..', '.dsh', 'wiki-assets.json');

export function loadAssets() {
  try { return JSON.parse(fs.readFileSync(p(), 'utf8')); } catch { return { assets: [] }; }
}

export function saveAssets(d) {
  fs.mkdirSync(path.dirname(p()), { recursive: true });
  fs.writeFileSync(p(), JSON.stringify(d, null, 2));
}

/** 资产说明空默认值（单文本）。 */
export const EMPTY_DESCRIPTION = '';

/** 迁移/归一化资产说明：字符串直接用；旧对象 {contains,excludes} 取 contains；缺失 → 空串。 */
export function descriptionOf(a) {
  if (!a) return EMPTY_DESCRIPTION;
  const d = a.description;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') return typeof d.contains === 'string' ? d.contains : '';
  return EMPTY_DESCRIPTION;
}

/** name → code（仅小写字母数字，无连字符）；空 → ''。 */
export function slugifyCode(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** 资产 code：显式 code 优先，否则 name slug，否则内部 id（保底）。 */
export function codeOf(a) {
  if (!a) return '';
  if (typeof a.code === 'string' && a.code.trim()) return a.code.trim();
  return slugifyCode(a.name) || a.id || '';
}

/** 读取视图：统一补 code + description（不写盘；JSON 只在显式更新时落 code/description）。 */
function withMeta(a) {
  if (!a) return a;
  return { ...a, code: codeOf(a), description: descriptionOf(a) };
}

export function listAssetsW() { return loadAssets().assets.map(withMeta); }

export function getAsset(id) { return withMeta(listAssetsW().find(a => a.id === id)) || null; }

/** 资产说明写盘归一化：payload = { code?, description? }（新）或 { contains?, excludes? }（旧迁移）。 */
export function updateAssetDescription(id, payload) {
  const d = loadAssets();
  const asset = d.assets.find(x => x.id === id);
  if (!asset) return { ok: false, reason: 'not found' };
  const p = payload || {};
  // 描述：新模型 description 字符串，或旧模型 contains（迁移）
  let description = null;
  if (typeof p.description === 'string') description = p.description.trim();
  else if (typeof p.contains === 'string') description = p.contains.trim();
  if (description === null) return { ok: false, reason: 'description 必须是非空字符串' };
  if (!description) return { ok: false, reason: 'description 不能为空（不会让资产时空白说明）' };
  // code：显式提供，否则保留既有，否则从 name 派生
  let code = codeOf(asset);
  if (typeof p.code === 'string' && p.code.trim()) code = p.code.trim();
  if (!code) return { ok: false, reason: 'code 不能为空' };
  if (!/^[a-z0-9]+$/.test(code))
    return { ok: false, reason: 'code 只能是小写英文字母和数字，无连字符 / 空格 / 符号' };
  if (d.assets.some(x => x.id !== id && codeOf(x) === code))
    return { ok: false, reason: `code 已存在：${code}` };
  asset.code = code;
  asset.description = description;
  saveAssets(d);
  return { ok: true, asset: withMeta(asset) };
}

export function registerAsset({ id, name, path: assetPath, enabled = true, state = 'ready', code, description }) {
  const d = loadAssets();
  if (d.assets.some(a => a.id === id)) return { ok: true, asset: getAsset(id) };
  // code：可选提供；提供则校验非空 / 字符集 / 全局唯一（新建资产必填，前端已保证）
  let finalCode = null;
  if (code != null) {
    if (typeof code !== 'string' || !code.trim()) return { ok: false, reason: 'code 不能为空' };
    finalCode = code.trim();
    if (!/^[a-z0-9]+$/.test(finalCode))
      return { ok: false, reason: 'code 只能是小写英文字母和数字，无连字符 / 空格 / 符号' };
    if (d.assets.some(x => codeOf(x) === finalCode)) return { ok: false, reason: `code 已存在：${finalCode}` };
    // 新增资产必带说明（用户：保证每个新增的资产都有 code 和说明，不会有空白）
    if (typeof description !== 'string' || !description.trim())
      return { ok: false, reason: 'description 不能为空（新增资产必须有说明）' };
  }
  const asset = { id, name, path: assetPath, enabled, state, registeredAt: new Date().toISOString(), lastUpdate: null, lastStatus: null };
  if (finalCode != null) asset.code = finalCode;
  asset.description = typeof description === 'string' ? description.trim() : EMPTY_DESCRIPTION;
  d.assets.push(asset); saveAssets(d); return { ok: true, asset: withMeta(asset) };
}

/** 新建任务确认后立即写入注册表，以便导入/配置两页同步显示“新建中”。 */
export function registerPendingAsset({ id, name, path: assetPath, code, description }) {
  return registerAsset({ id, name, path: assetPath, enabled: false, state: 'pending-assetize', code, description });
}

export function setAssetState(id, state) {
  const d = loadAssets(); const a = d.assets.find(x => x.id === id);
  if (!a) return { ok: false, reason: 'not found' };
  a.state = state; saveAssets(d); return { ok: true, asset: a };
}

/** 更新任务终态独立写回资产摘要，供列表/定时任务用户界面读取。 */
export function recordAssetUpdate(id, { status, at = new Date().toISOString() } = {}) {
  const d = loadAssets(); const a = d.assets.find(x => x.id === id);
  if (!a) return { ok: false, reason: 'not found' };
  a.lastUpdate = at;
  a.lastStatus = status || null;
  saveAssets(d);
  return { ok: true, asset: a };
}

export function unregisterAsset(id) {
  const d = loadAssets(); const n = d.assets.length;
  d.assets = d.assets.filter(a => a.id !== id);
  if (d.assets.length === n) return { ok: false, reason: 'not found' };
  saveAssets(d); return { ok: true };
}

export function setAssetEnabled(id, enabled) {
  const d = loadAssets(); const a = d.assets.find(x => x.id === id);
  if (!a) return { ok: false, reason: 'not found' };
  if (a.state && a.state !== 'ready') return { ok: false, reason: '资产新建中，完成后才可开关' };
  a.enabled = !!enabled; saveAssets(d); return { ok: true, asset: a };
}

export function _reset() { fs.rmSync(p(), { force: true }); }
