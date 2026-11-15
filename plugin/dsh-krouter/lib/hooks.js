/**
 * hooks.js — KRouter 五事件被动注入（DSH 桥接层）
 *
 * Claude Code 五事件 → DSH 插件事件映射：
 * ─────────────────────────────────────────────────────────
 * ① SessionStart      → agent/pre-step 首次触发（本文件导出 isSessionStart 检测）
 * ② UserPromptSubmit  → agent/pre-step 每轮（index.js 已实现被动召回）
 * ③ Stop (turn)       → session/event type="turn/end"
 * ④ SessionEnd        → agent/turn-stopping（近似；真正 session dispose 无对应事件）
 * ⑤ PreCompact        → session/event type="compaction/start"
 *
 * 每个 hook 调 session_hook.py 对应子命令，传 JSON payload on stdin。
 * transcript_path 在 DSH 中不可直接获取（session.v4.jsonl.zstd 格式），
 * turn/end 的 learn_from_turn 会因 transcript_path 为空而跳过（安全降级）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { findSessionFile, importSession, turnTranscript } from "./transcript.js";

const KROUTER_HOME = process.env.KROUTER_HOME || join(process.env.HOME || "", ".KRouter");
const SESSION_HOOK = join(KROUTER_HOME, "current", "skill", "krouter", "scripts", "session_hook.py");

/** seen-sessions 持久化文件（防进程重启后 standing index 重复注入同一会话）。 */
function seenSessionsFile() {
  const base = process.env.KROUTER_STATE_DIR || join(homedir(), ".local", "state", "krouter");
  return join(base, "dsh-krouter-seen-sessions.json");
}

/** session 记录保留期（毫秒）：超过则视为新会话可重新注入。默认 7 天。 */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 读 seen-sessions 映射（{ [sessionId]: firstSeenISO }），顺带清掉过期条目。
 * 文件不存在/损坏 → {}。
 */
function readSeenSessions() {
  const p = seenSessionsFile();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) || {};
    const now = Date.now();
    const out = {};
    for (const [sid, iso] of Object.entries(raw)) {
      const t = Date.parse(iso);
      if (Number.isFinite(t) && now - t < SEEN_TTL_MS) out[sid] = iso;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写 seen-sessions 映射（原子性不强求；写失败静默——标记丢了最多重复注入一次，不致命）。 */
function writeSeenSessions(map) {
  const p = seenSessionsFile();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(map, null, 1) + "\n", "utf-8");
  } catch {
    /* 标记写不进去不阻断对话 */
  }
}

/**
 * 检测是否为某 session 的首次 pre-step（SessionStart 等价）。
 * 首次调用返回 true 并持久化标记；后续调用（含跨进程重启）返回 false。
 * 持久化避免 DSH 重启后对同一会话重复注入 standing index。
 */
export function isSessionStart(sessionId) {
  if (!sessionId) return false;
  const seen = readSeenSessions();
  if (seen[sessionId]) return false;
  seen[sessionId] = new Date().toISOString();
  writeSeenSessions(seen);
  return true;
}

/**
 * 回滚某 session 的 seen 标记（fetch 失败/抛错时调）。
 * isSessionStart 先占位标记防并发重复注入；一旦 fetch 没拿到 standing，就撤销标记，
 * 让本会话下一次 pre-step 能重试。成功路径不调它——标记保留防重复。
 */
export function clearSessionSeen(sessionId) {
  if (!sessionId) return;
  const seen = readSeenSessions();
  if (!(sessionId in seen)) return;
  delete seen[sessionId];
  writeSeenSessions(seen);
}

/** 清空 session 追踪（测试用）。 */
export function resetSessions() {
  try {
    const p = seenSessionsFile();
    if (existsSync(p)) writeFileSync(p, "{}\n", "utf-8");
  } catch {
    /* 忽略 */
  }
}

/**
 * ② UserPromptSubmit 的「纠正候选捕捉」（对齐 Claude Code prompt hook 的 note_correction）。
 *
 * 用户随口一句像纠正的话（"以后都用 SQLite"），session_hook.py prompt 当场照录成
 * correction-candidates，待下次增量蒸馏判定。这是被动学习，不经 MCP。
 *
  * 写 vault：note_correction 写 vault 由本体 consented() 守。插件侧 consent 短路已按用户要求删除
  * （2026-11-14）——装插件即无条件 spawn，不再 pre-check consent（本体侧 import.json 闸由 initConsent 默认写 consent:true 放行）。
 *
 * KROUTER_RECALL_PROMPT=0：让 recall_note 早退（routes() 返回空），只跑 note_correction，
 * 不重复做「想起」（想起仍由 recollect.js 走 route_knowledge 富 receipt 负责，产出 state 驱动胶囊）。
 *
 * 纯被动、不阻断对话：失败静默（never throw）。
 * @param {string} text  用户当轮文本（own_words 后的）
 * @param {string} sessionId
 * @param {string} vault
 * @param {{cwd?:string}} [opts]
 * @returns {Promise<{ok:boolean, captured:boolean, reason?:string}>}
 */
