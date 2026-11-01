// lib/wiki-runner.js —— LLM WIKI 更新执行器（spawn run_fullflow.py + 锁 + 状态 + SIGSTOP/SIGCONT/kill）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, recordAssetUpdate } from './wiki-assets.js';
import * as llmPresets from './llm-presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WIKI_ASSETS_FILE 为可选 env：未设置时回退默认路径（与 wiki-assets.js 一致），防 path.dirname(undefined) 崩。
const assetsFile = () => process.env.WIKI_ASSETS_FILE || path.join(__dirname, '..', '.dsh', 'wiki-assets.json');
const lockFile = () => path.join(path.dirname(assetsFile()), 'wiki-update.lock');
const stateFile = () => path.join(path.dirname(assetsFile()), 'wiki-run-state.json');

let child = null;
let cur = null;   // 当前运行上下文 {id, runId, pid, startedAt, paused, forced}

function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } }
function writeState(s) { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); }
function acquireLock() { try { const fd = fs.openSync(lockFile(), 'wx'); fs.writeSync(fd, String(process.pid)); return true; } catch { return false; } }
function releaseLock() { try { fs.rmSync(lockFile(), { force: true }); } catch {} }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
/** 不只看 PID 存活：PID 可能已复用，必须仍是该资产的 run_fullflow.py。 */
function isExpectedProcess(pid, assetPath) {
  if (!pidAlive(pid) || !assetPath) return false;
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const cmd = String(r.stdout || '');
    return r.status === 0 && cmd.includes('run_fullflow.py') && cmd.includes(assetPath);
  } catch { return false; }
}
/** 服务重启后 child 句柄不可能恢复；将无归属的旧 running 状态收口，避免假运行卡住新任务。 */
function recoverOrphanedState() {
  const s = readState();
  if (!s?.running) return;
  const asset = getAsset(s.asset);
  if (isExpectedProcess(s.pid, asset?.path)) return;
  writeState({ ...s, running: false, paused: false, interrupted: true, stopped: false, lastError: '已中断：服务重启后未找到对应更新进程', doneAt: Date.now() });
  releaseLock();
}

function finalize(code) {
  // error 与 exit 共用（幂等）：Node 的 spawn 失败只保证触发 error、不保证触发 exit，
  // 两者都必须走同一条收尾路径——写最终状态、清空 child/cur、释放锁。
  // 否则 spawn 失败会遗留锁与 running:true 状态，卡死后续所有更新。
  if (!cur) { releaseLock(); return; }
  // 成功完成（exit 0）不记 lastError（stderr 的 import 警告不算错误）；仅失败/中止时取 stderr 尾部
  const err = code === 0 ? null : (stderrBuf || '').trim().slice(-500) || null;
  const finished = new Date().toISOString();
  // 资产摘要不从中间产物推断：以 child 的真实退出码记录本次更新结果。
  recordAssetUpdate(cur.id, { status: code === 0 ? 'success' : (cur.forced ? 'stopped' : 'failed'), at: finished });
  // startedAt 必须保留：完成后 getProgress 仍以它为时间锚判定本批产物（缺失 → stage 变 null）
  // modelSource/embeddingSource 必须保留：运行期在 startUpdate 写入，完成态丢失会破坏「本次来源可追溯」
  const prev = readState() || {};
  writeState({ running: false, paused: false, stopped: !!cur.forced, asset: cur.id, runId: cur.runId, startedAt: cur.startedAt, exit: code, lastError: err, doneAt: Date.now(), modelSource: prev.modelSource || null, embeddingSource: prev.embeddingSource || null });
  cur = null; child = null;
  releaseLock();
}

let stderrBuf = '';

