/**
 * dsh-krouter 插件入口
 *
 * 职责（单一）：挂 agent/pre-step 钩子，每轮取最后一条 user 文本 → recollect() 调 KRouter 本体
 * 被动召回 → 命中且非 none 则构造独立 snapshot user 消息（source.kind=krouter）插到最后一条
 * user 之前。纯被动下意识召回，不注册任何主动工具，不写 vault，不联网，不碰密钥。
 *
 * 这是官方 dsh-krouter 适配器（extras/dsh，只注册主动路由工具）缺失的那一半——下意识召回。
 * 复用官方 route.js（spawn+parseReceipt），钩子结构克隆 deep-search mountEvokePrestep
 * （DSH 真实契约：ctx.on("agent/pre-step")，独立 id + 独立 source，绝不复制用户消息字段）。
 *
 * 不可达/未命中/异常一律原样放行 decision，绝不阻断对话。
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// 配置页 schema（对齐 meow-memory 模式）：宿主读 entry.fiber.runtime.Config 生成配置面板。
// schemastery 放 peerDependencies（宿主运行时已提供），插件不自行安装。
import z from "@deepseek-ai/schemastery";
import { recollect } from "./recollect.js";
import { recallMessage, standingMessage, mountGuide } from "./capsule.js";
import { loadToolTexts, registerKrouterTools } from "./register.js";
import { startNightlyTimer, stopNightlyTimer } from "./nightly.js";
import { startLlmBridge } from "./llm-bridge.js";
import { isSessionStart, clearSessionSeen, fetchStandingIndex, mountKrouterSessionHooks, captureCorrection, distillSession } from "./hooks.js";
import { DEFAULT_IDLE, mountIdleDistill, idleDistiller } from "./idle.js";
import { registerDiagTool } from "./diag.js";
import { initConsent } from "./consent.js";

/** 取 decision.messages 最后一条真实 user 消息的纯文本（照 deep-search/tdai getLastUserText）。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.source?.kind !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
    }
  }
  return "";
}

/**
 * 挂载 agent/pre-step 钩子。opts 透传 recollect 的 vault/recollectPath/timeoutMs。
 */
