# deep-search — DSH 本地/网络多轮自主循环反思检索插件

`deep-search` 是 DSH host 的 hybrid 插件：一套「**路线选择 → 方法说明 → 工具参数 → 多轮循环反思**」的被动引导检索能力，覆盖**本地记忆**与**设备外网络**两类检索。生产安装于 `~/.dsh/profiles/web/node_modules/deep-search`，本目录为镜像副本。

版本：**0.5.0**（2026-11-09，本地检索升级为本地/网络多轮自主循环反思检索）。

## 形态

- cordis bundle 插件：`inject:["tools"]` 注册工具，`apply(ctx)` 挂 agent/pre-step 唤起钩子 + 侧边栏只读卡片。
- 检索后端分两路：**本地四源**走 Console（`127.0.0.1:6600`）`/search`，**网络检索**走内置 `web-research/scripts/` Python 状态机 + Wigolo/MediaCrawler。
- Console 是检索总表唯一写者，插件只读转发，绝不写总表。

## 检索工具族

### 本地检索（四源）
| 工具 | 作用 |
|---|---|
| `deep_search` | 四源递进检索（`ov_context` / `ov_session` / `mem0` / `wiki:<code>`） |
| `deep_search_next` | 沿层级源导航深挖 |
| `deep_search_read` | 取回 `ov_session` / `wiki` 截断结果全文 |
| `deep_search_status` / `deep_search_sync` | 四源健康探测 / 同步 |

### 网络检索（0.5.0 新增，多轮自主循环反思）
| 工具 | 作用 |
|---|---|
| `deep_search_web` | 创建设备外综合检索任务，拆 claims / 选证据渠道 |
| `deep_search_step` | 对下一个待办 claim 执行一轮取证 |
| `deep_search_reflect` | 反思本轮证据，判定 supported/refuted/uncertain，可追加子问题——**循环反思核心** |
| `deep_search_report` | 汇总问题 / claim 判定 / 真实证据 URL / 未解决项 |
| `deep_search_fanout` | 多分支编排（web 并行 + crawl 串行 + 跨类并发） |
| `deep_search_crawl` | 登录态社媒单平台定向抓取（MediaCrawler） |

### 路由引导
| 工具 | 作用 |
|---|---|
| `deep_search_guide` | `route`（local/web/social）→ 入口工具 → 方法说明；配 Console 渠道目录 |

## 三环节被动引导

1. `system-guide.md` 随系统提示被动呈现，只按 query 区分 local/web/social 三路线（不出现工具名）。
2. `deep_search_guide({route})` 返回 `{route, tool, guide}`，guide 为该入口工具完整说明。
3. 执行期间经 `deferContext` 把方法说明 / 决策胶囊 / catalogBlock 作**插件来源快照**排到结果后——`source.kind="deep-search"`，前端归为 context 节点、主对话流过滤，**前台无感**；`role:"user"` 保留使 agent 照常读到。

## web-research 执行层

- `web-research/scripts/*.py`（8 文件，纯标准库）：检索编排状态机，`cli.py` 为唯一入口（子命令 `start`/`step`/`reflect`/`report`/`crawl`/`fanout`）。
- `lib/webResearch.js`：`webExecute`/`runCli` 薄封装 `execFile` 调 cli.py；`ensureServices` 调工具前经 plugin-service-manager 检测拉起后端（wigolo/mediacrawler/n8n 断开自动 start）。
- `lib/workspace.js`：`resolveWorkspace` 跟随当前 DSH 对话工作区落盘（crawl 产物进 `<工作区>/Crawler Result/.tmp/`）。
- `templates/crawler/*.md`：各社媒平台抓取模板。

## 配置

- `deepsearch.config.json`：运行时配置（Console + 插件双向读写；evoke 唤起 / gateway / harnessRules 等）。
- `.gateway-token`：mediacrawler 鉴权 token（**不入库**，chmod 600）。
- 端口：Console `6600` 生产 / `6601` 沙盒；OV `1933` 生产 / `1934` 沙盒；mem0 `8915`。

## 依赖

- DSH host（cordis bundle 契约：`dsh.bundle.patch` + `apply` + `name` + `inject:["tools"]`）。
- Console `6600`（本地四源检索 + 渠道目录 + 唤起召回）。
- Wigolo（`wigolo-direct` :3333 / `wigolo-restricted` :3334）——网络检索引擎。
- MediaCrawler（Thorium CDP :9222 复用登录态）——社媒抓取。
- plugin-service-manager（宿主 3080）——`ensureServices` 检测拉起后端。

## 运行

插件由 DSH host 加载（非独立进程）。改 `lib/` 后需重启 DSH 生效；侧边栏卡片 `client.js` 纯前端热重载即生效。

## 相关文档

- Console：`../../console/README.md`（四源检索总表引擎 + 渠道目录）。
- 版本记录：本目录 `CHANGELOG.md`（镜像副本维护，生产插件不发版）。