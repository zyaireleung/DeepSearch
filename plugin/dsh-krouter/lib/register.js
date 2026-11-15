/**
 * register.js — KRouter 主动工具注册（9 个：8 个 canonical 工具 + krouter_guide）
 *
 * 文案全部外置到 `prompts/zh/`：
 *   - `system-guide.md`  整段进 system prompt（只做路由，由 capsule.mountGuide 挂）
 *   - `tools.md`         `键: 值` 槽位，喂工具 description 与每个参数的 description
 *   - `tools-guide.md`   `## <工具名>` 分节，**调用某工具时**只送该节（见 tool-guide.js）
 * 缺键/缺节一律在加载时报错：注册进宿主的空描述等于工具没有说明，比加载失败更难查。
 *
 * 执行两条路（与 MCP 契约一致）：
 *   - `krouter_changes` / `krouter_skill` 在 stdio MCP 不暴露 → 走 direct.js 直连 Python；
 *   - 其余经 mcp.callTool 代理到 mcp_server.py。
 *
 * 首调拦截：`execute(args, exec)` 在一次会话里第一次被调用时**不执行**，把该工具的
 * 用法说明送进上下文，返回「未执行，读完重调」。判据见 tool-guide.js 顶部。
 */

import { fileURLToPath } from "node:url";
import { KrouterMcp } from "./mcp.js";
import { directChanges, directSkill } from "./direct.js";
import { loadPrompts, parseToolGuides, requireKeys } from "./prompts.js";
import {
  WRITE_TOOL_NAMES,
  guideDelivered,
  guideIndex,
  guideMessage,
  guideTextFor,
  markGuideDelivered,
} from "./tool-guide.js";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts", import.meta.url));

/**
 * 工具声明（不含任何文案）：参数名、类型、是否必填。
 * 文案一律来自 prompts/zh/tools.md —— 这里多一个键，就要求槽位里多一条。
 */
const TOOL_SPECS = [
  {
    name: "krouter_ask",
    write: false,
    params: { query: { type: "string", required: true }, route: { type: "string" } },
  },
  { name: "krouter_status", write: false, params: {} },
  { name: "krouter_skill", write: false, params: { id: { type: "string" } } },
  {
    name: "krouter_changes",
    write: false,
    params: {
      page: { type: "string" },
      who: { type: "string" },
      text: { type: "string" },
      limit: { type: "number" },
    },
  },
  {
    name: "krouter_note",
    write: true,
    params: { text: { type: "string", required: true }, kind: { type: "string" } },
  },
  {
    name: "krouter_correct",
    write: true,
    params: {
      new: { type: "string", required: true },
      old: { type: "string" },
      page: { type: "string" },
    },
  },
  {
    name: "krouter_learn",
    write: true,
    params: {
      situation: { type: "string", required: true },
      action: { type: "string" },
      result: { type: "string" },
      subject: { type: "array", items: { type: "string" } },
      lesson: { type: "string" },
      title: { type: "string" },
      same_as: { type: "string" },
      quotes: { type: "array", items: { type: "string" } },
    },
  },
  {
    name: "krouter_page",
    write: true,
    params: {
      layer: { type: "string", required: true },
      slug: { type: "string", required: true },
      title: { type: "string", required: true },
      body: { type: "string", required: true },
      status: { type: "string" },
      triggers: { type: "array", items: { type: "string" } },
      merge: { type: "boolean" },
    },
  },
  // 说明工具自己：不参与拦截，不写库
  { name: "krouter_guide", write: false, params: { tool: { type: "string" } }, noIntercept: true },
];

export const KROUTER_TOOL_NAMES = TOOL_SPECS.map((t) => t.name);
export const KROUTER_WRITE_TOOL_NAMES = TOOL_SPECS.filter((t) => t.write).map((t) => t.name);
export const KROUTER_READ_TOOL_NAMES = TOOL_SPECS.filter((t) => !t.write).map((t) => t.name);

