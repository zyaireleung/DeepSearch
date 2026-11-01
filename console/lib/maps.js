// dsh-console/lib/maps.js — wiki/codegraph 标签映射存储（label→pages 单向，存 id+titleAtSave）
// 阶段1：映射管理唯一数据层。schema: { version:1, assets:{}, labels:{词:[{wiki_id,id,titleAtSave}]} }
// 原子写：tmp + rename，防止半写损坏。ESM（dsh-console/package.json type:module）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..');
const FILE = {
  wiki: path.join(DIR, 'wiki-map.json'),
  codegraph: path.join(DIR, 'codegraph-map.json'),
};
const EMPTY = { version: 1, assets: {}, labels: {}, mutedLabels: [] };

export function loadMaps(kind) {
  try {
    return JSON.parse(fs.readFileSync(FILE[kind], 'utf8'));
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveMaps(kind, data) {
  const tmp = FILE[kind] + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE[kind]);
}

/** 标签启用/停用（静音命中）：mutedLabels 存停用标签名。持久化。 */
export function toggleMuted(kind, label, on) {
  const d = loadMaps(kind);
  d.mutedLabels = d.mutedLabels || [];
  const has = d.mutedLabels.includes(label);
  if (on && !has) d.mutedLabels.push(label);
  if (!on && has) d.mutedLabels = d.mutedLabels.filter((l) => l !== label);
  saveMaps(kind, d);
  return d;
}

/** 清理孤儿 muted（标签被删除后停用记录无意义）。 */
function pruneMuted(d) {
  if (!Array.isArray(d.mutedLabels)) return d;
  d.mutedLabels = d.mutedLabels.filter((l) => d.labels[l] && d.labels[l].length > 0);
  return d;
}

export function addLabelRef(kind, label, ref) {
  const d = loadMaps(kind);
  d.labels[label] = d.labels[label] || [];
  if (!d.labels[label].some((r) => r.wiki_id === ref.wikiId && r.id === ref.id)) {
    d.labels[label].push({ wiki_id: ref.wikiId, id: ref.id, titleAtSave: ref.titleAtSave });
  }
  saveMaps(kind, d);
  return d;
}

export function removeLabelRef(kind, label, wikiId, id) {
  const d = loadMaps(kind);
  if (d.labels[label]) {
    d.labels[label] = d.labels[label].filter((r) => !(r.wiki_id === wikiId && r.id === id));
    if (!d.labels[label].length) delete d.labels[label];
  }
  pruneMuted(d);
  saveMaps(kind, d);
  return d;
}

export function renameLabel(kind, old, next) {
  const d = loadMaps(kind);
  if (!d.labels[old] || old === next) return d;
  if (d.labels[next]) d.labels[next] = d.labels[next].concat(d.labels[old]); // 撞同名=并入
  else d.labels[next] = d.labels[old];
  delete d.labels[old];
  saveMaps(kind, d);
  return d;
}

export function dropSource(kind, wikiId, id) {
  const d = loadMaps(kind);
  for (const lb of Object.keys(d.labels)) {
    d.labels[lb] = d.labels[lb].filter((r) => !(r.wiki_id === wikiId && r.id === id));
    if (!d.labels[lb].length) delete d.labels[lb];
  }
  saveMaps(kind, d);
  return d;
}

export function toggleManaged(kind, wikiId, on, name) {
  const d = loadMaps(kind);
  d.assets[wikiId] = d.assets[wikiId] || { managed: false, seeded: false, lastValidate: null };
  d.assets[wikiId].managed = on;
  if (name && String(name).trim()) d.assets[wikiId].name = String(name).trim(); // CG 项目名标签来源（默认隐藏标签）
  saveMaps(kind, d);
  return d;
}

export function getEntryById(kind, wikiId, id) {
  const d = loadMaps(kind);
  for (const [label, refs] of Object.entries(d.labels)) {
    const r = refs.find((x) => x.wiki_id === wikiId && x.id === id);
    if (r) return { label, ref: r };
  }
  return null;
}

export { FILE };