export function mountRecallPrestep(ctx, opts) {
  if (typeof ctx.on !== "function") return;
  let hintMissingWarned = false;
  ctx.on("agent/pre-step", async (payload, next) => {
    let decision;
    try {
      decision = await next();
    } catch {
      return undefined;
    }
    try {
      if (!decision || decision.kind !== "enter" || payload?.signal?.aborted) return decision;
      if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
      // 不打扰子代理：下意识召回只服务主会话
      if (decision.agent?.session?.header?.origin === "subagent") return decision;

      const sessionId = decision.agent?.session?.header?.id || "";
      let injectMsgs = [];

      // ── ① SessionStart: 首次 pre-step → 注入 standing index ────────────────
      if (opts.vault && isSessionStart(sessionId)) {
        try {
          const standing = await fetchStandingIndex(opts.vault, sessionId);
          if (standing) {
            injectMsgs.push(standingMessage({ text: standing }));
            ctx.logger?.info?.(`dsh-krouter: SessionStart standing index injected (${standing.length} chars)`);
          } else {
            // fetch 返回空（本体未就绪/失败）→ 回滚 seen 标记，下次 pre-step 重试
            clearSessionSeen(sessionId);
          }
        } catch (e) {
          // 抛错同样回滚 seen，允许后续重试；不阻断对话
          clearSessionSeen(sessionId);
          ctx.logger?.warn?.(`dsh-krouter: SessionStart 注入失败（不阻断）: ${e?.message ?? String(e)}`);
        }
      }

      // ── ② UserPromptSubmit: 被动召回 ────────────────────────────────────────
      const text = lastUserText(decision.messages);
      if (text.trim() && opts.vault) {
        // 纠正候选捕捉（对齐 Claude Code prompt hook 的 note_correction）：
        // 被动、不阻断对话。consent 短路已删（装插件即捕捉）+ KROUTER_RECALL_PROMPT=0 只跑 note_correction。
        // 不 await——绝不让它拖慢/阻塞召回与对话。
        captureCorrection(text, sessionId, opts.vault, { cwd: decision.agent?.session?.cwd || "" })
          .then((r) => {
            if (r.captured) {
              ctx.logger?.info?.("dsh-krouter: 纠正候选已捕捉（note_correction）");
            } else if (r.reason && r.reason !== "empty") {
              ctx.logger?.warn?.(`dsh-krouter: 纠正候选捕捉未落盘（不阻断）: ${r.reason}`);
            }
          })
          .catch(() => {});

        const r = recollect(text, opts);
        if (r.ok && r.hit) {
          const lastUser = [...decision.messages].reverse().find((m) => m?.source?.kind === "user");
          if (lastUser !== undefined) {
            // 命中必须带读法：`memory: direct` 这类回执不解释读法，模型读不懂就等于白注入。
            // 缺读法（生产漏拷 labels.md）时宁可什么都不发，也不能发一条没有读法的回执。
            const hint = String(opts.recallHint || "").trim();
            if (!hint) {
              if (!hintMissingWarned) {
                hintMissingWarned = true;
                ctx.logger?.warn?.(
                  "dsh-krouter: 缺读法 prompts/zh/labels.md 的 labels:inject.recallHint，本轮起停止注入（命中必须带读法）",
                );
              }
            } else {
              injectMsgs.push(recallMessage({ text: `${hint}\n${r.block}`, state: r.state, query: text }));
              ctx.logger?.info?.(
                `dsh-krouter: state=${r.state} capsule=${r.block.length}chars injected`,
              );
            }
          }
        }
      }

      if (injectMsgs.length === 0) return decision;
      // 插到最后一条 user 之前
      const lastUser = [...decision.messages].reverse().find((m) => m?.source?.kind === "user");
      if (lastUser === undefined) return decision;
      const rewritten = [...decision.messages];
      rewritten.splice(rewritten.indexOf(lastUser), 0, ...injectMsgs);
      return { ...decision, messages: rewritten };
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: pre-step 失败（不阻断）: ${e?.message ?? String(e)}`);
      return decision;
    }
  });
  ctx.logger?.info?.("dsh-krouter: agent/pre-step 钩子已挂载（SessionStart + 被动召回）");
}

export const name = "dsh-krouter";
export const inject = ["tools"];

/**
 * 配置页 schema（对齐 meow-memory：宿主读 entry.fiber.runtime.Config 自动生成配置面板）。
 * 只暴露用户可在设置页安全调整的子集；vaultPath/consent 等敏感项留在 cordis.patch.yml 手工管理。
 * 字段名与 apply(ctx, config) 里 config?.<key> 一一对应，改面板即改 config.nightlyModel 等。
 */
const config = z.object({
  /** 每日总结定时器总开关。 */
  nightlyEnabled: z.boolean().default(false),
  /** 每日总结触发时间（HH:mm，本地时区）。 */
  nightlyTime: z.string().default("09:10"),
  /** 每日总结用模型（留空=用 provider 默认）。下拉选项由 client 端 modelCatalog 注入。 */
  nightlyModel: z.string().default(""),
  /** 会话蒸馏（import distill）用模型（provider:model 全串，留空=跟随每日总结模型）。与每日总结可各选各的 provider。 */
  distillModel: z.string().default(""),
  /**
   * 会话空闲多少分钟算「结束」（分钟）。DSH 没有 session end 事件，
   * 所以用「停止更新满这么久」补原 Claude Code 的 SessionEnd 蒸馏。
   */
  idleMinutes: z.number().default(DEFAULT_IDLE.idleMinutes),
  /** 空闲检查周期（分钟）：每隔这么久看一次有没有会话settled下来。 */
  checkMinutes: z.number().default(DEFAULT_IDLE.checkMinutes),
  /**
   * 峰时抑制时段，"HH:MM-HH:MM" 数组。这些时段内不跑空闲蒸馏（时段内不烧模型、不占 IO），
   * 出了时段再补跑，不把一次蒸馏白吞掉。
   */
  suppressWindows: z.array(z.string()).default([...DEFAULT_IDLE.suppressWindows]),
  /** 工具在对话里的显示名（留空=默认）。 */
  label: z.string().default(""),
  /** 主动工具调用超时（毫秒）。 */
  toolTimeoutMs: z.number().default(60000),
  /** 导入后是否喂模型蒸馏（夜间/日内定时跑时生效，写进 import.json 供本体读）。 */
  distill: z.boolean().default(false),
});

// 标记整个 Config 为 volatile，让宿主 settings provider 把 dsh-krouter namespace
// 纳入 served 列表（否则 volatileForm() 对「无 volatile 字段」的 schema 返回 undefined，
// describe() return []，配置页 configForm 恒 unavailable、set 被静默吞）。
// 与 meow-memory 同款（其 index.js Object.assign(config.meta, { volatile: true })）。
Object.assign(config.meta, { volatile: true });

export { config as Config };

/**
 * 从 DSH profile 的 cordis.patch.yml 读取可用模型列表。
 * 返回 { providerId: { baseURL, apiKeyEnv, models: [{id, name}] } }
 */
function readModelProviders() {
  try {
    const dshHome = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
    const profileDir = process.env.DSH_PROFILE_DIR || join(dshHome, "profiles", "desktop");
    const patchPath = join(profileDir, "cordis.patch.yml");
    if (!existsSync(patchPath)) return {};
    // 简单解析：找 providers: 块下的 provider entries
    const text = readFileSync(patchPath, "utf-8");
    const providers = {};
    // provider 名 = 6 空格缩进的 key: 行。整块 = 从这个头行到下一个 6 空格头行（或结尾）。
    // 旧写法 indexOf("\n      ") 找下一 provider 边界，会被 block 内「空行+更深缩进」误命中
    // （空行后那段有 6 空格前缀），把 block 截断成几十字符、baseURL/models 全切掉 → 解析出空。
    // 改成按「头行到下一个同级头行」整块切，块内任意缩进都不误判。
    const headerRegex = /^ {6}([\w-]+):\s*$/gm;
    const heads = [];
    let hm;
    while ((hm = headerRegex.exec(text)) !== null) {
      heads.push({ pid: hm[1], start: hm.index + hm[0].length, end: headerRegex.lastIndex });
    }
    for (let i = 0; i < heads.length; i++) {
      const pid = heads[i].pid;
      const blockStart = heads[i].start;
      const blockEnd = i + 1 < heads.length ? heads[i + 1].start : Math.min(blockStart + 4000, text.length);
      const block = text.slice(blockStart, blockEnd);
      const baseURL = block.match(/baseURL:\s*(\S+)/)?.[1]?.trim() || "";
      const apiKeyEnv = block.match(/apiKeyEnv:\s*(\S+)/)?.[1]?.trim() || "";
      // 只收 models: 子块内的 "- id:" 行。两个坑：
      // ①旧 indexOf 边界被 block 内空行误判 → 整块截断（已改按头行切整块）。
      // ②扫整个 block 的 "- id:" 会误收 config entry 的 MCP server id → 只收 models 子块。
      // ③models 正则要求 id 行连续，被每个 model 的 name/contextWindow 行打断 → 只抓到第一个。
      // 故按行走 + 缩进：定位 "models:" 行，收它下面所有比它缩进更深的行，直到回到同级/更浅。
      const blockLines = block.split("\n");
      const modelsIdx = blockLines.findIndex((l) => /^ {8}models:\s*$/.test(l));
      const models = [];
      if (modelsIdx >= 0) {
        // models: 在 8 空格，其子项在 >8 空格。收连续的更深缩进行。
        let j = modelsIdx + 1;
        for (; j < blockLines.length; j++) {
          const line = blockLines[j];
          if (line.trim() === "") continue; // 空行跳过
          const indent = line.length - line.trimStart().length;
          if (indent <= 8) break; // 回到 models 同级或更浅 = 子块结束
          const idm = line.match(/-\s+id:\s*(\S+)/);
          if (idm) models.push({ id: idm[1] });
        }
      }
      if (models.length > 0) {
        providers[pid] = { baseURL, apiKeyEnv, models };
      }
    }
    return providers;
  } catch {
    return {};
  }
}

// ── 手动模型通道：把桥端点 + 蒸馏模型写进本体 keys.env ─────────────────────────
const KEYS_ENV_MARKER_BEGIN = "# BEGIN dsh-krouter model sync (managed)";
const KEYS_ENV_MARKER_END = "# END dsh-krouter model sync";

export function syncModelToKeysEnv(keysFile, { bridgeBaseURL, distillModel }) {
  const lines = [];
  if (bridgeBaseURL) {
    lines.push(KEYS_ENV_MARKER_BEGIN);
    lines.push("OPENAI_API_KEY=dsh-llm-bridge");
    lines.push(`OPENAI_BASE_URL=${bridgeBaseURL}`);
    const model = (distillModel || "").trim();
    if (model) lines.push(`KROUTER_LEARN_MODEL=${model}`);
    lines.push(KEYS_ENV_MARKER_END);
  }
  const block = lines.length ? lines.join("\n") + "\n" : "";
  let existing = "";
  try {
    existing = readFileSync(keysFile, "utf-8");
  } catch {
    /* 文件不存在 → 纯新建托管块 */
  }
  // 行过滤掐掉旧托管块（标记里的括号会让正则失效，按行走最稳）
  const kept = [];
  let inBlock = false;
  for (const ln of existing.split("\n")) {
    const t = ln.trim();
    if (t === KEYS_ENV_MARKER_BEGIN) { inBlock = true; continue; }
    if (t === KEYS_ENV_MARKER_END) { inBlock = false; continue; }
    if (!inBlock) kept.push(ln);
  }
  const next = kept.join("\n") + block;
  if (next === existing) return;
  try {
    writeFileSync(keysFile, next, { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* 写不进不致命：手动通道退回旧行为 */
  }
}

export function stripModelFromKeysEnv(keysFile) {
  syncModelToKeysEnv(keysFile, { bridgeBaseURL: "", distillModel: "" });
}

/** keys.env 路径：与本体 llm.py keys_file() 同源（KROUTER_KEYS_ENV 优先，回退 ~/.KRouter/keys.env）。 */
export function krouterKeysEnvPath() {
  return process.env.KROUTER_KEYS_ENV || join(homedir(), ".KRouter", "keys.env");
}

/**
 * 从插件自带的 bundle cordis.patch.yml 读取 vaultPath。
 *
 * 为什么不靠 config.vaultPath：宿主对 root-volatile Config 只把用户 patch 层的
 * 字段喂给 apply（config 是 createVolatile wrapper，浅覆盖且只含配置页声明的
 * nightly* 字段），bundle 层插入的 vaultPath 在 effectiveConfig 里被用户层抹掉。
 * vaultPath 是敏感项，按用户红线不进配置页 schema，故从 bundle patch 磁盘读，
 * 与 readModelProviders 同款解析。
 */
function readVaultPathFromBundle() {
  try {
    // 本文件在 <pkg>/lib/index.js，bundle patch 在 <pkg>/cordis.patch.yml
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = dirname(here);
    const patchPath = join(pkgRoot, "cordis.patch.yml");
    if (!existsSync(patchPath)) return "";
    const text = readFileSync(patchPath, "utf-8");
    // config: 段下 8 空格缩进的 vaultPath: <值>
    const m = text.match(/^\s*vaultPath:\s*(.+)$/m);
    const val = m?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
    return val;
  } catch {
    return "";
  }
}

/**
 * 展开 vaultPath 里的 ~（schema 默认值 / 用户手填常用 ~/...）。全链（nightly spawn、
 * MCP、route、hooks）都不展开 ~，故统一在 apply() 入口解一次，下游全拿到绝对路径。
 */
function expandVaultPath(p) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return join(homedir(), "");
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 解包根级 volatile 的 Config 引用。
 * 根节点 meta.volatile 时 schemastery 校验后返回 createVolatile(value) 引用对象
 * { get, [write] }，apply(ctx, config) 收到的就是它 —— 直接读 config?.X 全是 undefined。
 * 宿主 volatile 更新是原地替换该引用内部快照，所以每次现读都拿最新值。
 */
function readConfig(c) {
  return (typeof c?.get === "function" ? c.get() : c) ?? {};
}

export function apply(ctx, config = {}) {
  let nightlyDispose = null;
  let mcpDispose = null;
  const cfg = readConfig(config);
  try {
    // vault 解析优先级：effectiveConfig（配置页/patch 注入）> bundle patch 磁盘 > env。
    // config 是 createVolatile wrapper，读不到 bundle 层 vaultPath，故补磁盘 fallback。
    const configVault = expandVaultPath(cfg.vaultPath);
    const vault = configVault || expandVaultPath(readVaultPathFromBundle()) ||
      process.env.KROUTER_VAULT || process.env.OBSIDIAN_VAULT || "";
    const opts = {
      vault,
      // 两路各自可覆盖：canonical 直锁仍走 route_knowledge，其余委托 recollect.py。
      router: cfg.routerScript || process.env.KROUTER_ROUTER || "",
      recollectPath: cfg.recollectScript || "",
      timeoutMs: cfg.timeoutMs ?? 20000,
    };
    if (!opts.vault) {
      ctx.logger?.warn?.(
        "dsh-krouter: 未配置 vaultPath / KROUTER_VAULT，召回将空转（不报错）。装好 KRouter 并设 vault 后生效。",
      );
    }
    // 文案外置：prompts/zh/*.md（缺文件/缺键 → 抛错，导引与主动工具一并缺席并报出来）
    // 先加载：召回正文前的读法提示也在 labels.md 里，pre-step 要用它。
    let toolTexts = null;
    try {
      toolTexts = loadToolTexts();
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: 文案加载失败，导引与主动工具都不挂载: ${e?.message ?? String(e)}`);
    }
    mountRecallPrestep(ctx, { ...opts, recallHint: toolTexts?.labels?.["inject.recallHint"] || "" });
    // 工具路由表进 system prompt（前台永远不可见，因此不需要胶囊）。
    // 与记忆 recall 分道：recall 走 pre-step + source.kind="user" 变前台胶囊；导引不进对话流。
    if (toolTexts) mountGuide(ctx, toolTexts.systemGuide);
    const sessionHookState = mountKrouterSessionHooks(ctx, {
      ...opts,
      // transcript 桥接：默认开（用户要求去掉隐私闸、装插件即全功能）。
      // config.transcript 只有显式 === false 才关；config 被宿主整段替换抹掉时保持开启。
      transcript: cfg.transcript !== false,
      dryRun: cfg.transcriptDryRun === true,
      local: cfg.transcriptLocal !== false,
      dshHome: cfg.dshHome || process.env.DSH_HOME || "",
    });

    // nightlyState 提前声明：diag 工具的 getter 要实时读它（改 nightly 开关后 status 立刻反映，
    // 不再是 apply 时快照恒 false）。volatile-update 监听会原地 swap 本对象字段/引用。
    let nightlyState = {
      nightlyEnabled: cfg.nightlyEnabled ?? false,
      nightlyTime: cfg.nightlyTime || "09:10",
      nightlyModel: cfg.nightlyModel || "",
      distillModel: cfg.distillModel || "",
      vaultPath: opts.vault,
      modelProviders: readModelProviders(),
    };

    // ── LLM 桥：把 DSH 当前 provider 借给 nightly.py 的模型步骤 ─────────────
    // 只监听 127.0.0.1 的随机端口；selection 每次请求实时读 nightlyState，
    // 配置页改模型即时生效，不必重启。
    // 桥起不来时 nightly.js 仍会置 KROUTER_HOST_CLI=0，让模型步骤 skip ——
    // 绝不再静默掉回 claude 订阅通道（那正是 503 的来源）。
    const llmBridge = (() => {
      try {
        return startLlmBridge(ctx, () => nightlyState?.nightlyModel || "");
      } catch (e) {
        ctx.logger?.warn?.(
          `dsh-krouter: llm bridge 未启动（模型步骤将 skip，不走订阅）: ${e?.message ?? String(e)}`,
        );
        return null;
      }
    })();

    // 手动通道接线①：桥 listen 完成后（端口才确定）把端点+蒸馏模型写进本体 keys.env。
    // 不 await（apply 必须同步返回 dispose）；ready 是 Promise，listen 失败会 resolve(0)。
    const syncNow = () => {
      try {
        syncModelToKeysEnv(krouterKeysEnvPath(), {
          bridgeBaseURL: llmBridge?.baseURL || "",
          distillModel: nightlyState?.distillModel || "",
        });
      } catch (e) {
        ctx.logger?.warn?.(`dsh-krouter: keys.env 同步失败（手动通道不可用，不阻断）: ${e?.message ?? String(e)}`);
      }
    };
    if (llmBridge?.ready) llmBridge.ready.then(syncNow, syncNow);
    else syncNow();

    // ── 插件级诊断工具（只读；报桥侧 hook/开关状态，区别于 krouter_status 的 vault/nightly）──
    // 传 getter：render() 每次实时读最新 nightlyState + transcript，改开关即时反映。
    try {
      registerDiagTool(ctx, () => ({
        ...nightlyState,
        vault: nightlyState.vaultPath,
        llmBridge: llmBridge?.describe?.() ?? "(未启动)",
        transcript: readConfig(config).transcript !== false,
        idle: {
          enabled: readConfig(config).transcript !== false,
          idleMinutes: readConfig(config).idleMinutes ?? DEFAULT_IDLE.idleMinutes,
          checkMinutes: readConfig(config).checkMinutes ?? DEFAULT_IDLE.checkMinutes,
          suppressWindows: readConfig(config).suppressWindows ?? DEFAULT_IDLE.suppressWindows,
          runtime: idleState?.runtime ?? null,
        },
        hooksMounted: sessionHookState?.mounted || ["pre-step"],
      }));
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: 诊断工具注册失败（不阻断）: ${e?.message ?? String(e)}`);
    }

    // ── 会话导入 consent（默认写 consent:true，去掉隐私闸；revoke 才撤回）────────
    // 本体 import_sessions.py 的 consented() 读同一 import.json，不写它本体就静默不写 vault。
    try {
      initConsent({
        consentSessions: cfg.consentSessions,
        distill: cfg.distill,
        cli: cfg.cli,
      }, ctx.logger);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: consent 初始化失败（不阻断）: ${e?.message ?? String(e)}`);
    }

    // ── SessionEnd 等价物：会话停止更新满 idleMinutes → end hook + 整段导入 ──
    // DSH 没有 session end 事件（④ 只能拿 agent/turn-stopping 近似，那是每轮都触发的）。
    // transcript 闸门关着就不挂：既不读会话内容，也不写 vault。
    // 三个旋钮**调用时现读**：配置页改完由 volatile-update 重挂，不留旧闭包（否则
    // status 显示新值、行为还是旧值，查起来比没改更费劲）。
    let idleDispose = null;
    let idleState = null;
    const mountIdle = () => {
      try { idleDispose?.(); } catch {}
      idleDispose = null;
      idleState = null;
      const latest = readConfig(config);
      if (latest.transcript === false) return;
      try {
        const idleOpts = {
          idleMinutes: latest.idleMinutes ?? DEFAULT_IDLE.idleMinutes,
          checkMinutes: latest.checkMinutes ?? DEFAULT_IDLE.checkMinutes,
          suppressWindows: latest.suppressWindows ?? DEFAULT_IDLE.suppressWindows,
        };
        const watcher = mountIdleDistill(ctx, {
          ...idleOpts,
          onIdle: idleDistiller(ctx, {
            distillSession,
            transcript: true,
            vault: opts.vault,
            dshHome: latest.dshHome || process.env.DSH_HOME || "",
            dryRun: latest.transcriptDryRun === true,
            local: latest.transcriptLocal !== false,
            ...idleOpts,
          }),
        });
        idleDispose = () => watcher.dispose();
        idleState = watcher.state ?? null;
        ctx.logger?.info?.(
          `dsh-krouter: 空闲蒸馏已挂（空闲 ${idleOpts.idleMinutes} 分钟、检查周期 ${idleOpts.checkMinutes} 分钟、抑制 ${idleOpts.suppressWindows.join(",") || "无"}）`,
        );
      } catch (e) {
        ctx.logger?.warn?.(`dsh-krouter: 空闲蒸馏挂载失败（不阻断）: ${e?.message ?? String(e)}`);
      }
    };
    mountIdle();

    // ── 主动工具（读+写全注册；装插件即全注册，无独立写闸）────────
    // 单一 MCP stdio 子进程服务全部主动工具；写语义由 mcp_server.py 实现（不重实现）。
    try {
      if (!toolTexts) throw new Error("prompts 未加载，主动工具不注册（避免无说明的工具）");
      const ktools = registerKrouterTools(ctx, {
        vault: opts.vault,
        label: cfg.label || "",
        callTimeoutMs: cfg.toolTimeoutMs ?? 60000,
        prompts: toolTexts,
      });
      mcpDispose = ktools.dispose;
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: 主动工具注册失败（被动召回不受影响）: ${e?.message ?? String(e)}`);
    }

    // ── nightly timer ────────────────────────────────────────────────────────
    // configGetter：每次 tick 重读最新 config。root-volatile Config 改动走
    // loader/volatile-update 原地更新（不重启 fiber），下面的监听 swap config 对象
    // 并重排 timer，到点即用最新 time/enabled/model，不卡旧闭包。
    // （nightlyState 已在上方 diag 注册前声明，此处不再重复。）
    const configGetter = () => nightlyState;
    if (nightlyState.nightlyEnabled) {
      startNightlyTimer(ctx, configGetter, process.env, { bridge: llmBridge });
      ctx.logger?.info?.("dsh-krouter: 每日总结定时器已启动");
    }
    // 配置页改 nightly* / vaultPath 后热重排（宿主 emit loader/volatile-update，
    // fiber 不重启，apply 不重跑 —— 不监听则改时间要重启才生效）。
    let volatileDispose = null;
    try {
      if (typeof ctx?.on === "function") {
        const off = ctx.on("loader/volatile-update", () => {
          try {
            const latest = readConfig(ctx?.fiber?.effectiveConfig ?? config);
            nightlyState = {
              nightlyEnabled: latest?.nightlyEnabled ?? false,
              nightlyTime: latest?.nightlyTime || "09:10",
              nightlyModel: latest?.nightlyModel || "",
              distillModel: latest?.distillModel || "",
              vaultPath: latest?.vaultPath || opts.vault,
              modelProviders: readModelProviders(),
            };
            // 手动通道接线②：配置页改 distill 模型 → 立即重写 keys.env，手动跑不必重启
            try {
              syncModelToKeysEnv(krouterKeysEnvPath(), {
                bridgeBaseURL: llmBridge?.baseURL || "",
                distillModel: nightlyState?.distillModel || "",
              });
            } catch {}
            // 无条件重排：enabled 关 → startNightlyTimer 清 timer 不重挂；开/改时间 → 按新值重挂
            startNightlyTimer(ctx, configGetter, process.env, { bridge: llmBridge });
            // 空闲蒸馏的三个旋钮同样重挂：dispose 旧的，按最新值重建（含 transcript 由关改开）
            mountIdle();
            ctx.logger?.info?.(
              `dsh-krouter: nightly 配置热更新 → enabled=${nightlyState.nightlyEnabled} time=${nightlyState.nightlyTime}`,
            );
          } catch (e) {
            ctx.logger?.warn?.(`dsh-krouter: nightly 热重排失败（保留旧 timer）: ${e?.message ?? String(e)}`);
          }
        });
        volatileDispose = typeof off === "function" ? off : null;
      }
    } catch (e) {
      ctx.logger?.warn?.(`dsh-krouter: volatile-update 监听挂载失败（不影响启动）: ${e?.message ?? String(e)}`);
    }
    nightlyDispose = () => {
      try { volatileDispose?.(); } catch {}
      // 手动通道接线③：fiber 关 → 桥随之消失，清掉托管块免手动跑撞死端口
      try { stripModelFromKeysEnv(krouterKeysEnvPath()); } catch {}
      try { llmBridge?.dispose?.(); } catch {}
      stopNightlyTimer();
    };
  } catch (e) {
    ctx.logger?.warn?.(`dsh-krouter: apply 失败（不影响 DSH 启动）: ${e?.message ?? String(e)}`);
  }

  // 返回 dispose 函数（cordis 插件卸载时调用）
  return () => {
    try { idleDispose?.(); } catch {}
    try { nightlyDispose?.(); } catch {}
    try { mcpDispose?.(); } catch {}
  };
}
