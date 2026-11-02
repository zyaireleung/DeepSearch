// 契约测试：server.js mem0 导入 spawn args ↔ importer.py argparse。
// 根因（2026-11-02）：server.js 旧候选 spawn（--run-id/--limit-rows/--resume → mem0-prod-run.py）
// 与新 importer.py（--root/--source-db/--config/--limit-batches）不匹配，手动导入会 argparse 报未知参数。
// 修复：server.js 3 个 spawn 点统一 importer 新接口 + MEM0_PROD_RUN → console/mem0/importer.py（计划 L506）。
// 用户决策（2026-11-02）："每次批数"→"导入数量"= 导入消息条数（同 OV 导入 ovImportN 语义）→
//   spawn 传 --limit-rows（消息条数），不再传 --limit-batches（批数）；config schedBatches → importN。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const M = join(here, '..', '..');
const serverJs = readFileSync(join(M, 'server.js'), 'utf8');
const importerPy = readFileSync(join(M, 'mem0', 'importer.py'), 'utf8');

test('server.js 不再用旧候选 spawn 参数（--run-id/--resume）', () => {
  assert.ok(!/--run-id/.test(serverJs), 'server.js 不应再有 --run-id');
  assert.ok(!/--resume/.test(serverJs), 'server.js 不应再有 --resume');
});

