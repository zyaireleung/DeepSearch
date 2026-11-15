/**
 * 注入通道契约（宿主侧唯一出口）。
 *
 * 为什么单独成文件：胶囊能不能在前台渲染，只取决于 `source.kind` 的取值，不取决于
 * 走哪个 splice。
 *
 * 宿主源码实证（app.asar → @deepseek-ai/dsh-client-ui-chat/lib/client.js）：
 *   ① input-message 节点分类：`event.data.source.kind !== "user"` → 一律构造成
 *      `kind: "context"` 节点；等于 `"user"` → 构造成 `kind: "user"` 节点
 *      （被 inbox claim 认领时才是 `"steering"`，合成 id 不会被认领）。
 *   ② visibility 过滤：`isVisibleChatNode` = `kind !== "context"` 或 content 里含
 *      `tool-addition`/`tool-removal`。→ **纯文本 context 节点永远不渲染**。
 *   两者相乘的结论：裸自定义 kind（"krouter"/"deep-search"/"plugin:x"）→ context →
 *   纯文本 → 被可见性过滤丢掉 → 前台零痕迹，连裸文本都看不到。
 *   只有 `source.kind = "user"` 能进可见行，再由 client 折叠成胶囊。
 * 所以记忆 recall 一律走 user-kind；引导说明一律走 systemPrompt.section（不进对话流）。
 *
 * 另一条铁律：id 必须独立生成。复制用户消息的 id/rpcId 会让宿主把胶囊与真用户消息
 * 合并渲染，用户正文被吞。
 */
export const KROUTER_PLUGIN = "dsh-krouter";

/** 记忆 recall 的 source.kind。改这个值等于关掉前台胶囊，别动。 */
export const RECALL_SOURCE_KIND = "user";

/**
 * 召回回执的读法（direct/related/none）跟着**这一次注入**走，不占常驻位。
 * 文案在 `prompts/zh/labels.md` 的 `inject.recallHint`，由 index.js 读进来拼在正文前。
 */

/** 旧 deferContext 快照用的裸 kind，仅供 client 兼容历史节点。 */
export const LEGACY_CONTEXT_KIND = "krouter";

function mintId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造一条「记忆 recall」注入消息。
 * @param {{text:string, state:"direct"|"related"|"session-start", query?:string}} p
 */
export function recallMessage({ text, state, query = "" }) {
  return {
    id: mintId(),
    role: "user",
    content: [{ type: "text", text: String(text ?? "") }],
    source: {
      kind: RECALL_SOURCE_KIND,
      plugin: KROUTER_PLUGIN,
      form: "snapshot",
      sections: [{ name: "__meta__", text: JSON.stringify({ state, query: String(query ?? "").slice(0, 200) }) }],
    },
  };
}

/** SessionStart 常驻索引：也是 recall（hook 唤醒检索后的结果），前台可见可折。 */
export function standingMessage({ text }) {
  return recallMessage({ text, state: "session-start", query: "" });
}

/**
 * 把工具路由表挂进 system prompt 的一个 section。
 * 这条通道前台永远看不到（不产生任何对话节点），所以不需要胶囊、也不需要折叠。
 *
 * @returns {boolean} 是否已挂上（false = 服务未就绪，已排重试或放弃）
 */
export function mountGuide(ctx, text, opts = {}) {
  const { attempts = 20, delayMs = 1000 } = opts;
  try {
    const svc = ctx?.get?.("systemPrompt");
    if (svc && typeof svc.section === "function") {
      svc.section({ name: "dsh-krouter:guide", order: 140, text: String(text ?? "") });
      ctx?.logger?.info?.("dsh-krouter: guide section registered into system prompt");
      return true;
    }
  } catch (e) {
    ctx?.logger?.warn?.(`dsh-krouter: guide 挂载失败（不阻断）: ${e?.message ?? String(e)}`);
    return false;
  }
  if (attempts > 1) {
    setTimeout(() => mountGuide(ctx, text, { attempts: attempts - 1, delayMs }), delayMs);
  } else {
    ctx?.logger?.warn?.("dsh-krouter: systemPrompt 服务未就绪，工具路由表未挂载（工具不受影响）");
  }
  return false;
}
