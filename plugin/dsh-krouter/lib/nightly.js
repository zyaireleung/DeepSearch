/**
 * nightly.js — 每日总结定时器 + spawn nightly.py
 *
 * 职责：
 * - 根据 config.nightlyEnabled + config.nightlyTime (HH:MM) 设 setTimeout 循环
 * - 到点 spawn ~/.KRouter/current/skill/krouter/scripts/nightly.py
 * - 模型通道：根据 config.nightlyModel (provider/model) 设 OpenAI 兼容 env vars
 * - 纯本地步骤不需要模型；模型步骤由 nightly.py 自己判（有 key 就跑，没 key 就 skip）
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const KROUTER_HOME = process.env.KROUTER_HOME || join(process.env.HOME || "", ".KRouter");
const NIGHTLY_SCRIPT = join(KROUTER_HOME, "current", "skill", "krouter", "scripts", "nightly.py");

/**
 * 计算下次 HH:MM 的 Date（如果今天已过就明天的）。
 * @param {string} hhmm - "09:10" 格式
 * @returns {Date}
 */
export function computeNextRun(hhmm) {
  const [h, m] = (hhmm || "09:10").split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * 构建 nightly.py 的 env vars。
 *
 * 通道只有一条：llm bridge（127.0.0.1）→ ctx.llm.stream → DSH 当前 provider。
 * llm.py 认 OPENAI_API_KEY + OPENAI_BASE_URL 就是一条 OpenAI 兼容通道，这里给的 key
 * 只是占位值（真凭据在 DSH 手里，从不进子进程 env）。
 *
 * KROUTER_HOST_CLI=0 是 llm.py 自己的开关（llm.py:365/377）：关掉 claude/codex 订阅通道。
 * 没有桥时宁可让模型步骤 skip（NoModel），也不许静默掉回订阅——那正是之前 503 的来源。
 *
 * @param {object|null} modelConfig - { provider, model }
 * @param {object} processEnv - DSH 进程 env
 * @param {object|null} bridge - startLlmBridge() 的返回值
 * @returns {object} env vars to merge
 */
export function buildModelEnv(modelConfig, processEnv, bridge) {
  const env = { KROUTER_HOST_CLI: "0", KROUTER_EXPERIENCE: "1" };
  if (!modelConfig?.model) return env;
  env.KROUTER_LEARN_MODEL = modelConfig.model;
  // distill 模型（provider:model 全串）：本体 import_sessions.py 的 distill 作用域内会让它盖过 LEARN，
  // 桥按 body.model 的 provider 前缀路由到对应 provider —— 两个模型可各选各的 provider。
  // 留空 = 跟随每日总结模型（本体 _distill_model_scope 见 DISTILL 空即不遮 LEARN）。
  if (modelConfig.distillModel) env.KROUTER_DISTILL_MODEL = modelConfig.distillModel;
  const base = bridge?.baseURL || "";
  if (base) {
    env.OPENAI_API_KEY = "dsh-llm-bridge";
    env.OPENAI_BASE_URL = base;
  }
  return env;
}

/**
 * spawn nightly.py。dryRun=true 时只看会发什么（--dry-run）。
 * @param {object} opts
 * @param {string} opts.vault - vault 路径
 * @param {string} [opts.time="09:10"] - 不用了，只在这跑
 * @param {object} [opts.modelConfig] - { provider, model, baseURL, apiKeyEnv }
 * @param {boolean} [opts.dryRun=false]
 * @param {object} [opts.processEnv] - DSH 进程 env
 * @param {function} [opts.onLog] - 日志回调 (level, msg)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, rc: number}>}
 */
export async function runNightly(opts) {
  const {
    vault,
    modelConfig,
    bridge = null,
    dryRun = false,
    processEnv = process.env,
    onLog = () => {},
  } = opts;

  if (!vault) {
    onLog("warn", "nightly: vault 未配置，跳过");
    return Promise.resolve({ ok: false, stdout: "", stderr: "vault not set", rc: 2 });
  }
  if (!existsSync(NIGHTLY_SCRIPT)) {
    onLog("warn", `nightly: 脚本不存在 ${NIGHTLY_SCRIPT}`);
    return Promise.resolve({ ok: false, stdout: "", stderr: "script not found", rc: 2 });
  }

  const args = ["--vault", vault];
  if (dryRun) args.push("--dry-run");

  // 桥可能刚建好还没 listen 完（listen 是异步的），等到端口拿到再组 env。
  if (bridge?.ready) {
    try {
      await bridge.ready;
    } catch {
      /* 桥起不来就按「无桥」降级：模型步骤 skip，不走订阅 */
    }
  }

  const modelEnv = buildModelEnv(modelConfig, processEnv, bridge);
  const env = { ...processEnv, ...modelEnv, OBSIDIAN_VAULT: vault };

  const channel = bridge?.baseURL ? `dsh-provider ${bridge.baseURL}` : "(none: 模型步骤将 skip)";
  onLog(
    "info",
    `nightly: spawn ${dryRun ? "--dry-run " : ""}channel=${channel} provider=${modelConfig?.provider ?? "-"} model=${modelConfig?.model ?? "(none)"}`,
  );

  // DSH 会话批量导入已归 import_sessions.py 原生承担（--nightly 直接扫
  // `${DSH_HOME}/sessions` 的 session.v4.jsonl.zstd），这里不再先跑一遍 importDshSince，
  // 否则同一批会话被导入两次。nightly.py 的 import_sessions 步骤即唯一批量入口。

  return new Promise((resolve) => {
    const proc = spawn("python3", [NIGHTLY_SCRIPT, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    const finish = (rc, extraOut = "", extraErr = "") => {
      resolve({
        ok: rc === 0,
        stdout: stdout + extraOut,
        stderr: stderr + extraErr,
        rc: rc === 0 ? 0 : (rc || 1),
      });
    };
    proc.on("close", (rc) => finish(rc ?? 1));
    proc.on("error", (e) => {
      onLog("warn", `nightly: spawn 失败: ${e.message}`);
      finish(1, "", e.message);
    });
  });
}

/**
 * 定时器管理：设/清 setTimeout 循环。
 */
let nightlyTimer = null;
// 记录挂 timer 时用的 clearTimeout（测试注入不同来源时也能正确清掉）
let nightlyClearTimeout = null;
// 代次：每次 start/stop 递增。timer fire 的 finally 重排前比对，变了就放弃复活。
let nightlyGen = 0;

export function stopNightlyTimer() {
  nightlyGen++; // 让 in-flight 的 finally 放弃复活
  if (nightlyTimer) {
    (nightlyClearTimeout ?? clearTimeout)(nightlyTimer);
    nightlyTimer = null;
    nightlyClearTimeout = null;
  }
}

/**
 * 启动定时器。configGetter().nightlyEnabled=false 时只清旧 timer 不重排。
 *
 * configGetter 是函数：每次 tick 都重新读最新 config，这样配置页改 nightlyTime /
 * nightlyEnabled / nightlyModel 后（宿主走 loader/volatile-update 原地更新、不重启
 * fiber），index.js 的监听只需 swap configGetter 引用并重排，到点即用最新值，
 * 不会卡在旧闭包里。
 *
 * @param {object} ctx - DSH plugin ctx（logger）
 * @param {() => object} configGetter - 每次读最新 nightly config 的函数
 * @param {object} [processEnv] - DSH 进程 env
 * @param {object} [sched] - 可注入 setTimeout/clearTimeout/runNightly（测试用）
 */
export function startNightlyTimer(ctx, configGetter, processEnv = process.env, sched = {}) {
  stopNightlyTimer();
  const cfg = typeof configGetter === "function" ? configGetter() : configGetter;
  if (!cfg?.nightlyEnabled) {
    ctx?.logger?.info?.("dsh-krouter: 每日总结已关闭");
    return;
  }
  const setTimeout_ = sched.setTimeout ?? setTimeout;
  const clearTimeout_ = sched.clearTimeout ?? clearTimeout;
  const runNightly_ = sched.runNightly ?? runNightly;
  const bridge = sched.bridge ?? null;
  nightlyClearTimeout = clearTimeout_;
  // 代次守卫：startNightlyTimer / stopNightlyTimer 都会 ++gen。timer fire 后 finally
  // 重排前先比对 gen，期间若被 stop/重启则放弃复活（否则 dispose 后 timer 还会再挂）。
  const gen = ++nightlyGen;

  const schedule = () => {
    const current = typeof configGetter === "function" ? configGetter() : configGetter;
    if (!current?.nightlyEnabled) return;
    const hhmm = current?.nightlyTime || "09:10";
    const next = computeNextRun(hhmm);
    const delay = next.getTime() - Date.now();
    ctx?.logger?.info?.(
      `dsh-krouter: 每日总结定时 ${hhmm}，下次 ${next.toISOString()}（${Math.round(delay / 60000)} 分钟后）`,
    );
    nightlyTimer = setTimeout_(async () => {
      try {
        const live = typeof configGetter === "function" ? configGetter() : configGetter;
        if (!live?.nightlyEnabled) return;
        const vault = live?.vaultPath || processEnv.KROUTER_VAULT || processEnv.OBSIDIAN_VAULT || "";
        const modelConfig = resolveModelConfig(live, processEnv);
        const r = await runNightly_({
          vault, modelConfig, bridge, dryRun: false, processEnv,
          onLog: (lvl, msg) => ctx?.logger?.[lvl]?.(msg),
        });
        ctx?.logger?.[r.ok ? "info" : "warn"]?.(
          `dsh-krouter: 每日总结完成 rc=${r.rc}${r.ok ? "" : " stderr=" + r.stderr.slice(0, 200)}`,
        );
      } catch (e) {
        ctx?.logger?.warn?.(`dsh-krouter: 每日总结异常: ${e?.message ?? String(e)}`);
      } finally {
        if (gen !== nightlyGen) return; // 期间被 stop/重启，放弃复活
        nightlyTimer = null;
        schedule();
      }
    }, delay);
    if (nightlyTimer?.unref) nightlyTimer.unref();
  };
  schedule();
}

/**
 * 从 config.nightlyModel (provider id) + config.modelProviders 解析出 modelConfig。
 * @param {object} config
 * @param {object} processEnv
 * @returns {object|null} { provider, model, baseURL, apiKeyEnv }
 */
export function resolveModelConfig(config, processEnv) {
  const sel = config?.nightlyModel;
  if (!sel) return null;
  // sel 格式: "provider:model" 或 { provider, model }
  let provider, model;
  if (typeof sel === "string") {
    const idx = sel.indexOf(":");
    if (idx > 0) { provider = sel.slice(0, idx); model = sel.slice(idx + 1); }
    else { model = sel; }
  } else {
    provider = sel.provider; model = sel.model;
  }
  if (!model) return null;
  const providers = config?.modelProviders || {};
  const pinfo = providers[provider] || {};
  // distillModel 存 "provider:model" 全串，原样传给 buildModelEnv 设 KROUTER_DISTILL_MODEL；
  // 桥按 body.model 前缀路由到对应 provider，与每日总结模型互相独立。留空 = 跟随每日总结。
  const distillModel = typeof config?.distillModel === "string" ? config.distillModel : "";
  return { provider, model, distillModel, baseURL: pinfo.baseURL, apiKeyEnv: pinfo.apiKeyEnv };
}
