/**
 * evoke-core.js —— 唤起判定 → deep_search 检索 → 强锚点准入 → 预算分配 → 胶囊渲染
 *
 * 唯一实现（唤起测试 /api/evoke/test 与真实注入同源）：
 *   A 信号词门控：命中信号词 → 整条消息为 query
 *   B 显式指令：命中指令词 → 指令词与最近标点之间的文本为 query（原 C，语义兜底已删除）
 *
 * 准入（宁缺毋滥）：anchorHits ≥ 1（片段 exact 锚点）或 atomExactCount > 0（整段 exact span）。
 *   源预设只决定检索范围，不改准入规则。
 *
 * 预算（板块一 900 上限/1300 弹性 · 板块二 ov_session 400）：
 *   板块一 900 是上限非下限：默认 900；强锚点命中装不进 900 才浮到 1300。
 *   板块二 ov_session：≤400 完整展示，>400 不显示。
 */

import { executeSearch } from './search/engine.js';

/** 句末标点（B 模式 query 截断用） */
const SENTENCE_END = /[。！？；，,.!?;~—…]/;

/**
 * B 模式 query 提取：取指令词之后到最近句末标点之间的文本（不含指令词与标点）。
 * 指令词紧跟标点（之间为空）→ 顺延到下一个标点，避免 B 模式丢命中。
 * 无标点 → 取指令词之后的全部剩余文本。
 */
export function extractCommandQuery(text, commandWord) {
  const t = String(text || '');
  const i = t.indexOf(commandWord);
  if (i < 0) return '';
  let rest = t.slice(i + commandWord.length);
  let q = '';
  while (rest.length) {
    const m = rest.match(SENTENCE_END);
    if (!m) { q = rest; break; }
    q = rest.slice(0, m.index);
    if (q.trim()) break;              // 有实质内容 → 取这段
    rest = rest.slice(m.index + 1);   // 空段（信号词紧跟标点）→ 顺延
  }
  return q.trim();
}

/** 唤起判定：按 B(显式指令) → A(信号词) 优先级返回 { mode, query }；两模式全关 → null */
export function decideEvoke(cfg, text) {
  const t = String(text || '');
  const modes = cfg.modes || { A: true, B: false };
  // B 优先：显式指令最精准，query = 指令词与最近标点之间的文本
  if (modes.B) {
    const words = cfg.commandWords || [];
    for (const w of words) {
      if (w && t.includes(w)) {
        const q = extractCommandQuery(t, w);
        if (q) return { mode: 'B', query: q };
      }
    }
  }
  // A：信号词门控，整条消息为 query
  if (modes.A) {
    const words = cfg.signalWords || [];
    const hit = words.find((w) => w && t.includes(w));
    if (hit) return { mode: 'A', query: t };
  }
  return null;
}

/**
 * 强锚点准入：anchorHits ≥ 1 或 atomExactCount > 0。
 * 无命中 → false（宁缺毋滥，不展示）。
 */
export function passGate(r) {
  const cr = r.contentRank || {};
  return (cr.anchorHits ?? 0) >= 1 || (cr.atomExactCount ?? 0) > 0;
}

/**
 * 唤起召回主链路。deps = runDeps(query, sessionId) 返回的检索依赖；
 * wikiMaps = enabledWikiMaps() 返回的 { enabledWikiAssetIds, enabledWikiAssets }（fuzzy_history 的 wiki:<code> 解析必需）。
 * 返回 { ok, hit, mode, query, preset, board1, board2, block, gateStats }
 */
export async function evokeRecall(cfg, text, deps, wikiMaps = {}) {
  const decided = decideEvoke(cfg, text);
  if (!decided) return { ok: true, hit: false, mode: null, query: '', block: '', board1: [], board2: [], gateStats: { reason: 'no-mode' } };
  const { mode, query } = decided;
  const preset = cfg.sourcePreset || 'fuzzy_mem0_find';

  // 板块一/板块二两路检索相互独立 → 并行执行（原串行=耗时相加，是"慢"的主因之一）
  const t0 = Date.now();
  const [b1Res, b2Res] = await Promise.all([
    executeSearch({ query, method: preset, limit: 20, ...wikiMaps }, deps).catch(() => ({ page: null })),
    // 板块二：单独检索 ov_session（fuzzy_mem0_find 不含该源）；显式 sources=['ov_session'] 只跑这一源，不跑 fuzzy_full 全源
    executeSearch({ query, method: 'fuzzy_full', sources: ['ov_session'], limit: 20, ...wikiMaps }, deps).catch(() => ({ page: null })),
  ]);
  const searchMs = Date.now() - t0;
  const results = b1Res?.page?.results || [];
  const sessionResults = (b2Res?.page?.results || []).filter((x) => x.source === 'ov_session');

  // 无强锚点准入（2026-11-03 用户定案）：强锚点本质是语义判断，脚本格式/长度/句式规则判不准
  // → 放弃强锚点，改为"简易相关性记忆检索推荐"：deep_search 已按相关性排序，结果全部呈现，宁多勿缺。
  // 板块一 = 非 ov_session；板块二 = ov_session
  const board1 = results.filter((r) => r.source !== 'ov_session');
  const board2 = sessionResults;

  const block = renderBlock({ ...cfg, __query: query }, board1, board2);
  return {
    ok: true,
    hit: block.length > 0,
    mode,
    query,
    preset,
    board1,
    board2,
    block,
    searchMs,
    gateStats: { total: results.length + sessionResults.length, passed: results.length + sessionResults.length, b1: board1.length, b2: board2.length },
  };
}

