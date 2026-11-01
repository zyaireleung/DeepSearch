// lib/wiki-queue.js —— LLM WIKI 统一任务队列（2026-10-19 用户拍板 v2：持久化 + 中断恢复）
//
// 单一队列、严格串行：手动更新 / 定时多资产更新 / 新增资产化 全部入队，
// 永远只有一个任务在执行，任务间天然无锁竞争、无阻塞冲突。
//
// 用户核心要求（2026-10-19）：不能完全指望资产自身的状态判定任务完成——
// 资产解析流程可能出错、中断（server 重启 / 进程被杀），正常流程状态正常
// 不代表异常状态没问题。因此本队列：
//   1. 队列持久化到磁盘（qstate 文件）：pending + current 落盘，server 重启可恢复
//   2. 任务完成判定不依赖资产状态文件：等待「子进程 pid 不再存活 OR 锁释放」双条件
//   3. 启动恢复：update 中断→接管/清理；assetize 半完成→检测骨架后补注册或标记
//   4. 错误隔离：单任务失败不影响后续任务
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerAsset, setAssetState } from './wiki-assets.js';
import { startUpdate } from './wiki-runner.js';
import * as llmPresets from './llm-presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// WIKI_ASSETS_FILE 为可选 env：未设置时回退默认路径（与 wiki-assets.js 一致），
// 避免 path.dirname(undefined) TypeError（生产 8126 首次新增 wiki 崩、取消 409 的根因）。
const assetsFile = () => process.env.WIKI_ASSETS_FILE || path.join(__dirname, '..', '.dsh', 'wiki-assets.json');
const qstateFile = () => path.join(path.dirname(assetsFile()), 'wiki-queue.json');
const lockFile = () => path.join(path.dirname(assetsFile()), 'wiki-update.lock');

// ── 持久化状态（模块级单例）──
let queue = [];          // 待执行任务 [{type,id,path,assetizeSelf}]
let current = null;      // 正在执行 {type,id,path,pid,startedAt,assetizeSelf}
let working = false;
let lastError = null;

function qread() {
  try { return JSON.parse(fs.readFileSync(qstateFile(), 'utf8')); } catch { return null; }
}
function qwrite() {
  try {
    fs.mkdirSync(path.dirname(qstateFile()), { recursive: true });
    fs.writeFileSync(qstateFile(), JSON.stringify({ queue, current, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.warn('[wiki-queue] 队列持久化失败:', String(e && e.message || e));
  }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** PID 可被系统复用；恢复时必须验证它仍是该资产的 run_fullflow.py，不能只看 kill(pid,0)。 */
function isExpectedUpdateProcess(pid, assetPath) {
  if (!pidAlive(pid) || !assetPath) return false;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmd.includes('run_fullflow.py') && cmd.includes(assetPath);
  } catch {
    // macOS 没有 /proc：ps 是只读进程元数据，失败即保守判为不接管。
    try {
      const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      const cmd = String(out.stdout || '');
      return out.status === 0 && cmd.includes('run_fullflow.py') && cmd.includes(assetPath);
    } catch { return false; }
  }
}
function lockExists() { try { fs.accessSync(lockFile()); return true; } catch { return false; } }
function readRunnerState() {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(assetsFile()), 'wiki-run-state.json'), 'utf8')); } catch { return null; }
}

function getQueueStatus() {
  const total = queue.length + (current ? 1 : 0);
  return {
    running: current ? { type: current.type, asset: current.id || null, path: current.path || null, pid: current.pid || null, position: 1, total } : null,
    pending: queue.length,
    total,
    tasks: queue.map((t, index) => ({ type: t.type, id: t.id || null, path: t.path || null, position: index + (current ? 2 : 1), total })),
    lastError,
  };
}

/** 入队：任何任务统一进队，立即持久化；空闲即启动 worker。 */
function cancelPendingAssetize(id) {
  const index = queue.findIndex(t => t.type === 'assetize' && t.id === id);
  if (index < 0) return { ok: false, reason: '仅等待中的新建任务可取消' };
  const [task] = queue.splice(index, 1);
  qwrite();
  return { ok: true, task };
}

function enqueue(task) {
  if (!task || !task.type) return { ok: false, reason: '任务类型必填' };
  if (!['update', 'assetize'].includes(task.type)) return { ok: false, reason: '未知任务类型' };
  if (task.type === 'update' && !task.id) return { ok: false, reason: '更新任务缺少资产 id' };
  if (task.type === 'assetize' && (!task.id || !task.path || !task.assetizeSelf)) return { ok: false, reason: '资产化任务参数不完整' };
  const normalized = { ...task };
  // 同一资产的重复“更新”请求不再堆积：正在跑或已排队的那一份即可覆盖本轮意图。
  // assetize 不去重，因为尚未注册前路径/身份才是唯一可靠线索。
  if (normalized.type === 'update' && ((current && current.type === 'update' && current.id === normalized.id) || queue.some(t => t.type === 'update' && t.id === normalized.id))) {
    return { ok: true, queued: true, duplicate: true, position: 0 };
  }
  queue.push(normalized);
  const position = (current ? 1 : 0) + queue.length;
  qwrite();
  pump();
  return { ok: true, queued: true, position };
}