test('server.js MEM0_PROD_RUN 指向 console/mem0/importer.py（计划 L506，勿依赖 mutable root 复制）', () => {
  assert.ok(/MEM0_PROD_RUN\s*=\s*path\.join\(CONSOLE_DIR,\s*['"]mem0['"],\s*['"]importer\.py['"]\)/.test(serverJs),
    'MEM0_PROD_RUN 应指向 console/mem0/importer.py');
  assert.ok(!/MEM0_PROD_RUN\s*=\s*path\.join\(MEM0_ROOT[^)]*mem0-prod-run\.py/.test(serverJs),
    'MEM0_PROD_RUN 不应再指向 mutable root 的 mem0-prod-run.py');
});

test('server.js spawn 用 importer 新接口：--limit-rows（消息条数），不再有 --limit-batches', () => {
  // start 用 impArgs 变量（L366），resume/failed 用字面量 [MEM0_PROD_RUN, ...]（L1408/1463）。
  const spawnBlocks = serverJs.split(/spawn\(mem0Py\(\)/).slice(1);
  const mem0Spawns = spawnBlocks.filter((blk) => blk.includes('MEM0_PROD_RUN') || blk.includes('impArgs'));
  assert.ok(mem0Spawns.length >= 3, `应至少有 3 个 mem0 spawn（实际 ${mem0Spawns.length}）`);
  let startBlock = '';
  for (const blk of mem0Spawns) {
    // start（impArgs）或 resume/failed（字面量）都应含 --root 与 --config
    const argsSource = blk.includes('impArgs') ? serverJs.slice(serverJs.indexOf('const impArgs'), serverJs.indexOf('spawn(mem0Py(), impArgs') + 400) : blk;
    assert.ok(argsSource.includes('--root'), 'spawn 应含 --root');
    assert.ok(argsSource.includes('--config'), 'spawn 应含 --config');
    if (blk.includes('impArgs')) startBlock = argsSource;
  }
  // 只 start 传 --limit-rows（消息条数）；不传 --limit-batches（批数已废弃，语义改消息条数）
  assert.ok(startBlock.includes('--limit-rows'), 'start spawn 应传 --limit-rows（消息条数）');
  assert.ok(!/--limit-batches/.test(serverJs), 'server.js 不应再有 --limit-batches（已改消息条数）');
});

test('server.js resolveLimitRows 读 config.importN（导入数量=消息条数），不再读 schedBatches', () => {
  assert.ok(!/schedBatches/.test(serverJs), 'server.js 不应再有 schedBatches（改用 importN）');
  const fn = /function resolveLimitRows[\s\S]*?\n}/.exec(serverJs);
  assert.ok(fn, 'resolveLimitRows 应存在');
  assert.ok(/importN/.test(fn[0]), 'resolveLimitRows 应读取 importN（消息条数）');
  assert.ok(!/limitBatches/.test(fn[0]), 'resolveLimitRows 不应再读取 limitBatches（批数）');
});

test('importer.py argparse 暴露 --failed-only/--until/--limit-rows/--source-db/--config/--root', () => {
  for (const flag of ['--failed-only', '--until', '--limit-rows', '--source-db', '--config', '--root', '--budget']) {
    assert.ok(importerPy.includes(`add_argument("${flag}"`), `importer argparse 应含 ${flag}`);
  }
});

test('server.js state 写入不再含 OLD_FIELDS（currentId/failedIds/cursorTs/plannedEndTs，importer 会拒绝）', () => {
  // importer.load_state 检查 OLD_FIELDS = (cursorTs, plannedEndTs, currentId, failedIds) → raise。
  // server.js 若写这些字段到 state（候选/active），COW clone 后 importer 拒绝。故 server.js 不得写它们。
  for (const f of ['currentId', 'failedIds', 'cursorTs', 'plannedEndTs']) {
    assert.ok(!new RegExp(`${f}\\s*:`).test(serverJs), `server.js 不应写入 ${f}`);
  }
});

test('importer --dry-run 接受 server.js spawn args（契约端到端，--limit-rows=消息条数）', () => {
  // 用真实 fixture 验证 argparse 接受 server.js 生成的 args（--root/--source-db/--config/--limit-rows/--until/--failed-only）
  const run = join(here, '..', '..', '..', 'mem0-ov-real-e2e-zO9RwA');
  const fixture = join(run, 'fixture', 'ov-fixture.db');
  const cfg = join(M, 'console-config.json');
  const r = spawnSync('python3', [
    join(M, 'mem0', 'importer.py'), '--dry-run',
    '--root', join(run, 'frontend-state'),
    '--source-db', fixture,
    '--config', cfg,
    '--limit-rows', '2',
    '--until', '1793550167620',
    '--failed-only',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `importer --dry-run 应退出 0（stderr=${r.stderr.slice(0, 200)}）`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.dryRun, true);
  assert.ok(out.plannedTotal >= 0);
});


// 2026-11-02 用户定：暂停/停止要【直接】生效（像旧 mem0），且：
//  ① pause/stop 都向子进程发 SIGTERM（停止现在已发；暂停需补发）；② pause/stop 的 runId 需有
//  readMem0State().runId 兜底（锁已释放时仍能找到 runId → 不再 400 "runId 必填"）；
//  ③ resume 拒绝 stoppedByUser（停止取消队列不可继续）；④ 前端 pause/stop 请求体带 runId。
test('server.js pause 端点应向子进程发送 SIGTERM（直接暂停，非批边界软停）', () => {
  const start = serverJs.indexOf("p === '/api/mem0/pause'");
  const end = serverJs.indexOf("p === '/api/mem0/stop'", start);
  const block = serverJs.slice(start, end);
  assert.ok(start >= 0 && end > start, 'pause 路由应存在');
  assert.ok(/SIGTERM/.test(block) && /process\.kill/.test(block), 'pause 端点应 kill 子进程（SIGTERM 直接暂停）');
  assert.ok(/cmd:\s*['"]pause['"]/.test(block), 'pause 端点应写 {cmd:"pause"}');
});

test('server.js pause/stop 的 runId 有 readMem0State().runId 兜底（锁已释放仍可定位）', () => {
  const pauseM = /handleMem0Pause[\s\S]{0,600}?readMem0State/.exec(serverJs);
  const stopM = /handleMem0Stop[\s\S]{0,600}?readMem0State/.exec(serverJs) || /handleMem0Stop[\s\S]{0,600}?runId/.exec(serverJs);
  // 端点内 runId 解析应含 readMem0State().runId 兜底（不依赖 lock）
  const anyBlock = serverJs.slice(Math.max(0, serverJs.indexOf('handleMem0Pause')), serverJs.indexOf('handleMem0Resume'));
  assert.ok(anyBlock.includes('readMem0State().runId') || /readMem0State\(\)[\s\S]{0,80}runId/.test(anyBlock),
    'pause/stop 端点应含 readMem0State().runId 兜底');
});

test('server.js resume 拒绝 stoppedByUser（停止=取消队列，不可继续）', () => {
  const start = serverJs.indexOf("p === '/api/mem0/resume'");
  const end = serverJs.indexOf("p === '/api/mem0/retry'", start);
  const block = serverJs.slice(start, end);
  assert.ok(start >= 0 && end > start, 'resume 路由应存在');
  assert.ok(/stoppedByUser/.test(block), 'resume 应检查 stoppedByUser（停止后不可继续）');
});

test('前端 pause/stop 请求体带 runId（不再发空 body {}）', () => {
  const idx = readFileSync(join(M, 'web', 'index.html'), 'utf8');
  const pauseFn = /function\s+m0Pause[\s\S]*?\n\s*\}/.exec(idx);
  const stopFn = /function\s+m0Stop[\s\S]*?\n\s*\}/.exec(idx);
  assert.ok(pauseFn && /runId/.test(pauseFn[0]), 'm0Pause 应带 runId');
  assert.ok(stopFn && /runId/.test(stopFn[0]), 'm0Stop 应带 runId');
});
