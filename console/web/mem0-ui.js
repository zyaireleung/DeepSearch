// Mem0 UI：batch/session 进度派生（纯） + 渲染。
// deriveMem0View 为纯函数（可单测）；renderMem0Status 消费它更新进度/失败卡 DOM。
// 动作处理器（m0Tab/m0Save/m0Run/…）保留在 index.html 内联（低风险），
// 本模块只负责"从 status 到视图"的派生与渲染。
// 2026-11-02 用户：mem0 导入前端交互完全照抄 OV —— 进度卡仅运行/暂停/中断时显示
// （队列完成即隐藏，失败信息由失败批次卡保留）；失败卡 = OV 5 列（序号/失败时间/所属会话/重试次数/消息条数）。

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function deriveMem0View(status = {}) {
  // 计划数必须是 importer 规划出的【批数】；status.total 曾在启动阶段承载消息条数，不能回退使用。
  const planned = Number(status.plannedTotal || 0);
  const done = Number(status.done || 0);
  const failed = Number(status.failed || 0);
  const failures = (status.failedBatches || []).filter((item) => item.status === 'failed');
  const current = status.currentBatch
    ? `${status.currentBatch.sessionId} · 批 ${status.currentBatch.part}/${status.currentBatch.partTotal}`
    : '—';
  // OV 前端一致：顶部游标 = 已解析消息总数 / 全库消息总数（消息级，历史累加）
  const resolved = Number(status.resolvedMessages || 0);
  const total = Number(status.totalMessages || 0);
  // 进度卡显示 = 仅运行/暂停/中断（OV 一致：队列完成即隐藏；失败信息由失败批次卡保留，不驻留进度卡）
  // 计划尚未落盘时不显示卡片；出现时必已拿到真实批数，避免把消息条数误显示成“批”。
  const showProgress = !status.stoppedByUser && planned > 0 && (Boolean(status.running) || Boolean(status.paused) || Boolean(status.interrupted));
  return {
    counts: { planned, done, failed, pending: Math.max(0, planned - done) },
    current,
    cursor: resolved > 0 || total > 0 ? `${resolved} / ${total}` : '—',
    resolved,
    total,
    failures: failures.map((item) => ({ ...item, error: escapeHtml(String(item.error || '未知错误')) })),
    showProgress,
    showFailures: failures.length > 0,
  };
}

// 手动导入按钮禁用规则（OV 一致）：仅在【实际运行】时禁用（running），
// paused 但未运行（子进程已停/软停完成）不禁用 —— 否则遗留暂停 run 会锁死「立即导入」。
export function deriveMem0RunDisabled(status = {}) {
  return Boolean(status.running);
}

export function renderMem0Status(status = {}) {
  const view = deriveMem0View(status);
  const pc = document.getElementById('m0ProgCard');
  if (pc) pc.classList.toggle('hidden', !view.showProgress);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('m0Resolved', view.resolved);
  set('m0ResolvedTotal', view.total);
  set('m0Total', view.counts.planned);
  set('m0Done', view.counts.done);
  set('m0Fail', view.counts.failed);
  set('m0PendingNow', view.counts.pending);
  set('m0CurSession', view.current);
  const bar = document.getElementById('m0Bar');
  if (bar) bar.style.width = Math.min(100, Math.round((view.counts.done / Math.max(1, view.counts.planned)) * 100)) + '%';
  // 手动导入按钮：仅实际运行中禁用（OV 一致；paused 但未运行不禁用，避免遗留暂停 run 锁死）
  const btnRun = document.getElementById('btnM0Run');
  if (btnRun) btnRun.disabled = deriveMem0RunDisabled(status);
  // 进度卡子标题 + 三按钮（运行三态：写入进行中/已暂停/（停止中无——子进程暂停是软停，无独立 stopping 态））
  const sub = document.getElementById('m0ProgSub');
  const pauseBtn = document.getElementById('m0Pause');
  const resumeBtn = document.getElementById('m0Resume');
  const stopBtn = document.getElementById('m0Stop');
  const hint = document.getElementById('m0Hint');
  if (status.running) {
    if (status.paused) {
      if (sub) sub.textContent = '已暂停';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (resumeBtn) resumeBtn.style.display = '';
      if (stopBtn) stopBtn.style.display = '';
      if (hint) hint.textContent = '已暂停（当前批完成后停止，可继续）';
    } else {
      if (sub) sub.textContent = '写入进行中';
      if (pauseBtn) pauseBtn.style.display = '';
      if (resumeBtn) resumeBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
      if (hint) hint.textContent = '写入进行中';
    }
  } else if (status.paused) {
    // 子进程已停在批边界（软停完成），running=false 但 paused=true → 仍显示"已暂停，可继续"
    if (sub) sub.textContent = '已暂停';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = '';
    if (hint) hint.textContent = '已暂停（游标保留，可继续）';
  } else if (status.interrupted) {
    if (sub) sub.textContent = '已中断（未跑完）';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    if (hint) hint.textContent = `已中断（已处理 ${view.counts.done}/${view.counts.planned}，剩余失败 ${view.counts.failed}，可继续处理）`;
  } else {
    if (sub) sub.textContent = '';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (hint) hint.textContent = '';
  }
  // 失败批次卡：OV 5 列（序号/失败时间/所属会话/重试次数/消息条数），仅 failed 可见，不渲染错误列
  const fc = document.getElementById('m0FailCard');
  if (fc) fc.classList.toggle('hidden', !view.showFailures);
  const tbody = document.getElementById('m0FailTbody');
  if (tbody) {
    tbody.textContent = '';
    let idx = 1;
    for (const f of view.failures) {
      const tr = document.createElement('tr');
      const tdSeq = document.createElement('td'); tdSeq.textContent = idx++;
      const tdTime = document.createElement('td'); tdTime.textContent = f.failedAt ? new Date(f.failedAt).toLocaleString('zh-CN') : '—';
      const tdSess = document.createElement('td'); tdSess.textContent = f.sessionId;
      const tdAtt = document.createElement('td'); tdAtt.textContent = f.attempts || 1;
      const tdCnt = document.createElement('td'); tdCnt.textContent = f.messageCount || 0;
      tr.append(tdSeq, tdTime, tdSess, tdAtt, tdCnt);
      tbody.appendChild(tr);
    }
  }
  return view;
}

globalThis.renderMem0Status = renderMem0Status;