async function startUpdate({ id }) {
  recoverOrphanedState();
  if (!acquireLock()) return { ok: false, reason: '已有更新在跑（锁互斥）' };
  const runId = 'wiki-run-' + Date.now().toString(36);
  const asset = getAsset(id);
  if (!asset) { releaseLock(); return { ok: false, reason: 'asset 未注册' }; }
  // 2026-10-20（用户拍板）：每次 spawn 前以统一 LLM 总表 resolve 资产模型参数并同步 config.yaml 快照；
  // Embedding 同一套逻辑：embedding 总表 resolve → 快照 base_url/api_key/dimensions 跟随（离线兜底，embeddingSource 留痕）。
  let modelSource = 'master';
  let embeddingSource = 'master';
  try {
    const r = llmPresets.resolveAssetConfig(asset.path);
    modelSource = (r && r.source) || 'snapshot';
    if (r && r.changed && r.source !== 'snapshot') console.log(`[wiki-runner] 快照已按统一总表同步：${Object.keys(r.templates || {}).join('、')}`);
    if (modelSource === 'snapshot') console.warn('[wiki-runner] 统一总表不可用/为空，本次使用资产快照模型参数（离线兜底）');
    if (r && r.missing && r.missing.length) console.warn('[wiki-runner] 引用模型在总表缺失（用快照）: ' + r.missing.join('、'));
  } catch (e) { console.warn('[wiki-runner] resolve 失败（继续用资产 config.yaml 快照）: ' + (e && e.message || e)); modelSource = 'snapshot'; }
  try {
    const er = llmPresets.resolveAssetEmbedding(asset.path);
    embeddingSource = (er && er.source) || 'snapshot';
    if (er && er.changed && er.source === 'master') console.log(`[wiki-runner] Embedding 快照已按总表同步：${er.matched || er.name}`);
    if (embeddingSource === 'snapshot' && er && er.name) console.warn('[wiki-runner] Embedding 总表不可用/未匹配，本次使用资产快照（离线兜底）: ' + er.name);
  } catch (e) { console.warn('[wiki-runner] Embedding resolve 失败（用资产快照）: ' + (e && e.message || e)); embeddingSource = 'snapshot'; }
  stderrBuf = '';
  child = spawn('python3', ['scripts/run_fullflow.py'], { cwd: asset.path, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (c) => { stderrBuf = (stderrBuf + String(c)).slice(-2000); });
  cur = { id, runId, pid: child.pid, startedAt: Date.now(), paused: false, forced: false };
  writeState({ running: true, paused: false, stopped: false, asset: id, runId, startedAt: cur.startedAt, pid: child.pid, modelSource, embeddingSource });
  child.once('error', () => finalize(null));
  child.once('exit', (code) => finalize(code));
  return { ok: true, runId, pid: child.pid };
}

function pauseUpdate() { if (!child) return { ok: false, reason: '未在运行' }; try { process.kill(child.pid, 'SIGSTOP'); } catch {} const s = readState() || {}; writeState({ ...s, paused: true }); return { ok: true }; }
function resumeUpdate() { if (!child) return { ok: false, reason: '未在运行' }; try { process.kill(child.pid, 'SIGCONT'); } catch {} const s = readState() || {}; writeState({ ...s, paused: false }); return { ok: true }; }
function stopUpdate() {
  if (!child) return { ok: false, reason: '未在运行' };
  if (cur) cur.forced = true;
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} }, 30000);
  const s = readState() || {}; writeState({ ...s, stopped: true, running: false });
  return { ok: true };
}

function getProgress({ id }) {
  const s = readState() || {};
  const asset = getAsset(s.asset || id);
  let s4 = { total: null, done: null };
  let stage = null;
  if (asset) {
    const t0 = s.startedAt || 0;   // 本次更新起点：只认 t0 之后产生的产物（杜绝上次残留误判）
    s4 = countS4(asset.path, t0);
    stage = currentStage(asset.path, t0);
    // 状态归零：更新一旦开始（无论手动/定时）默认从 S1 起，直到捕捉到本批真实产物
    if (!stage && s.running) stage = 'S1';
  }
  return {
    running: !!s.running, paused: !!s.paused, stopped: !!s.stopped,
    asset: s.asset, runId: s.runId || null,
    lastError: s.lastError || null,
    modelSource: s.modelSource || null,   // 'master'（总表权威）| 'snapshot'（离线兜底）
    embeddingSource: s.embeddingSource || null,   // Embedding 总表权威 | 快照兜底
    elapsedSec: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
    stage,   // "S1"（归零）/"S1/S2" / "S3" / "S4 内容提取" / "S5" / "S6" / "S7" / null
    s4,
  };
}