export function captureCorrection(text, sessionId, vault, opts = {}) {
  return new Promise((resolve) => {
    const q = String(text || "").trim();
    if (!q) return resolve({ ok: false, captured: false, reason: "empty" });
    if (!vault || !existsSync(SESSION_HOOK)) {
      return resolve({ ok: false, captured: false, reason: "hook unavailable" });
    }

    const payload = {
      session_id: sessionId || "",
      transcript_path: "", // DSH 不给 transcript 路径；marked_out 检查跳过（安全降级）
      cwd: opts.cwd || "",
      prompt: q,
    };
    const hookEnv = {
      ...process.env,
      KROUTER_VAULT: vault,
      OBSIDIAN_VAULT: vault,
      KROUTER_RECALL_PROMPT: "0", // 关键：只跑 note_correction，跳过 recall_note
    };

    let stderr = "";
    let settled = false;
    const proc = spawn("python3", [SESSION_HOOK, "prompt"], {
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
        settled = true;
        resolve({ ok: false, captured: false, reason: "timeout" });
      }
    }, 10000);

    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (rc) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // note_correction 无 stdout 回执（静默写 vault）；rc=0 即跑通
      resolve({ ok: rc === 0, captured: rc === 0, reason: rc === 0 ? "" : stderr.slice(0, 120) });
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, captured: false, reason: e.message });
    });

    try {
      proc.stdin.write(JSON.stringify(payload) + "\n");
      proc.stdin.end();
    } catch { /* stdin 关闭忽略 */ }
  });
}

/**
 * 调 session_hook.py 子命令。
 * payload 通过 stdin 传 JSON（Claude Code hook 协议）。
 * 返回 { ok, stdout, stderr, rc }。
 */
function spawnHook(subcommand, payload, vault, timeoutMs = 10000, extraEnv = {}) {
  return new Promise((resolve) => {
    if (!vault || !existsSync(SESSION_HOOK)) {
      resolve({ ok: false, stdout: "", stderr: "hook unavailable", rc: 2 });
      return;
    }

    const hookEnv = {
      ...process.env,
      KROUTER_VAULT: vault,
      OBSIDIAN_VAULT: vault,
      ...extraEnv,
    };

    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn("python3", [SESSION_HOOK, subcommand], {
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
        settled = true;
        resolve({ ok: false, stdout, stderr: stderr + " [timeout]", rc: 124 });
      }
    }, timeoutMs);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (rc) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: rc === 0, stdout: stdout.trim(), stderr: stderr.trim(), rc: rc ?? 1 });
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + e.message, rc: 1 });
    });

    // Claude Code hook 协议：payload JSON on stdin
    try {
      proc.stdin.write(JSON.stringify(payload) + "\n");
      proc.stdin.end();
    } catch { /* stdin 可能已关闭，忽略 */ }
  });
}

/**
 * 解析 session_hook.py 的 stdout JSON，提取 additionalContext。
 * 输出格式：{"hookSpecificOutput": {"hookEventName": "...", "additionalContext": "..."}}
 */
export function parseAdditionalContext(stdout) {
  if (!stdout) return "";
  try {
    const parsed = JSON.parse(stdout);
    return parsed?.hookSpecificOutput?.additionalContext || "";
  } catch {
    return "";
  }
}

/**
 * 调 session_hook.py start，返回 standing index 文本（或空字符串）。
 */
export async function fetchStandingIndex(vault, sessionId) {
  const payload = { session_id: sessionId || "" };
  const r = await spawnHook("start", payload, vault);
  if (!r.ok && !r.stdout) return "";
  return parseAdditionalContext(r.stdout);
}

/**
 * 一个会话的「结束」动作：end hook（本体侧收尾）+ 整段导入（transcript 闸门开着才做）。
 *
 * 为什么抽出来：DSH 没有 session end 事件，能触发它的地方有两处——
 *  ① PreCompact（压缩前存一份，会话还要继续）；
 *  ② 空闲判定（会话停止更新满 N 分钟，见 idle.js）。
 * 两处逻辑必须一致，各写一份迟早走样。
 */
