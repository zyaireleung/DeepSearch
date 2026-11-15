/**
 * tool-guide.js — 「调用工具时」把该工具的用法说明送进上下文（拦截式投递）。
 *
 * 为什么是拦截：DSH 没有「工具执行前」的注入钩子（可订阅的只有 agent/pre-step、
 * agent/turn-stopping、agent/request；`tool/call` / `tool/result` 只是会话记录）。
 * `exec.deferContext()` 只能跟着**这次调用**的结果一起进上下文。
 * 所以要让「说明先到位、再执行」成立，唯一路径是：本次调用**不执行**，把说明送出去，
 * 让下一次（模型收到「未执行 + 说明」后自然重调的那次）真跑。
 *
 * 投递可见性：`source.kind` 用自定义值（非 "user"），宿主按 context 节点处理 → 前台不可见，
 * 只进上下文。这是说明，不是用户的话，不应该在对话里占一行。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { composeToolGuide, parseToolGuides } from "./prompts.js";

/** 说明消息的 source.kind：非 "user" → 宿主判为 context → 前台不渲染。 */
export const GUIDE_SOURCE_KIND = "krouter";

/** 需要共享段（vault 概览 + 写作准则）的写工具。 */
export const WRITE_TOOL_NAMES = new Set(["krouter_note", "krouter_correct", "krouter_learn", "krouter_page"]);

/** 写工具要带的共享判据（vault 概览 + 页状态）。格式规范在那几类文档模板里，这里不重复。 */
const SHARED_WRITE = ["_shared"];
const SHARED_READ = [];

function mintId() {
  return `m-guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造一条「工具用法说明」注入消息。
 * @param {string} text 说明正文（共享段 + 该工具那节）
 * @param {string} toolName 哪个工具
 */
export function guideMessage(text, toolName = "") {
  return {
    id: mintId(),
    role: "user",
    content: [{ type: "text", text: String(text ?? "") }],
    source: {
      kind: GUIDE_SOURCE_KIND,
      plugin: "dsh-krouter",
      form: "snapshot",
      sections: [{ name: "tool-guide", text: JSON.stringify({ tool: String(toolName || "") }) }],
    },
  };
}

/** 按工具取说明正文：写工具带共享段 + 它落的那几类文档模板，读工具只带自己那节。 */
export function guideTextFor(prompts, toolName, args = {}) {
  const toolsGuide = typeof prompts === "string" ? prompts : prompts?.toolsGuide;
  const shared = WRITE_TOOL_NAMES.has(toolName) ? SHARED_WRITE : SHARED_READ;
  const head = composeToolGuide(toolsGuide, toolName, shared);
  if (!head) return undefined;
  const docs = templateTextsFor(prompts?.templates, toolName, args);
  return docs ? `${head}\n\n${docs}` : head;
}

/**
 * 该工具这次要落的那几类文档的模板。
 * 模板自己声明 `tools:` / `layer:`（见 prompts.loadTemplates）——
 * 加一份新类型的模板不用改这里的代码。
 */
export function templateTextsFor(templates, toolName, args = {}) {
  const lane = String(args?.layer || "").trim();
  // 模板带 `layer:` 就必须显式匹配才送：没有 layer 时只送通用总则。
  // 旧条件里的 `!lane` 会把 project / source / review 三份一起送给模型自己选（破 N6）。
  return (templates || [])
    .filter((t) => t.tools.includes(toolName) && (!t.layer || t.layer === lane))
    .sort((a, b) => (a.name === "spec" ? -1 : b.name === "spec" ? 1 : a.name.localeCompare(b.name)))
    .map((t) => t.text.trim())
    .join("\n\n---\n\n");
}

/** 取某节里的「什么时候用」那句，给目录用；没有就退回节首行。 */
function purposeOf(toolsGuide, toolName) {
  const body = parseToolGuides(toolsGuide).get(toolName);
  if (!body) return "";
  const m = /^\*\*【什么时候用】\*\*\s*([\s\S]*?)$/m.exec(body);
  const text = (m ? m[1] : body).split("\n").find((l) => l.trim()) || "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `krouter_guide` 不带参数时的目录：8 个工具各一句，外加怎么取完整说明。
 * @param {string} toolsGuide
 * @param {string[]} toolNames 要列的（不含 krouter_guide 自己）
 */
export function guideIndex(toolsGuide, toolNames) {
  const lines = ["**【KRouter 工具目录】**", ""];
  for (const name of toolNames) {
    const why = purposeOf(toolsGuide, name);
    lines.push(why ? `- \`${name}\` —— ${why}` : `- \`${name}\``);
  }
  lines.push("", '取完整说明：`krouter_guide({ tool: "<工具名>" })`。写工具会连「vault 概览 + 写作准则」一起给。');
  return lines.join("\n");
}

// ---------- 交付状态（每会话每工具一次） ----------

const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 进程内主判据 + 磁盘次判据。
 *
 * 为什么内存是主判据：DSH 的文件沙盒可能拒绝写 `~/.local/state/krouter`（写失败时
 * writeSeen 静默吞掉）。若只认磁盘，标记永远写不进去 → 每次调用都被拦 → 工具永久
 * 不可用。内存记着，至少本进程内不会循环拦截；磁盘只用来跨重启省一次。
 */
const sentInMemory = new Set();

function seenFile() {
  const base = process.env.KROUTER_STATE_DIR || join(homedir(), ".local", "state", "krouter");
  return join(base, "dsh-krouter-tool-guides.json");
}

function readSeen() {
  const p = seenFile();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) || {};
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const t = Number(v);
      if (Number.isFinite(t) && now - t < SEEN_TTL_MS) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSeen(map) {
  const p = seenFile();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(map, null, 1) + "\n", "utf-8");
  } catch {
    /* 标记写不进去最多多拦一次，不致命，也不阻断对话 */
  }
}

function keyOf(sessionId, toolName) {
  return `${sessionId || "_nosession"}::${toolName}`;
}

/** 本会话这个工具的说明交付过没有（内存优先，磁盘兜底）。 */
export function guideDelivered(sessionId, toolName) {
  const key = keyOf(sessionId, toolName);
  if (sentInMemory.has(key)) return true;
  return Boolean(readSeen()[key]);
}

/** 记下「本会话这个工具的说明已交付」：内存必记，磁盘尽力。 */
export function markGuideDelivered(sessionId, toolName) {
  const key = keyOf(sessionId, toolName);
  sentInMemory.add(key);
  const seen = readSeen();
  seen[key] = Date.now();
  writeSeen(seen);
}

/** 测试用：清掉进程内标记。 */
export function __resetGuideMemory() {
  sentInMemory.clear();
}