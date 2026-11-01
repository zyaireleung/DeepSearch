// dsh-console/lib/panel-client.js — 8123 面板资产拉取（userKey 鉴权，只读）
// 数据源：POST /api/v1/knowledge/{wiki|code-graph}/team-assets {team_id}
// 凭证：console-config.json import.userKey（必要数据，不落日志）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'console-config.json');
let _cfg = null;
function cfg() {
  if (!_cfg) _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return _cfg;
}

const PANEL_URL = process.env.TDAI_PANEL_URL || 'http://127.0.0.1:8123';
const SERVICE_ID = process.env.TDAI_SERVICE_ID || 'default';

export function panelUserKey() {
  return (cfg().import && cfg().import.userKey) || process.env.TDAI_USER_KEY || '';
}

export function panelTeamId() {
  return (cfg().import && cfg().import.teamId) || process.env.TDAI_TEAM_ID || '';
}

/** type: 'wiki' | 'code-graph' */
export async function teamAssets(type, teamId) {
  const tid = teamId || panelTeamId();
  const r = await fetch(`${PANEL_URL}/api/v1/knowledge/${type}/team-assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tdai-service-id': SERVICE_ID,
      'x-tdai-user-key': panelUserKey(),
    },
    body: JSON.stringify({ team_id: tid }),
  });
  if (!r.ok) throw new Error(`panel team-assets HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j.data && j.data.items) || [];
}