/** tools.md 里必须存在的键：每个工具的 description + 每个参数的 description。 */
function requiredTextKeys() {
  const keys = [];
  for (const spec of TOOL_SPECS) {
    keys.push(`${spec.name}.description`);
    for (const p of Object.keys(spec.params || {})) keys.push(`${spec.name}.param.${p}`);
  }
  return keys;
}

/** 由声明 + 槽位文案拼出 object-rooted 的完整 JSON Schema（宿主只认父级 required 数组）。 */
function parametersOf(spec, texts) {
  const properties = {};
  const required = [];
  for (const [key, p] of Object.entries(spec.params || {})) {
    const node = { type: p.type };
    if (p.items) node.items = p.items;
    const desc = texts[`${spec.name}.param.${key}`];
    if (desc) node.description = desc;
    properties[key] = node;
    if (p.required) required.push(key);
  }
  const out = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * 加载并校验文案。缺键/缺节直接抛错（不允许注册一个没有说明的工具）。
 * @returns {{systemGuide:string, toolsGuide:string, tools:Record<string,string>}}
 */
export function loadToolTexts(opts = {}) {
  const prompts = loadPrompts({ baseDir: PROMPTS_DIR, lang: opts.lang || "", overrideDir: opts.overrideDir || "" });
  requireKeys(prompts.tools, requiredTextKeys(), "tools");
  requireKeys(prompts.labels, ["inject.recallHint"], "labels");
  const sections = parseToolGuides(prompts.toolsGuide);
  const missing = TOOL_SPECS.map((t) => t.name).filter((n) => !sections.get(n));
  if (missing.length > 0) {
    throw new Error(
      `[prompts] tools-guide 缺小节：${missing.join(", ")}（每个工具都要有一节；缺节即报错）`,
    );
  }
  // 写工具必须落得到文档模板：模板没接进投递是这套机制最容易出的漏（模板在、却不送）。
  const bare = TOOL_SPECS.filter((t) => t.write).filter(
    (t) => !prompts.templates.some((tpl) => tpl.tools.includes(t.name)),
  );
  if (bare.length > 0) {
    throw new Error(
      `[prompts] 写工具没有文档模板：${bare.map((t) => t.name).join(", ")}（模板 frontmatter 的 tools: 要写上它）`,
    );
  }
  return prompts;
}

/** 把 MCP 的 { ok, text, isError } 转成 DSH 工具输出。 */
function renderText(_args, value) {
  return [{ type: "text", text: value.text }];
}

/** 归一化参数：limit 转整并夹到 1..200；其余原样。 */
function cleanArgs(args) {
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null) continue;
    clean[k] = k === "limit" ? Math.max(1, Math.min(200, Math.trunc(Number(v) || 20))) : v;
  }
  return clean;
}

/**
 * 注册 KRouter 主动工具。
 * @param {object} ctx - DSH plugin ctx（ctx.tools.register）
 * @param {{vault:string, label?:string, callTimeoutMs?:number, prompts?:object}} config
 * @returns {{ mcp: KrouterMcp, registered: string[], dispose: () => void }}
 */