/** server 启动恢复：读取 qstate，接管/清理中断任务后继续排空队列。 */
function recoverQueue() {
  const s = qread();
  if (!s) return;
  queue = Array.isArray(s.queue) ? s.queue : [];
  const c = s.current;
  if (c && c.type === 'update') {
    // 更新中断恢复：PID 存活还不够，必须仍是该资产的 run_fullflow.py，防 PID 复用误接管。
    const asset = getRegisteredAsset(c.id);
    if (isExpectedUpdateProcess(c.pid, asset?.path)) {
      current = { ...c, startedAt: Date.now() };
      working = true;
      console.log('[wiki-queue] 恢复：接管进行中的更新 pid=' + c.pid);
      waitUpdateEnd(c.pid, c.id).then(async ok => {
        current = null; working = false;
        // 首次解析恢复收尾：根据进程退出码置 ready / first-update-failed（与正常路径一致）
        const isFirst = !!c.firstUpdate || !!asset && asset.state === 'assetize-done';
        await finalizeUpdateState({ id: c.id, firstUpdate: isFirst });
        if (ok) console.log('[wiki-queue] 恢复任务完成');
        pump();
      }).catch(e => { current = null; working = false; lastError = String(e.message || e).slice(0, 500); pump(); });
    } else {
      // 旧 PID、无进程或资产不匹配：不接管；只清理本队列残留锁，记录中断后继续。
      try { fs.rmSync(lockFile(), { force: true }); } catch {}
      current = null;
      lastError = `恢复：中断的更新任务（${c.id}）进程不存在或不匹配`;
      console.warn('[wiki-queue] 恢复：中断更新任务（' + c.id + '）已清理锁');
    }
  } else if (c && c.type === 'assetize') {
    // 资产化中断恢复：检测骨架是否已就位（半完成则视为失败，留待用户重试）
    const done = isAssetSkeleton(c.path);
    if (done && !hasRegistered(c.id)) {
      registerAsset({ id: c.id, name: path.basename(c.path), path: c.path });
      console.log('[wiki-queue] 恢复：资产化已完成但未注册，补注册 ' + c.id);
    } else if (!done) {
      lastError = `恢复：资产化中断（${c.path}），目录未完成资产化，请删除后重新新增`;
      console.warn('[wiki-queue] 恢复：资产化中断，骨架未就位 ' + c.path);
    }
    current = null;
  }
  qwrite();
  pump();
}

/** 资产骨架判定：scripts/ + config.yaml + prompts/ + schema/ 齐备（与 server isAssetSkeleton 一致）。 */
function isAssetSkeleton(target) {
  try { return ['scripts', 'config.yaml', 'prompts', 'schema'].every(n => fs.existsSync(path.join(target, n))); } catch { return false; }
}
function getRegisteredAsset(id) {
  try {
    const d = JSON.parse(fs.readFileSync(assetsFile(), 'utf8'));
    return (d.assets || []).find(a => a.id === id) || null;
  } catch { return null; }
}
function hasRegistered(id) { return !!getRegisteredAsset(id); }

// ── 串行 worker ──
async function pump() {
  if (working) return;
  const task = queue.shift();
  if (!task) { qwrite(); return; }
  working = true;
  current = { ...task, pid: null, startedAt: Date.now() };
  if (current.type === 'assetize') setAssetState(current.id, 'assetizing');
  qwrite();
  try {
    await execute(current);
    lastError = null;
  } catch (e) {
    lastError = String(e && e.message || e).slice(0, 500);
    if (current.type === 'assetize') setAssetState(current.id, 'assetize-failed');
    console.error('[wiki-queue] 任务失败', current.type, current.id || current.path, lastError);
  } finally {
    current = null;
    working = false;
    qwrite();
    pump();
  }
}

async function execute(task) {
  if (task.type === 'update') return runUpdate(task);
  if (task.type === 'assetize') return runAssetize(task);
  throw new Error(`未知任务类型: ${task.type}`);
}

// ── 更新任务：startUpdate → 等待「子进程结束 OR 锁释放」双条件（不依赖资产状态）──
async function runUpdate(task) {
  const r = await startUpdate({ id: task.id });
  if (!r.ok) throw new Error(r.reason || 'startUpdate 失败');
  task.pid = r.pid || null;
  qwrite();
  await waitUpdateEnd(task.pid, task.id);
  await finalizeUpdateState(task);
}

