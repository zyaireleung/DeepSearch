/**
 * plugin-service-manager — 插件/服务分组启动管理（host 端）
 *
 * 静态 bundle 插件的 client 无法用 host.call（那是动态插件内置），
 * 标准通道是 host 注册 HTTP 路由、client 直接 fetch（dsh-context/better-sidebar 同款）。
 *
 * 路由（挂在 dsh webServer 下）：
 *   GET  /tdai-svc/status              → 各服务端口 + 运行状态（JSON）
 *   POST /tdai-svc/control {action}    → 调 tdai-local.sh start/stop/restart + 重探测
 *
 * 状态用端口探测（串行，不并发）；控制命令按分组走各自的 controlXxx（DeepSearch/Mem0/OpenViking/n8n/WebSearch/New API）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const execFileP = promisify(execFile);
const HOME = process.env.HOME || "";

const SERVICES = [
  // DeepSearch 组（2026-10-26）：DeepSearch 控制台
  { id: "deepsearch-console", name: "DeepSearch Console", host: "127.0.0.1", port: 6600, desc: "DeepSearch 控制台" },
  // Mem0 组：检索常驻 canonical 6610（search_server.py，读 DeepSearch 重建库）+ wemm-embed 远程 108:8810
  // （旧 mem0-search 8915 已废弃，2026-11-12 移除）
  { id: "mem0-search-6610", name: "search_server", host: "127.0.0.1", port: 6610, desc: "Mem0 常驻检索（canonical 6610）" },
  { id: "wemm-embed", name: "WeMM Embedding", host: "192.168.1.108", port: 8810, desc: "embedding 上游（wemm-fix.sh）" },
  // Mem0 DB 板块：记忆库只读浏览（2026-11-12 迁到 DeepSearch 新库 + 6620）
  { id: "mem0-browse", name: "mem0-browse-server", host: "127.0.0.1", port: 6620, desc: "Mem0 记忆库只读浏览（新库 6620）" },
  { id: "newapi", name: "New API", host: "127.0.0.1", port: 13000, desc: "new-api LLM 网关（QuantumNous）" },
  // OpenViking 组（2026-10-24）：生产记忆库服务 + dsh session 常驻轮询导入
  { id: "openviking", name: "OpenViking", host: "127.0.0.1", port: 1933, desc: "生产记忆库服务" },
  { id: "dsh-session-ingest", name: "dsh-session-ingest", procPattern: "ingest_dsh_sessions.py.*--state .*ov-ingest-state-prod.db", desc: "常驻轮询（60s 增量导入）" },
  // n8n 组（2026-11-04）：工作流自动化，本机 5678（nvm node v24 全局安装，须 v24 on PATH）
  { id: "n8n-server", name: "n8n server", host: "127.0.0.1", port: 5678, desc: "工作流" },
  // Web Search 组（2026-11-09）：deep-search 检索执行器（不含 n8n——n8n 是通用网关平台，独立成组）
  //  wigolo-direct     : 常驻 daemon :3333，无代理 env 兜底渠道
  //  wigolo-restricted : 常驻 daemon :3334，注入 :7890 代理，仅受限域名
  //  mediacrawler      : 按需 CLI（非常驻），健康=Thorium CDP:9222 可达 + venv 存在；无端口故靠探测分支
  { id: "wigolo-direct", name: "Wigolo Direct", host: "127.0.0.1", port: 3333, desc: "Web 检索（直连兜底）" },
  { id: "wigolo-restricted", name: "Wigolo Restricted", host: "127.0.0.1", port: 3334, desc: "Web 检索（代理受限站）" },
  { id: "mediacrawler", name: "MediaCrawler", host: "127.0.0.1", port: 9222, desc: "社媒抓取（探测 Thorium CDP）" },
];

const MEM0_PY = process.env.MEM0_PY || `${HOME}/TencentDB-Agent-Memory/.data/mem0/venv/bin/python`;
// ---- canonical 6610 检索常驻：DeepSearch console/mem0/search_server.py，读 DeepSearch 重建库 ----
const SEARCH_SERVER_PY = process.env.MEM0_SEARCH_SERVER_PY || `${HOME}/DeepSearch/console/mem0/search_server.py`;
const SEARCH_SERVER_PORT = 6610;
const SEARCH_SERVER_ROOT = process.env.MEM0_ROOT || `${HOME}/DeepSearch/.data/mem0`;
const SEARCH_SERVER_CONFIG = process.env.MEM0_CONFIG_PATH || `${HOME}/DeepSearch/console/console-config.json`;
const SEARCH_SERVER_PROBE = process.env.MEM0_PROBE_RECORDS || `${HOME}/DeepSearch/.data/mem0/probe-records.jsonl`;
const WEMM_FIX = "bash ~/.omlx/models/WeMM-Embedding-2B-MLX-4bit/wemm-fix.sh";
// ---- mem0-browse 6620（2026-11-12）：DeepSearch console/mem0/mem0-browse-server.py，读 DeepSearch 新库 ----
const MEM0_BROWSE_SERVER = process.env.MEM0_BROWSE_SERVER || `${HOME}/DeepSearch/console/mem0/mem0-browse-server.py`;
const MEM0_BROWSE_PORT = 6620;
const MEM0_BROWSE_ROOT = process.env.MEM0_SANDBOX_ROOT || `${HOME}/DeepSearch/.data/mem0`;
const NEWAPI_DIR = process.env.NEWAPI_DIR || `${HOME}/apps/new-api`;
const NEWAPI_BIN = `${NEWAPI_DIR}/new-api`;
const NEWAPI_PORT = 13000;
const NEWAPI_CTL = `${NEWAPI_DIR}/newapi-ctl.sh`;

// ---- n8n 组（2026-11-04）：工作流自动化，本机 5678 ----
//  n8n 经 nvm node v24 全局安装，shebang #!/usr/bin/env node，须 v24 在 PATH（DSH 运行时 node 22 不受支持）
const N8N_BIN_DIR = process.env.N8N_BIN_DIR || `${HOME}/.nvm/versions/node/v24.14.0/bin`;
const N8N_PORT = 5678;
const N8N_LOG = `/tmp/n8n-server.log`;

// ---- Web Search 组（2026-11-09）：deep-search 检索执行器（wigolo 双 daemon + mediacrawler 探测）----
//  wigolo 经 nvm node v24 的 npx 运行（DSH 运行时 node 22 不支持）；复用 n8n/scripts/ 现成 daemon 管理脚本。
//  direct(:3333)=无代理兜底；restricted(:3334)=注入 :7890 代理仅受限域名；数据层各自 WIGOLO_DATA_DIR 隔离。
const N24_BIN = process.env.N8N_BIN_DIR || `${HOME}/.nvm/versions/node/v24.14.0/bin`;
const N8N_SCRIPTS = process.env.N8N_SCRIPTS_DIR || `${HOME}/ToDo/n8n/scripts`;
const WIGOLO_DIRECT_SCRIPT = `${N8N_SCRIPTS}/wigolo-direct-daemon.sh`;
const WIGOLO_RESTRICTED_SCRIPT = `${N8N_SCRIPTS}/wigolo-restricted-daemon.sh`;
const WIGOLO_DIRECT_PORT = 3333;
const WIGOLO_RESTRICTED_PORT = 3334;
//  mediacrawler：非常驻 CLI，健康=Thorium CDP:9222 可达（登录态载体）+ MediaCrawler venv 存在。
const MC_ROOT = process.env.MEDIACRAWLER_ROOT || `${HOME}/MediaCrawler`;
const MC_VENV = `${MC_ROOT}/.venv/bin/python`;
const MC_THORIUM_APP = "/Applications/Thorium-Opt.app";

// ---- OpenViking 组（生产）路径常量 ----
const OV_SERVER = `${HOME}/.local/bin/openviking-server`;
const OV_CONF = `${HOME}/.openviking/ov.conf`;
const OV_LOG = `${HOME}/.openviking/ov-prod-restart-20261024.log`;
const INGEST_DIR = `${HOME}/.openviking/ingest`;
const INGEST_SCRIPT = `${INGEST_DIR}/ingest_dsh_sessions.py`;
const INGEST_CONFIG = `${INGEST_DIR}/ov-import-config.json`;
const INGEST_STATE = `${HOME}/.openviking/data/vectordb/ingest/ov-ingest-state-prod.db`;
const INGEST_LOG = `/Users/zyaire/.openviking/ingest/logs/dsh-session-ingest.log`;
const INGEST_ARGS = `--config "${INGEST_CONFIG}" --dsh-home "${HOME}/.dsh" --state "${INGEST_STATE}" --ov http://127.0.0.1:1933 --interval 60`;

// ---- DeepSearch 组路径常量 ----
const DEEPSEARCH_DIR = `${HOME}/DeepSearch/console`;
const DEEPSEARCH_SERVER = `${DEEPSEARCH_DIR}/server.js`;
const DEEPSEARCH_PORT = Number(process.env.DEEPSEARCH_CONSOLE_PORT || 6600);
const DEEPSEARCH_NODE = `${HOME}/.local/node22/bin/node`;
const DEEPSEARCH_LOG = `/tmp/deepsearch-console.log`;

// ---- 自启动开关配置（2026-10-27，2026-11-03 增 Mem0）：DeepSearch / OpenViking / Mem0 组是否随 dsh 启动自动拉起一次 ----
// 开关状态持久化在 ~/.dsh/plugin-service-manager-autostart.json（前端组头开关读写）
const AUTOSTART_FILE = `${HOME}/.dsh/plugin-service-manager-autostart.json`;
const AUTOSTART_DEFAULTS = { openviking: true, deepsearch: false, mem0: false };

function loadAutostart() {
  try {
    const raw = readFileSync(AUTOSTART_FILE, "utf8");
    const cfg = JSON.parse(raw);
    return { ...AUTOSTART_DEFAULTS, ...(cfg && typeof cfg === "object" ? cfg : {}) };
  } catch {
    return { ...AUTOSTART_DEFAULTS };
  }
}

function saveAutostart(cfg) {
  try { mkdirSync(dirname(AUTOSTART_FILE), { recursive: true }); } catch {}
  writeFileSync(AUTOSTART_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function portUp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new (createRequire(import.meta.url)("node:net").Socket)();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host || "127.0.0.1");
  });
}

async function status() {
  const services = [];
  for (const s of SERVICES) {
    let running;
    if (s.procPattern) {
      // 无端口服务（如常驻轮询脚本）：按进程模式探测
      try {
        const { stdout } = await execFileP("bash", ["-c", `pgrep -f "${s.procPattern}" | head -1`], { timeout: 3000 });
        running = String(stdout || "").trim().length > 0;
      } catch {
        running = false;
      }
    } else if (s.id === "mediacrawler") {
      // mediacrawler：非常驻 CLI，"running"= Thorium CDP:9222 可达（登录态载体）+ venv 存在
      const thoriumUp = await portUp("127.0.0.1", 9222);
      let venvOk = false;
      try {
        await execFileP("bash", ["-c", `[ -x "${MC_VENV}" ]`], { timeout: 3000 });
        venvOk = true;
      } catch { venvOk = false; }
      running = thoriumUp && venvOk;
    } else {
      running = await portUp(s.host || "127.0.0.1", s.port);
    }
    services.push({ ...s, running });
  }
  return { ok: true, services, autostart: loadAutostart() };
}

/** Mem0 组独立控制（不走 tdai-local.sh）：
 *  mem0-search-6610:  本机 nohup 起 search_server.py（:6610，读 DeepSearch 重建库）/ kill 端口进程
 *  wemm-embed:        ssh 108 执行 wemm-fix.sh（start）/ kill 8810 python（stop）
 *  mem0-browse:       本机 nohup 起浏览 mem0-browse-server.py（:6620，读 DeepSearch 新库）/ kill 端口进程
 */
