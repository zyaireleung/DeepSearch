// plugin-service-manager — client side (right sidebar tab)
// Registers a RIGHT-sidebar tab (sibling of Files/Terminal/Browser) via the
// official two-stage mechanism, modeled on dsh-client-ui-sidebar-browser.
//   Stage 1: ctx.sidebarRightTabs.register(definition)  — tab type + guide entry
//   command: ctx.shortcuts.register({ id: commandId, resolve }) — opens the tab
//   Stage 2: ctx.slots.inject("sidebar.right.pane.tab", ...) — tab body (keyed)
// UI ported from the original plugin-service-manager (better-sidebar based),
// now rendered inside the official right-sidebar tab body.
window.__ModuleLoader__.load({
  id: "plugin-service-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var React = react;

    var PLUGIN_ID = "plugin-service-manager";
    var TAB_KIND = "serviceManager";
    var COMMAND_ID = "serviceManager.open";
    var NAMESPACE = "serviceManager";

    var inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs", "shortcuts"];

    function label() { return "插件启动管理"; }

    // Gear icon (ported from original plugin) for the guide entry card.
    function GearIcon(props) {
      var size = (props && props.size) || 16;
      return React.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", { d: "M14.0861 5.51366C13.8717 5.0575 13.588 4.58542 13.2889 4.18108C13.208 4.07172 13.1596 4.04373 13.0243 4.03054C12.4277 3.97255 11.8245 4.05527 11.2269 3.9972C10.7224 3.94816 10.3133 3.71661 10.0115 3.30919C9.66986 2.84777 9.43973 2.31343 9.09824 1.85234C9.01771 1.74365 8.96805 1.71589 8.83354 1.70282C8.29432 1.65044 7.70402 1.65061 7.16656 1.70282C7.03205 1.71589 6.98239 1.74365 6.90186 1.85234C6.56067 2.31303 6.33025 2.84774 5.98855 3.30919C5.68681 3.71661 5.27774 3.94816 4.77317 3.9972C4.17564 4.05527 3.57239 3.97255 2.97585 4.03054C2.84046 4.04373 2.79208 4.07172 2.71115 4.18108C2.41212 4.58542 2.12835 5.0575 1.91403 5.51366C1.85299 5.64359 1.85286 5.7018 1.91403 5.8319C2.14865 6.33077 2.49748 6.76892 2.73237 7.26854C2.9594 7.7515 2.96041 8.24717 2.73338 8.73044C2.49837 9.23061 2.14891 9.66837 1.91403 10.1681C1.85291 10.2982 1.85299 10.3564 1.91403 10.4863C2.12856 10.9429 2.41185 11.4142 2.71115 11.8189C2.79208 11.9283 2.84046 11.9563 2.97585 11.9694C3.57239 12.0274 4.17564 11.9447 4.77317 12.0028C5.27774 12.0518 5.68681 12.2834 5.98855 12.6908C6.33024 13.1522 6.56037 13.6866 6.90186 14.1476C6.98239 14.2563 7.03205 14.2841 7.16656 14.2972C7.70402 14.3494 8.29432 14.3495 8.83354 14.2972C8.96805 14.2841 9.01771 14.2563 9.09824 14.1476C9.43944 13.687 9.66985 13.1522 10.0115 12.6908C10.3133 12.2834 10.7224 12.0518 11.2269 12.0028C11.8244 11.9447 12.4271 12.0275 13.0243 11.9694C13.1596 11.9563 13.208 11.9283 13.2889 11.8189C13.5891 11.4131 13.872 10.942 14.0861 10.4863C14.1471 10.3564 14.1472 10.2982 14.0861 10.1681C13.8513 9.66861 13.5017 9.23061 13.2667 8.73044C13.0397 8.24717 13.0407 7.7515 13.2677 7.26854C13.5026 6.7689 13.8513 6.33106 14.0861 5.8319C14.1472 5.7018 14.1471 5.64359 14.0861 5.51366ZM15.3035 6.40373C15.0685 6.90359 14.7188 7.34119 14.4841 7.84037C14.4231 7.97025 14.423 8.02855 14.4841 8.15861C14.7189 8.65833 15.0685 9.09611 15.3035 9.59626C15.5308 10.0801 15.5308 10.5744 15.3035 11.0582C15.052 11.5933 14.4841 11.9184 14.4841 12.1596C14.4841 12.4009 14.7188 12.4157 15.0685 12.1596C15.4183 11.9035 15.3035 11.4161 15.0685 10.9288C14.8337 10.4414 14.4841 10.197 14.1343 10.4414C13.7846 10.6859 13.7846 11.1749 14.1343 11.6614C14.4841 12.1479 14.7188 12.1479 15.0685 11.9035C15.4183 11.659 15.3035 11.1726 15.0685 10.6852C14.8337 10.1977 14.4841 10.1977 14.1343 10.4422ZM9.13764 7.99999C9.13764 7.3715 8.62855 6.8624 8.00005 6.8624C7.37155 6.8624 6.86246 7.3715 6.86246 7.99999C6.86246 8.62849 7.37155 9.13759 8.00005 9.13759C8.62855 9.13759 9.13764 8.62849 9.13764 7.99999ZM10.4834 7.99999C10.4834 9.37126 9.37132 10.4833 8.00005 10.4833C6.62878 10.4833 5.51674 9.37126 5.51674 7.99999C5.51674 6.62873 6.62878 5.51669 8.00005 5.51669C9.37132 5.51669 10.4834 6.62873 10.4834 7.99999Z" }));
    }

    //#region ported UI (from original plugin-service-manager client.js)
    var GROUPS = [
      { id: "deepsearch", name: "DeepSearch", desc: "DeepSearch 控制台", serviceIds: ["deepsearch-console"], autoStart: true },
      { id: "mem0", name: "Mem0 服务", desc: "检索常驻 canonical 6610", serviceIds: ["mem0-search-6610"], autoStart: true },
      { id: "mem0-db", name: "Mem0 DB", desc: "记忆库只读浏览（新库 6620）", serviceIds: ["mem0-browse"] },
      { id: "embedding", name: "Embedding", desc: "embedding 上游（WeMM 108:8810）", serviceIds: ["wemm-embed"] },
      { id: "newapi", name: "New API", desc: "new-api LLM 网关", serviceIds: ["newapi"] },
      { id: "openviking", name: "OpenViking", desc: "生产记忆库 + 常驻轮询", serviceIds: ["openviking", "dsh-session-ingest"], autoStart: true },
      { id: "n8n", name: "n8n", desc: "工作流自动化", serviceIds: ["n8n-server"], autoStart: true },
      { id: "websearch", name: "Web Search", desc: "deep-search 执行器：Wigolo 直连/代理 + MediaCrawler", serviceIds: ["wigolo-direct", "wigolo-restricted", "mediacrawler"], autoStart: true },
    ];

    var ROW = { display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", borderBottom: "1px solid rgba(127,127,127,.12)", fontSize: "13px" };
    var DOT = { width: "10px", height: "10px", borderRadius: "50%", display: "inline-block", flex: "none" };
    var BTN = { background: "rgba(127,127,127,.1)", border: "1px solid rgba(127,127,127,.2)", color: "inherit", borderRadius: "6px", padding: "4px 12px", fontSize: "12px", cursor: "pointer", marginLeft: "6px" };
    var BTN_PRIMARY = Object.assign({}, BTN, { background: "#4f8cff", borderColor: "#4f8cff", color: "#fff" });
    var HDR = { display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", fontWeight: "600", fontSize: "14px" };
    var GROUP_HDR = { display: "flex", alignItems: "center", gap: "8px", padding: "10px 12px 6px", fontSize: "13px", fontWeight: "600" };
    var DIM = { color: "rgba(127,127,127,.8)", fontSize: "12px" };
    var NOTE = { color: "rgba(127,127,127,.7)", fontSize: "11px", padding: "8px 12px" };
    var EMPTY = { color: "rgba(127,127,127,.5)", fontSize: "12px", padding: "8px 12px" };

    function ServiceRow(props) {
      var svc = props.svc;
      var dotColor = svc.running ? "#3fb950" : "#f85149";
      return React.createElement("div", { style: ROW },
        React.createElement("span", { style: Object.assign({}, DOT, { background: dotColor }) }),
        React.createElement("span", { style: { width: "120px", flex: "none" } }, svc.name),
        React.createElement("span", { style: DIM }, ":" + svc.port),
        React.createElement("span", { style: { flex: "1", color: "rgba(127,127,127,.6)", fontSize: "11px" } }, svc.desc));
    }

    function AutoStartSwitch(props) {
      var enabled = props.enabled, onToggle = props.onToggle;
      var SW = { position: "relative", width: "28px", height: "16px", borderRadius: "8px", border: "none", cursor: "pointer", background: enabled ? "#3fb950" : "rgba(127,127,127,.35)", transition: "background .15s", flex: "none", padding: "0" };
      var KNOB = { position: "absolute", top: "2px", left: enabled ? "14px" : "2px", width: "12px", height: "12px", borderRadius: "50%", background: "#fff", transition: "left .15s" };
      return React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "5px", marginLeft: "2px" } },
        React.createElement("button", { style: SW, title: enabled ? "随 dsh 启动自动拉起一次（已开启）" : "随 dsh 启动自动拉起一次（已关闭）", onClick: onToggle },
          React.createElement("span", { style: KNOB })),
        React.createElement("span", { style: { fontSize: "11px", color: "rgba(127,127,127,.7)" } }, "自启动"));
    }

    function apiGet(path) {
      return fetch(path, { method: "GET", headers: { accept: "application/json" } })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)));
    }
    function apiPost(path, body) {
      return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)));
    }

    var REFRESH_WINDOW = [2000, 5000, 10000, 20000, 40000];

    function ServiceManager() {
      var s = React.useState({ services: [], autostart: {}, loading: true, msg: "" });
      var state = s[0], setState = s[1];
      var busyState = React.useState(null);
      var busyGroup = busyState[0], setBusyGroup = busyState[1];
      var timersRef = React.useRef([]);

      var refresh = React.useCallback(function (quiet) {
        if (!quiet) setState(function (p) { return Object.assign({}, p, { loading: true }); });
        apiGet("/tdai-svc/status").then(function (r) {
          setState({ services: (r && r.services) || [], autostart: (r && r.autostart) || {}, loading: false, msg: "" });
        }).catch(function (e) { setState(function (p) { return Object.assign({}, p, { loading: false, msg: "读取失败: " + e.message }); }); });
      }, []);

      var clearWindow = React.useCallback(function () {
        (timersRef.current || []).forEach(function (t) { clearTimeout(t); });
        timersRef.current = [];
      }, []);

      var scheduleWindow = React.useCallback(function () {
        clearWindow();
        REFRESH_WINDOW.forEach(function (ms) { timersRef.current.push(setTimeout(function () { refresh(true); }, ms)); });
      }, [refresh, clearWindow]);

      React.useEffect(function () {
        clearWindow();
        refresh(true);
        return clearWindow;
      }, [refresh, clearWindow]);

      var pollUntilRunning = React.useCallback(function (groupId) {
        var deadline = Date.now() + 150000;
        var tick = function () {
          apiGet("/tdai-svc/status").then(function (r) {
            var svcs = (r && r.services) || [];
            var autostart = (r && r.autostart) || {};
            var grp = null;
            for (var i = 0; i < GROUPS.length; i++) { if (GROUPS[i].id === groupId) { grp = GROUPS[i]; break; } }
            var mine = grp ? svcs.filter(function (sv) { return grp.serviceIds.indexOf(sv.id) !== -1; }) : [];
            var allUp = mine.length > 0 && mine.every(function (sv) { return sv.running; });
            setState({ services: svcs, autostart: autostart, loading: false, msg: allUp ? (groupId + " 已全部运行") : (groupId + " 启动中…（持续检测）") });
            if (allUp) { setBusyGroup(null); return; }
            if (Date.now() > deadline) { setBusyGroup(null); setState(function (p) { return Object.assign({}, p, { msg: groupId + " 启动超时（150s），请手动刷新确认" }); }); return; }
            timersRef.current.push(setTimeout(tick, 3000));
          }).catch(function () {
            if (Date.now() > deadline) { setBusyGroup(null); return; }
            timersRef.current.push(setTimeout(tick, 3000));
          });
        };
        tick();
      }, [setBusyGroup]);

      var control = React.useCallback(function (groupId, action) {
        setBusyGroup(groupId);
        setState(function (p) { return Object.assign({}, p, { msg: action + " " + groupId + " …" }); });
        apiPost("/tdai-svc/control", { action: action, groupId: groupId }).then(function (r) {
          if (r && r.ok) {
            setState(function (p) { return Object.assign({}, p, { loading: false, msg: action + " 已下发（" + groupId + "），持续检测直到拉起…" }); });
            if (action === "stop") { scheduleWindow(); setBusyGroup(null); }
            else { pollUntilRunning(groupId); }
          } else {
            setState(function (p) { return Object.assign({}, p, { loading: false, msg: "操作失败: " + (r && r.error) }); });
            setBusyGroup(null);
          }
        }).catch(function (e) { setState(function (p) { return Object.assign({}, p, { loading: false, msg: "操作失败: " + e.message }); }); })
          .finally(function () { if (action === "stop") setBusyGroup(null); });
      }, [setBusyGroup, scheduleWindow, pollUntilRunning]);

      var toggleAutostart = React.useCallback(function (groupId, enabled) {
        var next = !enabled;
        setState(function (p) { return Object.assign({}, p, { autostart: Object.assign({}, p.autostart || {}, (function () { var o = {}; o[groupId] = next; return o; })()) }); });
        apiPost("/tdai-svc/autostart", { groupId: groupId, enabled: next }).then(function (r) {
          if (r && r.ok) {
            setState(function (p) { return Object.assign({}, p, { autostart: (r.autostart) || p.autostart, msg: "自启动已" + (next ? "开启" : "关闭") + "（" + groupId + "）" }); });
          } else {
            setState(function (p) { return Object.assign({}, p, { autostart: Object.assign({}, p.autostart || {}, (function () { var o = {}; o[groupId] = enabled; return o; })()), msg: "自启动设置失败: " + (r && r.error) }); });
          }
        }).catch(function (e) { setState(function (p) { return Object.assign({}, p, { autostart: Object.assign({}, p.autostart || {}, (function () { var o = {}; o[groupId] = enabled; return o; })()), msg: "自启动设置失败: " + e.message }); }); });
      }, []);

      var groups = GROUPS.map(function (g) {
        var svcs = (state.services || []).filter(function (sv) { return g.serviceIds.indexOf(sv.id) !== -1; });
        var running = svcs.filter(function (sv) { return sv.running; }).length;
        return Object.assign({}, g, { svcs: svcs, running: running });
      });

      return React.createElement("div", { style: { padding: "8px 0", fontFamily: "inherit" } },
        React.createElement("div", { style: HDR },
          React.createElement("span", null, "⚙ 插件启动管理"),
          React.createElement("span", { style: DIM }, "按工具/插件分组管理"),
          React.createElement("button", { style: BTN, onClick: function () { refresh(false); } }, "刷新")),
        React.createElement("div", { style: { maxHeight: "calc(100vh - 200px)", overflowY: "auto" } },
          groups.map(function (g) {
            var as = !!(state.autostart || {})[g.id];
            return React.createElement("div", { key: g.id, style: { borderTop: "1px solid rgba(127,127,127,.1)" } },
              React.createElement("div", { style: GROUP_HDR },
                React.createElement("span", null, g.name),
                g.autoStart ? React.createElement(AutoStartSwitch, { key: "as", enabled: as, onToggle: function () { toggleAutostart(g.id, as); } }) : null,
                React.createElement("span", { style: { flex: "1" } }),
                React.createElement("span", { style: DIM }, g.running + "/" + g.svcs.length + " 运行中"),
                React.createElement("button", { style: BTN_PRIMARY, disabled: busyGroup === g.id, onClick: function () { control(g.id, "start"); } },
                  busyGroup === g.id ? "操作中…" : "启动"),
                React.createElement("button", { style: BTN, disabled: busyGroup === g.id, onClick: function () { control(g.id, "stop"); } }, "停止"),
                React.createElement("button", { style: BTN, disabled: busyGroup === g.id, onClick: function () { control(g.id, "restart"); } }, "重启")),
              g.svcs.length
                ? g.svcs.map(function (sv) { return React.createElement(ServiceRow, { key: sv.id, svc: sv }); })
                : React.createElement("div", { style: EMPTY }, "暂无服务状态（host 未返回该组服务）"));
          })),
        React.createElement("div", { style: NOTE },
          state.msg || (state.loading ? "读取状态中…" : "提示：服务组头「自启动」开关控制随 dsh 启动自动拉起一次。操作后会自动刷新状态一小段时间。")));
    }
    //#endregion

    function apply(ctx) {
      // Stage 1 — register the tab type (adds the guide entry card).
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: PLUGIN_ID,
          kind: TAB_KIND,
          priority: "extension",
          title: label,
          guide: [{
            id: "open",
            commandId: COMMAND_ID,
            order: 10,
            title: label,
            description: function () { return "管理本地服务分组"; },
            icon: GearIcon
          }]
        });
      }, "psm: type");

      // Command — invoked when the guide entry card is clicked; opens the tab.
      ctx.inject(["shortcuts"], function (scope) {
        scope.effect(function () {
          return scope.shortcuts.register({
            id: COMMAND_ID,
            label: label,
            resolve: function (_a) {
              var element = _a.target;
              var target = ctx.sidebarRight.commandTarget(element);
              if (target === void 0) return { status: "blocked", reason: "no active session" };
              return {
                status: "handled",
                run: function () { ctx.sidebarRight.openTabFromTarget(TAB_KIND, target); }
              };
            }
          });
        }, "psm: command");
      });

      // Stage 2 — register the tab body under the same id (keyed dispatch).
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: PLUGIN_ID,
            locale: NAMESPACE,
            inject: function () { return {}; }
          }, ServiceManager);
        });
      }, "psm: body");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});