/** 首次解析（新建资产）收尾：S1-S8 全程 exit 0 才算可编辑；否则保持非 ready（失败可删除重来）。
 *  恢复路径与正常路径共用，保持一致。 */
async function finalizeUpdateState(task) {
  if (!task || !task.firstUpdate) return;
  const st = readRunnerState();
  // finalize 可能在 stopped 判定后稍晚写盘，短暂等待 exit 落盘
  let exit = st && st.exit;
  const t = Date.now();
  while (exit === undefined || exit === null) {
    if (Date.now() - t > 5000) break;
    await sleep(150);
    exit = (readRunnerState() || {}).exit ?? undefined;
  }
  setAssetState(task.id, exit === 0 ? 'ready' : 'first-update-failed');
}
async function waitUpdateEnd(pid, id) {
  // 独立完成判定：pid 不存活（进程结束）或锁已释放，二者任一即视为结束。
  // 不读资产中间产物/state —— 那些在出错/中断时不可靠。
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 3600 * 1000) {
    // stopUpdate 已明确把该 runner 标为 stopped/running:false：队列可立即推进，
    // 不等待 Python 优雅退出或 30 秒 SIGKILL 定时器。
    const state = readRunnerState();
    if (state?.asset === id && state.stopped && !state.running) return true;
    if (!pidAlive(pid) || !lockExists()) return true;
    await sleep(500);
  }
  throw new Error(`更新等待超时（6h）id=${id}`);
}

// ── 资产化任务：异步 spawn assetize.py → 完成后注册 ──
async function runAssetize(task) {
  // 资产化前同步（2026-10-20 用户拍板）：模版 model_templates 并入统一总表（同名→模版参数覆盖+留痕、新名→加入）
  // Embedding 同一套逻辑：模版 config.yaml 的 embedding 段并入 Embedding 总表（model.embeddingPresets）
  try {
    const tplCfg = llmPresets.readAssetConfig(task.assetizeSelf);
    if (tplCfg && tplCfg.model_templates && typeof tplCfg.model_templates === 'object') {
      llmPresets.mergeTemplateIntoMaster(tplCfg.model_templates, (m) => console.warn(m));
    }
    if (tplCfg && tplCfg.embedding && typeof tplCfg.embedding === 'object') {
      llmPresets.mergeEmbeddingTemplateIntoMaster(tplCfg.embedding, (m) => console.warn(m));
    }
  } catch (e) { console.warn('[wiki-queue] 模版并入统一总表失败（不影响资产化继续）: ' + (e && e.message || e)); }
  const script = path.join(task.assetizeSelf, 'assetize.py');
  if (!fs.existsSync(script)) throw new Error(`assetize.py 缺失: ${script}`);
  await new Promise((resolve, reject) => {
    const child = spawn('python3', [script, task.path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 仅测试显式传入时才慢化资产化；生产环境未设置则保持原行为。
      env: process.env,
    });
    task.pid = child.pid || null;
    qwrite();
    let err = '';
    child.stderr.on('data', (c) => { err = (err + String(c)).slice(-2000); });
    child.on('error', (e) => reject(new Error(e.message)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `assetize 退出码 ${code}`).slice(0, 400)));
    });
  });
  // 资产化完成：不再直接 ready——先登记已完成状态，自动入队首次全流程解析（S1-S8），
  // 首次解析 exit 0 后才置 ready（可编辑/可配置/可开关），与确认稿「首次解析完成才可编辑」一致。
  const done = setAssetState(task.id, 'assetize-done');
  if (!done.ok) registerAsset({ id: task.id, name: path.basename(task.path), path: task.path, state: 'assetize-done' });
  const q = enqueue({ type: 'update', id: task.id, firstUpdate: true });
  if (!q.ok) console.error('[wiki-queue] 资产化完成但首次解析入队失败', task.id, q.reason);
}

/** 启动补跑：所有 assetize-done（资产化完成但尚未首次解析）资产自动入队首次全流程解析。
 *  覆盖两类场景：①修复前的遗留状态；②资产化完成后、首次解析前服务重启。
 *  enqueue 内部按 id 去重，已排队/运行中的 update 不会重复入队。 */
function recoverFirstUpdates() {
  let assets = [];
  try {
    const d = JSON.parse(fs.readFileSync(assetsFile(), 'utf8'));
    assets = Array.isArray(d.assets) ? d.assets.filter(a => a.state === 'assetize-done' && a.id) : [];
  } catch { assets = []; }
  for (const a of assets) {
    const r = enqueue({ type: 'update', id: a.id, firstUpdate: true });
    if (r.ok && r.queued) console.log(`[wiki-queue] 补跑首次解析 ${a.name}（${a.id}）位置 ${r.position}`);
  }
}

export { enqueue, cancelPendingAssetize, getQueueStatus, recoverQueue, recoverFirstUpdates };