/**
 * consent.js — KRouter 会话导入 consent（隐私闸门）
 *
 * 管的是什么：`consent` 存在 ~/.local/state/krouter/import.json（或 $KROUTER_STATE_DIR/import.json），
 * 只闸「会话导入 / nightly learn」这条管线（import_sessions.py --nightly / --intraday / --file）。
 * 没同意时 scheduled import 直接 `{"import":"off","reason":"no consent yet"}` 返回，不读任何 transcript。
 *
 * 不管的是什么：主动写工具 krouter_note/correct/learn 走 MCP stdio（WRITE=True + may_write()），
 * 与本 consent 无关——那三个工具装插件即注册，不设独立写闸（vault 保护靠关插件）。
 *
 * 行为（2026-11-14 用户要求去掉隐私闸后）：initConsent 默认写 consent:true——装插件即全功能，
 * 本体 import_sessions.py 的 consented() 读同一 import.json，不写它本体就静默不写 vault。
 * config.consentSessions === "revoke" 才撤回；=== false 保持关。写 JSON 状态本身不写 vault（vault 写发生在后续 import）。
 *
 * Schema（对齐 import_sessions.py:995 save_state）：
 *   { consent: bool, distill: bool, overlap: str, cli: str, exclude_roots: [...], at: ISO }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** import.json 绝对路径（尊重 KROUTER_STATE_DIR）。 */
export function stateFile() {
  const base = process.env.KROUTER_STATE_DIR || join(homedir(), ".local", "state", "krouter");
  return join(base, "import.json");
}

/** 读当前 consent 状态（文件不存在/损坏 → {}）。 */
export function readState() {
  const p = stateFile();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) || {};
  } catch {
    return {};
  }
}

/**
 * consent 摘要，供 apply 时 log / 供 status 工具呈现。
 * @returns {{consented:boolean, distill:boolean, cli:string, at:string, stateFile:string}}
 */
export function consentStatus() {
  const st = readState();
  return {
    consented: st.consent === true,
    distill: st.distill === true,
    cli: typeof st.cli === "string" ? st.cli : "",
    at: typeof st.at === "string" ? st.at : "",
    stateFile: stateFile(),
  };
}

/**
 * 写 consent 开关（保留其它字段）。consent=false = 撤回（对齐 --revoke 只把 consent 置 false）。
 * @param {boolean} on
 * @param {{distill?:boolean, cli?:string}} [extra]
 * @returns {{ok:boolean, status:object, error?:string}}
 */
export function setConsent(on, extra = {}) {
  const p = stateFile();
  try {
    const st = readState();
    const next = { ...st, consent: on === true };
    if (on === true) {
      if (extra.distill !== undefined) next.distill = extra.distill === true;
      if (extra.cli) next.cli = String(extra.cli);
      next.at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 1) + "\n", "utf-8");
    return { ok: true, status: consentStatus() };
  } catch (e) {
    return { ok: false, status: consentStatus(), error: e?.message ?? String(e) };
  }
}

/**
 * apply 时调用：按 config 初始化 consent，并 log 状态。
 * 默认（2026-11-14 起）写 consent:true——装插件即全功能，去掉隐私闸。
 * 只有 config.consentSessions === "revoke" 才撤回；=== false 保持关。
 * @param {{consentSessions?:boolean|"revoke", distill?:boolean, cli?:string}} config
 * @param {object} [logger]
 * @returns {object} consentStatus()
 */
export function initConsent(config = {}, logger = {}) {
  const log = (lvl, msg) => {
    const fn = logger?.[lvl];
    if (typeof fn === "function") fn.call(logger, msg);
  };
  const mode = config.consentSessions;
  if (mode === "revoke") {
    const r = setConsent(false);
    log(r.ok ? "info" : "warn", `dsh-krouter: 会话导入 consent 已撤回（${r.status.stateFile}）`);
  } else if (mode === false) {
    // 显式 false = 保持关（用户将来想重新启用隐私闸时用）
    const s = consentStatus();
    log("info", `dsh-krouter: 会话导入 consent=${s.consented ? "已开启" : "未开启"}（config.consentSessions=false，不改动）。`);
  } else {
    // 默认（含 undefined / true）：写 consent:true —— 用户要求去掉隐私闸、装插件即全功能。
    // 本体 import_sessions.py 的 consented() 读同一 import.json，不写它本体就静默不写 vault。
    const r = setConsent(true, { distill: config.distill, cli: config.cli });
    log(r.ok ? "info" : "warn",
      `dsh-krouter: 会话导入 consent 已${r.ok ? "记录" : "记录失败"}（${r.status.stateFile}）` +
      (r.error ? `: ${r.error}` : ""));
  }
  return consentStatus();
}
