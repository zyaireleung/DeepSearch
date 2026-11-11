// deep-search — client 折叠注入渲染（meow dock 架构版 2026-11-10）
// 根因：context 节点被 isVisibleChatNode 过滤不进 DOM，纯 DOM 扫描永远找不到。
// 修复：照 meow 机制挂 dock → useChat 取快照 → computeInjectionGroups 从 node store 读 context 节点 → 自建 anchor 渲染。

// ── 顶层纯函数（不依赖 React/DOM；node 可测）──
var INJ_MARKERS = ["<tdai_memory_recall", "<inject_recall"];
var INJ_ENDS = ["</tdai_memory_recall>", "</inject_recall>"];
var TIME_ATTR = "data-tdai-time";
var CAPSULE_DEEP_SEP = "\u2500\u2500 DeepSearch \u547D\u4E2D\u4EE5\u4E0B\u5386\u53F2\u8BB0\u5FC6\uFF0C\u4F9B\u53C2\u8003 \u2500\u2500";
var CAPSULE_TITLE_LEGACY = "已\u6CE8\u5165TencentDB\u8BB0\u5FC6\uFF08\u5173\u952E\u8BCD\u547D\u4E2D\uFF09";
var CAPSULE_TITLE_HAR = "已\u6CE8\u5165 Harness \u8BF4\u660E";
var CAPSULE_TITLE_DEEP = "已\u6CE8\u5165 DeepSearch \u8BB0\u5FC6";
var CAPSULE_TITLE_BOTH = "已\u6CE8\u5165 Harness \u548C\u8BB0\u5FC6";
// 无信封时按内容 marker 判标题（meow promptVariantHead 同款思路：认内容头特征，不认信封 tag）
function hasDeepMarker(text) { return String(text || "").indexOf(CAPSULE_DEEP_SEP) !== -1; }
function hasHarnessMarker(text) { return /Harness\s*说明|Harness\s*规则/.test(String(text || "")); }

function capsuleTitle(injectedText, titleOverride) {
  // meta.title 优先（Console harnessAssemble 算好的权威标题，摘信封后 harness 段无 marker 只能靠它）
  if (titleOverride) {
    if (titleOverride === CAPSULE_TITLE_HAR) return CAPSULE_TITLE_HAR;
    if (titleOverride === CAPSULE_TITLE_DEEP) return CAPSULE_TITLE_DEEP;
    if (titleOverride === CAPSULE_TITLE_BOTH) return CAPSULE_TITLE_BOTH;
  }
  var t = String(injectedText || "");
  var hasDeep = hasDeepMarker(t);
  var hasHar = hasHarnessMarker(t);
  // 有信封时沿用原信封 tag 内的 harness 段判定（向后兼容旧格式）
  if (/^<inject_recall/.test(t.trimStart())) {
    var sepAt = t.indexOf(CAPSULE_DEEP_SEP);
    var beginTag = "<inject_recall>";
    var afterTag = t.indexOf(beginTag) === -1 ? "" : t.slice(beginTag.length, sepAt === -1 ? t.length : sepAt);
    afterTag = afterTag.replace(/<\/inject_recall>[\s\S]*$/, "").replace(/\n/g, "").replace(/\s/g, "").trim();
    hasHar = afterTag.length > 0;
    hasDeep = sepAt !== -1;
  }
  if (hasHar && hasDeep) return CAPSULE_TITLE_BOTH;
  if (hasDeep) return CAPSULE_TITLE_DEEP;
  if (hasHar) return CAPSULE_TITLE_HAR;
  return CAPSULE_TITLE_LEGACY;
}

function blocksToText(blocks) { return (blocks || []).map((b) => (b && b.text != null ? b.text : "")).join("\n").trim(); }

// 从 node source.sections 读 __meta__（meow extractMetaFromSections 同款）
function extractMeta(source) {
  if (!source || !Array.isArray(source.sections)) return null;
  for (var i = 0; i < source.sections.length; i++) {
    if (source.sections[i] && source.sections[i].name === "__meta__") {
      try { return JSON.parse(source.sections[i].text || "{}"); } catch (e) { return null; }
    }
  }
  return null;
}

