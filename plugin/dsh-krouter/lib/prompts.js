/**
 * prompts 槽位 loader。
 *
 * 三级回退：默认语言包（zh） → 当前语言包 → 实例覆盖目录。后者覆盖前者，缺键即在加载时报错。
 *
 * 槽位文件格式（tools.md，键值槽位）：
 *   - 每行一条 `key: value`（冒号后一个空格；value 为该行剩余）
 *   - 续行：以 1+ 空格开头，追加到上一 key 的 value（换行连接）
 *   - 注释 `#` 开头行、分隔 `---` 行、首尾 frontmatter 均忽略
 *
 * system-guide.md / tools-guide.md 是**整段文档槽位**，按原始文本读取，不做 key-value 解析；
 * tools-guide.md 再按 `## <工具名>` 切小节，供「调用工具时」只送该节。
 *
 * 判据：文案一旦外置，缺键必须炸，不能静默退化成空描述——空描述注册进宿主
 * 等于工具没有说明，比加载失败更难查。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_LANG = "zh";

/** 解析 key-value 槽位文本 → 键值对象（续行合并；注释/分隔/frontmatter 跳过）。 */
export function parseSlot(text) {
  const out = {};
  let currentKey = null;
  let inFrontmatter = false;
  let frontmatterSeen = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!frontmatterSeen && line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      if (!inFrontmatter) frontmatterSeen = true;
      continue;
    }
    if (inFrontmatter) continue;
    if (frontmatterSeen && line.trim() === "---") continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = line.match(/^(?:-\s+)?(\S[^:]*?):\s*(.*)$/);
    if (m && !line.startsWith(" ")) {
      currentKey = m[1].trim();
      out[currentKey] = m[2].trim();
    } else if (currentKey !== null && line.startsWith(" ")) {
      out[currentKey] = (out[currentKey] ? out[currentKey] + "\n" : "") + line.trim();
    }
  }
  return out;
}

/** 槽位候选路径，从低到高（默认语言 → 当前语言 → 覆盖目录）。 */
function slotCandidates(name, opts) {
  const out = [resolve(opts.baseDir, DEFAULT_LANG, `${name}.md`)];
  const lang = opts.lang || DEFAULT_LANG;
  if (lang !== DEFAULT_LANG) out.push(resolve(opts.baseDir, lang, `${name}.md`));
  if (opts.overrideDir) out.push(resolve(opts.overrideDir, `${name}.md`));
  return out;
}

/** 读取整段文档槽位（最后一个存在的候选胜出）。 */
export function readSlotText(name, opts) {
  const candidates = slotCandidates(name, opts);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (existsSync(candidates[i])) return readFileSync(candidates[i], "utf8");
  }
  throw new Error(
    `[prompts] 槽位 "${name}" 缺失：尝试了 ${candidates.join(", ")}（默认语言→语言包→覆盖目录均无）`,
  );
}

/** 读取键值槽位并**按键合并**：实例只覆盖部分键时，其余键回退语言包→默认语言。 */
export function readSlotMerged(name, opts) {
  let found = false;
  const merged = {};
  for (const p of slotCandidates(name, opts)) {
    if (!existsSync(p)) continue;
    found = true;
    Object.assign(merged, parseSlot(readFileSync(p, "utf8")));
  }
  if (!found) {
    throw new Error(`[prompts] 槽位 "${name}" 缺失：默认语言→语言包→覆盖目录均无`);
  }
  return merged;
}

/** 加载 krouter 用到的全部槽位。 */
export function loadPrompts(opts) {
  return {
    systemGuide: readSlotText("system-guide", opts),
    toolsGuide: readSlotText("tools-guide", opts).trim(),
    tools: readSlotMerged("tools", opts),
    labels: readSlotMerged("labels", opts),
    templates: loadTemplates(resolve(opts.baseDir, "..", "templates")),
  };
}

/**
 * 文档模板 = 一类记忆文档一个文件，不按工具分。
 * 每个模板用自己的 frontmatter 声明投递给谁：
 *   tools: krouter_note, krouter_page   ← 只给这些工具
 *   layer: project                       ← 可选，只在 tool 参数 layer 匹配时给
 * 没有任何 `tools:` 的（会话摘录 / 主题档案 / 生成页 / 流水）是给人看的，不投递。
 */
export function loadTemplates(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const raw = readFileSync(resolve(dir, f), "utf8");
      const meta = frontmatterOf(raw);
      return {
        name: f.replace(/\.md$/, ""),
        tools: String(meta.tools || "").split(",").map((s) => s.trim()).filter(Boolean),
        layer: String(meta.layer || "").trim(),
        text: stripFrontmatter(raw).trim(),
      };
    })
    .filter((t) => t.text);
}

/** 只读首块 frontmatter 的 `key: value`（模板用，不做 YAML）。 */
function frontmatterOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith(" ")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 去掉首块 frontmatter，正文从 `---` 之后开始。 */
export function stripFrontmatter(text) {
  return String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** 缺键报错：required 里的键必须存在且非空，否则 throw（新增工具/参数必须同步槽位）。 */
export function requireKeys(map, required, slotName) {
  const missing = required.filter((k) => !(k in map) || String(map[k]).trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `[prompts] 槽位 "${slotName}" 缺键：${missing.join(", ")}（缺键即报错；新增工具或参数须同步补文案）`,
    );
  }
  return map;
}

/** 把 tools-guide.md 切成 { 小节名 → 正文 }（按 `^## <名>`，到下一个 `## ` 止）。 */
export function parseToolGuides(text) {
  const out = new Map();
  const lines = String(text || "").split(/\r?\n/);
  let name = null;
  let buf = [];
  const flush = () => {
    if (name) out.set(name, buf.join("\n").trim());
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(\S.*?)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1].trim();
      continue;
    }
    if (name) buf.push(line);
  }
  flush();
  return out;
}

/**
 * 取一个工具的说明小节，带 `## 名` 标题一起返回，便于注入后自成一块。
 * 没有该节时返回 undefined（不虚构：宁可让调用方报错，也不要送一段空说明）。
 */
export function extractToolSection(guideText, toolName) {
  if (!guideText || !toolName) return undefined;
  const body = parseToolGuides(guideText).get(toolName);
  return body ? `## ${toolName}\n\n${body}` : undefined;
}

/** 把「共享段 + 该工具段」拼成一次注入的正文（共享段可缺）。 */
export function composeToolGuide(guideText, toolName, sharedNames = []) {
  const sections = parseToolGuides(guideText);
  const parts = [];
  for (const s of sharedNames) {
    const body = sections.get(s);
    if (body) parts.push(body);
  }
  const own = sections.get(toolName);
  if (!own) return undefined;
  parts.push(`## ${toolName}\n\n${own}`);
  return parts.join("\n\n");
}