// ── 批次化状态捕捉（2026-10-19 用户拍板）：每次更新先将状态归零（默认 S1），
//    之后只认「本次更新（startedAt 之后）产生的中间产物」——
//    上次遗留的 overview.md / flow_stage1 等一律不算，杜绝增量运行误报完成态。
//    依据真实产物目录（run_fullflow.py + runtime.py set_batch 核实）：
//      S1/S2: .tmp/flow_stage1/<S1S2-<batch>>-<ts>/（run_s1s2 创建）
//      S3:    .tmp/flow_classify/<S3-<batch>>-<ts>/
//      S4:    .tmp/flow_s4/<batch>/（逐条目 json，S4 提取中=部分）
//      S5:    .tmp/flow_s4/<batch>/s5-results.json 出现
//      S6:    cursor.json 被 run_s6 mark_cursor 重写（last_batch=本批）
//      S7:    overview.md 被 run_s7 重写（mtime=本批）
function currentStage(assetPath, startedAt) {
  if (!startedAt) return null;   // 无本次运行上下文 → 不推断（残留误判根源在此）
  const t0 = startedAt;
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
  const newestDirSince = (parent) => {
    try {
      return fs.readdirSync(parent)
        .map(n => path.join(parent, n))
        .filter(p => { try { return fs.statSync(p).isDirectory() && fs.statSync(p).mtimeMs >= t0; } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    } catch { return null; }
  };
  const ov = mtime(path.join(assetPath, 'overview.md'));
  if (ov !== null && ov >= t0) return 'S7';            // overview 本批重写
  const cu = mtime(path.join(assetPath, 'cursor.json'));
  if (cu !== null && cu >= t0) return 'S6';            // S6 mark_cursor 本批写入
  const s4 = newestDirSince(path.join(assetPath, '.tmp', 'flow_s4'));
  if (s4) {
    if (mtime(path.join(s4, 's5-results.json')) !== null) return 'S5';   // S5 完成
    return 'S4 内容提取';
  }
  if (newestDirSince(path.join(assetPath, '.tmp', 'flow_classify'))) return 'S3';
  if (newestDirSince(path.join(assetPath, '.tmp', 'flow_stage1'))) return 'S1/S2';
  return null;
}

function countS4(assetPath, startedAt) {
  // 只统计「本次更新」的批次产物；S8 清理 flow_stage1 后 total 回退 done（不归零）。
  const t0 = startedAt || 0;
  const newestDirSince = (parent) => {
    try {
      return fs.readdirSync(parent)
        .map(n => path.join(parent, n))
        .filter(p => { try { return fs.statSync(p).isDirectory() && fs.statSync(p).mtimeMs >= t0; } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    } catch { return null; }
  };
  let total = null, done = null;
  const stage1 = newestDirSince(path.join(assetPath, '.tmp', 'flow_stage1'));
  if (stage1) {
    total = 0;
    try {
      for (const f of fs.readdirSync(stage1)) {
        if (!f.endsWith('.json')) continue;
        const d = JSON.parse(fs.readFileSync(path.join(stage1, f), 'utf8'));
        total += (d['filter·s1'] && d['filter·s1'].extraction ? d['filter·s1'].extraction.length : 0);
      }
    } catch { total = null; }
  }
  const s4 = newestDirSince(path.join(assetPath, '.tmp', 'flow_s4'));
  if (s4) {
    try {
      done = fs.readdirSync(s4).filter(f => /__.+\.json$/.test(f) && f !== 'records.json' && f !== 's5-results.json').length;
    } catch { done = null; }
  }
  // S8 已清理 flow_stage1（无出错保留）→ total 读不到 → 回退 done（完成态 100%，不归零）
  if (total === null && done !== null) total = done;
  return { total, done };
}

// 阶段判定（无结构化事件流，从真实中间产物推导；无法判定则未知）：
//   S1/S2: flow_stage1/<S1S2-*>/run.json complete:true   | S3: flow_classify/<S3-*>/ 存在
//   S4: flow_s4/<batch>/ per-entry json 生成中；records.json 出现 = S4 完成
//   S5: s5-results.json 出现                              | S6: entities/ 非空 + cursor.json documents 非空
//   S7: overview.md 存在

/** 删除资产后清理其残留运行状态（2026-10-22 用户发现：删资产只清注册表，
 *  run-state 残留 lastError → 前端持续显示「上次更新失败」提示条）。
 *  仅当 run-state.asset === 被删 id 时清空 lastError/asset；running 标志保留
 *  （若真在运行，其 finalize 收尾会重写状态；此处不误清运行中资产）。 */
export function clearAssetStaleState(id) {
  const s = readState();
  if (!s || s.asset !== id) return { ok: true, cleared: false };
  writeState({ ...s, asset: null, lastError: null });
  return { ok: true, cleared: true };
}

export { startUpdate, pauseUpdate, resumeUpdate, stopUpdate, getProgress, currentStage, countS4, recoverOrphanedState };