function splitInjection(full) {
  var start = -1, end = -1;
  for (var i = 0; i < INJ_MARKERS.length; i++) {
    var s = full.indexOf(INJ_MARKERS[i]);
    if (s !== -1 && (start === -1 || s < start)) { start = s; end = INJ_ENDS[i]; }
  }
  if (start === -1) return null;
  var endIdx = full.indexOf(end, start);
  if (endIdx === -1) return null;
  var injectedText = full.slice(start, endIdx + end.length);
  var remainder = (full.slice(0, start) + "\n" + full.slice(endIdx + end.length)).replace(/\n{2,}/g, "\n").trim();
  var MEOW_PROMPT_LABEL = "\u672C\u8F6E\u7528\u6237prompt\uFF1A";
  var sep = remainder.lastIndexOf(MEOW_PROMPT_LABEL);
  var userText = sep === -1 ? remainder : remainder.slice(sep + MEOW_PROMPT_LABEL.length).replace(/^\n+/, "").trim();
  return { injectedText: injectedText, userText: userText, meowInjected: sep !== -1 };
}

function stripTrailingClock(text) {
  var t = String(text || "").replace(/\s+$/, "");
  for (;;) {
    var m = /^([\s\S]*?)(?:\n|^)(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) break;
    t = m[1].replace(/\s+$/, "");
  }
  return t;
}

function formatClock(time, now) {
  var d = new Date(time), n = new Date(now === void 0 ? Date.now() : now);
  var pad = function (v) { return String(v).padStart(2, "0"); };
  var clock = pad(d.getHours()) + ":" + pad(d.getMinutes());
  var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return clock;
  var md = d.getFullYear() === n.getFullYear() ? (d.getMonth() + 1) + "\u6708" + d.getDate() + "\u65E5" : d.getFullYear() + "\u5E74" + (d.getMonth() + 1) + "\u6708" + d.getDate() + "\u65E5";
  return md + " " + clock;
}

function resolveClockText(group, now) {
  var t = group && group.timeText;
  if (t) return t;
  if (group && typeof group.time === "number") return formatClock(group.time, now);
  return "";
}

function mergeGroups(snapshotGroups, domGroups) {
  var byId = new Map();
  for (var i = 0; i < domGroups.length; i++) byId.set(domGroups[i].id, domGroups[i]);
  for (var j = 0; j < snapshotGroups.length; j++) byId.set(snapshotGroups[j].id, snapshotGroups[j]);
  var out = [];
  var iter = byId.values();
  for (var g = iter.next(); !g.done; g = iter.next()) {
    var group = g.value;
    if (group && typeof group.userText === "string") group.userText = stripTrailingClock(group.userText);
    out.push(group);
  }
  return out;
}

function planPromptActions(hasPrompt, actionsInPromptCount) {
  if (!hasPrompt) return "none";
  if (actionsInPromptCount >= 1) return "reuse";
  return "create";
}

