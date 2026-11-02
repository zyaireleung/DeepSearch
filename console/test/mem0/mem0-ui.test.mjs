import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMem0View } from '../../web/mem0-ui.js';

test('view uses batch progress and message-level cursor (OV 一致)', () => {
  const view = deriveMem0View({
    running: true, plannedTotal: 4, done: 2, failed: 1,
    currentBatch: { sessionId: 'session-a', part: 3, partTotal: 4 },
    doneSessions: ['session-z'], sessionCursors: { 'session-a': { timeMs: 1200, id: 'a-2' } },
    resolvedMessages: 66, totalMessages: 225,
    failedBatches: [{ sessionId: 'session-a', attempts: 2, messageCount: 50, error: 'timeout', failedAt: 1000, status: 'failed' }],
  });
  assert.deepEqual(view.counts, { planned: 4, done: 2, failed: 1, pending: 2 });
  assert.equal(view.current, 'session-a · 批 3/4');
  assert.equal(view.cursor, '66 / 225'); // 已解析消息总数 / 全库消息总数
  assert.equal(view.resolved, 66);
  assert.equal(view.total, 225);
  assert.equal(view.showFailures, true);
});

test('partial completion hides progress card but preserves failure history (OV 一致)', () => {
  const view = deriveMem0View({ running: false, paused: false, stoppedByUser: false,
    plannedTotal: 4, done: 3, failed: 1, doneSessions: ['session-a'],
    sessionCursors: { 'session-a': { timeMs: 1200, id: 'a-3' } },
    resolvedMessages: 66, totalMessages: 225,
    failedBatches: [{ sessionId: 'session-b', part: 1, attempts: 2, messageCount: 50,
      error: '<timeout>', failedAt: 1000, status: 'failed' }] });
  // OV 一致：队列完成（running=false）→ 进度卡隐藏；失败信息由失败批次卡保留
  assert.equal(view.showProgress, false);
  assert.equal(view.showFailures, true);
  assert.equal(view.failures[0].error, '&lt;timeout&gt;');
  assert.equal(view.cursor, '66 / 225');
});

test('paused run keeps progress card visible with resume affordance (可继续)', () => {
  const view = deriveMem0View({ running: false, paused: true, stoppedByUser: false,
    plannedTotal: 4, done: 3, failed: 0,
    resolvedMessages: 66, totalMessages: 225 });
  assert.equal(view.showProgress, true);
  assert.equal(view.counts.pending, 1);
});

test('user stop hides the active progress controls but preserves failure history', () => {
  const view = deriveMem0View({ stoppedByUser: true, plannedTotal: 0, done: 0, failed: 1,
    resolvedMessages: 66, totalMessages: 225,
    failedBatches: [{ sessionId: 'session-a', status: 'failed', attempts: 1, messageCount: 1 }] });
  assert.equal(view.showProgress, false);
  assert.equal(view.showFailures, true);
  assert.equal(view.cursor, '66 / 225');
});

test('no resolved/total → cursor placeholder', () => {
  const view = deriveMem0View({ running: true, plannedTotal: 0, done: 0, failed: 0 });
  assert.equal(view.cursor, '—');
  assert.equal(view.resolved, 0);
  assert.equal(view.total, 0);
});
