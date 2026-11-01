import test from 'node:test';
import assert from 'node:assert/strict';
import { createMem0Service } from '../../lib/mem0-service.js';

test('service defaults search and activation to the independent 6610 root', () => {
  const service = createMem0Service({
    root: '/tmp/deepsearch-mem0',
    searchUrl: 'http://127.0.0.1:6610',
    configPath: '/tmp/console-config.json',
    fs: { existsSync: () => false },
  });
  assert.equal(service.searchPort, 6610);
  assert.equal(service.paths.stateFile, '/tmp/deepsearch-mem0/mem0-state.json');
});

function fakeFsWithJson(files) {
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => JSON.stringify(files[path]),
    readdirSync: () => ['run-x'],
  };
}
function fakeFsRecordingReads(paths) {
  return {
    existsSync: (path) => path.endsWith('/mem0-count.json'),
    readFileSync: (path) => { paths.push(path); throw new Error('invalid snapshot'); },
    readdirSync: () => [],
  };
}

test('status bridges a candidate state while it is running', () => {
  const state = { running: true, plannedTotal: 4, done: 2, failed: 1,
    currentBatch: { sessionId: 'session-a', part: 3, partTotal: 4 }, failedBatches: [] };
  const service = createMem0Service({ root: '/tmp/r', searchUrl: 'http://127.0.0.1:6610', configPath: '/tmp/cfg',
    fs: fakeFsWithJson({
      '/tmp/r/mem0-state.json': { running: true },
      '/tmp/r/import.lock': { runId: 'run-x', workDir: '/tmp/r/imports/run-x/work' },
      '/tmp/r/imports/run-x/work/mem0-state.json': state,
    }) });
  assert.deepEqual(service.status().currentBatch, state.currentBatch);
});

test('count snapshot comes only from the selected Mem0 root', () => {
  const paths = [];
  const service = createMem0Service({ root: '/tmp/new-root', searchUrl: 'http://127.0.0.1:6610',
    configPath: '/tmp/cfg', fs: fakeFsRecordingReads(paths) });
  service.countSnapshot();
  assert.deepEqual(paths, ['/tmp/new-root/mem0-count.json']);
});
