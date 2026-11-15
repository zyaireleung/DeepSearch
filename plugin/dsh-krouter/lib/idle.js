/**
 * idle.js — SessionEnd 等价物。
 *
 * DSH 没有 session 结束事件（hooks.js 顶部那张表里 ④ 只能用 agent/turn-stopping 近似，
 * 那是每轮都触发的，不是真结束）。所以「会话结束」只能靠推断：**会话停止更新满 N 分钟**
 * 就当它结束了，为它跑一次原 Claude Code 的 SessionEnd 蒸馏（end hook + 整段导入）。
 *
 * 三个旋钮（用户点名的三个配置项）：
 *   - idleMinutes      窗口空闲多少分钟算结束（Distill 窗口空闲时间）
 *   - checkMinutes     多久检查一次（检查周期）
 *   - suppressWindows  峰时抑制时段，"HH:MM-HH:MM" 数组；这些时段内不跑，出了时段再补
 *
 * 判据取舍：
 *   ①没到阈值不跑；②同一会话只跑一次，之后有活动才重新计时；
 *   ③抑制时段里不跑，但**不标记已跑**，出了时段还要补——峰时不该把一次蒸馏白吞掉；
 *   ④跨零点窗口算得对（23:00 与 01:00 都在 "22:00-02:00" 里）。
 *   时段按本机时区判（用户机器就是 Asia/Shanghai），不额外引入时区配置。
 */

/** 三个旋钮的默认值（配置页没配、patch 又抹掉字段时按这个跑）。 */
export const DEFAULT_IDLE = {
  idleMinutes: 180,
  checkMinutes: 15,
  suppressWindows: ["09:00-12:00", "14:00-18:00"],
};

/** "HH:MM-HH:MM" → 当天分钟数；垃圾值 null。 */
export function parseWindow(spec) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec ?? ""));
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start > 1439 || end > 1439) return null;
  return { start, end };
}

/** nowMs 落在任一时段内就抑制。start===end 视为空窗口（不抑制）。 */
export function inSuppressWindow(nowMs, windows = []) {
  const d = new Date(nowMs);
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const spec of windows || []) {
    const w = typeof spec === "string" ? parseWindow(spec) : spec;
    if (!w || w.start === w.end) continue;
    if (w.start < w.end) {
      if (minute >= w.start && minute < w.end) return true;
    } else if (minute >= w.start || minute < w.end) {
      return true; // 跨零点
    }
  }
  return false;
}

/** 该跑哪些会话。纯函数，测试直接喂时间。 */
export function idleDue({ last, fired, nowMs, idleMinutes = 180, suppressWindows = [] }) {
  if (inSuppressWindow(nowMs, suppressWindows)) return [];
  const threshold = Math.max(1, Number(idleMinutes) || 180) * 60000;
  const due = [];
  for (const [id, t] of last) {
    if (fired.has(id)) continue;
    if (nowMs - Number(t) >= threshold) due.push(id);
  }
  return due.sort();
}

/**
 * 挂上活动采集 + 定时检查。
 * @param {object} ctx DSH ctx（只用 ctx.on 与 ctx.logger）
 * @param {object} opts {idleMinutes, checkMinutes, suppressWindows, onIdle, timer, now}
 *   timer/now 可注入，测试用；不注入就走真 setInterval（unref，不吊住进程）。
 */
export function mountIdleDistill(ctx, opts = {}) {
  const idleMinutes = Math.max(1, Number(opts.idleMinutes) || 180);
  const checkMinutes = Math.max(1, Number(opts.checkMinutes) || 15);
  const suppressWindows = Array.isArray(opts.suppressWindows) ? opts.suppressWindows : [];
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const onIdle = typeof opts.onIdle === "function" ? opts.onIdle : () => {};
  const timer =
    opts.timer ||
    {
      set: (fn, ms) => {
        const h = setInterval(fn, ms);
        h.unref?.();
        return h;
      },
      clear: (h) => clearInterval(h),
    };

  const last = new Map();
  const fired = new Set();
  let lastFiredAt = null;
  let lastFiredId = null;
  let fireCount = 0;

  // 活动来源：session/event 是每轮/每次工具都有的那条流，够判「还在动」。
  if (typeof ctx?.on === "function") {
    ctx.on("session/event", (session) => {
      const id = session?.id;
      if (!id) return;
      last.set(id, now());
      fired.delete(id); // 又动了：下次空闲要能再蒸馏一次
    });
  }

  const tick = (atMs = now()) => {
    const due = idleDue({ last, fired, nowMs: atMs, idleMinutes, suppressWindows });
    for (const id of due) {
      fired.add(id);
      // 记账留给人看：DSH 的宿主日志不落盘，没有这两个字段，生产上无法证明
      // 「到点真触发过」——只能靠 vault 有没有新页去猜（lesson 0mwge8py3 禁止）。
      lastFiredAt = atMs;
      lastFiredId = id;
      fireCount += 1;
      try {
        onIdle(id);
      } catch (e) {
        ctx?.logger?.warn?.(`dsh-krouter: 空闲蒸馏触发失败（不阻断）: ${e?.message ?? String(e)}`);
      }
    }
    return due;
  };

  const handle = timer.set(tick, checkMinutes * 60000);

  return {
    tick,
    dispose() {
      timer.clear(handle);
      last.clear();
      fired.clear();
    },
    state: {
      last,
      fired,
      get runtime() {
        return {
          tracked: last.size,
          // fired 是「当前挂起未跑」的集合：一有活动就被 delete，拿它当次数会永远读到 0。
          // 次数必须单调，否则 status 会显示「已触发 0 次」而 lastFiredAt 明明有值。
          pending: fired.size,
          fireCount,
          lastFiredAt,
          lastFiredId,
          checkMinutes,
          idleMinutes,
        };
      },
    },
  };
}

/**
 * 空闲到点的动作：跑原 Claude Code 的 SessionEnd 蒸馏（end hook + 整段导入）。
 * 与 PreCompact 那支共用 hooks.distillSession，这里只做「按会话找文件」。
 */
export function idleDistiller(ctx, opts = {}) {
  const { distillSession } = opts;
  return (sessionId) => {
    if (typeof distillSession !== "function") {
      ctx?.logger?.warn?.("dsh-krouter: 空闲蒸馏没有 distillSession 可调（不阻断）");
      return;
    }
    ctx?.logger?.info?.(
      `dsh-krouter: 会话空闲满 ${opts.idleMinutes ?? 180} 分钟，跑 SessionEnd 蒸馏（${sessionId}）`,
    );
    Promise.resolve()
      .then(() => distillSession(ctx, sessionId, opts))
      .catch((e) => ctx?.logger?.warn?.(`dsh-krouter: 空闲蒸馏失败（不阻断）: ${e?.message ?? String(e)}`));
  };
}
