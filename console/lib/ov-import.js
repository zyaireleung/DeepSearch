/**
 * DeepSearch Console — OpenViking 导入 / 批级 commit 控制（预规划批队列）
 *
 * 零第三方依赖（Node 内置：node:sqlite 读本地状态库做历史统计、fetch 调 OV API）。
 *
 * Commit 队列规则（用户定稿）：
 *   1. 会话选取：未 commit 会话（OV live message_count > 0）
 *      按导入时间（created_at）由远及近排序，前缀累加未 commit 消息数，
 *      累计 ≤ 导入数量 N（0=全部）；一旦 累计+下一个 > N 则停（下一个留到下轮）。
 *   2. 预切批（事前计算，不是执行时现算）：每个会话按 pending_token_threshold
 *      （估算 token 预算，默认 150000，配置可覆盖）算出每批应归档的条数 → 批数 → 展开成批序列。
 *   3. 队列 = 全部批展开：[(会话A,批1),(会话A,批2),…,(会话B,批1),…]，总批数已知。
 *   4. 执行：逐批 commit，keep_recent_count 在 commit 时按实时 live 条数算绝对尾部
 *      （= live − 本批条数）→ OV 归档最老的"live − keep_recent_count"条，
 *      于是归档条数恒等于本批计划条数；每批一个 OV task，批间有暂停/停止检查点。
 *   5. 进度 = 已完成批 / 计划总批。
 *   6. 断点续传不靠"已完成批号"过滤新计划：part 是每次运行按当前 live 重切的相对编号，
 *      历史 part 1 与本轮 part 1 不是同一批，键碰撞会误杀新 part 1。
 *      去重信号是 OV live 本身——已归档的消息已不在 live，重切批自然只剩未归档部分。
 *      doneParts 仅作审计留痕，不参与计划过滤。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_STATE = {
  running: false, paused: false, stopping: false, stoppedByUser: false,
  plannedTotal: 0, done: 0, failed: 0,
  currentBatchText: '', currentSession: '', startedAt: 0, finishedAt: 0, lastError: '',
  plan: [], doneSessions: [], failedBatches: [], queueErrors: [],
  taskWaitStartedAt: 0, taskWaitSeconds: 0, taskLastStatus: '',
};

const TASK_POLL_MS = 5000;
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_STALL_MS = 30 * 60 * 1000;
const boundedMs = (value, fallback, min) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/** OV HTTP 客户端（user key 访问租户数据 API） */
class OvClient {
  constructor(baseUrl, apiKey, timeoutMs = 15000) {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.timeoutMs = timeoutMs;
  }
  async _req(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.base + p, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
      });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!resp.ok) {
        const msg = data?.error?.message || data?.error || data?.raw || `HTTP ${resp.status}`;
        throw new Error(`OV ${method} ${p} -> ${resp.status}: ${msg}`);
      }
      return data?.result ?? data;
    } finally { clearTimeout(t); }
  }
  async get(p) { return this._req('GET', p); }
  async post(p, body) { return this._req('POST', p, body); }

  /** 会话列表（含 mod_time） */
  async listSessions() {
    const r = await this.get('/api/v1/sessions?limit=2000');
    return Array.isArray(r) ? r : (r?.sessions || []);
  }
  /** 单个会话 meta：未 commit 消息数 / token 估算 / 导入时间 */
  async sessionMeta(sessionId) {
    const r = await this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    return r || {};
  }
  /** commit：keep_recent_count = 归档本批后保留的最近消息条数（0=归档全部） */
  async commit(sessionId, keepRecent = 0) {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      keep_recent_count: Number(keepRecent) || 0,
    });
  }
  async cancelTask(taskId) {
    return this.post(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {});
  }
  async taskStatus(taskId) {
    const r = await this.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    return r?.status || '';
  }
  /**
   * 任务详情（含 status/error/resource_id，反查任务中心用）。
   * 错误分类（队列表层 vs 任务层失败的分界）：
   *   HTTP 404 → 返回 null（任务中心可达但该任务已滚出/不存在 → 上层按 unknown 处理）
   *   其他错误（网络断连/超时/5xx）→ 抛出（上层按"连接故障"处理，不篡改记录、不判 failed）
   */
  async taskInfo(taskId) {
    if (!taskId) return null;
    try { return await this.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`); }
    catch (e) {
      const msg = String(e?.message || e);
      if (/-> 404/.test(msg)) return null;
      throw e;
    }
  }
  /** 追回消息到 live（failed archive 恢复：≤100 条/批，OV 自动更新 message_count） */
  async messagesBatch(sessionId, messages) {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, { messages: messages || [] });
  }
}

/** 状态库（SQLite）只读统计：synced 表按 session 分组计数（历史导入总量展示用） */
class OvStateDb {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }
  close() { try { this.db.close(); } catch {} }
  listSessions() {
    const rows = this.db.prepare(
      `SELECT session_id, COUNT(*) AS messages FROM synced GROUP BY session_id ORDER BY messages DESC`
    ).all();
    return rows.map((r) => ({ session_id: r.session_id, messages: Number(r.messages) }));
  }
  totalMessages() {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM synced`).get();
    return Number(row?.c || 0);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OvImport {
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || ((...a) => console.log('[ov-import]', ...a));
    this.state = structuredClone(DEFAULT_STATE);
    this.progress = {};
    this.done = [];            // 已完成（所有批都跑完）的 session_id
    this.doneParts = [];       // 已完成批 [{session_id, part}]（断点续传）
    this.timer = null;
    this._abort = false;
    this._currentTaskId = '';  // 当前等待中的 OV 提取任务（停止时真实 cancel）
    this._loadState();
    this._loadProgress();
    this._loadDone();
    this._loadDoneParts();
    this._recoverStaleRun();
    this.config = this._loadConfig();
    this.ov = new OvClient(opts.ovBaseUrl || this.config.ovBaseUrl, opts.ovApiKey || this.config.ovApiKey);
    this.stateDb = opts.stateDbPath || this.config.stateDbPath;
    this.sessionsDir = opts.sessionsDir || this.config.sessionsDir || '';   // 会话消息文件目录（贪心切批读文件用）
    this.taskPollMs = boundedMs(opts.taskPollMs, TASK_POLL_MS, 100);
    this.taskTimeoutMs = boundedMs(opts.taskTimeoutMs, TASK_TIMEOUT_MS, this.taskPollMs);
    this.taskStallMs = boundedMs(opts.taskStallMs, TASK_STALL_MS, this.taskPollMs);
    this._armTimer();
  }

  // ── 持久化 ──
  _loadConfig() {
    try { return JSON.parse(fs.readFileSync(this.opts.configFile, 'utf8')).ovImport || {}; }
    catch { return {}; }
  }
  _loadState() {
    try { this.state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(fs.readFileSync(this.opts.stateFile, 'utf8')) }; } catch {}
  }
  _saveState() {
    try { fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true }); fs.writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2)); } catch {}
  }
  /**
   * 进程启动前不存在可继续执行的 _runLoop；持久化的 running=true 只能来自上次异常退出。
   * 不根据历史 plan 续跑，下一次 run() 会用 OV live 消息重新切批，避免重归档。
   */
  _recoverStaleRun() {
    if (!this.state.running) return;
    const previous = this.state.currentBatchText || this.state.currentSession || '未知批次';
    this.state.running = false;
    this.state.paused = false;
    this.state.stopping = false;
    this.state.stoppedByUser = false;
    this.state.currentBatchText = '';
    this.state.currentSession = '';
    this.state.taskWaitStartedAt = 0;
    this.state.taskWaitSeconds = 0;
    this.state.taskLastStatus = '';
    this.state.finishedAt = Date.now();
    this.state.lastError = `检测到上次异常退出，已释放陈旧导入状态（${previous}）；下次运行将按 OV live 消息重新切批`;
    this._saveState();
    this.log(this.state.lastError);
  }
  _loadProgress() {
    try { this.progress = JSON.parse(fs.readFileSync(this.opts.progressFile, 'utf8')) || {}; } catch { this.progress = {}; }
  }
  _saveProgress() {
    try { fs.writeFileSync(this.opts.progressFile, JSON.stringify(this.progress, null, 2)); } catch {}
  }
  _loadDone() {
    try { this.done = JSON.parse(fs.readFileSync(this.opts.doneFile, 'utf8')) || []; } catch { this.done = []; }
  }
  _saveDone() {
    try { fs.writeFileSync(this.opts.doneFile, JSON.stringify([...new Set(this.done)], null, 2)); } catch {}
  }
  _loadDoneParts() {
    try { this.doneParts = JSON.parse(fs.readFileSync(this.opts.donePartsFile, 'utf8')) || []; } catch { this.doneParts = []; }
  }
  _saveDoneParts() {
    try { fs.writeFileSync(this.opts.donePartsFile, JSON.stringify(this.doneParts, null, 2)); } catch {}
  }

  // ── 状态库统计（历史总量展示） ──
  listSessions() {
    try {
      const db = new OvStateDb(this.stateDb);
      try { return { sessions: db.listSessions(), totalMessages: db.totalMessages() }; }
      finally { db.close(); }
    } catch { return { sessions: [], totalMessages: 0 }; }
  }

  /** 状态（供 /api/ov/status）：配置、下次导入、批级进度 */
  status() {
    const dbStat = this.listSessions();
    const plan = this.state.plan || [];
    const doneBatches = this.state.done || 0;
    const totalBatches = this.state.plannedTotal || 0;
    // 已 commit 进度的分子是成功完成批的消息数，绝不能用批次数冒充。
    // 语义（用户定稿 2026-10-25）：跨轮历史累计 —— 取 doneParts 审计账本
    // （_markBatchDone 时持久化累积、不随本轮 plan/done 重置），下一轮在上
    // 一次之上叠加，而不是只统计本轮 plan 前 done 批（那样每轮从 0 重计）。
    const committedMessages = (this.doneParts || [])
      .reduce((sum, p) => sum + Number(p?.messages || 0), 0);
    return {
      running: this.state.running, paused: this.state.paused, stopping: this.state.stopping, stoppedByUser: this.state.stoppedByUser,
      plannedTotal: totalBatches, done: doneBatches, failed: this.state.failed,
      currentBatchText: this.state.currentBatchText,
      currentSession: this.state.currentSession,
      taskWaitStartedAt: this.state.taskWaitStartedAt || 0,
      taskWaitSeconds: this.state.taskWaitSeconds || 0,
      taskLastStatus: this.state.taskLastStatus || '',
      startedAt: this.state.startedAt, finishedAt: this.state.finishedAt, lastError: this.state.lastError,
      // 供前端“已 commit 对话”展示：已成功 commit 消息总数 / 全库消息总数。
      committedMessages,
      totalMessages: dbStat.totalMessages,
      plan: plan, doneSessions: this.state.doneSessions, failedBatches: this.state.failedBatches,
      queueErrors: this.state.queueErrors || [],
      doneCount: this.done.length,
      pendingBatches: totalBatches - doneBatches,
      pendingSessions: new Set(plan.filter((b) => b && b.session_id).map((b) => b.session_id)).size,
      nextRunAt: this._nextRunAt(),
      config: {
        enabled: !!this.config.enabled, mode: this.config.mode || 'sched',
        startMode: this.config.startMode || 'daily', startDaily: this.config.startDaily || '03:00',
        startAt: this.config.startAt || '', intervalMin: this.config.intervalMin || 720,
        importN: this.config.importN || 0,
        pendingTokenBudget: this.config.pendingTokenBudget || 60000,
      },
    };
  }

  // ── 队列生成（预规划） ──
  /** 拉取所有会话 meta（并发受限），返回 [{session_id, message_count, pending_tokens, created_at}] */
  async _fetchMetas(sessionIds) {
    const out = [];
    const concurrency = 8;
    for (let i = 0; i < sessionIds.length; i += concurrency) {
      const chunk = sessionIds.slice(i, i + concurrency);
      const rs = await Promise.all(chunk.map(async (id) => {
        try { return await this.ov.sessionMeta(id); } catch (e) { this.log('meta 拉取失败', id, e?.message || e); return null; }
      }));
      for (const r of rs) if (r && r.session_id) out.push(r);
    }
    return out;
  }

  // ── token 估算（与 OV token_estimation.py 同款 CJK-aware 公式，保证与 OV 内部 policy 口径一致）──
  _estimateTextTokens(text) {
    if (!text) return 0;
    const units = [];
    let ascii = true;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) { units.push(1); continue; }
      ascii = false;
      if (cp >= 0x4E00 && cp <= 0x9FFF) units.push(6);
      else if (cp < 0x1100) units.push(1);
      else if (
        cp <= 0x11FF || (0x3000 <= cp && cp <= 0x30FF) || (0x3130 <= cp && cp <= 0x318F) ||
        (0x31F0 <= cp && cp <= 0x31FF) || (0x3400 <= cp && cp <= 0x4DBF) || (0xAC00 <= cp && cp <= 0xD7AF) ||
        (0xF900 <= cp && cp <= 0xFAFF) || (0xFF00 <= cp && cp <= 0xFFEF) || (0x20000 <= cp && cp <= 0x2EBEF)
      ) units.push(6);
      else if (cp > 0xFFFF) units.push(8);
      else units.push(1);
    }
    if (ascii) return Math.floor((text.length + 3) / 4);
    return Math.floor((units.reduce((a, b) => a + b, 0) + 3) / 4);
  }
  _msgTokens(m) {
    const texts = [];
    for (const p of (m.parts || [])) {
      const t = p.type;
      if (t === 'text') texts.push(p.text || '');
      else if (t === 'context') texts.push(p.abstract || '');
      else if (t === 'tool') {
        if (p.tool_id) texts.push(p.tool_id);
        if (p.tool_name) texts.push(p.tool_name);
        if (p.tool_input != null) texts.push(JSON.stringify(p.tool_input));
        if (p.tool_output != null) texts.push(String(p.tool_output));
      }
    }
    return this._estimateTextTokens(texts.join(''));
  }

  /** 读会话 live messages.jsonl → 逐条估算 token */
  _readLiveMessages(sessionId) {
    const filePath = path.join(this.sessionsDir, sessionId, 'messages.jsonl');
    const text = fs.readFileSync(filePath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const m = JSON.parse(l);
        out.push({ tokens: this._msgTokens(m) });
      } catch {}
    }
    return out;
  }

  _makeBatch(sessionId, part, size, remaining) {
    return { session_id: sessionId, part, partTotal: 0, messages: size, keepRecent: Math.max(0, remaining - size) };
  }

  /**
   * commit 时的 keep_recent_count（保留最近 N 条）：实时重读 live 条数，
   * 返回 live − 本批条数，保证 OV 归档的恰好是本批计划条数。
   *
   * v3 根因修复：keep_recent_count 在 OV 侧语义是「归档边界」（split_idx = live − keep_recent_count），
   * 不是「上下文尾巴大小」。早期版本按 totalInputTokenBudget 贪心压缩保留后缀，方向反了——
   * 压小 keepRecent = 归档更多 = 提取 prompt 更大（1.9M token 超窗 400 的直接原因）。
   * 且 OV 的 hydrate_for_extraction 只处理归档消息、不带入保留尾巴，预算约束本身也不成立。
   * 现在只以条数锚定：keepRecent = liveCount − batchSize，归档数恒等于本批。
   *
   * live < 本批条数时返回 0（归档全部）；读文件失败退回计划时的估算值，不阻断本批。
   */
  _absKeepRecent(b, fallback) {
    try {
      const messages = this._readLiveMessages(b.session_id);
      const batchSize = Math.max(0, Number(b.messages) || 0);
      return Math.max(0, messages.length - batchSize);
    } catch (e) { return fallback; }
  }

  /**
   * 会话内【贪心切批】：
   * 读 live messages.jsonl → 逐条估算 token → 按预算（pending_token_budget，估算口径）顺序累加，
   * 到预算切一批；单条超预算单独一批（不切断消息）。与 OV plan_extraction_batches 同行为、同口径。
   */
  async _splitBatches(sessionId) {
    let messages;
    try {
      messages = this._readLiveMessages(sessionId);
    } catch (e) {
      throw new Error(`读取会话消息失败 ${sessionId}: ${e?.message || e}（sessionsDir=${this.sessionsDir}）`);
    }
    if (!messages.length) return [];
    const budget = this.config.pendingTokenBudget || 60000;

    const batches = [];
    let currentSize = 0, currentTokens = 0, remaining = messages.length;
    for (const m of messages) {
      const t = m.tokens;
      // 单条超预算：先 flush 当前批，再单独成批（不切断）
      if (t > budget) {
        if (currentSize > 0) {
          batches.push(this._makeBatch(sessionId, batches.length + 1, currentSize, remaining));
          remaining -= currentSize;
          currentSize = 0; currentTokens = 0;
        }
        batches.push(this._makeBatch(sessionId, batches.length + 1, 1, remaining));
        remaining -= 1;
        continue;
      }
      if (currentSize > 0 && currentTokens + t > budget) {
        batches.push(this._makeBatch(sessionId, batches.length + 1, currentSize, remaining));
        remaining -= currentSize;
        currentSize = 0; currentTokens = 0;
      }
      currentSize += 1;
      currentTokens += t;
    }
    if (currentSize > 0) {
      batches.push(this._makeBatch(sessionId, batches.length + 1, currentSize, remaining));
    }
    const total = batches.length;
    for (const b of batches) b.partTotal = total;
    return batches;
  }

  /**
   * 构建批队列（预规划）：
   * 未 commit 会话按导入时间由远及近逐会话切批；importN 限制的是消息总数，
   * 因而允许从一个大会话选取若干完整前置批，绝不因整会话超过 N 而拒绝。
   */
  async _buildPlan(importN) {
    const list = await this.ov.listSessions();
    const metas = await this._fetchMetas(list.map((s) => s.session_id));
    const pending = metas
      .filter((m) => (m.message_count || 0) > 0)
      .sort((a, b) => this._planSort(a, b));   // 失败优先 + 时间由远及近

    const n = Number(importN) || 0;
    const plan = [];
    let selectedMessages = 0;
    for (const s of pending) {
      let batches;
      try { batches = await this._splitBatches(s.session_id); }
      catch (e) {
        this.log('切批失败，跳过该会话', s.session_id, e?.message || e);
        continue;
      }
      for (const batch of batches) {
        // 限额只接纳完整批；不能截断批，也不会跨会话拼接消息。
        if (n > 0 && selectedMessages + (batch.messages || 0) > n) return plan;
        plan.push(batch);
        selectedMessages += batch.messages || 0;
      }
    }

    // 不用历史 doneParts（session#part）过滤新计划。
    // part 是本轮按"当前 live"重切的相对编号：历史 b9cca7ce#1（上一轮 162 条）与本轮
    // part 1（225 条）不是同一批，键碰撞会把新 part 1 误杀；被跳过后执行从 part 2 起步，
    // keep_recent_count 仍按"part 1 已归档"的假设，OV 一次归档 772−362=410 条（两批合并）。
    // 真正的去重信号是 OV live 本身：已归档的消息已不在 live，重切批自然只剩未归档部分。
    return plan;
  }

  /**
   * 计划排序（用户定稿：失败批次卡片的顺序 = 队列优先顺序，不新增规则）：
   * 先按 failedBatches 中该 session 出现的顺序（最早失败在前）排最前，
   * 未失败的会话保持按 created_at 由远及近。
   */
  _planSort(a, b) {
    // 失败会话享最高优先级（用户定稿）：先 restored（已恢复未 commit 待重试），
    // 再未恢复 failed（等待恢复），均按失败时间（早失败在前），不按 created_at 远近。
    // 普通会话按 created_at 由远及近；detached/unknown/superseded/retrying 不入排序。
    const rank = (m) => {
      const recs = (this.state.failedBatches || [])
        .filter((f) => f.session_id === m.session_id && !f.detached && f.status === 'failed');
      if (!recs.length) return Infinity;
      const best = recs.reduce((p, c) => {
        const pb = p.restored ? 1 : 0, cb = c.restored ? 1 : 0;
        if (cb !== pb) return cb > pb ? c : p;
        return (c.ts || 0) < (p.ts || 0) ? c : p;
      }, recs[0]);
      const ts = best.ts || 0;
      return best.restored ? ts : 1e15 + ts;   // restored 桶在前，未恢复 failed 桶居中，普通=Infinity
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return new Date(a.created_at) - new Date(b.created_at);
  }

  /**
   * 失败批次重试判定：该失败记录是否需要在下一轮恢复 + 优先重试。
   * 以 OV 任务中心真实状态为准（与卡片同步）：task_id 存在且任务 status=failed → 恢复重试；
   * 任务不存在（查不到/已滚出任务中心）或 status=completed（控制台误判，如"卡住"实为成功）→ 不恢复。
   */
  async _shouldRestore(rec) {
    if (!rec || !rec.session_id) return false;
    // 状态机过滤：retrying/retried_success/unknown/superseded 均不恢复（已有后续处理/不可盲目动作）
    if (rec.status && rec.status !== 'failed') return false;
    // detached（断开占位）不是 OV 确认的失败，不按 failed 恢复
    if (rec.detached) return false;
    if (!rec.task_id) return false;
    try {
      const task = await this.ov.taskInfo(rec.task_id);
      if (!task || !task.status) return false;
      return task.status === 'failed';
    } catch (e) {
      // 连接故障：无法确认任务状态，不恢复、不改状态（队列层处理）
      this.log('任务中心不可达，跳过恢复判定', rec.session_id, e?.message || e);
      return false;
    }
  }

  /**
   * 恢复失败批次为"未 commit"：读 failed archive 的 messages.jsonl → POST /messages/batch
   * 追回原会话（≤100 条/批）→ OV 自动更新 message_count → 下一轮 buildPlan 自然选中。
   * 返回恢复的消息条数（0=无需恢复/恢复失败）。
   *
   * failed archive 定位：优先用失败记录里的 archive_uri（commit 响应返回的本次归档目录，
   * 精确可靠）；无 archive_uri 时才按"mtime 最接近失败时刻"猜测兜底（多轮归档并存时可能误选，
   * 故 archive_uri 是主路径）。
   */
  /**
   * 精确定位某失败批的归档消息文件：
   * 主路径用失败记录里的 archive_uri（commit 响应返回的本次归档目录，精确可靠）；
   * 无 archive_uri 时才按"mtime 最接近失败时刻"猜测兜底（多轮归档并存时可能误选，
   * 故 archive_uri 是主路径）。返回 '' 表示无法定位（归档缺失/会话目录不存在）。
   */
  _resolveArchiveMessageFile(rec) {
    if (!rec || !rec.session_id) return '';
    const sessionDir = this.sessionsDir ? path.join(this.sessionsDir, rec.session_id) : '';
    const historyDir = sessionDir ? path.join(sessionDir, 'history') : '';
    if (!historyDir || !fs.existsSync(historyDir)) return '';
    let msgFile = '';
    // 主路径：archive_uri 精确定位（如 viking://user/default/sessions/xxx/history/archive_003）
    if (rec.archive_uri) {
      const m = String(rec.archive_uri).match(/archive_\d+$/);
      if (m) {
        const cand = path.join(historyDir, m[0], 'messages.jsonl');
        if (fs.existsSync(cand)) msgFile = cand;
      }
    }
    // 兜底：按 mtime 最接近失败时刻（rec.ts）的归档目录
    if (!msgFile) {
      const archives = fs.readdirSync(historyDir)
        .filter((d) => /^archive_\d+$/.test(d))
        .map((d) => {
          const p = path.join(historyDir, d);
          return { dir: d, mtime: fs.statSync(p).mtimeMs };
        })
        .sort((x, y) => x.mtime - y.mtime);
      if (archives.length) {
        const ts = rec.ts || Date.now();
        let best = archives[0], bestDiff = Math.abs(best.mtime - ts);
        for (const a of archives) {
          const diff = Math.abs(a.mtime - ts);
          if (diff < bestDiff) { best = a; bestDiff = diff; }
        }
        msgFile = path.join(historyDir, best.dir, 'messages.jsonl');
      }
    }
    return msgFile;
  }

  /**
   * 落盘证据核验（Option A 扩展，用户定稿）：对某批次读取 OV live message_count
   * 与精确归档行数，判断该批是否"真已 commit（landed）"。
   * - landed = 精确归档存在且非空（消息已落盘）。
   * - liveCount = OV 会话当前未归档消息数（live>0 且归档空 → 仍在待 commit）。
   * - 归档空 + live=0 → 数据既不在 live 也不在归档，调用方必须走"不可恢复"分支，
   *   禁止盲重提（否则伪造空队列/掩盖数据丢失）。
   * ponytail: OV sessionMeta 不可达时按 liveCount=0 处理（保守侧：不盲重提）。
   */
  async _inspectBatchEvidence(rec) {
    let meta = {};
    try { meta = await this.ov.sessionMeta(rec.session_id); }
    catch (e) { this.log('落盘证据核验：sessionMeta 不可达，按 live=0 处理', rec.session_id, e?.message || e); }
    const liveCount = Math.max(0, Number(meta?.message_count || 0));
    const archivePath = this._resolveArchiveMessageFile(rec);
    const archiveLines = archivePath && fs.existsSync(archivePath)
      ? fs.readFileSync(archivePath, 'utf8').split('\n').filter((l) => l.trim()).length
      : 0;
    return {
      liveCount,
      archivePath,
      archiveLines,
      hasArchiveMessages: archiveLines > 0,
      landed: archiveLines > 0,
    };
  }

  /**
   * 终态批调和（用户定稿核心）：按落盘证据而非 OV task status 决定批次去留。
   * 终态（completed/failed/cancelled/cancelling/blocked/unknown）统一走证据判定：
   *   landed           → 消息已落盘（真 commit）：不登记失败、不恢复、不重提。
   *   restored-live    → 未落地但归档有消息：登记 failed + 复用恢复路径追回 live 并清空归档。
   *   pending-live     → 未落地且 live>0：登记 failed（消息已在 live，下一轮自然重提）。
   *   unrecoverable    → 既无 live 又无归档：不盲重提，记录明确错误。
   * 返回四种字面量之一；调用方仅在 landed 且任务为 completed 时视为本轮成功。
   */
  async _reconcileTerminalBatch({ b, taskId, archiveUri, taskStatus, taskDetail, seq }) {
    const status = String(taskStatus || '').toLowerCase();
    if (status !== 'failed') {
      // 非 OV failed 终态（用户定稿：失败列表只认 OV 任务中心真实 status=failed）：
      // 绝不登记失败、绝不重放归档、绝不成为重提候选。
      // completed 仅在证据证明已落盘时返回 'landed'（调用方据此正常记账）；
      // completed+未落地 / cancelled / cancelling / blocked / unknown 一律 'not-failed'
      // （_waitTask 返回 false：不记成功账、不登记失败、不重提）。
      if (status === 'completed') {
        const rec = {
          session_id: b.session_id, part: b.part, messages: b.messages || 0,
          task_id: taskId || '', archive_uri: archiveUri || '', ts: Date.now(),
        };
        const evidence = await this._inspectBatchEvidence(rec);
        if (evidence.landed) return 'landed';
      }
      this.state.lastError = `${b.session_id}#${b.part}: 任务 ${status || 'unknown'} 未被 OV 任务中心确认失败；不进入失败批次、不重提`;
      this._saveState();
      this.log('终态批非 OV failed，不进入失败批次', b.session_id, '#', b.part, status || 'unknown');
      return 'not-failed';
    }
    const rec = {
      session_id: b.session_id, part: b.part, messages: b.messages || 0,
      task_id: taskId || '', archive_uri: archiveUri || '', ts: Date.now(),
    };
    const evidence = await this._inspectBatchEvidence(rec);
    const errText = String(taskDetail?.error || `task ${status}`);
    if (evidence.hasArchiveMessages) {
      this._recordFailure(b, errText, seq, taskId, archiveUri, taskDetail);
      const active = this.state.failedBatches[this.state.failedBatches.length - 1];
      await this._restoreFailedBatch(active, { skipTaskStatusCheck: true });
      return 'restored-live';
    }
    if (evidence.liveCount > 0) {
      this._recordFailure(b, errText, seq, taskId, archiveUri, taskDetail);
      return 'pending-live';
    }
    this.state.lastError = `${b.session_id}#${b.part}: OV failed，但未发现 live 消息或可恢复归档，禁止盲目重提`;
    this._saveState();
    this.log('OV failed 批不可恢复（不盲重提）', b.session_id, '#', b.part);
    return 'unrecoverable';
  }

  async _restoreFailedBatch(rec, { skipTaskStatusCheck = false } = {}) {
    if (!rec || !rec.session_id) return 0;
    if (rec.status && rec.status !== 'failed') return 0;   // retrying/retried_success/unknown/superseded
    // skipTaskStatusCheck=true：由 _reconcileTerminalBatch 按落盘证据定性，
    // 跳过 task_id/taskInfo 判定（避免 completed→superseded 误判、无 task_id 时无法恢复）。
    if (!skipTaskStatusCheck) {
      if (!rec.task_id) return 0;
      // 以 OV 任务中心真实状态判定（与卡片同步）：status=failed → 恢复重试；
      // completed（控制台误判，如"卡住"实为成功）→ superseded，不追回（避免重复 commit 已成功归档的消息）；
      // 查不到（不可达/已滚出）→ unknown，不盲目恢复、不篡改 archive。
      let task;
      try { task = await this.ov.taskInfo(rec.task_id); }
      catch (e) {
        // 连接故障：不改状态（不是 unknown——unknown 语义是"可达但查无"），留待队列层恢复后复查
        this.log('任务中心不可达，跳过恢复', rec.session_id, e?.message || e);
        return 0;
      }
      if (!task || !task.status) {
        rec.status = 'unknown'; this._saveState();
        return 0;
      }
      if (task.status !== 'failed') {
        rec.status = 'superseded'; this._saveState();
        return 0;
      }
    }
    const msgFile = this._resolveArchiveMessageFile(rec);
    if (!msgFile || !fs.existsSync(msgFile)) return 0;
    const lines = fs.readFileSync(msgFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return 0;   // archive 已空（上次已恢复）→ 幂等，不重复追回
    const messages = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!messages.length) return 0;

    // 断点续追：rec.restoredCount 记录已成功追回的条数（上次中途失败时保留），从那里继续，
    // 避免把已追回的消息再 POST 一遍（OV 会重写消息 id，无法按 id 去重）。
    const offset = Math.max(0, Number(rec.restoredCount || 0));
    if (offset >= messages.length) {
      // 已全部追回但 archive 未清（崩溃窗口）→ 本次只清 archive、标记待重试
      try { fs.writeFileSync(msgFile, ''); } catch {}
      rec.status = 'failed'; rec.restored = true; rec.restoredAt = Date.now();
      this._saveState();
      return 0;
    }
    // 幂等：OV messages/batch 追回时会重写消息 id（沙盒实测：live 新 id ≠ archive 原 id），
    // 无法按 id 去重；改为"恢复成功后清空该 failed archive"——消息已回到 live，归档副本不再
    // 需要。archive 空后下次 _restoreFailedBatch 直接返回 0，不会重复追回（防消息翻倍）。
    // 中途失败（某批 400/网络断）不清 archive，只推进 restoredCount —— 下轮从剩余部分续追。
    let restored = 0;
    let completed = true;
    for (let i = offset; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const r = await this.ov.messagesBatch(rec.session_id, chunk);
        restored += Number(r?.added || 0);
        rec.restoredCount = i + chunk.length;
        this._saveState();
      } catch (e) {
        this.log('恢复追回失败（保留进度，下轮续追）', rec.session_id, path.basename(path.dirname(msgFile)), e?.message || e);
        completed = false;
        break;
      }
    }
    if (completed && restored > 0) {
      // 追回成功 → 清空该 failed archive（已恢复消息的归档副本移除）
      try { fs.writeFileSync(msgFile, ''); } catch (e) { this.log('清空 failed archive 失败', msgFile, e?.message || e); }
      // 恢复为"未 commit"：消息已回 live；记录保持 status='failed' 并打 restored 标记，
      // _planSort 据此把它排到下一轮队列最前（最高优先级），且不再触发二次恢复。
      rec.status = 'failed';
      rec.restored = true;
      rec.restoredAt = Date.now();
      this._saveState();
      this.log('已恢复失败批为未 commit（待最高优先级重试）', rec.session_id, path.basename(path.dirname(msgFile)), restored, '条，archive 已清空');
    }
    return restored;
  }

  /** 下一轮 run 前：对 failedBatches 逐条判定并恢复（自动优先重试入口） */
  async _restoreFailedBatches() {
    const recs = this.state.failedBatches || [];
    let total = 0, restored = 0;
    for (const rec of recs) {
      // 已重试成功/已被取代/状态未知/已恢复待提交 的记录不重复恢复（幂等 + 防误追）
      if (rec.status && rec.status !== 'failed') continue;
      if (rec.restored) continue;   // 已恢复待重试，不再二次恢复
      const n = await this._restoreFailedBatch(rec);
      if (n > 0) { restored++; total += n; }
    }
    if (restored > 0) this.log('失败批次恢复完成', restored, '批 /', total, '条');
    return { restored: restored > 0 ? restored : 0, messages: total };
  }

  // ── 循环定时 ──
  _nextRunAt() {
    const c = this.config;
    if (!c.enabled || c.mode !== 'sched') return null;
    const now = new Date();
    if (c.startMode === 'daily') {
      const [hh, mm] = String(c.startDaily || '03:00').split(':').map(Number);
      const t = new Date(now); t.setHours(hh || 0, mm || 0, 0, 0);
      if (t <= now) t.setDate(t.getDate() + 1);
      return t.toISOString();
    }
    const base = c.startAt ? new Date(c.startAt) : new Date(now.getTime() + (c.intervalMin || 720) * 60000);
    const intervalMs = (c.intervalMin || 720) * 60000;
    let t = base;
    while (t <= now) t = new Date(t.getTime() + intervalMs);
    return t.toISOString();
  }

  _armTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const next = this._nextRunAt();
    if (!next) return;
    const wait = new Date(next).getTime() - Date.now();
    if (wait < 0) return;
    this.log(`定时：下次 commit ${new Date(next).toLocaleString()}（${Math.round(wait / 60000)}min 后）`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.state.running) this.run().catch((e) => this.log('定时 commit 失败', e?.message || e));
      this._armTimer();
    }, wait);
  }

  /** 保存配置后重置定时 */
  saveConfig(cfg) {
    this.config = { ...(this.config || {}), ...(cfg || {}) };
    this.ov = new OvClient(this.opts.ovBaseUrl || this.config.ovBaseUrl, this.opts.ovApiKey || this.config.ovApiKey);
    this.taskPollMs = boundedMs(this.opts.taskPollMs, TASK_POLL_MS, 100);
    this.taskTimeoutMs = boundedMs(this.opts.taskTimeoutMs, TASK_TIMEOUT_MS, this.taskPollMs);
    this.taskStallMs = boundedMs(this.opts.taskStallMs, TASK_STALL_MS, this.taskPollMs);
    this._armTimer();
    return { ok: true, nextRunAt: this._nextRunAt() };
  }

  // ── 执行 ──
  /** 手动立即导入一次：先恢复失败批为未 commit（自动优先重试）→ 预规划批队列 → 逐批 commit */
  async run(importN) {
    if (this.state.running) return { ok: false, error: '已有导入在运行' };
    // 失败优先重试：下一轮开始前，把上一轮 failedBatches 中"OV 任务中心确认失败"的批次
    // 恢复为未 commit（读 failed archive → messages/batch 追回），使其重新进入待 commit 队列。
    try { await this._restoreFailedBatches(); }
    catch (e) { this.log('失败批次恢复异常（继续构建计划）', e?.message || e); }
    let plan;
    try { plan = await this._buildPlan(importN); }
    catch (e) { return { ok: false, error: '队列生成失败: ' + (e?.message || e) }; }
    if (!plan.length) return { ok: false, error: '没有待 commit 的批（已全部完成）' };
    this.state = {
      ...structuredClone(DEFAULT_STATE), running: true,
      plan, plannedTotal: plan.length, startedAt: Date.now(),
      // failedBatches 跨轮保留：失败批次卡片持续显示 + 下一轮继续失败优先排序/恢复。
      // （恢复幂等由 failed archive 清空保证：已追回的不再重复；completed 误判由任务中心判定剔除。）
      failedBatches: this.state.failedBatches || [],
    };
    this.progress = {};
    this._runDone = new Set();   // 本轮已完成的 batch key（判定会话是否全部完成用）
    for (const b of plan) this.progress[`${b.session_id}#${b.part}`] = 'pending';
    this._saveState(); this._saveProgress();
    this._abort = false;
    this._runLoop().catch((e) => {
      this.state.running = false; this.state.lastError = String(e?.message || e);
      this._saveState(); this.log('run error', e?.message || e);
    });
    return { ok: true, plannedTotal: plan.length, batches: plan.length };
  }

  /** 串行执行批队列：逐批 commit（keep_recent_count）→ 等 Phase 2 → 批间暂停/停止检查点 */
  async _runLoop() {
    const plan = this.state.plan || [];
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      if (!b || !b.session_id) continue;
      while (this.state.paused) { await sleep(2000); if (this._abort) break; }
      if (this._abort) break;
      this.state.currentBatchText = `${b.session_id} · 批 ${b.part}/${b.partTotal}`;
      this.state.currentSession = b.session_id;
      this.progress[`${b.session_id}#${b.part}`] = 'running';
      this._saveState(); this._saveProgress();
      try {
        // keep_recent_count 用 commit 时的实时 live 条数算绝对尾部（见 _absKeepRecent）：
        // OV 归档"最老的 live − keep_recent_count 条"，于是归档条数恒等于本批计划条数，
        // 上一批被跳过/提前归档/外部补回消息都不会把两批合并成一个归档。
        const keepRecent = this._absKeepRecent(b, b.keepRecent);
        const r = await this.ov.commit(b.session_id, keepRecent);
        const taskId = r?.task_id || '';
        const archiveUri = r?.archive_uri || '';
        let ok = true;
        let skipMark = false;   // 断开批次由 _syncDetached 记账，本层不再记
        if (taskId) {
          this._currentTaskId = taskId;
          // archiveUri = commit 响应的本次归档目录：任务失败时记入失败记录，
          // 下轮恢复用精确定位 failed archive（勿靠 mtime 猜）。
          const wr = await this._waitTask(taskId, b, i + 1, archiveUri);
          this._currentTaskId = '';
          this.state.taskWaitStartedAt = 0;
          this.state.taskWaitSeconds = 0;
          this.state.taskLastStatus = '';
          if (wr === 'disconnected') {
            // 队列层断开（网络断/停滞/总超时）：_waitTask 已写 detached 记录。
            // 暂停队列等 OV 恢复，resume() 做 _syncDetached 重新定性本批。
            this.state.paused = true;
            this.state.lastError = 'OV 连接中断，队列已暂停（点继续获取 OV 状态）';
            this._saveState();
            // 等待用户"继续"（resume 已 _syncDetached）；期间可停止。
            while (this.state.paused && !this._abort) { await sleep(2000); }
            if (this._abort) { await this._finalizeAbort(); break; }
            // 继续后：本批已由 _syncDetached 定性并记账（completed→_markBatchDone 已做 /
            // failed→不记账留恢复 / unknown→live 重发）。这里不再记账，避免重复 doneParts。
            const det = (this.state.failedBatches || []).filter((x) => x.session_id === b.session_id && x.part === b.part).pop();
            if (det?.status === 'failed') ok = false;
            this.log('断开批次重新定性', b.session_id, '#', b.part, det?.status || 'none');
            skipMark = true;
          } else {
            ok = wr === true;
          }
        } else {
          this.log('commit 未返回 task（空归档？）', b.session_id, '#', b.part);
        }
        // 当前批正常完成就记账（即使已 stop —— stop 只停后续批，不丢当前批）；
        // task 失败/取消（ok=false）不记账，留给下次导入自动优先重试（含归档恢复）；
        // 断开批次（skipMark）由 _syncDetached 定性记账，本层跳过避免重复。
        if (ok && taskId && !skipMark) {
          // 记录本会话最近一次成功 commit 的 task_id（会话级重试成功时回填 resolvedTaskId）
          this._lastTaskBySession = this._lastTaskBySession || {};
          this._lastTaskBySession[b.session_id] = taskId;
          this._markBatchDone(b);
        }
      } catch (e) {
        // commit 阶段失败——队列错误层，不产生失败批次：
        //   4xx（OV 拒绝，参数错误等）→ 提示队列错误，跳过后继续后续批；
        //   网络/连接错误 → 队列错误 + 暂停队列（等 OV 恢复，resume 后重发本批由 live 保证）。
        const msg = String(e?.message || e);
        const is4xx = /-> 4\d\d/.test(msg);
        if (is4xx) {
          this.state.lastError = `${b.session_id}#${b.part} commit 被拒绝（OV）：${msg.replace(/^OV \S+ -> \S+: /, '')}`;
          this.state.queueErrors = this.state.queueErrors || [];
          this.state.queueErrors.push({ session_id: b.session_id, part: b.part, error: msg, ts: Date.now() });
          this.log('commit OV 拒绝（队列错误，跳过）', b.session_id, '#', b.part, msg);
        } else {
          // 连接类故障（ECONNREFUSED/超时/网络断）：队列错误 + 暂停
          this.state.lastError = 'OV 提交中断，队列已暂停（点继续重试本批）';
          this.state.paused = true;
          this._saveState();
          this.log('commit 连接失败（队列暂停）', b.session_id, '#', b.part, msg);
          while (this.state.paused && !this._abort) { await sleep(2000); }
          if (this._abort) { await this._finalizeAbort(); break; }
          // 继续后重发本批：live 消息未动（commit 未送达），下一批继续由 buildPlan 的
          // live 扫描自动重发。这里不记账。
        }
        this.progress[`${b.session_id}#${b.part}`] = 'done';
        this._saveState(); this._saveProgress();
        continue;
      }
      this.progress[`${b.session_id}#${b.part}`] = 'done';
      this._saveState(); this._saveProgress();
    }
    this.state.running = false;
    this.state.finishedAt = Date.now();
    if (this._abort) {
      // 停止的终态不保留队列；前端据 stoppedByUser 隐藏进度卡。
      // failedBatches 不清：失败批次卡片保持显示（停止后仍可见，可反查任务中心）。
      this.state.stoppedByUser = true;
      this.state.plan = [];
      this.state.plannedTotal = 0;
      this.state.done = 0;
      this.state.failed = 0;
      this.state.doneSessions = [];
      this.progress = {};
      this._saveProgress();
    }
    this.state.paused = false;
    this.state.stopping = false;
    this.state.currentBatchText = '';
    this.state.currentSession = '';
    this.state.taskWaitStartedAt = 0;
    this.state.taskWaitSeconds = 0;
    this.state.taskLastStatus = '';
    this._saveState();
  }

  _markBatchDone(b) {
    if (!b || !b.session_id) return;
    const key = `${b.session_id}#${b.part}`;
    if (!this._runDone) this._runDone = new Set();
    this._runDone.add(key);
    this.doneParts.push({ session_id: b.session_id, part: b.part, messages: b.messages });
    this._saveDoneParts();
    this.state.done++;
    // 该 session 的所有批都完成 → 记为已完成 session。
    // 按"本轮计划的批在本轮是否都完成"判定，不用跨轮累积的 doneParts 计数——
    // doneParts 会跨运行留痕，历史残留条目会把计数撑到超过本轮批数，导致提前判完成。
    const parts = (this.state.plan || []).filter((x) => x.session_id === b.session_id);
    const doneThisRun = parts.filter((x) => this._runDone.has(`${x.session_id}#${x.part}`));
    if (parts.length > 0 && doneThisRun.length >= parts.length && !this.state.doneSessions.includes(b.session_id)) {
      this.state.doneSessions.push(b.session_id);
      if (!this.done.includes(b.session_id)) { this.done.push(b.session_id); this._saveDone(); }
      // 会话全部重新 commit 完成 → 从失败列表移除该会话记录（已解决，不再显示；
      // 不产生 retried_success 可见状态）。历史审计由 doneParts 账本承载。
      const before = this.state.failedBatches.length;
      this.state.failedBatches = (this.state.failedBatches || []).filter(
        (x) => !(x.session_id === b.session_id && !x.detached),
      );
      if (this.state.failedBatches.length !== before) this._saveState();
    }
  }

  /**
   * 统一记录批次失败：补全 ts/messages/attempts/seq/task_id/archive_uri 字段。
   * attempts = 同一 session_id#part 的累计失败次数（含本次），跨轮累积——
   * 失败批次下轮自动优先重试（_buildPlan 按 failedBatches 顺序排最前）；
   * task_id = OV 任务中心可反查的失败任务标识（序号列展示用）；
   * archive_uri = commit 响应里的本次归档目录（恢复时精确定位 failed archive，勿靠 mtime 猜）。
   *
   * 重试状态机：同一 session_id#part 只保留一条 ACTIVE（failed/retrying）记录。
   * 本次失败发生时，旧 ACTIVE 记录标记 superseded（已被本次失败取代，卡片显示），
   * 再追加新记录并关联【新 task_id / 新 archive_uri / 任务中心错误文本】——
   * 再次失败时卡片序号与反查目标跟随新任务，任务中心可追溯。
   */
  _recordFailure(b, error, seq, taskId, archiveUri, taskDetail) {
    if (!b || !b.session_id) return;
    const sameKey = (x) => x.session_id === b.session_id && x.part === b.part;
    // 失败列表只保留一条 ACTIVE failed（用户定稿）：同批旧记录（含 retrying/superseded/
    // unknown/detached）全部移除，不再产生可见的 superseded 状态；attempts 跨轮累计。
    const prev = this.state.failedBatches.filter(sameKey);
    const prevAttempts = prev.reduce((m, x) => Math.max(m, Number(x.attempts || 0)), 0);
    this.state.failedBatches = this.state.failedBatches.filter((x) => !sameKey(x));
    const attempts = prevAttempts + 1;
    this.state.failedBatches.push({
      session_id: b.session_id,
      part: b.part,
      error: String(taskDetail?.error || error || '未知错误'),
      ts: Date.now(),
      messages: b.messages || 0,
      attempts,
      seq: seq || 0,
      task_id: taskId || '',
      archive_uri: archiveUri || '',
      resource_id: taskDetail?.resource_id || b.session_id,
      status: 'failed',
    });
    this.state.failed++;
    this.state.lastError = `${b.session_id}#${b.part}: ${error}`;
    this._saveState();
  }

  /**
   * 记录"断开批次"（临时占位，区别于 OV 确认的失败批次）：
   * 队列任务进行中 OV 侧断开/长时间未返回终态 → 本批生成 detached 记录。
   * - 语义：连接断开 = 队列层状态，不是 OV 任务失败。OV 侧任务状态未知，
   *   控制台不猜测、不判 failed、不篡改 archive。
   * - 展示：序号列 '-'、重试次数列 'disconnected'，与失败批次区分（前端）。
   * - 恢复：OV 连通后（resume/继续/下轮）对该 session 的 OV 任务重新定性——
   *   failed→升级为真失败 / completed→补记账 / 查无→按 live+archive 判重发或 unknown。
   * - detached 不参与失败优先排序（_planSort 只认 status=failed 的记录）。
   */
  _recordDetached(b, error, taskId = '', archiveUri = '') {
    if (!b || !b.session_id) return;
    // 断开是队列暂停时的瞬态：同一会话已有 detached 则更新时间戳（不累积、不聚合）
    const sameKey = (x) => x.session_id === b.session_id && x.part === b.part;
    const prev = this.state.failedBatches.filter(sameKey).find((x) => x.detached);
    if (prev) {
      prev.ts = Date.now();
      prev.error = String(error || 'OV 连接断开');
      prev.task_id = prev.task_id || taskId || '';
      prev.archive_uri = prev.archive_uri || archiveUri || '';
      this._saveState();
      return;
    }
    this.state.failedBatches.push({
      session_id: b.session_id,
      part: b.part,
      detached: true,                    // 展示字段：断开占位，非状态机成员
      error: String(error || 'OV 连接断开'),
      ts: Date.now(),
      messages: b.messages || 0,
      attempts: 0,                       // 断开无重试语义，前端显示 'disconnected'
      seq: 0,                            // 序号显示 '-'
      task_id: taskId || '',             // 断开时 commit 可能已返回 task（轮询断），存下供恢复反查
      archive_uri: archiveUri || '',
      resource_id: b.session_id,
      status: 'detached',                // 不入状态机：_shouldRestore/_restoreFailedBatch 均跳过
    });
    this._saveState();
  }

  /**
   * OV 连通后对全部 detached 记录重新定性（resume/继续 时调用）：
   * 以 OV 任务中心真实状态为准，detached → 正式状态：
   *   task failed        → 升级为真失败（status='failed'，error 同步任务中心）
   *   task completed     → 该批实际成功 → 补 _markBatchDone 记账，detached 记录转 superseded
   *   task 查无(404)     → 查该 session live/archive：live 有消息 → commit 未送达，安全重发
   *                       （detached → 直接删/标 retry 重发）；live 空 → 已归档但任务滚出，
   *                       不盲重发 → unknown（不篡改 archive）
   *   仍不可达          → 保持 detached + paused，提示"服务端已断开"
   *   仍 running        → 保持 detached（继续等，不升级不删除）
   * 返回 { blocked: boolean, message }：blocked=true 时队列保持暂停。
   */
  async _syncDetached() {
    const recs = (this.state.failedBatches || []).filter((r) => r.detached);
    let blocked = false;
    for (const rec of recs) {
      if (!rec.session_id) continue;
      // 1) 任务中心反查（无 task_id = commit 未送达/未返回 → 直接按 live 判）
      let task = null;
      if (rec.task_id) {
        try { task = await this.ov.taskInfo(rec.task_id); }
        catch (e) {
          // 仍不可达 → 保持 detached，暂停继续
          this.state.lastError = 'OpenViking 服务端已断开，无法继续任务';
          blocked = true; continue;
        }
      }
      if (task && task.status) {
        if (task.status === 'failed') {
          // 断开批次升级为真失败：交给 _reconcileTerminalBatch 按证据定性
          // （登记唯一 failed 行 + 按需恢复 archive），再移除旧 detached 占位。
          const b = (this.state.plan || []).find((x) => x.session_id === rec.session_id && x.part === rec.part)
            || { session_id: rec.session_id, part: rec.part, messages: rec.messages || 0 };
          await this._reconcileTerminalBatch({
            b,
            taskId: rec.task_id,
            archiveUri: rec.archive_uri,
            taskStatus: 'failed',
            taskDetail: task,
            seq: rec.seq || 0,
          });
          this.state.failedBatches = (this.state.failedBatches || []).filter((x) => x !== rec);
          this._saveState();
          this.log('断开批次按证据定性为 OV failed', rec.session_id, task.task_id || rec.task_id);
          continue;
        }
        if (task.status === 'completed') {
          // completed：仅当证据证明已落盘才补记账；未落地则移除占位、诊断错误，
          // 不登记失败、不重放（_reconcileTerminalBatch 状态门禁保证）。
          const b = (this.state.plan || []).find((x) => x.session_id === rec.session_id && x.part === rec.part)
            || { session_id: rec.session_id, part: rec.part, messages: rec.messages || 0 };
          const outcome = await this._reconcileTerminalBatch({
            b,
            taskId: rec.task_id,
            archiveUri: rec.archive_uri,
            taskStatus: 'completed',
            taskDetail: task,
            seq: rec.seq || 0,
          });
          if (outcome === 'landed') {
            if (b && (this.state.plan || []).some((x) => x.session_id === b.session_id && x.part === b.part)) {
              this._markBatchDone(b);
            }
            this.log('断开批次实为成功（completed+landed），补记账并移除占位', rec.session_id);
          } else {
            this.log('断开批次 completed 但无落盘证据，移除占位（不记账、不重提）', rec.session_id);
          }
          const at = this.state.failedBatches.indexOf(rec);
          if (at >= 0) this.state.failedBatches.splice(at, 1);
          this._saveState();
          continue;
        }
        // 其他终态（cancelled/cancelling/blocked/unknown）：非 OV failed，不生成失败卡片、
        // 不重放；移除 detached 占位 + 诊断。仍 running/pending → 继续等。
        if (task.status === 'running' || task.status === 'pending') {
          blocked = true;
          this.state.lastError = `任务 ${rec.task_id?.slice(0, 8) || ''} 仍在运行，等待终态`;
          continue;
        }
        this.state.lastError = `${rec.session_id}#${rec.part}: 任务 ${task.status} 未被 OV 任务中心确认失败；移除断开占位，不进入失败批次`;
        const at = this.state.failedBatches.indexOf(rec);
        if (at >= 0) this.state.failedBatches.splice(at, 1);
        this._saveState();
        this.log('断开批次终态非 OV failed，移除占位', rec.session_id, task.status);
        continue;
      }
      // task 查无 或 无 task_id：按 session live/archive 判
      let meta = {};
      try { meta = await this.ov.sessionMeta(rec.session_id); } catch (e) {
        this.state.lastError = 'OpenViking 服务端已断开，无法继续任务';
        blocked = true; continue;
      }
      const live = Number(meta?.message_count || 0);
      const sessionDir = this.sessionsDir ? path.join(this.sessionsDir, rec.session_id) : '';
      const historyDir = sessionDir ? path.join(sessionDir, 'history') : '';
      const hasArchive = historyDir && fs.existsSync(historyDir)
        && fs.readdirSync(historyDir).some((d) => /^archive_\d+$/.test(d) && fs.statSync(path.join(historyDir, d)).size > 0);
      if (live > 0 && !hasArchive) {
        // commit 未送达：live 有消息、无归档 → 安全重发（下一轮 run 自动选中该会话）
        this.log('断开批次判定：commit 未送达（live 有消息），下轮安全重发', rec.session_id);
      } else {
        // live 空 或 已有归档但任务滚出：不盲重发，不篡改 archive
        this.log('断开批次判定：任务查无且不满足重发条件 → 移除占位，保留 archive（不盲重发）', rec.session_id);
      }
      // unknown 不留在失败列表（用户定稿：仅 failed + detached 可见）：
      // 移除占位，archive 保持不动，避免误重发。
      const at = this.state.failedBatches.indexOf(rec);
      if (at >= 0) this.state.failedBatches.splice(at, 1);
      this._saveState();
    }
    return { blocked, message: blocked ? this.state.lastError : '' };
  }

  async _waitTask(taskId, b, seq, archiveUri) {
    const startedAt = Date.now();
    let lastStatus = '';
    let lastDetail = null;
    let nullCount = 0;
    let connErrCount = 0;                // 连续连接错误计数（连接故障 → detached，不判 failed）
    this.state.taskWaitStartedAt = startedAt;
    // 无限等 OV 终态（用户定稿：任务 running 就一直等，不因时间/停滞判失败）。
    // 退出条件只有三个：completed、failed/cancelled（任务中心真实终态）、
    // 连接故障（连续 3 次，→ detached + 暂停待复查）、任务中心持续查无（→ unknown）。
    // 注意：不因 _abort 提前 return —— 停止必须等当前批 Phase 2 完成
    // （中途取消会把归档标记 .failed.json，OV 永不重试 → 该批记忆永久跳过）。
    while (true) {
      try {
        // 用任务中心【完整详情】（含 status/error/resource_id）轮询——
        // 失败信息从任务中心同步（同一血缘的 commit 结果状态重新同步）。
        // taskInfo 已分类：404 → null（任务中心可达但查无）；网络/5xx → 抛错（连接故障）。
        const task = await this.ov.taskInfo(taskId);
        connErrCount = 0;                // 轮询成功 → 连接错误计数清零
        const now = Date.now();
        this.state.taskWaitSeconds = Math.floor((now - startedAt) / 1000);
        this.state.taskLastStatus = task?.status || 'unknown';
        if (task && task.status && task.status !== lastStatus) {
          lastStatus = task.status;
          lastDetail = task;
        }
        this._saveState();
        if (lastStatus === 'completed' || lastStatus === 'failed' ||
            lastStatus === 'cancelled' || lastStatus === 'cancelling') {
          // 用户定稿：失败列表只认 OV 任务中心真实 status=failed（_reconcileTerminalBatch 状态门禁）。
          // completed+landed → 真成功（return true → 调用方 _markBatchDone）；
          // completed+未落地 → 'not-failed'（不登记失败、不重提，仅不记成功账）→ return false；
          // failed → 按证据登记失败+恢复（restored-live/pending-live）→ return false；
          // cancelled/cancelling/blocked → 'not-failed'（不登记失败、不重放）→ return false。
          const outcome = await this._reconcileTerminalBatch({
            b, taskId, archiveUri, taskStatus: lastStatus, taskDetail: lastDetail, seq,
          });
          if (lastStatus === 'completed') return outcome === 'landed';
          return false;
        }
        if (!task) {
          // 任务中心可达但查无（404/已滚出）：连续多次仍无 → 仅记录诊断。
          // 用户定稿：task-not-found 不是 OV confirmed failed，不能污染失败列表/计数，
          // 也不能重放或重提。
          if (++nullCount >= 5) {
            this.state.lastError = `${b.session_id}#${b.part}: task 查询失败：任务中心可达但任务已滚出；不进入失败批次、不重提`;
            this._saveState();
            this.log('任务中心查无，终止等待但不登记失败', b.session_id, '#', b.part, taskId);
            return false;
          }
        } else {
          nullCount = 0;
          // 有状态（running/pending/…）→ 继续等终态，不判停滞（VLM 慢提取不是失败）
        }
      } catch (e) {
        // 连接故障（网络断/超时/5xx）：连续 N 次 → detached + 暂停，不判 failed
        connErrCount++;
        this.state.taskLastStatus = 'connection-error';
        this._saveState();
        this.log('task 轮询连接失败', b.session_id, e?.message || e);
        if (connErrCount >= 3) {
          this._recordDetached(b, `OV 连接中断：${e?.message || e}`, taskId, archiveUri);
          return 'disconnected';
        }
      }
      await sleep(this.taskPollMs);
    }
  }

  pause() { this.state.paused = true; this._saveState(); return { ok: true }; }
  /**
   * 继续：先对 detached 记录重新定性（同步 OV 侧真实状态）——
   * 全部解除阻塞才解除暂停；仍断开/仍在运行则保持暂停并提示。
   */
  async resume() {
    if (!this.state.paused) return { ok: true, message: '未在暂停状态' };
    const sync = await this._syncDetached();
    if (sync.blocked) {
      this._saveState();
      return { ok: false, error: sync.message || 'OV 服务端仍不可用' };
    }
    this.state.paused = false;
    this._saveState();
    return { ok: true };
  }
  /**
   * 停止前复查（用户定稿）：停止不得直接以 _abort 甩掉未确认终态的任务。
   * 先向 OV 复查在途/断开任务：failed → 登记失败并恢复 archive 为未 commit
   * （下一轮 _planSort 以最高优先级重切批）；completed → 补记账移除占位；
   * 仍 running / 暂不可达 → 保留运行态（detached）待下次复查，不伪造失败。
   */
  async _finalizeAbort() {
    try { await this._syncDetached(); }
    catch (e) { this.log('停止前复查失败（继续）', e?.message || e); }
    try { await this._restoreFailedBatches(); }
    catch (e) { this.log('停止前恢复失败批失败（继续）', e?.message || e); }
  }

  stop() {
    // 停止 = 两阶段：
    //   ① 先暂停（stopping=true, paused=true）：当前批继续跑完（Phase 2 完成，不产生
    //      .failed.json 跳过），OV 进度继续显示，队列未取消；
    //   ② 当前批完成后 _runLoop 收尾：队列取消（后续批不跑），stoppedByUser=true 终态。
    // 与暂停的区别：暂停可 resume 继续；停止不可继续（等当前批完成后即终态）。
    this.state.stopping = true;
    this.state.paused = true;
    this._abort = true;
    this._saveState();
    return { ok: true };
  }
  reset() {
    this.state = structuredClone(DEFAULT_STATE);
    this.progress = {};
    this.done = [];
    this.doneParts = [];
    this._saveState();
    this._saveProgress();
    this._saveDone();
    this._saveDoneParts();
    return { ok: true };
  }
}