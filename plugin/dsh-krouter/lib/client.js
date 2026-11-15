/**
 * dsh-krouter — settings panel (client side)
 *
 * 在 DSH 设置页注册 "KRouter" section，3 个字段：
 *   1. 每日总结开关 (bool)
 *   2. 定时时间 (text, HH:MM)
 *   3. 模型 (select, provider:model)
 *
 * 风格对齐 meow-memory：DSH 原生浅色、checkbox、monospace 时间输入、原生 select。
 * 配置写入 DSH settings（per-field），host 侧 apply(ctx, config) 读到后设定时器。
 */
window.__ModuleLoader__.load({
  id: "dsh-krouter",
  factory: (require) => {
    const React = require("react");
    const { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } = React;

    // ── i18n ──────────────────────────────────────────────────────────────────
    const STRINGS = {
      zh: {
        "settings.title": "KRouter",
        "settings.summary": "每日总结：定时编译下意识索引、健康检查。模型步骤走已选模型。",
        "settings.loading": "加载 KRouter 配置…",
        "settings.saved": "已保存 ✓ 已即时生效",
        "settings.saveFailed": "保存失败：{error}",
        "settings.badge.override": "已修改",
        "settings.badge.default": "默认",
        "settings.reset": "恢复默认",
        "field.nightlyEnabled.label": "每日总结",
        "field.nightlyEnabled.hint": "关闭后定时器不启动，工具仍可用",
        "field.nightlyTime.label": "定时时间",
        "field.nightlyTime.hint": "每天几点跑，格式 HH:MM",
        "field.nightlyTime.error": "格式应为 HH:MM",
        "field.nightlyModel.label": "每日总结模型",
        "field.nightlyModel.hint": "每日总结（reconsolidate）用的模型；留空只跑纯本地步骤",
        "field.nightlyModel.placeholder": "— 纯本地（不用模型）—",
        "field.distillModel.label": "Distill 模型",
        "field.distillModel.hint": "会话蒸馏（import distill）用的模型，可与每日总结不同；留空跟每日总结同一模型",
        "field.distillModel.placeholder": "— 跟随每日总结模型 —",
        "field.idleMinutes.label": "Distill窗口空闲时间",
        "field.idleMinutes.hint": "分钟。会话停止更新满这么久，跑一次结束蒸馏（DSH 没有 session end 事件，只能这样推断）",
        "field.checkMinutes.label": "空闲检查周期",
        "field.checkMinutes.hint": "分钟。每隔这么久看一次有没有会话停下来",
        "field.suppressWindows.label": "峰时抑制时段",
        "field.suppressWindows.hint": "HH:MM-HH:MM，逗号分隔；时段内不跑，出时段补跑，留空=不抑制",
        "field.suppressWindows.error": "每段应为 HH:MM-HH:MM",
        "fold.bar": "已注入 KRouter 相关记忆",
        "fold.expand": "点击展开",
        "fold.collapse": "点击收起",
      },
      en: {
        "settings.title": "KRouter",
        "settings.summary": "Daily summary: compile subconscious index, health check on schedule. Model steps use the selected model.",
        "settings.loading": "Loading KRouter configuration…",
        "settings.saved": "Saved ✓ applied immediately",
        "settings.saveFailed": "Save failed: {error}",
        "settings.badge.override": "Overridden",
        "settings.badge.default": "Default",
        "settings.reset": "Reset",
        "field.nightlyEnabled.label": "Daily summary",
        "field.nightlyEnabled.hint": "When off, the nightly timer does not start; tools remain available",
        "field.nightlyTime.label": "Schedule time",
        "field.nightlyTime.hint": "Daily run time, format HH:MM",
        "field.nightlyTime.error": "Format should be HH:MM",
        "field.nightlyModel.label": "Daily summary model",
        "field.nightlyModel.hint": "Model for the daily summary (reconsolidate); empty = local-only steps",
        "field.nightlyModel.placeholder": "— Local only (no model) —",
        "field.distillModel.label": "Distill model",
        "field.distillModel.hint": "Model for session distillation (import distill), can differ from the daily summary; empty = follow the daily summary model",
        "field.distillModel.placeholder": "— Follow daily summary model —",
        "field.idleMinutes.label": "Distill window idle time",
        "field.idleMinutes.hint": "Minutes. A session that stops updating this long runs the ending distillation (DSH has no session-end event)",
        "field.checkMinutes.label": "Idle check interval",
        "field.checkMinutes.hint": "Minutes between checks for sessions that have gone quiet",
        "field.suppressWindows.label": "Peak-hour suppression",
        "field.suppressWindows.hint": "HH:MM-HH:MM separated by commas; suppressed inside, caught up after; empty = never suppress",
        "field.suppressWindows.error": "Each window should be HH:MM-HH:MM",
        "fold.bar": "KRouter relevant memory injected",
        "fold.expand": "Click to expand",
        "fold.collapse": "Click to collapse",
      },
    };

    let currentLocale = "zh";
    function t(key, vars) {
      let s = (STRINGS[currentLocale] || STRINGS.zh)[key] ?? STRINGS.zh[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    const el = React.createElement;
    const SETTINGS_NS = "dsh-krouter";

    /** field definitions */
    const FIELDS = [
      { key: "nightlyEnabled", type: "bool", def: false },
      { key: "nightlyTime",    type: "text", def: "09:10", sub: "time" },
      { key: "nightlyModel",   type: "select", def: "" },
      { key: "distillModel",   type: "select", def: "" },
      // 空闲蒸馏（SessionEnd 等价物）三旋钮。默认值必须与 index.js 的 Config 一致。
      { key: "idleMinutes",    type: "number", def: 180 },
      { key: "checkMinutes",   type: "number", def: 15 },
      { key: "suppressWindows", type: "array", def: ["09:00-12:00", "14:00-18:00"] },
    ];

    /** 值比较：数组按内容比，否则严格比。用于「已修改」标记（null/undefined 都算未改）。 */
    function sameValue(a, b) {
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      return a === b;
    }

    /** "09:00-12:00, 14:00-18:00" → 数组；任一段格式不对返回 null；空串返回 []（=不抑制）。 */
    function parseWindows(text) {
      const parts = String(text).split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
      for (const w of parts) if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w)) return null;
      return parts;
    }

    // ── 配置读写层（走 DSH configForms，对齐自带 settings-* 插件的唯一正确 API）──
    // 关键映射（已读 DSH 源码钉死，非推断）：
    //   configForms.get(entryId) 的 entryId = 插件 entry id = "dsh-krouter"；
    //   server 侧 apply(ctx, config) 的 config 正是 cordis.patch.yml 里同一 entry 的 config 块。
    //   ∴ configForm.getSnapshot().value = entry config 顶层字段对象，
    //     configForm.set(field, value) 写该 namespace 顶层字段（mutate→remote.settings.mutate→落 entry config）。
    //   字段名（nightlyEnabled/nightlyTime/nightlyModel）直接对上 server 读的 config.<key>。
    // 旧实现用 ctx.settings.get(["plugins",ns,key]) —— DSH client 侧根本没有这个 API，
    // cordis inject 守卫直接抛 "cannot get property settings without inject" 致整个面板崩溃。
    function fieldValue(configForm, spec) {
      try {
        const v = configForm?.getSnapshot?.()?.value?.[spec.key];
        return v !== undefined ? v : spec.def;
      } catch { return spec.def; }
    }

    function readValue(configForm, spec) { return fieldValue(configForm, spec); }

    function isOverridden(configForm, spec) {
      try {
        const v = configForm?.getSnapshot?.()?.value?.[spec.key];
        return v !== undefined && !sameValue(v, spec.def);
      } catch { return false; }
    }

    async function writeValue(configForm, spec, value) {
      await configForm?.set?.(spec.key, value);
    }

    async function resetField(configForm, spec) {
      await configForm?.set?.(spec.key, spec.def);
    }

    // ── 模型列表（client 侧合法来源：remote.session.modelCatalog）──────────────
    // 返回 {ok, value:{groups:[{id,name,models:[{id,...}]}], default}}，
    // 映射成组件期望的 {providerId:{models:[id,...]}}；value "pid:mid" 与 server
    // resolveModelConfig 拆解逻辑一致。catalog 取不到时回退空（下拉仅剩"纯本地"项）。
    async function fetchModelProviders(remote) {
      try {
        const res = await remote?.session?.modelCatalog?.();
        if (!res?.ok || !res.value) return {};
        const out = {};
        for (const group of res.value.groups || []) {
          const models = (group.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
          if (group.id && models.length) out[group.id] = { models };
        }
        return out;
      } catch { return {}; }
    }

    // ── CSS ───────────────────────────────────────────────────────────────────
    const CSS_TEXT = `
[data-plugin="dsh-krouter-settings"] .krt_row{align-items:flex-start;display:flex;gap:10px;justify-content:space-between;padding:12px 0}
[data-plugin="dsh-krouter-settings"] .krt_row+.krt_row{border-top:1px solid var(--dsw-alias-border-l2, #f0f0f0)}
[data-plugin="dsh-krouter-settings"] .krt_rowtext{display:flex;flex-direction:column;gap:2px;min-width:0}
[data-plugin="dsh-krouter-settings"] .krt_label{font-size:13px;font-weight:500}
[data-plugin="dsh-krouter-settings"] .krt_hint{font-size:11px;color:var(--dsw-alias-text-secondary, #999);line-height:1.4}
[data-plugin="dsh-krouter-settings"] .krt_check{cursor:pointer;flex-shrink:0;margin-top:1px}
[data-plugin="dsh-krouter-settings"] .krt_input{background:transparent;border:1px solid var(--dsw-alias-border-l3, #d0d0d0);border-radius:6px;color:inherit;font-size:13px;padding:4px 8px;width:120px;outline:none}
[data-plugin="dsh-krouter-settings"] .krt_input:focus{border-color:var(--dsw-alias-focus, #007aff)}
[data-plugin="dsh-krouter-settings"] .krt_input_err{border-color:#f43f5e}
[data-plugin="dsh-krouter-settings"] .krt_input_time{width:100px;font-family:ui-monospace,monospace;text-align:center}
[data-plugin="dsh-krouter-settings"] .krt_input_num{width:90px;font-family:ui-monospace,monospace;text-align:center}
[data-plugin="dsh-krouter-settings"] .krt_input_windows{width:260px;font-family:ui-monospace,monospace}
[data-plugin="dsh-krouter-settings"] .krt_select{background:transparent;border:1px solid var(--dsw-alias-border-l3, #d0d0d0);border-radius:6px;color:inherit;font-size:13px;padding:4px 8px;width:220px;outline:none;cursor:pointer}
[data-plugin="dsh-krouter-settings"] .krt_select:focus{border-color:var(--dsw-alias-focus, #007aff)}
[data-plugin="dsh-krouter-settings"] .krt_badge{display:inline-block;font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle}
[data-plugin="dsh-krouter-settings"] .krt_badge_override{background:var(--dsw-alias-info-bg, #e3f2fd);color:var(--dsw-alias-info, #1976d2)}
[data-plugin="dsh-krouter-settings"] .krt_badge_default{background:var(--dsw-alias-border-l2, #f0f0f0);color:var(--dsw-alias-text-secondary, #999)}
[data-plugin="dsh-krouter-settings"] .krt_reset{background:none;border:none;color:var(--dsw-alias-text-secondary, #888);cursor:pointer;font-size:11px;margin-left:8px;padding:0}
[data-plugin="dsh-krouter-settings"] .krt_reset:hover{text-decoration:underline}
[data-plugin="dsh-krouter-settings"] .krt_saved{font-size:11px;color:var(--dsw-alias-success, #4caf50);margin-top:8px}
[data-plugin="dsh-krouter-settings"] .krt_error{font-size:11px;color:#f43f5e;margin-top:8px}
[data-plugin="dsh-krouter-settings"] .krt_section{padding:4px 0}
[data-krouter-folded="true"]{display:none!important}
[data-krouter-injection-anchor]{padding:2px 0}
/* 胶囊观感全部由 PILL_STYLE / BODY_STYLE 内联给出（对齐 meow-memory 生产胶囊）：
   这里不再写死颜色，写死浅色主题的灰阶在深色主题下会变成浅灰块+深灰字，和宿主胶囊两种样子。 */
    `;

    function injectCss() {
      if (typeof document === "undefined") return;
      let tag = document.querySelector('style[data-plugin-css="dsh-krouter-settings"]');
      if (!tag) {
        tag = document.createElement("style");
        tag.dataset.plugin = "dsh-krouter-settings";
        tag.dataset.pluginCss = "dsh-krouter-settings";
        document.head.appendChild(tag);
      }
      tag.textContent = CSS_TEXT;
    }

    // ── main component ────────────────────────────────────────────────────────
    function KRouterSettingsSection(props) {
      const configForm = props?.configForm;
      const remote = props?.remote;
      const [providers, setProviders] = useState({});
      const [drafts, setDrafts] = useState({});
      const [savedAt, setSavedAt] = useState(0);
      const [error, setError] = useState(null);

      // 拉一次 DSH env 模型列表（provider→models）。失败静默=下拉仅"纯本地"项，不阻塞其它字段。
      useEffect(() => {
        let alive = true;
        fetchModelProviders(remote).then((mp) => { if (alive) setProviders(mp); });
        return () => { alive = false; };
      }, [remote]);

      const timeDraft = drafts["nightlyTime"];
      const timeError = timeDraft !== undefined && !/^\d{2}:\d{2}$/.test(timeDraft);

      const renderField = (spec) => {
        const raw = readValue(configForm, spec);
        const overridden = isOverridden(configForm, spec);
        const label = t(`field.${spec.key}.label`);
        const hint = t(`field.${spec.key}.hint`);

        const labelNode = el("span", { className: "krt_label" },
          label,
          el("span", { className: `krt_badge ${overridden ? "krt_badge_override" : "krt_badge_default"}` },
            t(overridden ? "settings.badge.override" : "settings.badge.default")),
          overridden ? el("button", {
            className: "krt_reset",
            onClick: async () => { await resetField(configForm, spec); setSavedAt(Date.now()); },
          }, t("settings.reset")) : null,
        );

        const rowtext = el("div", { className: "krt_rowtext" },
          labelNode,
          el("span", { className: "krt_hint" }, hint),
        );

        let control = null;
        if (spec.type === "bool") {
          control = el("input", {
            className: "krt_check",
            type: "checkbox",
            checked: raw === true,
            onChange: async (e) => {
              await writeValue(configForm, spec, e.target.checked);
              setSavedAt(Date.now()); setError(null);
            },
          });
        } else if (spec.sub === "time") {
          const val = drafts[spec.key] ?? (typeof raw === "string" ? raw : spec.def);
          control = el("input", {
            className: "krt_input krt_input_time" + (timeError ? " krt_input_err" : ""),
            type: "text",
            value: val,
            placeholder: "09:10",
            onChange: (e) => setDrafts((p) => ({ ...p, [spec.key]: e.target.value })),
            onBlur: async (e) => {
              const v = e.target.value.trim();
              if (!/^\d{2}:\d{2}$/.test(v) || v === raw) { setDrafts((p) => { delete p[spec.key]; return { ...p }; }); return; }
              await writeValue(configForm, spec, v);
              setDrafts((p) => { delete p[spec.key]; return { ...p }; });
              setSavedAt(Date.now()); setError(null);
            },
          });
        } else if (spec.type === "number") {
          const draft = drafts[spec.key];
          const val = draft ?? (typeof raw === "number" ? String(raw) : String(spec.def));
          control = el("input", {
            className: "krt_input krt_input_num",
            type: "number", min: "1", step: "1",
            value: val,
            onChange: (e) => setDrafts((p) => ({ ...p, [spec.key]: e.target.value })),
            onBlur: async (e) => {
              const v = Number(String(e.target.value).trim());
              setDrafts((p) => { delete p[spec.key]; return { ...p }; });
              if (!Number.isFinite(v) || v < 1 || v === raw) return;
              await writeValue(configForm, spec, v);
              setSavedAt(Date.now()); setError(null);
            },
          });
        } else if (spec.type === "array") {
          const base = Array.isArray(raw) ? raw.join(",") : spec.def.join(",");
          const draft = drafts[spec.key];
          const val = draft ?? base;
          const parsed = draft === undefined ? [] : parseWindows(draft);
          const bad = draft !== undefined && parsed === null;
          control = el("input", {
            className: "krt_input krt_input_windows" + (bad ? " krt_input_err" : ""),
            type: "text",
            value: val,
            placeholder: "09:00-12:00,14:00-18:00",
            onChange: (e) => setDrafts((p) => ({ ...p, [spec.key]: e.target.value })),
            onBlur: async (e) => {
              const parsedNext = parseWindows(e.target.value);
              setDrafts((p) => { delete p[spec.key]; return { ...p }; });
              if (parsedNext === null) return; // 格式不对：丢弃草稿，红框已在输入时标过
              if (sameValue(parsedNext, raw)) return;
              await writeValue(configForm, spec, parsedNext);
              setSavedAt(Date.now()); setError(null);
            },
          });
        } else if (spec.type === "select") {
          const options = [{ value: "", label: t(`field.${spec.key}.placeholder`) }];
          for (const [pid, pinfo] of Object.entries(providers)) {
            for (const m of pinfo.models || []) {
              const mid = typeof m === "string" ? m : m.id;
              options.push({ value: `${pid}:${mid}`, label: mid });
            }
          }
          control = el("select", {
            className: "krt_select",
            value: typeof raw === "string" ? raw : "",
            onChange: async (e) => {
              await writeValue(configForm, spec, e.target.value);
              setSavedAt(Date.now()); setError(null);
            },
          },
            options.map((o) => el("option", { key: o.value, value: o.value }, o.label)),
          );
        }

        return el("div", { key: spec.key, className: "krt_row" }, rowtext, control);
      };

      return el("div", { className: "krt_section", "data-plugin": "dsh-krouter-settings" },
        el("div", { style: { fontSize: "13px", fontWeight: 500, marginBottom: "4px" } }, t("settings.title")),
        el("div", { style: { fontSize: "12px", color: "#888", marginBottom: "8px", lineHeight: "1.5" } }, t("settings.summary")),
        FIELDS.map(renderField),
        savedAt > 0 && !error ? el("div", { className: "krt_saved" }, t("settings.saved")) : null,
        error ? el("div", { className: "krt_error" }, t("settings.saveFailed", { error })) : null,
      );
    }

    // ── 胶囊折叠渲染（照搬 meow-memory 的纯 DOM overlay 模式）────────────────
    // 不覆写共享 React slot，只操作自己 source 的 context 流行，避免遮蔽其它插件。
    // 前台胶囊路：state ∈ {session-start, direct, related} 的注入 → 折叠成胶囊。
    // 后台静默路：其它 state（含 PreCompact 未来可能的 reinjection）→ 不折，保持原生静默。
    const FOLD_ATTR = "data-krouter-folded";
    /**
     * 胶囊样式：逐字对齐 meow-memory 生产胶囊（2026-11-15 21:05 用 dsh-gui-debug 从 GUI 实测
     * outerHTML / computed style 抄下来，宿主是深色主题）。
     * 两个要害：
     *  ① `margin:4px 0 4px auto` —— 胶囊靠 margin-left:auto 贴到**右侧**，和内联用户气泡同一列；
     *  ② 颜色一律用 --dsw-alias-* token 或 rgba(127,127,127,.0x) 这类主题中性值，
     *     写死 #f5f5f5 / #666 只在浅色主题成立，深色主题下看着就是另一套东西。
     */
    const PILL_STYLE = [
      "display:block",
      "margin:4px 0 4px auto",
      "max-width:82%",
      "padding:5px 12px",
      "font-size:12px",
      "line-height:1.6",
      "text-align:left",
      "cursor:pointer",
      "color:var(--dsw-alias-label-secondary, rgba(127,127,127,.9))",
      "background:rgba(127,127,127,.07)",
      "border:1px solid rgba(127,127,127,.14)",
      "border-radius:999px",
    ].join(";");
    /** 展开后的正文：对齐 meow 的注入正文块（等宽、淡底、8px 圆角）。 */
    const BODY_STYLE = [
      "margin:2px 0 8px",
      "padding:8px 10px",
      "font-size:12px",
      "line-height:1.7",
      "white-space:pre-wrap",
      "word-break:break-word",
      "color:var(--dsw-alias-label-secondary, rgba(190,190,190,.9))",
      "background:rgba(127,127,127,.05)",
      "border:1px solid rgba(127,127,127,.12)",
      "border-radius:8px",
      "font-family:ui-monospace,'Cascadia Code',Consolas,'Courier New',monospace",
    ].join(";");
    const ANCHOR_ATTR = "data-krouter-injection-anchor";
    const BODY_ATTR = "data-krouter-injection-body";
    const META_SECTION = "__meta__";
    const KROUTER_PLUGIN = "dsh-krouter";
    /** 折叠成前台胶囊的 state 集合；其余 state 静默。 */
    const FOLD_STATES = new Set(["session-start", "direct", "related"]);

    function isKrouterSource(source) {
      if (!source || typeof source !== "object") return false;
      if (source.plugin === KROUTER_PLUGIN) return true;
      return source.kind === "krouter";
    }

    /** 胶囊标题：收起 ▸ / 展开 ▾（文案在 i18n 的 fold.bar）。 */
    function pillText(isExpanded) {
      return `${isExpanded ? "▾" : "▸"} ${t("fold.bar")}`;
    }

    /**
     * 折叠该组时要隐藏的行：只有**精确命中**的那一行。
     *
     * 两个方向都不能错：
     *  - 精确行必须隐藏。改造前注入是 context 节点、被 isVisibleChatNode 过滤掉本来就不进 DOM，
     *    所以"精确行不用隐藏"成立；改成 user-kind 后精确行是**可见的人话行**，漏隐藏就把整条
     *    记忆原文露在对话里（2026-11-15 生产实测：胶囊不出、消息原样暴露）。
     *  - fallback 行绝不隐藏。turn 兜底命中的是包裹用户真实提问的轮次容器，隐藏会连用户的话
     *    一起吞掉（deep-search foldOne 同样只在"找到的就是 flow-key 行本身"时才折）。
     */
    function rowsToHide(found) {
      if (found === null || found === undefined) return null;
      if (found.exact !== true) return null;
      return found.row ?? null;
    }

    /**
     * 折叠视图的容器根。
     *
     * dock 挂在 conversation.composer.dock（输入框区域），未必在 scroll 容器内部，
     * 所以 closest 落空必须回退——否则 mountKrouterFoldView 拿到 null 直接放弃，
     * 折叠整条通道静默失效（deep-search 同款三级回退）。
     */
    function resolveFoldRoot(el, doc) {
      const SEL = "[data-conversation-scroll]";
      const near = el?.closest?.(SEL);
      if (near) return near;
      const found = doc?.querySelector?.(SEL);
      if (found) return found;
      return doc?.body ?? null;
    }

    function metaStateOf(node) {
      const sections = node?.data?.source?.sections;
      if (!Array.isArray(sections)) return undefined;
      for (const s of sections) {
        if (s?.name !== META_SECTION) continue;
        try { return JSON.parse(s.text || "{}")?.state; } catch { return undefined; }
      }
      return undefined;
    }

    function blocksToText(blocks) {
      if (!Array.isArray(blocks)) return "";
      return blocks
        .map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n");
    }

    function contextText(node) {
      return blocksToText(node?.data?.content ?? []);
    }

    function chatKeyOrder(snapshot) {
      const chat = snapshot?.chat;
      if (!chat) return [];
      const keys = [];
      const seen = new Set();
      for (const key of chat.order || []) {
        if (seen.has(key)) continue;
        seen.add(key); keys.push(key);
      }
      const store = chat.nodes;
      if (typeof store?.values !== "function") return keys;
      const extra = [];
      for (const node of store.values()) {
        const key = node?.key;
        if (key === undefined || seen.has(key)) continue;
        seen.add(key);
        extra.push({ key, seq: node?.anchorSeq ?? node?.data?.seq ?? 0 });
      }
      extra.sort((a, b) => a.seq - b.seq);
      for (const item of extra) keys.push(item.key);
      return keys;
    }

    /** 扫 snapshot，产出 krouter 前台胶囊折叠组。 */
    function computeKrouterInjectionGroups(snapshot) {
      if (!snapshot || snapshot.chat === undefined) return [];
      const nodes = snapshot.chat.nodes;
      if (!nodes || typeof nodes.get !== "function") return [];
      const groups = [];
      for (const key of chatKeyOrder(snapshot)) {
        const node = nodes.get(key);
        if (!node) continue;
        const source = node.data?.source;
        // Path 2（主路）：user-kind 注入 = 记忆 recall。宿主按 source.kind="user" 落成 user 节点，
        // 前台可见；靠 source.plugin 认领，别家插件的 user 节点不吞、真用户气泡（无 source）不碰。
        const isUserInjection = node.kind === "user" &&
          !!source && typeof source === "object" &&
          source.plugin === KROUTER_PLUGIN && source.form === "snapshot";
        // Path 1（兼容）：context-kind 快照（历史 deferContext 路）。
        const isContextInjection = node.kind === "context" && isKrouterSource(source);
        if (!isUserInjection && !isContextInjection) continue;
        const state = metaStateOf(node);
        if (typeof state !== "string" || !FOLD_STATES.has(state)) continue; // 静默路不折
        // turn：context 节点在 anchor、user 节点在 location.turn（宿主两种形状都见过）
        const turn = node.anchor?.turn ?? node.data?.turn ?? node.location?.turn?.turn;
        const injectedText = contextText(node);
        if (!injectedText.trim()) continue;
        groups.push({
          id: key,
          turn: typeof turn === "number" ? turn : undefined,
          state,
          injectedText,
        });
      }
      return groups;
    }

    function chatFlows(root) {
      const list = Array.from(root.querySelectorAll("[data-chat-flow]"));
      if (typeof root.matches === "function" && root.matches("[data-chat-flow]")) list.unshift(root);
      return list;
    }

    /**
     * 属性值选择器转义。
     *
     * 宿主渲染层**没有标准 CSS API 的 escape()**（2026-11-15 20:47 dsh-gui-debug 实测：
     * `TypeError: escape is not a function` → 宿主报
     * "slot entry crashed in 'conversation.composer.dock'" → 整个折叠 dock 被卸载，
     * 胶囊永不出现、注入文本原样裸露）。渲染层是本 app 的自定义协议页面，别假设有
     * 完整 Web CSS API；deep-search 早就用 safeEscape 挡了这一手。
     */
    function safeEscape(value) {
      const s = String(value);
      try {
        const host = globalThis.CSS;
        if (host && typeof host === "object" && typeof host.escape === "function") return host.escape(s);
      } catch { /* 宿主无 CSS 或访问即抛：走手写转义 */ }
      return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    function flowElements(flow, selector) {
      return Array.from(flow.querySelectorAll(selector)).filter((e) => e.closest("[data-chat-flow]") === flow);
    }

    function flowRow(container, key) {
      return flowElements(container, `[data-chat-flow-key="${safeEscape(key)}"]`)
        .find((row) => row.closest(`[${BODY_ATTR}]`) === null) ?? null;
    }

    /**
     * 找这一组要折叠的行：**只认精确的 flow 行**。
     *
     * 曾经的「找不到就退化成轮次容器」在 2026-11-15 20:52 生产实测里造出重复胶囊：
     * 同一条注入在内层 flow 隐藏成功，外层 flow 又拿轮次行插了一个 ▸（2 条注入 → 4 个胶囊）。
     * 而且轮次容器里裹着用户真实提问，对它插胶囊既是重复也是误导。
     * 所以：精确行缺失 = 本容器不是它家 = 什么都不做。
     */
    function injectionRow(container, group) {
      const exact = flowRow(container, group.id);
      return exact !== null ? { row: exact, exact: true } : null;
    }

    function ensureFoldAnchor(container, group, expanded, onToggle) {
      const found = injectionRow(container, group);
      if (!found) return null;
      const row = found.row;
      const target = rowsToHide(found);
      if (target !== null && target.getAttribute(FOLD_ATTR) !== "true") {
        target.setAttribute(FOLD_ATTR, "true");
      }
      let anchor = flowElements(container, `[${ANCHOR_ATTR}="${safeEscape(group.id)}"]`)[0] ?? null;
      if (!anchor) {
        anchor = document.createElement("div");
        anchor.setAttribute(ANCHOR_ATTR, group.id);
        const pill = document.createElement("button");
        pill.className = "krt_fold_pill";
        pill.type = "button";
        pill.style.cssText = PILL_STYLE;
        const isExp = expanded.has(group.id);
        pill.textContent = pillText(isExp);
        pill.addEventListener("click", () => onToggle(group.id));
        const body = document.createElement("div");
        body.className = "krt_fold_body";
        body.setAttribute(BODY_ATTR, "true");
        body.style.cssText = BODY_STYLE;
        if (isExp) { body.style.display = "block"; body.textContent = group.injectedText; }
        else { body.style.display = "none"; }
        anchor.appendChild(pill);
        anchor.appendChild(body);
        row.parentNode?.insertBefore(anchor, row);
      } else {
        const pill = anchor.querySelector(".krt_fold_pill");
        const body = anchor.querySelector(".krt_fold_body");
        const isExp = expanded.has(group.id);
        if (pill) { pill.style.cssText = PILL_STYLE; pill.textContent = pillText(isExp); }
        if (body) { body.style.cssText = BODY_STYLE;
          if (isExp) { body.style.display = "block"; body.textContent = group.injectedText; }
          else { body.style.display = "none"; }
        }
      }
      return anchor;
    }

    function applyKrouterFold(containers, groups, expanded, onToggle) {
      const hidden = new Set(groups.map((g) => g.id));
      for (const container of containers) {
        // 还原不再需要折叠的行
        for (const row of flowElements(container, `[${FOLD_ATTR}]`)) {
          if (!hidden.has(row.getAttribute("data-chat-flow-key") ?? "")) row.removeAttribute(FOLD_ATTR);
        }
        // 移除已消失组的 anchor；也清孤儿（宿主把行卸载了、或该行已不再折叠 → 只剩一个空胶囊）
        for (const anchor of flowElements(container, `[${ANCHOR_ATTR}]`)) {
          const id = anchor.getAttribute(ANCHOR_ATTR) ?? "";
          const alive = groups.some((g) => g.id === id);
          // 只删「后面什么都没有」的孤儿：锚点永远是插在目标行前面，next 为空说明那行已被宿主卸载。
          // 不要按「下一行没折」来删——那会和 ensureFoldAnchor 的重插形成删/插来回抖动。
          if (!alive || anchor.nextElementSibling == null) anchor.remove();
        }
        for (const g of groups) ensureFoldAnchor(container, g, expanded, onToggle);
      }
    }

    /** 挂载折叠视图：MutationObserver 驱动，debounce 80ms。 */
    function mountKrouterFoldView(root, getLatest) {
      let disposed = false;
      const apply2 = () => {
        if (disposed) return;
        const { groups, expanded, toggle } = getLatest();
        applyKrouterFold(chatFlows(root), groups, expanded, toggle);
      };
      let timer = 0;
      const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(apply2, 80);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      apply2();
      return {
        apply: apply2,
        dispose: () => {
          disposed = true;
          window.clearTimeout(timer);
          observer.disconnect();
          for (const container of chatFlows(root)) {
            for (const anchor of flowElements(container, `[${ANCHOR_ATTR}]`)) anchor.remove();
            for (const row of flowElements(container, `[${FOLD_ATTR}]`)) row.removeAttribute(FOLD_ATTR);
          }
        },
      };
    }

    /** dock 组件：挂在 conversation.composer.dock slot，渲染隐藏 sentinel 驱动折叠。 */
    function KRouterFoldDock(props) {
      const sentinelRef = useRef(null);
      const viewRef = useRef(null);
      const useChat = props?.useChat;
      const chatViaHook = typeof useChat === "function" ? useChat((c) => c) : undefined;
      const legacySession = props?.session;
      const snapshot = chatViaHook !== undefined
        ? { chat: chatViaHook }
        : legacySession && typeof legacySession === "object" && legacySession.chat !== undefined
          ? legacySession
          : undefined;
      const [expanded, setExpanded] = useState(() => new Set());
      const groups = useMemo(() => computeKrouterInjectionGroups(snapshot), [snapshot]);
      const toggle = useCallback((id) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      }, []);
      const state = { groups, expanded, toggle };
      const latest = useRef(state);
      latest.current = state;
      useLayoutEffect(() => {
        const root = resolveFoldRoot(sentinelRef.current, document);
        if (!root) return;
        const view = mountKrouterFoldView(root, () => latest.current);
        viewRef.current = view;
        return () => { viewRef.current = null; view.dispose(); };
      }, []);
      useLayoutEffect(() => { viewRef.current?.apply(); });
      return el("span", { ref: sentinelRef, "data-krouter-fold-dock": "", style: { display: "none" } });
    }

    // ── apply(ctx) ────────────────────────────────────────────────────────────
    // settings.section 注册范式（照搬 meow-memory 2527-2598，两条链解耦）：
    //   ① section 挂载只依赖 slots 服务：slots.inject("settings.section", cb) 的 cb
    //      触发 registerSection()，slot 就绪即挂，不等 configForms。
    //   ② configForms 是独立数据链：configForm.get(ns) 未就绪时 poll 轮询重试
    //      （带 maxPollAttempts 上限），就绪后才 mount 数据；不影响 section 何时出现。
    // 旧实现把 register 绑死在 configForms.whileServed 上——host 不 serve 该 ns（或
    // serve 晚于 client mount 且 whileServed 不补触发）时 register 永不执行 → 菜单消失。
    function apply(ctx) {
      injectCss();
      if (!ctx?.slots) return;
      const disposers = [];
      let disposeEntry = null;
      let mountDisposer = null;
      // inject 回调返回组件 props：configForm 管 entry config 读写，remote 供 modelCatalog 拉模型列表。
      // 这两个都来自模块 inject 声明（configForms/remote/remote.session），cordis 守卫才放行访问。
      const propsInject = () => ({ configForm: ctx.configForms?.get?.(SETTINGS_NS), remote: ctx.remote });
      const registerSection = () => {
        try { disposeEntry?.(); } catch {}
        disposeEntry = null;
        try {
          disposeEntry = ctx.slots.register({
            name: "settings.section", id: SETTINGS_NS, order: 36,
            label: () => t("settings.title"),
            inject: propsInject,
          }, KRouterSettingsSection);
        } catch (e) {
          console.info("[dsh-krouter] settings.section 尚未就绪，跳过本次注册（slot 就绪后由 inject 回调补挂）：", e?.message ?? String(e));
        }
      };
      // ① section 注册：slot 就绪即挂，只依赖 slots。
      disposers.push(ctx.slots.inject("settings.section", () => { registerSection(); }));
      // ② configForms 数据链：独立 poll 重试（照 meow-memory attach/poll 范式）。
      //    configForm 就绪后重挂一次 section，让 props.configForm 从 unavailable 变为可用。
      const configForms = ctx.configForms;
      if (!configForms || typeof configForms.get !== "function") {
        console.info("[dsh-krouter] configForms 服务未就绪（设置页数据不可读写；section 已挂、其余功能不受影响）");
      } else {
        let pollTimer = null;
        let attempts = 0;
        const maxPollAttempts = 50;
        const stopPoll = () => { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } };
        const attach = () => {
          try {
            const cf = configForms.get(SETTINGS_NS);
            if (cf !== undefined && cf !== null) {
              mountDisposer = registerSection(); // configForm 就绪，重挂 section 取到可用数据
              stopPoll();
            }
          } catch (e) {
            console.info("[dsh-krouter] configForms.get 尚未就绪，继续轮询：", e?.message ?? String(e));
          }
        };
        attach();
        if (mountDisposer === null) {
          pollTimer = setInterval(() => {
            attach();
            attempts += 1;
            if (mountDisposer === null && attempts >= maxPollAttempts) {
              stopPoll();
              console.info("[dsh-krouter] configForms 服务超时未就绪（设置页数据不可读写；section 已挂、其余功能不受影响）");
            }
          }, 200);
          disposers.push(() => stopPoll());
        }
      }
      disposers.push(() => {
        try { disposeEntry?.(); } catch {}
      });

      // 前台胶囊折叠 dock：挂在 composer.dock slot，渲染隐藏 sentinel 驱动 DOM 折叠。
      try {
        disposers.push(ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
          { name: "conversation.composer.dock", id: SETTINGS_NS, order: 95 },
          KRouterFoldDock,
        )));
      } catch (e) {
        console.info("[dsh-krouter] composer.dock 尚未就绪，折叠胶囊跳过：", e?.message ?? String(e));
      }

      return () => { for (const d of disposers) { try { d(); } catch {} } };
    }

    // configForms：entry config 读写（settings 面板）；remote.session：modelCatalog 拉模型列表。
    // 注意 remote.session 是子属性，cordis 守卫要求显式声明 "remote.session"（settings-account 同款），
    // 只声明 "remote" 访问 .session 仍会抛 cannot get property "remote.session" without inject。
    const inject = ["slots", "configForms", "remote", "remote.session"];
    return { apply, inject, KRouterSettingsSection, KRouterFoldDock, computeKrouterInjectionGroups, pillText, rowsToHide, resolveFoldRoot, safeEscape, flowRow, injectionRow, PILL_STYLE, BODY_STYLE };
  },
});