async function controlMem0(action, ids) {
  const results = {};
  const targets = ids || ["mem0-search-6610", "wemm-embed"];
  for (const s of SERVICES) {
    if (!targets.includes(s.id)) continue;
    try {
      if (s.id === "mem0-search-6610") {
        // canonical 6610 检索常驻：MEM0_ROOT/CONFIG/PROBE 指向 DeepSearch 重建库，venv 用 mem0 那个
        const SS_ENV = `MEM0_ROOT="${SEARCH_SERVER_ROOT}" MEM0_CONFIG_PATH="${SEARCH_SERVER_CONFIG}" MEM0_PROBE_RECORDS="${SEARCH_SERVER_PROBE}"`;
        const SS_START = `nohup "${MEM0_PY}" "${SEARCH_SERVER_PY}" --port ${SEARCH_SERVER_PORT} > /tmp/search-server-6610.log 2>&1 &`;
        if (action === "start") {
          await execFileP("bash", ["-c", `${SS_ENV} ${SS_START}`], { timeout: 10000 });
        } else if (action === "stop") {
          await execFileP("bash", ["-c", `lsof -tiTCP:${SEARCH_SERVER_PORT} -sTCP:LISTEN | xargs -r kill; true`], { timeout: 10000 });
        } else if (action === "restart") {
          await execFileP("bash", ["-c", `lsof -tiTCP:${SEARCH_SERVER_PORT} -sTCP:LISTEN | xargs -r kill; sleep 1; ${SS_ENV} ${SS_START}`], { timeout: 15000 });
        }
        results[s.id] = { ok: true, action };
      } else if (s.id === "wemm-embed") {
        if (action === "start") {
          await execFileP("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "192.168.1.108", WEMM_FIX], { timeout: 30000 });
        } else if (action === "stop") {
          await execFileP("ssh", ["-o", "BatchMode=yes", "192.168.1.108", "lsof -tiTCP:8810 -sTCP:LISTEN | xargs -r kill; true"], { timeout: 15000 });
        } else if (action === "restart") {
          await execFileP("ssh", ["-o", "BatchMode=yes", "192.168.1.108", `lsof -tiTCP:8810 -sTCP:LISTEN | xargs -r kill; sleep 1; ${WEMM_FIX}`], { timeout: 30000 });
        }
        results[s.id] = { ok: true, action };
      } else if (s.id === "mem0-browse") {
        if (action === "start") {
          await execFileP("bash", ["-c", `MEM0_SANDBOX_ROOT="${MEM0_BROWSE_ROOT}" nohup "${MEM0_PY}" "${MEM0_BROWSE_SERVER}" --port ${MEM0_BROWSE_PORT} > /tmp/mem0-browse-server.log 2>&1 &`], { timeout: 10000 });
        } else if (action === "stop") {
          await execFileP("bash", ["-c", `lsof -tiTCP:${MEM0_BROWSE_PORT} -sTCP:LISTEN | xargs -r kill; true`], { timeout: 10000 });
        } else if (action === "restart") {
          await execFileP("bash", ["-c", `lsof -tiTCP:${MEM0_BROWSE_PORT} -sTCP:LISTEN | xargs -r kill; sleep 1; MEM0_SANDBOX_ROOT="${MEM0_BROWSE_ROOT}" nohup "${MEM0_PY}" "${MEM0_BROWSE_SERVER}" --port ${MEM0_BROWSE_PORT} > /tmp/mem0-browse-server.log 2>&1 &`], { timeout: 15000 });
        }
        results[s.id] = { ok: true, action };
      }
    } catch (e) {
      results[s.id] = { ok: false, action, error: String(e?.message || e) };
    }
  }
  return results;
}

/** New API 组独立控制（不走 tdai-local.sh）：
 *  newapi: 调 apps/new-api/newapi-ctl.sh（python Popen 分离会话，免 execFile 管道占用）
 */
async function controlNewApi(action) {
  try {
    await execFileP("bash", [NEWAPI_CTL, action], { timeout: 15000 });
    return { ok: true, action };
  } catch (e) {
    return { ok: false, action, error: String(e?.message || e) };
  }
}

/** OpenViking 组独立控制（不走 tdai-local.sh）：
 *  openviking:          nohup 起 openviking-server（生产 1933）/ lsof kill
 *  dsh-session-ingest:  nohup 起 ingest 常驻轮询（--interval 60，生产状态库）/ pgrep kill
 */
async function controlOpenViking(action, ids) {
  const results = {};
  const targets = ids || ["openviking", "dsh-session-ingest"];
  for (const s of SERVICES) {
    if (s.id !== "openviking" && s.id !== "dsh-session-ingest") continue;
    if (!targets.includes(s.id)) continue;
    try {
      if (s.id === "openviking") {
        if (action === "start") {
          await execFileP("bash", ["-c", `NO_PROXY="*" no_proxy="*" nohup "${OV_SERVER}" --config "${OV_CONF}" > "${OV_LOG}" 2>&1 &`], { timeout: 10000 });
        } else if (action === "stop") {
          await execFileP("bash", ["-c", `lsof -tiTCP:1933 -sTCP:LISTEN | xargs -r kill; true`], { timeout: 10000 });
        } else if (action === "restart") {
          await execFileP("bash", ["-c", `lsof -tiTCP:1933 -sTCP:LISTEN | xargs -r kill; sleep 1; NO_PROXY="*" no_proxy="*" nohup "${OV_SERVER}" --config "${OV_CONF}" > "${OV_LOG}" 2>&1 &`], { timeout: 15000 });
        }
        results[s.id] = { ok: true, action };
      } else if (s.id === "dsh-session-ingest") {
        const procCmd = `pgrep -f "${s.procPattern}" | xargs -r kill; true`;
        if (action === "start") {
          await execFileP("bash", ["-c", `PATH="/opt/homebrew/bin:$PATH" nohup python3 "${INGEST_SCRIPT}" ${INGEST_ARGS} > "${INGEST_LOG}" 2>&1 &`], { timeout: 10000 });
        } else if (action === "stop") {
          await execFileP("bash", ["-c", procCmd], { timeout: 10000 });
        } else if (action === "restart") {
          await execFileP("bash", ["-c", `${procCmd}; sleep 1; PATH="/opt/homebrew/bin:$PATH" nohup python3 "${INGEST_SCRIPT}" ${INGEST_ARGS} > "${INGEST_LOG}" 2>&1 &`], { timeout: 15000 });
        }
        results[s.id] = { ok: true, action };
      }
    } catch (e) {
      results[s.id] = { ok: false, action, error: String(e?.message || e) };
    }
  }
  return results;
}

/** DeepSearch 组独立控制（不走 tdai-local.sh）：
 *  deepsearch-console: nohup 起 server.js（:6600）/ lsof kill
 */
async function controlDeepSearch(action) {
  const results = {};
  try {
    if (action === "start") {
      await execFileP("bash", ["-c", `DEEPSEARCH_CONSOLE_PORT=${DEEPSEARCH_PORT} nohup "${DEEPSEARCH_NODE}" "${DEEPSEARCH_SERVER}" > "${DEEPSEARCH_LOG}" 2>&1 &`], { timeout: 10000 });
    } else if (action === "stop") {
      await execFileP("bash", ["-c", `lsof -tiTCP:${DEEPSEARCH_PORT} -sTCP:LISTEN | xargs -r kill; true`], { timeout: 10000 });
    } else if (action === "restart") {
      await execFileP("bash", ["-c", `lsof -tiTCP:${DEEPSEARCH_PORT} -sTCP:LISTEN | xargs -r kill; sleep 1; DEEPSEARCH_CONSOLE_PORT=${DEEPSEARCH_PORT} nohup "${DEEPSEARCH_NODE}" "${DEEPSEARCH_SERVER}" > "${DEEPSEARCH_LOG}" 2>&1 &`], { timeout: 15000 });
    }
    results["deepsearch-console"] = { ok: true, action };
  } catch (e) {
    results["deepsearch-console"] = { ok: false, action, error: String(e?.message || e) };
  }
  return results;
}

/** n8n 组独立控制（不走 tdai-local.sh）：
 *  n8n-server: nohup 起 n8n start（:5678，须 nvm v24 node on PATH）/ lsof 按端口 kill
 */
async function controlN8n(action) {
  const results = {};
  try {
    if (action === "start") {
      await execFileP("bash", ["-c", `PATH="${N8N_BIN_DIR}:$PATH" N8N_PORT=${N8N_PORT} nohup n8n start > "${N8N_LOG}" 2>&1 &`], { timeout: 10000 });
    } else if (action === "stop") {
      await execFileP("bash", ["-c", `lsof -tiTCP:${N8N_PORT} -sTCP:LISTEN | xargs -r kill; true`], { timeout: 10000 });
    } else if (action === "restart") {
      await execFileP("bash", ["-c", `lsof -tiTCP:${N8N_PORT} -sTCP:LISTEN | xargs -r kill; sleep 1; PATH="${N8N_BIN_DIR}:$PATH" N8N_PORT=${N8N_PORT} nohup n8n start > "${N8N_LOG}" 2>&1 &`], { timeout: 15000 });
    }
    results["n8n-server"] = { ok: true, action };
  } catch (e) {
    results["n8n-server"] = { ok: false, action, error: String(e?.message || e) };
  }
  return results;
}

/** Web Search 组独立控制（2026-11-09）：wigolo-direct / wigolo-restricted / mediacrawler。
 *  wigolo-direct/restricted: 复用 n8n/scripts/wigolo-*-daemon.sh（npx wigolo serve，须 v24 on PATH）
 *  mediacrawler: 非常驻 CLI——start=确保 Thorium CDP:9222 起来（复用登录态载体），stop 不杀 Thorium（用户可能在用）。
 */
async function controlWebSearch(action) {
  const results = {};
  const daemon = async (id, script, port) => {
    try {
      if (action === "status") {
        const { stdout } = await execFileP("bash", ["-c", `bash "${script}" status`], { timeout: 5000 });
        results[id] = { ok: true, action, running: /UP/.test(String(stdout)), detail: String(stdout).trim() };
      } else {
        const { stdout } = await execFileP("bash", ["-c", `PATH="${N24_BIN}:$PATH" bash "${script}" ${action}`], { timeout: 70000 });
        results[id] = { ok: true, action, detail: String(stdout).trim().split("\n").slice(-2).join(" | ") };
      }
    } catch (e) {
      results[id] = { ok: false, action, error: String(e?.message || e) };
    }
  };
  await daemon("wigolo-direct", WIGOLO_DIRECT_SCRIPT, WIGOLO_DIRECT_PORT);
  await daemon("wigolo-restricted", WIGOLO_RESTRICTED_SCRIPT, WIGOLO_RESTRICTED_PORT);
  // mediacrawler 探测：Thorium CDP:9222 up + venv 存在 = ready
  try {
    const thoriumUp = await portUp("127.0.0.1", 9222);
    let venvOk = false;
    try {
      await execFileP("bash", ["-c", `[ -x "${MC_VENV}" ]`], { timeout: 3000 });
      venvOk = true;
    } catch { venvOk = false; }
    if (action === "start" && !thoriumUp) {
      // 按需拉起 Thorium（带 CDP 调试端口），最多等 25s；已在跑则 open 幂等无害
      await execFileP("bash", ["-c", `open -a "${MC_THORIUM_APP}" --args --remote-debugging-port=9222`], { timeout: 5000 });
      for (let i = 0; i < 25; i++) { if (await portUp("127.0.0.1", 9222)) { break; } await new Promise((r) => setTimeout(r, 1000)); }
    }
    const up = await portUp("127.0.0.1", 9222);
    results["mediacrawler"] = {
      ok: true, action, running: up,
      ready: up && venvOk,
      detail: `Thorium CDP:9222 ${up ? "UP" : "DOWN"} · venv ${venvOk ? "ok" : "missing"}`,
    };
  } catch (e) {
    results["mediacrawler"] = { ok: false, action, error: String(e?.message || e) };
  }
  return results;
}

async function runScript(action, groupId) {
  // Mem0 组独立控制（不走 tdai-local.sh）：mem0 / embedding / mem0-db 三组
  // 2026-11-03：WeMM Embedding 自「mem0」组拆出为独立「embedding」组，组内控制面 1:1（避免分组 action 误伤）
  const MEM0_GROUPS = { mem0: ["mem0-search-6610"], embedding: ["wemm-embed"], "mem0-db": ["mem0-browse"] };
  if (groupId === "mem0" || groupId === "embedding" || groupId === "mem0-db") {
    const mem0Res = await controlMem0(action, MEM0_GROUPS[groupId] || []);
    const anyFail = Object.values(mem0Res).some((r) => r.ok !== true);
    return { ok: !anyFail, action, mem0: mem0Res, stderr: "" };
  }
  // New API 组独立控制
  if (groupId === "newapi") {
    const newapiRes = await controlNewApi(action);
    return { ok: newapiRes.ok === true, action, newapi: newapiRes, stderr: "" };
  }
  // OpenViking 组独立控制
  if (groupId === "openviking") {
    const ovRes = await controlOpenViking(action);
    const anyFail = Object.values(ovRes).some((r) => r.ok !== true);
    return { ok: !anyFail, action, openviking: ovRes, stderr: "" };
  }
  // DeepSearch 组独立控制
  if (groupId === "deepsearch") {
    const dsRes = await controlDeepSearch(action);
    const anyFail = Object.values(dsRes).some((r) => r.ok !== true);
    return { ok: !anyFail, action, deepsearch: dsRes, stderr: "" };
  }
  // n8n 组独立控制
  if (groupId === "n8n") {
    const n8nRes = await controlN8n(action);
    return { ok: n8nRes["n8n-server"]?.ok === true, action, n8n: n8nRes, stderr: "" };
  }
  // Web Search 组（2026-11-09）：wigolo-direct / wigolo-restricted / mediacrawler
  if (groupId === "websearch") {
    const wsRes = await controlWebSearch(action);
    const anyFail = Object.values(wsRes).some((r) => r.ok !== true);
    return { ok: !anyFail, action, websearch: wsRes, stderr: "" };
  }
  // TencentDB 组（tdai）已废弃移除；未知组兜底
  return { ok: false, action, error: `unknown group: ${groupId}` };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function apply(ctx, config) {
  // webServer 通过模块级 inject 注入（dsh-better-sidebar 同款声明方式）
  const webServer = ctx.webServer;
  if (webServer === void 0 || typeof webServer.register !== "function") {
    ctx.logger?.warn?.("[plugin-service-manager] webServer unavailable; routes not registered");
    return;
  }

  // GET /tdai-svc/status
  const off1 = webServer.register({
    kind: "exact",
    path: "/tdai-svc/status",
    handler: async (req, res) => {
      try {
        json(res, 200, await status());
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) });
      }
    },
  });

  // POST /tdai-svc/control
  const off2 = webServer.register({
    kind: "exact",
    path: "/tdai-svc/control",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const action = String(body?.action || "");
        const groupId = String(body?.groupId || "");
        if (!["start", "stop", "restart"].includes(action)) {
          json(res, 400, { ok: false, error: `unknown action: ${action}` });
          return;
        }
        const r = await runScript(action, groupId);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const st = await status();
        json(res, r.ok ? 200 : 500, { ...r, services: st.services });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) });
      }
    },
  });

  ctx.logger?.info?.("[plugin-service-manager] routes: /tdai-svc/status + /tdai-svc/control + /tdai-svc/autostart");

  // POST /tdai-svc/autostart —— 前端组头「自启动」开关读写（2026-10-27，2026-11-03 增 mem0，持久化到 ~/.dsh/plugin-service-manager-autostart.json）
  const off3 = webServer.register({
    kind: "exact",
    path: "/tdai-svc/autostart",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const groupId = String(body?.groupId || "");
        const enabled = body?.enabled === true;
        if (!["openviking", "deepsearch", "mem0", "websearch", "n8n"].includes(groupId)) {
          json(res, 400, { ok: false, error: `unknown group: ${groupId}` });
          return;
        }
        const cfg = loadAutostart();
        cfg[groupId] = enabled;
        saveAutostart(cfg);
        json(res, 200, { ok: true, autostart: cfg });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e) });
      }
    },
  });

  // 跟随 dsh 启动：按「自启动」开关逐组探测拉起一次（幂等，延迟等 webServer 就绪）
  // 2026-10-27 用户需求：autoStart 由前端组头开关控制（DeepSearch / OpenViking 两组）；
  // 2026-11-03 增 Mem0 组（仅本机 mem0-search）。
  // 只幂等拉起一次，不做无限自启动（服务可被杀，需再起走插件面板）；旧沙盒脚本已归档，任何机制不得再拉起
  const autoStartGroups = async () => {
    try {
      const cfg = loadAutostart();
      const st = await status();
      const byId = new Map(st.services.map((s) => [s.id, s.running]));
      const toStart = [];
      if (cfg.openviking) {
        const need = [];
        if (byId.get("openviking") === false) need.push("openviking");
        if (byId.get("dsh-session-ingest") === false) need.push("dsh-session-ingest");
        if (need.length) toStart.push(() => controlOpenViking("start", need));
      }
      if (cfg.deepsearch && byId.get("deepsearch-console") === false) {
        toStart.push(() => controlDeepSearch("start"));
      }
      // Mem0 组（2026-11-12 起：仅 canonical search_server 6610；旧 8915 已废弃移除）；
      // embedding(108:8810，远程 ssh) 不随 dsh 自启动
      if (cfg.mem0) {
        const need = [];
        if (byId.get("mem0-search-6610") === false) need.push("mem0-search-6610");
        if (need.length) toStart.push(() => controlMem0("start", need));
      }
      // Web Search 组（2026-11-09）：随 dsh 自启动拉起 wigolo 双 daemon + 确保 Thorium(mediacrawler)
      //  wigolo 冷启动慢（首次 npx 装包+加载模型 ~60s+），autoStartGroups 不等它——controlWebSearch 内部
      //  daemon 脚本自己轮询 health。mediacrawler 非常驻，仅确保 Thorium CDP 起来（幂等，已在跑则跳过）。
      if (cfg.websearch) {
        const need = [];
        if (byId.get("wigolo-direct") === false) need.push("wigolo-direct");
        if (byId.get("wigolo-restricted") === false) need.push("wigolo-restricted");
        if (byId.get("mediacrawler") === false) need.push("mediacrawler");
        if (need.length) toStart.push(() => controlWebSearch("start"));
      }
      // n8n 组（2026-11-09 加自启动）：随 dsh 启动拉起 n8n server(:5678，须 nvm v24 on PATH)
      if (cfg.n8n && byId.get("n8n-server") === false) {
        toStart.push(() => controlN8n("start"));
      }
      if (toStart.length === 0) {
        ctx.logger?.info?.("[plugin-service-manager] 自启动组均已运行，跳过自动拉起");
        return;
      }
      for (const run of toStart) await run();
      ctx.logger?.info?.("[plugin-service-manager] 自启动拉起完成: " + toStart.length + " 组");
    } catch (e) {
      ctx.logger?.warn?.("[plugin-service-manager] autoStart failed: " + String(e?.message || e));
    }
  };
  setTimeout(autoStartGroups, 5000);

  ctx.on("dispose", () => {
    try { off1?.(); } catch {}
    try { off2?.(); } catch {}
    try { off3?.(); } catch {}
    ctx.logger?.info?.("[plugin-service-manager] disposed");
  });
}

const Config = {
  "~standard": {
    version: 1,
    vendor: "plugin-service-manager",
    validate: (value) => ({ value: value && typeof value === "object" ? value : {} }),
  },
};

// Cordis 硬依赖声明：注入后 ctx.webServer 才可用（dsh-better-sidebar 同款导出方式）
const inject = ["webServer"];

export { apply, Config, inject };
