/**
 * wiki 资产挂载（② 骨架，方案 § 四 L2-A / 待确认项 3）
 *
 * 真源：<console>/../.dsh/wiki-assets.json 的 assets[]，挂载谓词 = enabled && state==="ready"。
 * 只读探测；不写回、不推断。挂载后的块分区（wiki_blocks）由后续同步（⑥/⑦）填充。
 */
import { readFileSync } from "node:fs";

/** 读取资产清单（缺文件 → 空数组；不抛） */
export function readAssets(wikiAssetsJsonPath) {
  try {
    const raw = readFileSync(wikiAssetsJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.assets) ? parsed.assets : [];
  } catch {
    return [];
  }
}

/** 挂载谓词：enabled && state==="ready"（真源确认，待确认项 3） */
export function isMounted(a) {
  return Boolean(a?.enabled && a?.state === "ready");
}

/** 已挂载资产（enabled + state=ready）→ [{ id, name, path }] */
export function mountedAssets(wikiAssetsJsonPath) {
  return readAssets(wikiAssetsJsonPath)
    .filter(isMounted)
    .map((a) => ({ id: a.id, name: a.name, path: a.path }));
}

/** 资产路径回源（按 id 取 path；未挂载/不存在 → null） */
export function assetPath(wikiAssetsJsonPath, assetId) {
  const a = readAssets(wikiAssetsJsonPath).find((x) => x.id === assetId);
  return a && isMounted(a) ? a.path : null;
}
