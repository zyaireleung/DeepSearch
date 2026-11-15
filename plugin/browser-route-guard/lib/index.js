// browser-route-guard v0.2.1 (sandbox candidate, 精简版)
//
// Browser tools are locked by default. Before any browser call the model must,
// in the current user turn:
//   1. successfully execute skill(name="browser-route")
//   2. call browser_route_select(taskKind=...)
// and then use a tool family matching the computed route. Anything else is
// denied by a monotonic DSH tools.guard BEFORE the tool body runs.
//
// Real DSH contract (verified against 0.2.2-rc.1):
//   export const inject = ["tools"], export function apply(ctx)
//   ctx.tools.guard(exec => string | undefined)
//   ctx.on("tools/result", (exec, result) => ...)
//   ctx.on("session/event", (session, event) => ...)
//   systemPrompt.section({ name, order, text })
//
// v0.2.1 change: the v0.2.0 token-position bash scanner (~60 lines) is replaced
// by a single fail-closed substring check. Rationale: the goal is default-lock,
// so a false POSITIVE (over-deny, safe direction) costs one extra unlock while
// a false NEGATIVE (browser slips through) is the real failure. The scanner
// spent 60 lines avoiding false positives and still missed `eval`/`node -e`/
// `python -c`/`$(...)`. The substring check catches all of them and never
// misses a command-position case.

// taskKind -> route. The model never picks a route directly; it declares what
// kind of task it is doing and the plugin computes the route from this table.
export const TASK_ROUTES = Object.freeze({
  "frontend-test": "playwright",
  "general-web": "obscura",
  "human-handoff": "dsh-ego",
  "ego-lite-exception": "ego-lite",
});

// The only non-browser exception: closing a page introduces no new browsing.
const BROWSER_CLOSE = "mcp__obscura__browser_close";

// ponytail: fail-closed substring match over the whole bash command string,
// NOT a shell parser. Boundary: it only recognizes the literal tokens
// playwright / playwright-cli / ego-browser. A command that launches a browser
// WITHOUT one of these literal tokens (a browser binary copied to a new name,
// a raw CDP websocket) is out of scope. False positives (`cat playwright.log`,
// `echo playwright-cli`) are accepted by design — they only force the unlock
// flow, never weaken the lock.
const PLAYWRIGHT_RE = /\bplaywright(?:-cli)?\b/i;
const EGO_LITE_RE = /\bego-browser\b/i;

/** Classify one tool call. Returns a route key, or null for non-browser calls. */
export function classify(toolName, args = {}) {
  if (typeof toolName !== "string") return null;
  if (toolName === BROWSER_CLOSE) return null;
  if (toolName.startsWith("mcp__obscura__browser_")) return "obscura";
  if (toolName.startsWith("ego_") || toolName.startsWith("ego_browser_")) return "dsh-ego";
  if (toolName === "bash") {
    const cmd = String(args?.command ?? "");
    if (!cmd) return null;
    // Normalize both a real newline and a literal `\n` / `\r` to a space so a
    // token glued after a joiner (`hi\nplaywright-cli`) still has a word
    // boundary and matches.
    const flat = cmd.replace(/\\n|\\r|[\n\r]/g, " ");
    if (EGO_LITE_RE.test(flat)) return "ego-lite";
    if (PLAYWRIGHT_RE.test(flat)) return "playwright";
    return null;
  }
  return null;
}

export function createGuardState() {
  return { turn: 0, skillLoaded: false, taskKind: null, route: null };
}

export function createRegistry() {
  return new Map();
}

export function agentKey(agent) {
  const id = agent?.id ?? "(no-agent)";
  const sessionId = agent?.session?.id ?? "(no-session)";
  return `${id}@${sessionId}`;
}

export function stateFor(registry, agent) {
  const key = agentKey(agent);
  let state = registry.get(key);
  if (!state) {
    state = createGuardState();
    registry.set(key, state);
  }
  return state;
}

/** A new user message ends the previous turn's permissions for this session. */
export function onUserMessage(state) {
  state.skillLoaded = false;
  state.taskKind = null;
  state.route = null;
  state.turn += 1;
  return state;
}

/** Only a SUCCESSFUL skill(browser-route) call in the CURRENT turn unlocks. */
export function observeSkillResult(state, exec, result, expectedTurn = state.turn) {
  if (state.turn !== expectedTurn) return false;
  if (exec?.name !== "skill") return false;
  if (exec?.arguments?.name !== "browser-route") return false;
  if (result?.isError !== false) return false;
  state.skillLoaded = true;
  return true;
}

