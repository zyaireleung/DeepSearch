/**
 * diag.js — dsh-krouter 插件级诊断（只读）
 *
 * 为什么不用 krouter_status：那走 MCP，只报 KRouter 本体的 vault/nightly 健康，
 * 看不见「DSH 桥这一侧」的被动注入开关状态——turn 学习 / 纠正候选 /
 * 写开关 / nightly 到底生效没有，用户开了 config 也无从确认。
 *
 * 本模块注册一个原生只读工具 dsh_krouter_status，直接报插件运行时状态：
 *   - vault 是否配置（不配=被动召回空转）
 *   - 五事件被动注入：哪些挂上了（pre-step / session/event）
 *   - transcript 学习：transcript 总闸（config.transcript，默认开）——consent 闸已按用户要求删除，开即真跑
 *   - 纠正候选捕捉：每轮被动跑，写 vault（无 consent 闸）
 *   - 写工具 note/correct/learn：装插件即注册（无独立写闸）
 *   - nightly：enabled / time
 *
 * 隐私：纯只读，不读会话内容、不写 vault，只报告开关与路径。
 */


/**
 * 注册 dsh_krouter_status 诊断工具。
 *
 * state 参数是 getter（函数），render() 每次调用时实时取最新状态——否则 nightly 开关
 * 改了（配置页 / volatile-update 热重排 / patch 重启生效）这里仍显示 apply 时快照，
 * 会一直 false，用户误判「nightly 不生效」。
 *
 * @param {object} ctx - DSH plugin ctx（ctx.tools.register / ctx.logger）
 * @param {() => object} stateFn - 返回最新运行时状态的函数（nightlyEnabled/nightlyTime 等）
 * @returns {{ dispose: () => void, name: string }}
 */