function safeEscape(value) {
  var s = String(value);
  try {
    if (typeof CSS === "object" && CSS !== null && typeof CSS.escape === "function") return CSS.escape(s);
  } catch (e) {}
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── 浏览器侧（ModuleLoader factory）──
if (typeof window === "undefined" || !window.__ModuleLoader__) {
  if (typeof module !== "undefined") module.exports = { blocksToText, splitInjection, stripTrailingClock, formatClock, mergeGroups, resolveClockText, planPromptActions, safeEscape, capsuleTitle };
} else {
  window.__ModuleLoader__.load({
    id: "deep-search",
    factory: (require) => {
      var module = { exports: {} };
      var React = require("react");

      var FOLDED_ATTR = "data-tdai-folded";
      var ANCHOR_ATTR = "data-tdai-anchor";
      var BODY_ATTR = "data-tdai-body";
      var PROMPT_ATTR = "data-tdai-prompt";
      var ACTIONS_ATTR = "data-tdai-actions";
      var COPY_ATTR = "data-tdai-copy";
      var CSS_TAG = "deep-search-fold-css";

      var COPY_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>';
      var CHECK_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z" fill="currentColor"/></svg>';

      async function copyInjectionText(button, text) {
        var ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          var textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          try { ok = document.execCommand("copy"); } catch { ok = false; }
          document.body.removeChild(textarea);
        }
        if (ok) {
          button.innerHTML = CHECK_ICON_SVG;
          button.dataset.label = "已复制";
          setTimeout(function () {
            button.innerHTML = COPY_ICON_SVG;
            button.dataset.label = "复制";
          }, 1000);
        }
      }

      var FOLD_CSS = [
        "[" + FOLDED_ATTR + '="true"] { display: none !important; }',
        "[" + BODY_ATTR + "] { display: none; margin: 2px 0 8px; padding: 8px 10px; font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9)); background: rgba(127,127,127,.05); border: 1px solid rgba(127,127,127,.12); border-radius: 8px; font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace; }",
        "[" + PROMPT_ATTR + "] { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }",
        "[" + PROMPT_ATTR + "] > [data-tdai-bubble] { max-width: min(525px, 82%); padding: 10px 16px; border-radius: 22px; background: var(--dsw-specific-bubble); color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; white-space: pre-wrap; word-break: break-word; }",
        "[" + ANCHOR_ATTR + "] > button { display: block; margin: 4px 0 4px auto; max-width: 82%; padding: 5px 12px; font-size: 12px; line-height: 1.6; text-align: left; cursor: pointer; color: var(--dsw-text-secondary, rgba(127,127,127,.9)); background: rgba(127,127,127,.07); border: 1px solid rgba(127,127,127,.14); border-radius: 999px; }",
        "[" + ACTIONS_ATTR + "] { display: flex; align-items: center; gap: 10px; height: 28px; background: transparent; }",
        "[" + TIME_ATTR + "] { padding-right: 12px; font-size: 14px; line-height: 24px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.6)); white-space: nowrap; background: transparent; }",
        "@media (hover: hover) { [" + TIME_ATTR + "] { opacity: 0; transition: opacity 80ms ease; } [" + PROMPT_ATTR + "]:hover [" + TIME_ATTR + "], [" + PROMPT_ATTR + "]:focus-within [" + TIME_ATTR + "] { opacity: 1; } }",
        "[" + COPY_ATTR + "] { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; border: none; border-radius: 28px; background: transparent; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.6)); cursor: pointer; }",
        "[" + COPY_ATTR + "]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); color: var(--dsw-alias-label-secondary, rgba(190,190,190,.9)); }",
        "[" + COPY_ATTR + "] { position: relative; }",
        "[" + COPY_ATTR + "]::after { content: attr(data-label); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); padding: 3px 7px; border-radius: 8px; background: var(--dsw-alias-tooltip-bg, rgba(30,30,30,.95)); color: var(--dsw-static-neutral-bluish-00, #fff); font-size: 13px; line-height: 20px; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 80ms ease; z-index: 100; }",
        "[" + COPY_ATTR + "]:hover::after { opacity: 1; }"
      ].join("\n");

      // ── source 识别 ──
      var DS_SOURCE_KIND = "deep-search";
      var DS_PLUGIN_NAME = "deep-search";
      function isDeepSearchSource(source) {
        if (source === null || typeof source !== "object") return false;
        return source.kind === DS_SOURCE_KIND ||
               (source.kind === "plugin" && source.plugin === DS_PLUGIN_NAME);
      }

      // ── node store 遍历 ──
      function chatKeyOrder(snapshot) {
        var chat = snapshot && snapshot.chat;
        if (!chat) return [];
        var keys = [];
        var seen = new Set();
        if (Array.isArray(chat.order)) {
          for (var i = 0; i < chat.order.length; i++) {
            if (!seen.has(chat.order[i])) { seen.add(chat.order[i]); keys.push(chat.order[i]); }
          }
        }
        var store = chat.nodes;
        if (store && typeof store.values === "function") {
          var extra = store.values();
          for (var it = extra.next ? extra.next() : { done: true, value: undefined }; !it.done; it = extra.next()) {
            var node = it.value;
            var k = node && node.key;
            if (k !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); }
          }
        }
        return keys;
      }

      function contextText(node) {
        return blocksToText(node.data && node.data.content || []);
      }

      // ── computeInjectionGroups（meow 双路径：context + user）──
      function computeInjectionGroups(snapshot) {
        var groups = [];
        if (!snapshot || !snapshot.chat) return groups;
        var chat = snapshot.chat;
        if (!chat.nodes || typeof chat.nodes.get !== "function") {
          return groups;
        }
        var keys = chatKeyOrder(snapshot);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var node = chat.nodes.get(key);
          if (!node) continue;

          // Path 1: context 节点（deep-search snapshot 注入的主路径）
          if (node.kind === "context") {
            var source = node.data && node.data.source;
            if (!isDeepSearchSource(source)) continue;
            if (source.form !== "snapshot") continue;
            var meta1 = extractMeta(source);
            var title1 = meta1 && meta1.title ? meta1.title : void 0;
            var injText = contextText(node);
            var sp = splitInjection(injText);
            if (sp) {
              groups.push({ id: key, key: key, injectedText: sp.injectedText, userText: sp.userText, meowInjected: sp.meowInjected, time: node.data.time, title: title1 });
            } else {
              // 整块当 injectedText（无信封时）
              groups.push({ id: key, key: key, injectedText: injText, userText: "", meowInjected: false, time: node.data.time, title: title1 });
            }
            continue;
          }

          // Path 2: user 节点（meow 同款：deep-search 的胶囊走 user-kind splice，靠 source.plugin 识别）
          if (node.kind === "user") {
            var data = node.data;
            var source2 = data && data.source;
            // 只折 deep-search 注入的 user-kind 节点；真用户气泡（无 plugin:deep-search）不折
            if (!source2 || source2.plugin !== "deep-search") continue;
            var meta2 = extractMeta(source2);
            var title2 = meta2 && meta2.title ? meta2.title : void 0;
            var content = data && data.content;
            if (!Array.isArray(content) || content.length === 0) continue;
            if (!content.some(function(b) { return b && b.type === "text"; })) continue;
            var used = [];
            for (var j = 0; j < content.length; j++) {
              if (content[j] && content[j].type === "text") used.push(content[j].text || "");
            }
            var full = used.join("\n").trim();  // used 已是字符串数组，直接 join
            var sp2 = splitInjection(full);
            // 摘信封后：整块当 injectedText（无信封不丢组）
            var injText2 = sp2 ? sp2.injectedText : full;
            var userText2 = sp2 ? sp2.userText : "";
            var time = (data && typeof data.time === "number") ? data.time : void 0;
            var loc2 = node.location;
            var turn2 = (loc2 && loc2.turn && typeof loc2.turn.turn === "number") ? loc2.turn.turn : void 0;
            groups.push({ id: key, key: key, injectedText: injText2, userText: userText2, meowInjected: sp2 ? sp2.meowInjected : false, time: time, title: title2, turn: turn2 });
          }
        }
        return groups;
      }

      function flowRow(container, key) {
        try {
          return container.querySelector('[data-chat-flow-key="' + safeEscape(key) + '"]');
        } catch {
          return null;
        }
      }

      function collectDomGroups(container) {
        var groups = [];
        var rows = container.querySelectorAll("[data-chat-flow-key]");
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (row.querySelector("[" + ANCHOR_ATTR + "]")) continue;
          var key = row.getAttribute("data-chat-flow-key") || "";
          if (!/:input-message/.test(key) && !/^user-/.test(key)) continue;
          var txt = row.textContent || "";
          var clockMatch = /(\d{1,2}):(\d{2})$/.exec(txt.replace(/\s+$/, ""));
          var sp = splitInjection(txt);
          if (sp === null) continue;
          sp.userText = stripTrailingClock(sp.userText);
          groups.push({
            id: key, key: key,
            injectedText: sp.injectedText, userText: sp.userText,
            meowInjected: sp.meowInjected,
            timeText: clockMatch ? clockMatch[0] : void 0,
          });
        }
        return groups;
      }

      function foldOne(container, group, expanded, onToggle) {
        var startRow = flowRow(container, group.key);
        // turn fallback：flow-key 行找不到时，按 data-chat-turn 定位轮次行挂 anchor（meow foldAnchorRow 同款兜底）
        if (startRow === null && typeof group.turn === "number") {
          try {
            var turnRows = container.querySelectorAll('[data-chat-turn="' + group.turn + '"]');
            if (turnRows.length > 0) startRow = turnRows[0];
          } catch (e) {}
        }
        if (startRow === null || startRow.parentElement === null) return;
        var anchor = container.querySelector('[' + ANCHOR_ATTR + '="' + safeEscape(group.id) + '"]');
        if (anchor === null) {
          anchor = document.createElement("div");
          anchor.setAttribute(ANCHOR_ATTR, group.id);
          startRow.parentElement.insertBefore(anchor, startRow);
        }
        // 只折 flow-key 行本身；turn fallback 挂的轮次行不折（meow ensureAnchor 从不设 FOLDED）
        if (flowRow(container, group.key) === startRow) startRow.setAttribute(FOLDED_ATTR, "true");

        var meowAnchorForRow = container.querySelector('[data-meow-injection-anchor="' + safeEscape(group.id) + '"]');
        if (meowAnchorForRow !== null && meowAnchorForRow.parentElement === anchor.parentElement && meowAnchorForRow.previousElementSibling !== anchor) {
          meowAnchorForRow.parentElement.insertBefore(anchor, meowAnchorForRow);
        }

        var bar = anchor.querySelector(":scope > button");
        if (bar === null) {
          bar = document.createElement("button");
          bar.type = "button";
          bar.style.cssText = "display:block;margin:4px 0 4px auto;max-width:82%;padding:5px 12px;font-size:12px;line-height:1.6;text-align:left;cursor:pointer;color:var(--dsw-text-secondary,rgba(127,127,127,.9));background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.14);border-radius:999px;";
          anchor.appendChild(bar);
        }
        bar.onclick = () => onToggle(group.id);
        var isExpanded = expanded.has(group.id);
        var label = (isExpanded ? "\u25BE " : "\u25B8 ") + capsuleTitle(group.injectedText, group.title);
        if (bar.textContent !== label) bar.textContent = label;

        var body = anchor.querySelector(":scope > [" + BODY_ATTR + "]");
        if (body === null) {
          body = document.createElement("div");
          body.setAttribute(BODY_ATTR, "true");
          anchor.appendChild(body);
        }
        if (isExpanded) {
          if (body.textContent !== group.injectedText) body.textContent = group.injectedText;
          body.style.display = "block";
        } else {
          body.style.display = "none";
        }

        var meowOwnsPrompt = group.meowInjected === true &&
          container.querySelector('[data-meow-injection-anchor="' + safeEscape(group.id) + '"]') !== null;
        var independentInjection = group.userText === "";
        var prompt = anchor.querySelector(":scope > [" + PROMPT_ATTR + "]");
        if (meowOwnsPrompt || independentInjection) {
          if (prompt !== null) prompt.style.display = "none";
        } else {
          if (prompt === null) {
            prompt = document.createElement("div");
            prompt.setAttribute(PROMPT_ATTR, "true");
            var bubble = document.createElement("div");
            bubble.setAttribute("data-tdai-bubble", "true");
            prompt.appendChild(bubble);
            anchor.appendChild(prompt);
          }
          if (prompt.style.display === "none") prompt.style.display = "";
          var bubbleEl = prompt.querySelector(":scope > [data-tdai-bubble]");
          if (bubbleEl && bubbleEl.textContent !== group.userText) bubbleEl.textContent = group.userText;
        }

        var actionsPlan = planPromptActions(prompt !== null, prompt === null ? 0 : prompt.querySelectorAll(":scope > [" + ACTIONS_ATTR + "]").length);
        if (actionsPlan === "create") {
          var actionsEl = document.createElement("div");
          actionsEl.setAttribute(ACTIONS_ATTR, "true");
          var timeEl = document.createElement("span");
          timeEl.setAttribute(TIME_ATTR, "true");
          actionsEl.appendChild(timeEl);
          var copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.setAttribute(COPY_ATTR, "true");
          copyBtn.dataset.label = "复制";
          copyBtn.innerHTML = COPY_ICON_SVG;
          copyBtn.addEventListener("click", () => { if (group.userText !== void 0) void copyInjectionText(copyBtn, group.userText); });
          actionsEl.appendChild(copyBtn);
          prompt.appendChild(actionsEl);
        } else if (actionsPlan === "reuse" && prompt !== null) {
          var actionsList = prompt.querySelectorAll(":scope > [" + ACTIONS_ATTR + "]");
          for (var ai = 1; ai < actionsList.length; ai++) actionsList[ai].remove();
        }

        var actionsEl2 = prompt === null ? null : prompt.querySelector(":scope > [" + ACTIONS_ATTR + "]");
        var timeEl2 = actionsEl2 === null ? null : actionsEl2.querySelector(":scope > [" + TIME_ATTR + "]");
        var clockText = resolveClockText(group);
        if (timeEl2 !== null) {
          if (timeEl2.textContent !== clockText) timeEl2.textContent = clockText;
          timeEl2.style.display = clockText ? "" : "none";
        }
        var legacyTime = anchor.querySelector(":scope > [" + TIME_ATTR + "]");
        if (legacyTime !== null && legacyTime !== timeEl2) legacyTime.remove();
      }

      function injectStyles() {
        var tagId = CSS_TAG;
        for (var stale of Array.from(document.querySelectorAll("style[data-" + tagId + "]"))) stale.remove();
        if (typeof styles !== "undefined" && typeof styles.insert === "function") {
          styles.insert(FOLD_CSS);
        } else {
          var el = document.createElement("style");
          el.setAttribute("data-" + tagId, "true");
          el.textContent = FOLD_CSS;
          document.head.appendChild(el);
        }
      }

      // ── DeepSearchFoldDock 组件（照 meow MemoryFoldDock）──
      function DeepSearchFoldDock(props) {
        var sentinelRef = React.useRef(null);
        var viewRef = React.useRef(null);
        var expandedRef = React.useRef(new Set());
        var stateRef = React.useRef({});
        var chatIdentity = function(chat) { return chat; };
        var useChat = props && props.useChat;
        var chatViaHook = typeof useChat === "function" ? useChat(chatIdentity) : void 0;
        var snapshot = chatViaHook !== void 0 ? { chat: chatViaHook } : void 0;

        var toggle = React.useCallback(function(id) {
          if (expandedRef.current.has(id)) expandedRef.current.delete(id);
          else expandedRef.current.add(id);
          if (viewRef.current) viewRef.current.apply();
        }, []);

        stateRef.current = { snapshot: snapshot, expanded: expandedRef.current, toggle: toggle };

        React.useLayoutEffect(function() {
          var el = sentinelRef.current;
          if (!el) return;
          var root = el.closest("[data-conversation-scroll]") || document.querySelector("[data-conversation-scroll]") || document.body;
          var view = mountDeepSearchFoldView(root, function() { return stateRef.current; });
          viewRef.current = view;
          return function() {
            viewRef.current = null;
            view.dispose();
          };
        }, []);

        React.useLayoutEffect(function() {
          if (viewRef.current) viewRef.current.apply();
        });

        return React.createElement("span", { ref: sentinelRef, "data-deep-search-dock": "", style: { display: "none" } });
      }

      // ── mountDeepSearchFoldView（照 meow mountMemoryFoldView）──
      function mountDeepSearchFoldView(root, read) {
        var disposed = false;
        var timer = 0;

        function applyFold() {
          if (disposed) return;
          var state = read();
          var groups = computeInjectionGroups(state.snapshot);
          var expanded = state.expanded;
          var toggle = state.toggle;

          var containers = Array.from(root.querySelectorAll("[data-chat-flow]") || []);
          if (root.matches && root.matches("[data-chat-flow]")) containers.push(root);
          if (containers.length === 0) return;

          var liveKeys = new Set(groups.map(function(g) { return g.key || g.id; }));

          for (var c = 0; c < containers.length; c++) {
            var container = containers[c];

            // 移除 stale anchors
            var staleAnchors = container.querySelectorAll("[" + ANCHOR_ATTR + "]");
            for (var s = 0; s < staleAnchors.length; s++) {
              var aid = staleAnchors[s].getAttribute(ANCHOR_ATTR);
              if (!liveKeys.has(aid)) staleAnchors[s].remove();
            }

            // 解除不在 liveKeys 的折叠行
            var foldedRows = container.querySelectorAll("[" + FOLDED_ATTR + '="true"]');
            for (var f = 0; f < foldedRows.length; f++) {
              var fkey = foldedRows[f].getAttribute("data-chat-flow-key") || "";
              if (!liveKeys.has(fkey)) foldedRows[f].removeAttribute(FOLDED_ATTR);
            }

            // 折叠每个 group
            for (var g = 0; g < groups.length; g++) {
              foldOne(container, groups[g], expanded, toggle);
            }
          }
        }

        var observer = new MutationObserver(function() {
          window.clearTimeout(timer);
          timer = window.setTimeout(applyFold, 80);
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        applyFold();

        return {
          apply: applyFold,
          dispose: function() {
            disposed = true;
            window.clearTimeout(timer);
            observer.disconnect();
            var containers = Array.from(root.querySelectorAll("[data-chat-flow]") || []);
            if (root.matches && root.matches("[data-chat-flow]")) containers.push(root);
            for (var c = 0; c < containers.length; c++) {
              var anchors = containers[c].querySelectorAll("[" + ANCHOR_ATTR + "]");
              for (var a = 0; a < anchors.length; a++) anchors[a].remove();
              var folded = containers[c].querySelectorAll("[" + FOLDED_ATTR + '="true"]');
              for (var fd = 0; fd < folded.length; fd++) folded[fd].removeAttribute(FOLDED_ATTR);
            }
          }
        };
      }

      // ── apply(ctx)：挂 dock + 降级 fallback ──
      function apply(ctx) {
        var disposers = [];
        injectStyles();

        var slots = ctx && ctx.slots;
        if (slots && typeof slots.inject === "function") {
          // 主路径：挂 dock 到 conversation.composer.dock
          disposers.push(slots.inject("conversation.composer.dock", function() {
            return slots.register(
              { name: "conversation.composer.dock", id: "deep-search", order: 91 },
              DeepSearchFoldDock
            );
          }));
        } else {
          // 降级：纯 DOM 扫描（找不到 context 节点，但至少不崩）
          var expanded = new Set();
          function toggle(id) {
            if (expanded.has(id)) expanded.delete(id);
            else expanded.add(id);
            applyFallbackFold();
          }
          function applyFallbackFold() {
            var containers = Array.from(document.querySelectorAll("[data-chat-flow]"));
            for (var c = 0; c < containers.length; c++) {
              var container = containers[c];
              var merged = mergeGroups([], collectDomGroups(container));
              for (var g = 0; g < merged.length; g++) foldOne(container, merged[g], expanded, toggle);
            }
          }
          applyFallbackFold();
          var timer = 0;
          var observer = new MutationObserver(function() {
            window.clearTimeout(timer);
            timer = window.setTimeout(applyFallbackFold, 80);
          });
          observer.observe(document.body, { childList: true, subtree: true });
          disposers.push(function() {
            window.clearTimeout(timer);
            observer.disconnect();
          });
        }

        if (typeof ctx.on === "function") {
          disposers.push(ctx.on("dispose", function() {
            for (var d of disposers) { try { d(); } catch(e) {} }
          }));
        }

        return function() {
          for (var d of disposers) { try { d(); } catch(e) {} }
        };
      }

      var inject = ["slots"];

      // 导出内部函数供测试
      module.exports = {
        name: "deep-search",
        inject: inject,
        apply: apply,
        _internals: { isDeepSearchSource, chatKeyOrder, contextText, computeInjectionGroups, DeepSearchFoldDock, mountDeepSearchFoldView, foldOne }
      };
      return module.exports;
    }
  });
}
