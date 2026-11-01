// dsh-console/lib/cg-import.js — CodeGraph 导入（URL 三层防御 + 本地直索引）
// URL 模式：官方流程（panel create → KS worker clone+index → register-meta）
// 本地模式：直写 KS DB ready 行 → 复制目录 → codegraph 本地直索引（零网络）→ panel 幂等 create → register-meta
// 注：本地模式直写 KS DB = 生产数据写入，须用户授权/沙盒验证后方可执行（红线）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
// 修复（沙盒副本验证）：better-sqlite3 必须锚定 MemoryKnowledge 依赖（KS 有），dsh-console 无 node_modules
const require2 = createRequire(path.join(REPO_ROOT, 'MemoryKnowledge', 'package.json'));

// ── URL 三层防御（定稿）：直连 ls-remote 探测 → 镜像重写 → 报错提示本地路径 ──
export function probeGit(url, timeoutMs = 3000) {
  try {
    execFileSync('git', ['ls-remote', '--heads', url], { timeout: timeoutMs, stdio: 'pipe' });
    return 'ok';
  } catch {
    return 'fail';
  }
}

export function mirrorOf(url) {
  const m = String(url).match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) return [];
  return [`https://gitee.com/${m[1]}/${m[2]}.git`, `https://gitcode.com/${m[1]}/${m[2]}.git`];
}

// 三层探测：直连 → gitee → gitcode；全失败抛错提示本地路径
export async function resolveCloneUrl(url) {
  if (probeGit(url) === 'ok') return { url, mode: 'direct' };
  for (const m of mirrorOf(url)) {
    if (probeGit(m) === 'ok') return { url: m, mode: 'mirror' };
  }
  throw new Error(`直连与 gitee/gitcode 镜像均不可达（${url}）。请改用本地路径导入。`);
}

// ── 本地直索引（复用沙盒已验证脚本 20260920_010008 逻辑，参数化配置）──
// cfg: { serviceId, teamId, ownerUserId, userId, agentId, panelUrl, panelUserKey, ksDbPath, ksDataRoot }
export async function importLocal(cfg, localDir, opts = {}) {
  const local = path.resolve(localDir);
  if (!fs.existsSync(local)) throw new Error(`本地路径不存在: ${local}`);

  // 1. 幂等检查
  const Database = require2('better-sqlite3');
  const db = new Database(cfg.ksDbPath);
  const repoUrl = opts.repoUrl || local;
  const branch = opts.branch || 'main';
  const existing = db
    .prepare('SELECT code_graph_id FROM knowledge_code_graph WHERE service_id=? AND team_id=? AND repo_url=? AND branch=? AND deleted_at IS NULL')
    .get(cfg.serviceId, cfg.teamId, repoUrl, branch);
  if (existing) { db.close(); return { imported: 0, code_graph_id: existing.code_graph_id, existed: true }; }

  // 2. cg- id + 建目录 + 复制（滤 node_modules/.git/.codegraph）
  const cgId = genCgId();
  const dir = path.join(cfg.ksDataRoot, cfg.serviceId, cfg.teamId, cgId);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(local, dir, {
    recursive: true,
    filter: (src) => !src.includes('/node_modules') && !src.includes('/.git') && !src.includes('/.codegraph'),
  });

  // 3. 本地索引（零网络）
  const { CodeGraph } = await loadCodegraph();
  const cg = await CodeGraph.init(dir, { index: true });
  const stats = cg.getStats ? cg.getStats() : {};
  cg.close?.();

  // 4. 直写 KS DB ready 行
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_code_graph
      (code_graph_id, service_id, team_id, repo_name, repo_url, branch, owner_user_id, user_id, agent_id,
       visibility, status, service_url, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'team', 'ready', ?, 0, ?, ?)`,
  ).run(cgId, cfg.serviceId, cfg.teamId, opts.name || path.basename(local), repoUrl, branch,
    cfg.ownerUserId, cfg.userId, cfg.agentId, cfg.serviceUrl || '', now, now);
  db.close();

  // 5. panel 幂等 create（existed=true 不触发 worker）
  const createResp = await fetch(`${cfg.panelUrl}/api/v1/knowledge/code-graph/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': cfg.serviceId, 'x-tdai-user-key': cfg.panelUserKey },
    body: JSON.stringify({ team_id: cfg.teamId, repo_url: repoUrl, branch, repo_name: opts.name || path.basename(local) }),
  });
  if (createResp.status >= 400) throw new Error(`panel create 失败 HTTP ${createResp.status}`);
  await createResp.json().catch(() => ({}));

  // 6. 登记 meta_asset
  const regResp = await fetch(`${cfg.panelUrl}/api/v1/knowledge/code-graph/register-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tdai-service-id': cfg.serviceId, 'x-tdai-user-key': cfg.panelUserKey },
    body: JSON.stringify({ team_id: cfg.teamId, code_graph_id: cgId }),
  });
  if (regResp.status >= 400) throw new Error(`register-meta 失败 HTTP ${regResp.status}`);

  return { imported: 1, code_graph_id: cgId, existed: false, stats };
}

// codegraph npm 模块（复用 KS 依赖：platform 子包 + ESM default 解包，对齐沙盒已验证脚本）
async function loadCodegraph() {
  const appRequire = createRequire(path.join(REPO_ROOT, 'MemoryKnowledge', 'package.json'));
  const entry = appRequire.resolve('@colbymchenry/codegraph');
  const platform = `${process.platform}-${process.arch}`;
  const cgRequire = createRequire(entry);
  const toolsPath = cgRequire.resolve(`@colbymchenry/codegraph-${platform}/lib/dist/mcp/tools.js`);
  const cg = await import(entry);
  const tools = await import(toolsPath);
  const unwrap = (m) => (m && m.default && typeof m.default === 'object' ? m.default : m);
  return { CodeGraph: unwrap(cg).CodeGraph, ToolHandler: unwrap(tools).ToolHandler };
}

// cg- 8位 base36 id 生成（与 KS ids.ts 一致）
function genCgId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return 'cg-' + out;
}

export const CG_DEFAULT = {
  serviceId: process.env.TDAI_SERVICE_ID || 'default',
  ksDbPath: path.join(REPO_ROOT, 'MemoryKnowledge', 'data', 'knowledge.db'),
  ksDataRoot: path.join(REPO_ROOT, 'MemoryKnowledge', 'data'),
};
