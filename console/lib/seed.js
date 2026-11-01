// dsh-console/lib/seed.js — wiki / codegraph 标签 LLM 冷启动提词（阶段1 种子）
// 模型强制 = MemoryKnowledge/.env 全局配置（与 Wiki 摄入模型一致，禁止其他模型）
// 输入 = wiki: 页面 title；cg: 符号 name + kind + 文件路径
// 原理（2026-09-21 t9d 定稿）：命名任务——名字是指示符，用户输入它唯一定位该页；
//   固有称呼（专名/术语/符号名）按本来形态作名字，任何改写丢指代性；类别描述不是名字；无检索价值页给空数组。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as maps from './maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 修复 2026-09-20 (t9b 复测发现)：readKsEnv 必须与 saveKsEnv 一致遵循 TDAI_BASE。
// 此前硬编码 __dirname/../../MemoryKnowledge/.env（沙盒下落在 .sandbox-run/MemoryKnowledge/.env），
// 而 saveKsEnv 写 TDAI_BASE/MemoryKnowledge/.env —— 读写指向两个文件，改模型后显示仍是旧值。
const KS_ENV = process.env.TDAI_BASE
  ? path.join(process.env.TDAI_BASE, 'MemoryKnowledge', '.env')
  : path.join(__dirname, '../../MemoryKnowledge/.env');

export function readKsEnv() {
  const raw = fs.readFileSync(KS_ENV, 'utf8');
  const kv = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return {
    baseUrl: kv.LLM_BASE_URL || 'http://127.0.0.1:18088/v1',
    model: kv.LLM_MODEL || 'Qwen3.8-27B-4bit',
    key: kv.LLM_API_KEY || 'asdf',
    maxTokens: Number(kv.LLM_MAX_TOKENS || 32768),
  };
}

const STRUCTURAL = /^(index|log|overview|purpose|schema|persona)([\s_/-]|$)/i;

function buildPrompt(batch) {
  // t9d V9（2026-09-21）：命名任务——无损指代；无范例无反例（用户准则：范例/反例多数情况是干扰项）；完整名称优先，别名仅无损等价时给
  return `你是"检索名"命名器。为每个 wiki 页面产出用户在检索时会输入、用来找到这个页面的词（0-1 个）。
核心判定：名字是指示符——用户输入它，能唯一定位到这个页面。
1. 页面的名字优先用其完整名称（标题的核心完整称呼），按本来形态给出，不翻译、不省略、不概括；
2. 仅当存在无损等价的说法（意思完全不变、细节不丢、无歧义）时才可补 1 个别名；否则只给完整名称；
3. 用途/类别描述不是名字（概括页面"讲什么"的词无法定位特定页面），不用。
只输出 JSON：{"<page_id>": ["名字"]}
页面（page_id | title）：
${batch.map((p) => `${p.id} | ${p.title}`).join('\n')}`;
}

function buildCgPrompt(batch) {
  // t9d V8（2026-09-21）：命名任务——无损指代；符号名完整给出，别名仅无损等价时给，不做价值判断（删除兜底）
  return `你是"检索名"命名器。为每个 CodeGraph 节点产出用户在检索时会输入、用来找到这个节点的词（0-1 个）。
核心判定：名字是指示符——用户输入它，能唯一定位到这个节点。
1. 节点的名字 = 它的符号名（函数名/常量名/类名/文件名等），按本来形态完整给出，不翻译、不概括、不省略；
2. 仅当存在无损等价的说法（意思完全不变、细节不丢、无歧义）时才可补 1 个别名；否则只给符号名本身；
3. 用途/类别描述不是名字（概括节点"做什么"的词无法定位特定节点），不用。
只输出 JSON：{"<node_id>": ["名字"]}
节点（node_id | kind | name | 文件路径）：
${batch.map((n) => `${n.id} | ${n.kind || ''} | ${n.name || ''} | ${n.file_path || ''}`).join('\n')}`;
}

/** 公共 LLM 调用：单次 prompt → JSON 对象。返回 {} 失败兜底。 */
async function llmJson(cfg, prompt) {
  const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: Math.min(cfg.maxTokens, 8192),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

/** 只保留 LLM 返回中 key 确实命中候选 id 的条目（防 LLM 改写 id/哈希）。 */
function pickKnown(result, knownIds) {
  const out = {};
  for (const [id, labels] of Object.entries(result || {})) {
    if (knownIds.has(id)) out[id] = Array.isArray(labels) ? labels : [];
  }
  return out;
}

/** wiki 种子（2026-09-22 机械登记：去 LLM——名称即桥，title 原样入标签；保留结构页正则跳过） */
export async function seedLabels(cfg, pages, { dryRun = true, maxPages = 3, kind = 'wiki', wikiId = '' } = {}) {
  const candidates = (pages || [])
    .filter((p) => p && p.id && p.title)
    .filter((p) => !STRUCTURAL.test(p.id) && !STRUCTURAL.test(p.title));
  const batch = candidates.slice(0, maxPages);
  if (!batch.length) return { ok: true, generated: [], skippedStructural: candidates.length === 0, dryRun };
  const titleOf = {};
  for (const p of batch) titleOf[p.id] = p.title;
  // 机械登记：完整名称（title）原样作标签；无价值判断不做（用户拍板：全登记+人工停用兜底）
  const generated = batch.map((p) => ({ page_id: p.id, labels: [p.title.trim()] }));
  if (!dryRun && wikiId) {
    for (const g of generated) {
      for (const lb of g.labels) {
        const label = String(lb).trim();
        if (label) maps.addLabelRef(kind, label, { wikiId, id: g.page_id, titleAtSave: titleOf[g.page_id] });
      }
    }
  }
  return { ok: true, generated, skippedStructural: candidates.length === 0, dryRun };
}

/** codegraph 种子（2026-09-22 机械登记：去 LLM——符号名即桥，name 原样入标签） */
export async function seedCgLabels(cfg, nodes, { dryRun = true, maxNodes = 20, cgId = '' } = {}) {
  const candidates = (nodes || []).filter((n) => n && n.id);
  const batch = candidates.slice(0, maxNodes);
  if (!batch.length) return { ok: true, generated: [], dryRun };
  const nameOf = {};
  for (const n of batch) nameOf[n.id] = n.name || n.file_path || n.id;
  // 机械登记：符号名原样作标签
  const generated = batch.map((n) => ({ node_id: n.id, labels: [nameOf[n.id].trim()] }));
  if (!dryRun && cgId) {
    for (const g of generated) {
      for (const lb of g.labels) {
        const label = String(lb).trim();
        if (label) maps.addLabelRef('codegraph', label, { wikiId: cgId, id: g.node_id, titleAtSave: nameOf[g.node_id] });
      }
    }
  }
  return { ok: true, generated, dryRun };
}

/** 兼容旧导出（server 未用，外部脚本可能引用）。 */
export async function generateForBatch(cfg, batch) {
  return llmJson(cfg, buildPrompt(batch));
}