export function registerKrouterTools(ctx, config) {
  const vault = config.vault || "";
  const registered = [];

  const log = (lvl, msg) => {
    const fn = ctx?.logger?.[lvl];
    if (typeof fn === "function") fn.call(ctx.logger, msg);
  };

  if (!ctx?.tools?.register) {
    log("warn", "dsh-krouter: ctx.tools.register 不可用，主动工具未注册（被动召回不受影响）");
    const mcp = new KrouterMcp({ vault, label: config.label, callTimeoutMs: config.callTimeoutMs, onLog: log });
    return { mcp, registered, dispose: () => mcp.dispose() };
  }

  // 文案加载失败就让注册整体失败：宁可工具缺席并报出来，也不要注册一堆没有说明的工具。
  const texts = config.prompts || loadToolTexts();

  const mcp = new KrouterMcp({
    vault,
    label: config.label,
    callTimeoutMs: config.callTimeoutMs,
    onLog: log,
  });

  /** 真正的执行体（拦截后的那一层）。 */
  const runTool = async (toolName, clean) => {
    if (toolName === "krouter_changes") {
      const r = await directChanges({ vault }, clean);
      return { ok: r.ok, text: r.text, isError: r.isError };
    }
    if (toolName === "krouter_skill") {
      const r = await directSkill({ vault }, clean);
      return { ok: r.ok, text: r.text, isError: r.isError };
    }
    const r = await mcp.callTool(toolName, clean);
    return { ok: r.ok, text: r.text, isError: r.isError };
  };

  /**
   * krouter_guide：不带参数列目录，带参数给该工具完整说明。
   * 预习只替**读工具**记账：读工具没有模板、没有 layer，预习内容与真调要送的一致。
   * 写工具必须留着真实拦截那一次，否则 `krouter_page` 会因为预习时不知道 layer 而拿不到
   * 要落的那类模板（S5 / N6）。
   */
  const runGuide = async (clean, exec) => {
    const sessionId = exec?.agent?.session?.header?.id || "";
    const tool = String(clean.tool || "").trim();
    if (!tool) {
      const names = KROUTER_TOOL_NAMES.filter((n) => n !== "krouter_guide");
      return { ok: true, isError: false, text: guideIndex(texts.toolsGuide, names) };
    }
    if (!KROUTER_TOOL_NAMES.includes(tool) || tool === "krouter_guide") {
      return { ok: false, isError: true, text: `没有 ${tool} 这个工具。可用：${KROUTER_TOOL_NAMES.join(", ")}` };
    }
    const guide = guideTextFor(texts, tool, {});
    if (!guide) return { ok: false, isError: true, text: `没有 ${tool} 的说明小节` };
    // 预习没有 layer/body，写工具靠这一次投递拿不到正确模板，故不记账，真调仍拦一次。
    if (!WRITE_TOOL_NAMES.has(tool)) markGuideDelivered(sessionId, tool);
    return { ok: true, isError: false, text: guide };
  };

  for (const spec of TOOL_SPECS) {
    if (!vault) break; // 没有 vault 时一个都不注册（MCP 起不来，注册了也是空转）

    const toolName = spec.name;
    const execute = async (args = {}, exec) => {
      const clean = cleanArgs(args);
      if (spec.noIntercept) return runGuide(clean, exec);

      // ── 首调拦截：说明先到位，才允许执行 ──────────────────────────
      const sessionId = exec?.agent?.session?.header?.id || "";
      if (!guideDelivered(sessionId, toolName)) {
        const guide = guideTextFor(texts, toolName, clean);
        if (guide && typeof exec?.deferContext === "function") {
          await exec.deferContext(guideMessage(guide, toolName));
          markGuideDelivered(sessionId, toolName);
          return {
            ok: false,
            isError: false,
            text: `未执行：${toolName} 的用法说明已送入上面的上下文，请按那一节读完再重调一次。`,
          };
        }
        // 没有说明节 / 宿主不给 deferContext → 放行（不虚构、不阻断）
      }
      return runTool(toolName, clean);
    };

    ctx.tools.register({
      name: toolName,
      description: texts.tools[`${toolName}.description`],
      parameters: parametersOf(spec, texts.tools),
      // dsh ctx.tools.register 契约：output 必须 { schema, render }，schema 是 raw JSON Schema。
      // 本工具 execute 返回 { ok, text, isError }，故输出 object-rooted 开放 schema。
      output: {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" }, text: { type: "string" }, isError: { type: "boolean" } },
        },
        render: renderText,
      },
      execute,
    });
    registered.push(toolName);
  }

  ctx.logger?.info?.(`dsh-krouter: 主动工具已注册 ${registered.length} 个（${registered.join(", ")}）`);

  return { mcp, registered, dispose: () => mcp.dispose() };
}