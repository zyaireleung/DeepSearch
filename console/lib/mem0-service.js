import path from 'node:path';
import nodeFs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Mem0 lifecycle service.
 *
 * Owns the Mem0 runtime configuration (selected root, search endpoint, count
 * file) and the state/count/search views that the rebuild changes, while the
 * heavy import/activation lifecycle is delegated to `options.lifecycle`
 * (closures over server.js internals) so its behavior is untouched.
 *
 * The search endpoint is resolved as `options.searchUrl` (or
 * `process.env.MEM0_SERVER_URL`) and defaults to the independent 6610 service.
 * Production keeps a `mem0Import.searchBaseUrl` pin so the data source is
 * switched later, not by this rebuild.
 */
export function createMem0Service(options = {}) {
  const root = options.root;
  const searchUrlOpt = options.searchUrl || process.env.MEM0_SERVER_URL || 'http://127.0.0.1:6610';
  const resolveSearchUrl = () => (typeof searchUrlOpt === 'function' ? searchUrlOpt() : searchUrlOpt);
  const configPath = options.configPath;
  const getConfig = options.getConfig || (() => ({}));
  const saveConfig = options.saveConfig || (() => {});
  const log = options.log || (() => {});
  const fss = options.fs || nodeFs;
  const pathMod = options.path || path;
  const spawnImpl = options.spawn || spawn;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lifecycle = options.lifecycle || {};
  const searchPort = Number(new URL(resolveSearchUrl()).port || 6610);
  const consoleDir = options.consoleDir || pathMod.join(pathMod.dirname(new URL(import.meta.url).pathname), '..');

  const paths = {
    stateFile: pathMod.join(root, 'mem0-state.json'),
    countFile: pathMod.join(root, 'mem0-count.json'),
    lockFile: pathMod.join(root, 'import.lock'),
    activationFile: pathMod.join(root, 'activation.json'),
    ownerFile: pathMod.join(root, 'mem0-search-owner.json'),
    importsRoot: lifecycle.importsRoot || pathMod.join(root, 'imports'),
    // canonical tracked 6610 服务（切换数据源时由该文件启动；生产切换前仍用旧 mem0-search-server.py）
    searchServer: pathMod.join(consoleDir, 'mem0', 'search_server.py'),
  };

  function readState() {
    try { return JSON.parse(fss.readFileSync(paths.stateFile, 'utf8')); }
    catch { return { cursorTs: null, plannedEndTs: null, currentId: '', total: 0, done: 0, failed: 0, running: false, startedAt: 0, finishedAt: 0, lastError: '' }; }
  }

  function readLock() {
    try { return JSON.parse(fss.readFileSync(paths.lockFile, 'utf8')); }
    catch { return null; }
  }

  function countSnapshot() {
    try {
      const d = JSON.parse(fss.readFileSync(paths.countFile, 'utf8'));
      const n = Number(d.count);
      if (Number.isFinite(n)) return { count: n };
    } catch {}
    return { count: 0 };
  }

  function status() {
    const st = readState();
    // 导入进行中：从 import.lock 定位候选 work 状态并桥接（候选是唯一进度写者）。
    if (st.running) {
      const lock = readLock();
      if (lock && lock.workDir) {
        try {
          const cand = JSON.parse(fss.readFileSync(pathMod.join(lock.workDir, 'mem0-state.json'), 'utf8'));
          if (cand && typeof cand.done === 'number') {
            st.done = cand.done;
            if (typeof cand.total === 'number') st.total = cand.total;
            if (cand.currentId !== undefined) st.currentId = cand.currentId;
            if (typeof cand.failed === 'number') st.failed = cand.failed;
          }
          if (cand && typeof cand === 'object') {
            for (const k of ['plannedTotal', 'currentBatch', 'doneSessions', 'sessionCursors', 'failedBatches', 'stoppedByUser', 'paused', 'interrupted']) {
              if (cand[k] !== undefined) st[k] = cand[k];
            }
          }
        } catch {}
      }
    }
    // 可重试/可续跑 runId 推导（候选 imports 最新终态 run）。
    try {
      let best = '', bestT = 0;
      for (const d of fss.readdirSync(paths.importsRoot)) {
        const rp = pathMod.join(paths.importsRoot, d, 'work', 'run.json');
        if (!fss.existsSync(rp)) continue;
        try {
          const rj = JSON.parse(fss.readFileSync(rp, 'utf8'));
          const t = fss.statSync(rp).mtimeMs;
          if (t > bestT && rj && ['failed', 'partial-completed', 'paused', 'stopped'].includes(rj.outcome)) { best = d; bestT = t; }
        } catch {}
      }
      if (best) st.runId = best;
    } catch {}
    const cfg = getConfig();
    return {
      ok: true,
      nextRunAt: lifecycle.mem0NextRunAt || null,
      config: { ...(lifecycle.defaultMem0Import || {}), ...(cfg.mem0Import || {}) },
      ...st,
      ...countSnapshot(),
    };
  }

  async function search(body, timeoutMs = 3000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${resolveSearchUrl()}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      const data = await resp.json().catch(() => null);
      if (resp.status === 503 && data && data.source) return data;
      if (!resp.ok) {
        if (resp.status === 500 && data && typeof data.error === 'string') return data;
        return null;
      }
      return data && data.ok === true ? data : null;
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  function saveImportConfig(partial) {
    const cfg = getConfig();
    const next = { ...(lifecycle.defaultMem0Import || {}), ...(cfg.mem0Import || {}), ...(partial || {}) };
    next.intervalMin = Math.max(1, Number(next.intervalMin) || 720);
    next.pendingTokenBudget = Math.max(256, Number(next.pendingTokenBudget) || 60000);
    next.importN = Number(next.importN) || 0; // 导入数量=消息条数（0=增量全部；同 OV 导入 ovImportN 语义）
    // searchBaseUrl 仅保留（spread）；默认解析 6610 由 mem0SearchUrl() 承担，不在保存时强写，
    // 避免生产在未钉住前被 UI 保存提前切到 6610。
    cfg.mem0Import = next;
    saveConfig(cfg);
    return next;
  }

  function start(opts) { return lifecycle.startCandidateImport ? lifecycle.startCandidateImport(opts) : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }
  function pause() { return lifecycle.pause ? lifecycle.pause() : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }
  function resume() { return lifecycle.resume ? lifecycle.resume() : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }
  function stop(opts) { return lifecycle.stop ? lifecycle.stop(opts) : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }
  function retry(opts) { return lifecycle.retry ? lifecycle.retry(opts) : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }
  function activate(runId) { return lifecycle.activate ? lifecycle.activate(runId) : Promise.resolve({ ok: false, reason: 'no lifecycle' }); }

  function searchServerEnv() {
    return {
      MEM0_ROOT: root,
      MEM0_CONFIG_PATH: configPath,
      MEM0_PROBE_RECORDS: options.probeRecords || '',
    };
  }

  return { searchPort, configPath, paths, status, countSnapshot, search, saveImportConfig, start, pause, resume, stop, retry, activate, searchServerEnv, _lifecycle: lifecycle };
}