export function registerDiagTool(ctx, stateFn = () => ({})) {
  const name = "dsh_krouter_status";
  if (!ctx?.tools?.register) {
    ctx?.logger?.warn?.("dsh-krouter: ctx.tools.register 不可用，dsh_krouter_status 未注册");
    return { dispose: () => {}, name: null };
  }

  const render = () => {
    // 每次渲染实时读最新状态（兼容误传对象：typeof 判断）
    const state = typeof stateFn === "function" ? (stateFn() || {}) : (stateFn || {});
    const hooks = Array.isArray(state.hooksMounted) ? state.hooksMounted : [];
    const transcriptOn = state.transcript !== false;
    // transcript 学习 = transcript 开即接通（consent 闸已按用户要求删除，装插件即跑）
    const transcriptLearning = transcriptOn;
    // 空闲蒸馏（0.2.0 的 SessionEnd 等价物）：index.js 把 idle 段交给了本工具，
    // 早期这里没读它，于是 P5 的判据（status 的 idle 段）在生产上根本读不到。
    const idle = state.idle && typeof state.idle === "object" ? state.idle : {};
    const idleOn = idle.enabled === true || (idle.enabled === undefined && transcriptOn);
    const idleMinutes = idle.idleMinutes ?? 180;
    const checkMinutes = idle.checkMinutes ?? 15;
    const windows = Array.isArray(idle.suppressWindows) ? idle.suppressWindows : [];

    const lines = [];
    lines.push("dsh-krouter 插件状态（DSH 桥侧，只读诊断）");
    lines.push("────────────────────────────────────────");
    lines.push(`vault: ${state.vault || "（未配置 — 被动召回将空转，设 vaultPath / KROUTER_VAULT）"}`);
    lines.push("");
    lines.push("五事件被动注入（对齐 Claude Code 调用 KRouter）:");
    lines.push(`  ① SessionStart  standing index : ${hooks.includes("pre-step") ? "✅ 挂载（每会话首次注入，持久化防重启重复）" : "— 未挂载"}`);
    lines.push(`  ② UserPromptSubmit 想起        : ${hooks.includes("pre-step") ? "✅ 挂载（canonical 直锁优先，其余委托本体 recollect.py；无命中静默）" : "— 未挂载"}`);
    lines.push(`  ② UserPromptSubmit 纠正候选    : ${hooks.includes("pre-step") ? "✅ 活跃（note_correction 写 vault，无 consent 闸）" : "— 未挂载"}`);
    lines.push(`  ③ Stop/turn 学习               : ${hooks.includes("session/event") ? (transcriptLearning ? "✅ 已挂载且 transcript 已开启（本诊断只报 hook/开关，未验证本次数据流）" : "⚪ transcript 已关（config.transcript===false）") : "— 未挂载"}`);
    lines.push(`  ⑤ PreCompact/SessionEnd 导入   : ${hooks.includes("session/event") ? (transcriptLearning ? "✅ 已挂载且 transcript 已开启（同上，未验证本次导入）" : "⚪ transcript 已关") : "— 未挂载"}`);
    lines.push(`  ④ SessionEnd（DSH 无真事件）    : ${idleOn ? `✅ 空闲蒸馏已挂（会话停止更新满 ${idleMinutes} 分钟触发；证据看日志「会话空闲满」）` : "⚪ 未挂（transcript 关着，空闲蒸馏整支不挂）"}`);
    lines.push("");
    lines.push("开关:");
    lines.push(`  transcript（会话学习总闸）: ${transcriptOn ? "true（默认开 — 读会话学进 vault）" : "false（config.transcript===false 显式关闭）"}`);
    lines.push(`  nightly（每日总结）       : ${state.nightlyEnabled === true ? `true（${state.nightlyTime || "09:10"}）` : "false"}`);
    lines.push("");
    lines.push("空闲蒸馏（SessionEnd 等价物 — DSH 无 session end 事件，靠「停止更新」推断）:");
    lines.push(`  enabled        : ${idleOn ? "true（transcript 开着即挂）" : "false（transcript 关着）"}`);
    lines.push(`  idleMinutes    : ${idleMinutes}（会话停止更新满这么久，跑一次结束蒸馏）`);
    lines.push(`  checkMinutes   : ${checkMinutes}（每隔这么久看一次有没有会话停下来）`);
    lines.push(`  suppressWindows: ${windows.length ? windows.join(" ") : "无（不抑制）"}（时段内不触发、也不记已跑，出时段补跑）`);
    // 宿主日志不落盘，没有这一行，生产上只能靠「vault 有没有新页」猜触发过没有。
    const rt = idle.runtime && typeof idle.runtime === "object" ? idle.runtime : null;
    if (rt) {
      const when = rt.lastFiredAt ? new Date(rt.lastFiredAt).toLocaleString("zh-CN", { hour12: false }) : "";
      lines.push(
        `  运行时         : 记账 ${rt.tracked ?? 0} 个会话、已触发 ${rt.fireCount ?? rt.fired ?? 0} 次（当前挂起 ${rt.pending ?? 0}）` +
          (rt.lastFiredAt ? `；最近一次 ${when}（${rt.lastFiredId ?? "?"}）` : "；尚未触发过"),
      );
    } else {
      lines.push("  运行时         : 无 watcher（这一支没挂起来）");
    }
    lines.push("");
    if (!transcriptOn) {
      lines.push("提示: ③ turn 学习 / ⑤ 整段导入当前关（config.transcript===false）。删掉该 override 或设 true 即接通。");
    }
    return lines.join("\n");
  };

  const renderText = (_args, value) => [{ type: "text", text: value.text }];

  ctx.tools.register({
    name,
    description:
      "dsh-krouter 桥自身状态（区别于 krouter_status 那个报 vault/nightly 健康）: " +
      "五事件被动注入哪些挂上了、transcript 学习/纠正候选/consent/写开关/nightly 的当前开关值。只读，不读会话内容。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    // dsh ctx.tools.register 契约：output 必须 { schema, render }，schema 是 raw JSON
    // Schema（register() 直接 assertSupportedJsonSchema）。缺 schema 会 throw，诊断工具
    // 注册中断。execute 返回 { ok, text }，故输出 object-rooted 开放 schema。
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, text: { type: "string" } },
      },
      render: renderText,
    },
    execute: async () => ({ ok: true, text: render() }),
  });

  ctx.logger?.info?.(`dsh-krouter: 诊断工具 ${name} 已注册（报桥侧 hook/开关状态）`);
  return { dispose: () => {}, name };
}