/** 条目正文（跨源统一取 text，缺失回退 abstract/snippet）。压缩内部换行→单行，避免一条记忆被空行拆成多段 */
function bodyOf(r) {
  return String(r.text || r.abstract || r.snippet || '').replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * 板块一概要句过滤：只留真正的记忆概要句，剔除 OV 实体页/知识库路径节点。
 * 用户拍板（2026-11-03）：板块一只留真正的记忆概要句，路径/overview 列表不进板块一。
 * 判据：viking:// 路径、.md 文件、# 标题、overview、纯链接列表（- [x](./x.md)）→ 剔除。
 */
export function isSummaryText(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.startsWith('viking://')) return false;
  if (/\.(md|json|js|ts|py)\b/i.test(t.slice(0, 200)) && /#{1,6}\s|\.overview|Entities Overview|entities\//i.test(t)) return false;
  if (/^#{1,6}\s/.test(t)) return false;                       // markdown 标题开头
  if (/(Entities Overview|\.overview\.md)/i.test(t)) return false;
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length >= 2) {
    const linkLines = lines.filter((l) => /^\s*-\s*\[.*\]\(.*\)/.test(l) || /^\s*-\s*\S+\.(md|json)\b/i.test(l)).length;
    if (linkLines / lines.length >= 0.5) return false;          // 过半是链接/文件列表 → 路径节点
  }
  return true;
}

/** 板块一预算：默认 p1Base（900）；强锚点命中装不下才浮到 p1Max（1300） */
function board1Budget(cfg, items) {
  const base = cfg.p1Base ?? 900;
  const max = cfg.p1Max ?? 1300;
  // 按准入序（executeSearch 已按 compareContentRank 排好）累加长度，超 base 则尝试 max
  let need = 0;
  for (const r of items) { need += bodyOf(r).length + 2; if (need > base) break; }
  return need > base ? max : base;
}

/**
 * 胶囊渲染（格式对齐 tdai `<tdai_memory_recall>`，内容 = deep_search 四源强锚点结果）。
 * 板块一整条放不下不截半条；板块二 ≤p2Max 完整展示，>p2Max 不显示。
 */
export function renderBlock(cfg, board1, board2) {
  const lines = [];
  const b1 = board1 || [];
  const b2 = board2 || [];
  if (!b1.length && !b2.length) return '';

  lines.push('<tdai_memory_recall （命中以下历史记忆，供参考）>');

  if (b1.length) {
    const budget = board1Budget(cfg, b1);
    let used = 0;
    const pushed = [];
    for (const r of b1) {
      const content = bodyOf(r);
      if (!content) continue;
      if (!isSummaryText(content)) continue; // 板块一只留记忆概要句，路径/overview 节点剔除
      if (used + content.length + 2 > budget) continue; // 整条放不下不截半条
      pushed.push(`- ${content}`);
      used += content.length + 2;
    }
    lines.push(...pushed);
  }

  if (b2.length) {
    const p2Max = cfg.p2Max ?? 400;
    // 板块二 = 总量 p2Max 预算（用户拍板 2026-11-03）：按排序依次放入【完整原文，不截断】，
    // 累加超预算即跳过该条继续看下一条（不截半条）；全超预算 → 整段(含分隔符)不显示。
    const lines2 = [];
    let used2 = 0;
    for (const r of b2) {
      const content = bodyOf(r);
      if (!content) continue;
      if (used2 + content.length > p2Max) continue; // 超剩余预算 → 跳过（不截断）
      lines2.push(`- ${content}`);
      used2 += content.length;
    }
    if (lines2.length) {
      lines.push('── 原始对话节选 ──');
      lines.push(...lines2);
    }
  }

  // 板块三 · 固定说明（尾）：只要胶囊有内容就渲染 cmdText，<你的问题> 用本轮 query 置换
  let cmd = String(cfg.cmdText || '').trim();
  if (cmd) {
    const key = String(cfg.__query || '').trim().slice(0, 120);
    if (key) cmd = cmd.replaceAll('<你的问题>', key);
    lines.push(cmd);
  }

  lines.push('</tdai_memory_recall>');
  return lines.join('\n');
}