/** Record a successful taskKind selection. Route is computed, never model-supplied. */
export function selectTaskKind(state, taskKind, reason) {
  if (typeof taskKind !== "string" || !TASK_ROUTES[taskKind]) {
    return { ok: false, error: `unknown taskKind "${String(taskKind)}"; expected one of ${Object.keys(TASK_ROUTES).join(", ")}` };
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason is required and must be non-empty" };
  }
  if (!state.skillLoaded) {
    return { ok: false, error: "browser-route skill has not been loaded this turn; call skill(name=\"browser-route\") first" };
  }
  state.taskKind = taskKind;
  state.route = TASK_ROUTES[taskKind];
  return { ok: true, taskKind, route: state.route };
}

/**
 * Return a denial reason for a pending call, or undefined to allow.
 * Pure: the plugin apply() wires this into ctx.tools.guard.
 */
export function gateCall(state, toolName, args) {
  const route = classify(toolName, args);
  if (route === null) return undefined;
  if (!state.skillLoaded) {
    return `浏览器工具已锁定：先调用 skill(name="browser-route") 读取路由规则。被拒工具: ${toolName}。`;
  }
  if (!state.route) {
    return `已读取 browser-route，但尚未选择浏览器：请调用 browser_route_select(taskKind=...)。当前浏览器工具: ${toolName}。`;
  }
  if (state.route !== route) {
    return `浏览器 route 不匹配：本回合 taskKind=${state.taskKind}（route=${state.route}），但调用了 ${toolName}（route=${route}）。请改用对应工具或重新选择 taskKind。`;
  }
  return undefined;
}

export const GUIDANCE_SECTION = `## 浏览器路由门禁（强制）

浏览器工具默认锁定。要使用浏览器，本回合必须按顺序：

1. 调用 skill 工具，加载 \`browser-route\`（必须成功返回）。
2. 调用 \`browser_route_select\`，传入当前任务的 \`taskKind\` 和 \`reason\`。
   route 由插件根据 taskKind 计算，模型不能直接指定 route：
   - \`frontend-test\`  -> playwright（bash 中的 \`playwright-cli\`）
   - \`general-web\`    -> obscura（\`mcp__obscura__browser_*\`）
   - \`human-handoff\`  -> dsh-ego（\`ego_*\` 工具，实时观察窗/扫码/人工接管）
   - \`ego-lite-exception\` -> ego-lite（bash 中的 \`ego-browser\`）
3. 只调用与 route 匹配的浏览器工具。

新用户消息会清空上一回合的全部许可。未走完上述流程直接调用浏览器工具会被拒绝，工具 body 不会执行。`;

function schemaEnum() {
  return Object.keys(TASK_ROUTES);
}

export function apply(ctx) {
  const registry = createRegistry();
  const logger = ctx?.logger?.warn?.bind(ctx.logger) ?? (() => {});

  ctx?.get?.("systemPrompt")?.section({
    name: "browser-route-guard",
    order: 130,
    text: GUIDANCE_SECTION,
  });

  ctx?.on?.("session/event", (session, event) => {
    if (event?.type !== "user/message") return;
    const sid = session?.id;
    for (const [key, state] of registry) {
      if (key.endsWith(`@${sid}`)) {
        onUserMessage(state);
      }
    }
  });

  ctx?.on?.("tools/result", (exec, result) => {
    const state = registry.get(agentKey(exec?.agent));
    if (!state) return;
    observeSkillResult(state, exec, result, state.turn);
  });

  ctx?.tools?.guard?.((exec) => {
    const state = stateFor(registry, exec?.agent);
    const reason = gateCall(state, exec?.name, exec?.arguments);
    if (reason) logger(`[browser-route-guard] deny ${exec?.name}: ${reason}`);
    return reason;
  });

  ctx?.tools?.register({
    name: "browser_route_select",
    description:
      "登记本回合要使用的浏览器通道。必须在成功加载 skill(name=\"browser-route\") 之后、调用任何浏览器工具之前调用一次。参数只描述任务类别，route 由插件计算。",
    parameters: {
      type: "object",
      properties: {
        taskKind: {
          type: "string",
          enum: schemaEnum(),
          description: "当前任务的类别；插件据此计算 route。",
        },
        reason: {
          type: "string",
          description: "简述当前任务为什么属于该类别（必填，非空）。",
        },
      },
      required: ["taskKind", "reason"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          taskKind: { type: "string" },
          route: { type: "string" },
        },
        required: ["ok"],
      },
      render: (_args, value) => [
        {
          type: "text",
          text: JSON.stringify(value),
        },
      ],
    },
    execute: async (args, exec) => {
      const state = stateFor(registry, exec?.agent);
      const selected = selectTaskKind(state, args?.taskKind, args?.reason);
      if (!selected.ok) return { ok: false, error: selected.error };
      return {
        ok: true,
        taskKind: selected.taskKind,
        route: selected.route,
      };
    },
  });

  return {
    registry,
    /** Ensure a state entry exists for an agent; returns the live state object. */
    ensureState(agent) {
      return stateFor(registry, agent);
    },
  };
}

export const inject = ["tools"];

export const name = "browser-route-guard";

export default { apply, inject, name };