export function distillSession(ctx, sessionId, opts = {}) {
  const { vault } = opts;
  if (!vault || !sessionId) return Promise.resolve({ ok: false, error: "缺 vault 或 sessionId" });

  const endRun = spawnHook("end", { transcript_path: "", session_id: sessionId }, vault)
    .then((r) => {
      if (r.stderr) ctx.logger?.warn?.(`dsh-krouter: session end hook: ${r.stderr.slice(0, 100)}`);
      return r;
    })
    .catch(() => ({ ok: false }));

  // 隐私红线：整段导入与 turn 学习同走 transcript 闸门（consent 由本体再判一次）。
  if (opts.transcript === false) return endRun;

  const dshPath = findSessionFile(sessionId, opts.dshHome);
  if (!dshPath) return endRun;

  const importRun = importSession({
    vault,
    dshPath,
    dryRun: opts.dryRun === true,
    local: opts.local !== false,
  })
    .then((r) => {
      if (r.ok) {
        ctx.logger?.info?.(
          `dsh-krouter: transcript 导入完成（${r.lines} 行，dryRun=${opts.dryRun === true}）${r.stderr ? `: ${r.stderr.slice(0, 120)}` : ""}`,
        );
      } else {
        ctx.logger?.warn?.(`dsh-krouter: transcript 导入失败（不阻断）: ${r.error || r.stderr?.slice(0, 120)}`);
      }
      return r;
    })
    .catch((e) => {
      ctx.logger?.warn?.(`dsh-krouter: transcript 导入异常（不阻断）: ${e?.message ?? String(e)}`);
      return { ok: false };
    });

  return Promise.all([endRun, importRun]);
}

/**
 * 挂载 session/event + agent/turn-stopping 钩子。
 * 处理 Stop(turn)、PreCompact、SessionEnd 三个事件。
 */
export function mountKrouterSessionHooks(ctx, opts) {
  const { vault } = opts;
  if (typeof ctx.on !== "function") return { mounted: [] };

  // 采集挂载了哪些 DSH 事件（供 dsh_krouter_status 诊断报告）。
  // ①② 都靠 pre-step（由 mountRecallPrestep 挂，不在本函数），故此处只标 session/event 系。
  const mounted = ["pre-step"];

  // ── session/event: Stop(turn) + PreCompact ────────────────────────────────
  ctx.on("session/event", (session, event) => {
    if (!mounted.includes("session/event")) mounted.push("session/event");
    if (!session?.id || !vault) return;
    const type = event?.type;
    if (type === "turn/end") {
      // 对齐 Claude Code turn hook：喂真实 transcript_path 让 learn_from_turn 读"本轮 agent 用了什么"，
      // 喂夜间 learn_mentions（本地、无模型）。DSH session/event 不给 transcript_path，
      // 这里用 turnTranscript() 自己扫 session→convertDshToKrouter→临时 JSONL 补上。
      //
      // 隐私：与整段导入同属学习管线，走同一双闸门（opts.transcript===true && consent）。
      // 默认关——没明确授权不读会话内容。learn_from_turn 本体侧另有 learn_on() 闸门。
      let tpath = "";
      let learnEnv = {};
      if (opts.transcript !== false) {
        const t = turnTranscript(session.id, { dshHome: opts.dshHome });
        if (t.ok && t.path) {
          tpath = t.path;
          // KRouter 侧 learn 闸门默认关（learn_on() 要 KROUTER_RECALL_LEARN=1）。
          // 开 transcript 学习时一并打开，capture_turn 才会真跑（记本轮取用了什么→夜间 learn_mentions）。
          learnEnv = { KROUTER_RECALL_LEARN: "1" };
        } else if (!t.ok) {
          ctx.logger?.warn?.(`dsh-krouter: turn transcript 不可用（不阻断）: ${t.reason}`);
        }
      }
      spawnHook("turn", { transcript_path: tpath, session_id: session.id }, vault, 10000, learnEnv)
        .then((r) => {
          if (r.stderr && !r.stderr.includes("transcript")) {
            ctx.logger?.warn?.(`dsh-krouter: turn hook: ${r.stderr.slice(0, 100)}`);
          }
        })
        .catch(() => {})
        .finally(() => {
          // 清理临时 transcript（learn_from_turn 同步读完即无用；兜底删除）
          if (tpath) { try { rmSync(tpath, { force: true }); } catch {} }
        });
    }

    // ⑤ PreCompact: 压缩开始前 → 存一份（end hook + 整段导入，与空闲蒸馏同一段逻辑）
    if (type === "compaction/start") {
      distillSession(ctx, session.id, opts).catch(() => {});
    }
  });

  // ── agent/turn-stopping: SessionEnd 近似 ─────────────────────────────────
  // 注意：agent/turn-stopping 每轮都触发，不是真正的 session end。
  // 真正的 session dispose 没有对应 DSH 事件。
  // 这里用 turn-stopping 做轻量记录（end(local=True) 模式），
  // 完整 session import 待 transcript_path 接通后再启用。
  // 当前不在此处 spawn end() 以免每轮都触发 import——由 session/event turn/end 覆盖。
  mounted.push("agent/turn-stopping");

  return { mounted };
}
