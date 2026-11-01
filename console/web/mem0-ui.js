// Mem0 UI：batch/session 进度派生（纯） + 渲染。
// deriveMem0View 为纯函数（可单测）；renderMem0Status 消费它更新进度/失败卡 DOM。
// 动作处理器（m0Tab/saveM0Cfg/runM0Write/…）保留在 index.html 内联（低风险），
// 本模块只负责"从 status 到视图"的派生与渲染。

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function deriveMem0View(status = {}) {
  const planned = Number(status.plannedTotal || status.total || 0);
  const done = Number(status.done || 0);
  const failed = Number(status.failed || 0);
  const failures = (status.failedBatches || []).filter((item) => item.status === 'failed');
  const current = status.currentBatch
    ? `${status.currentBatch.sessionId} · 批 ${status.currentBatch.part}/${status.currentBatch.partTotal}`
    : '—';
  // OV 前端一致：顶部游标 = 已解析消息总数 / 全库消息总数（消息级，历史累加）
  const resolved = Number(status.resolvedMessages || 0);
  const total = Number(status.totalMessages || 0);
  return {
    counts: { planned, done, failed, pending: Math.max(0, planned - done) },
    current,
    cursor: resolved > 0 || total > 0 ? `${resolved} / ${total}` : '—',
    resolved,
    total,
    failures: failures.map((item) => ({ ...item, error: escapeHtml(String(item.error || '未知错误')) })),
    showProgress: !status.stoppedByUser && (Boolean(status.running) || Boolean(status.paused) || Boolean(status.interrupted) || (failed > 0 && done > 0)),
    showFailures: failures.length > 0,
  };
}

export function renderMem0Status(status = {}) {
  const view = deriveMem0View(status);
  const pc = document.getElementById('m0ProgCard');
  if (pc) pc.classList.toggle('hidden', !view.showProgress);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('m0Resolved', view.resolved);
  set('m0ResolvedTotal', view.total);
  set('m0CursorText2', view.cursor);
  set('m0Total', view.counts.planned);
  set('m0Done', view.counts.done);
  set('m0Fail', view.counts.failed);
  set('m0Pending', view.counts.pending);
  set('m0Cur', view.current);
  const bar = document.getElementById('m0Bar');
  if (bar) bar.style.width = Math.min(100, Math.round((view.counts.done / Math.max(1, view.counts.planned)) * 100)) + '%';
  const sub = document.getElementById('m0ProgSub');
  if (sub) sub.textContent = status.running ? '写入进行中' : (status.paused ? '已暂停' : (status.interrupted ? '已中断（未跑完）' : (view.counts.failed > 0 && view.counts.done > 0 ? '已完成，有失败' : '')));
  const pauseBtn = document.getElementById('m0Pause');
  if (pauseBtn) pauseBtn.style.display = (status.running && !status.paused) ? '' : 'none';
  const resumeBtn = document.getElementById('m0Resume');
  if (resumeBtn) resumeBtn.style.display = (status.paused || status.interrupted) ? '' : 'none';
  const stopBtn = document.getElementById('m0Stop');
  if (stopBtn) stopBtn.style.display = (status.running || status.paused) && !status.stoppedByUser ? '' : 'none';
  const hint = document.getElementById('m0Hint');
  if (hint) hint.textContent = status.running ? '写入进行中' : (status.paused ? '已暂停（可继续）' : (status.interrupted ? `已中断（已处理 ${view.counts.done}/${view.counts.planned}，剩余失败 ${view.counts.failed}，可继续处理）` : (view.counts.failed > 0 && view.counts.done > 0 ? '已完成，有失败可重试' : '')));
  const fc = document.getElementById('m0FailCard');
  if (fc) fc.classList.toggle('hidden', !view.showFailures);
  const tbody = document.getElementById('m0FailTbody');
  if (tbody) {
    tbody.textContent = '';
    for (const f of view.failures) {
      const tr = document.createElement('tr');
      const tdTime = document.createElement('td'); tdTime.textContent = f.failedAt ? new Date(f.failedAt).toLocaleString('zh-CN') : '—';
      const tdSess = document.createElement('td'); tdSess.textContent = f.sessionId;
      const tdAtt = document.createElement('td'); tdAtt.textContent = f.attempts || 1;
      const tdCnt = document.createElement('td'); tdCnt.textContent = f.messageCount || 0;
      const tdErr = document.createElement('td'); tdErr.innerHTML = f.error; // 已转义
      tr.append(tdTime, tdSess, tdAtt, tdCnt, tdErr);
      tbody.appendChild(tr);
    }
  }
  return view;
}

globalThis.renderMem0Status = renderMem0Status;
