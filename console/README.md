# DeepSearch Console（dsh-console）— 四源检索总表引擎

DeepSearch 控制台（`127.0.0.1:6600`，`DEEPSEARCH_CONSOLE_PORT` 可改）：把 **dsh 对话/记忆 → 四源检索 → 结果导航/全文/同步** 这条链路包成一个可视化控制台，并承担 **OV 批级 commit 导入**。

版本：**V_0.8.0**（2026-11-02，mem0 导入批数不再回退 + 暂停直接生效 + 停止取消队列 + 手动导入死锁修复）。

## 形态

- 独立轻量 Node 服务，默认 `127.0.0.1:6600`，本机访问。
- 后端零第三方依赖（仅 Node 内置模块 + `node:sqlite`），前端单页原生 HTML+JS。
- **唯一写者**：Console 进程是检索总表（`deep-search.db`）的唯一写者，host 插件（`plugin/deepsearch`）只读转发，绝不写总表。

## 四源检索

| 源 | 数据来自 | 层级 | 导航 |
|---|---|---|---|
| `ov_context` | OV API（生产 1933 / 沙盒 1934，`DEEP_SEARCH_OV_URL` 可覆盖） | layered | 可 `next` 沿链深挖 |
| `ov_session` | 本地总表 `ov_chunks` 扫描（OV ingest 状态库镜像） | flat | 恒 `no_direction`（只能 carry 回 S1 重搜） |
| `mem0` | `8915`（只读接生产） | flat | 恒 `no_direction` |
| `wiki:<code>` | 启用/就绪 Wiki 资产（资产注册表 `.dsh/wiki-assets.json`） | layered | 可 `next`（`wiki_nav` 查表 / 四层深挖链） |

源身份与资产模型：`wiki:<code>` 是唯一能力选择器，内部经 `enabledWikiAssets` 解析到 assetId；`ov_context` 保留 uri/level/sessionId 分层身份透传（否则 carry/next 依赖丢失）。

## 检索模式（前端）

- **信号词触发**：消息出现信号词即触发三板块检索——最省 token、命中即精准。
- **指令式唤起**：用户显式要求才检索（Mem0+L1+L0，topK 大）——最精准、token 成本最低。

## 排序链（V_0.7.3）

`anchorSignature → spanSignature → anchorHits → atomExactCount → semanticConf(min→mean) → candidate.id`

- **span 签名 v2**：保留空格段 → 段内原子化 → 贪心最长连续 span 保序非重叠 → 签名字典序降序。
- **强锚点候选管线**：`anchor-resolve.js` 解析 query 锚点（resolved / technical / ambiguous / unresolved；仅 resolved + technical 进 strong 数组），检索对象不漂移保护。
- 语义分：`semanticConf`（余弦置信），禁加权，前级同才看后级。

## 检索 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/search` | 四源递进检索（`explain=true` 附 `anchorResolution` + 六键 explain） |
| GET/POST | `/next` | 沿结果导航（层级源真实导航派生，禁硬编码 available） |
| GET/POST | `/read` | 按结果身份（source+id）取回全文（ov_session/wiki 返回 DB 全文；mem0/ov_context 诚实说明不可独立取回） |
| GET | `/status` | 四源健康真实探测（mem0/OV/表 + wiki 块） |
| GET | `/source-catalog` | 只读源目录（固定源 + 启用/就绪 Wiki 资产；绝不写注册表） |
| GET | `/source-stats` | 只读源统计（端口/数据量/上次同步，真实来源） |
| POST | `/sync` | 同步（`target`: wiki / session / all；`dryRun` 默认 true） |
| GET | `/sync/:jobId` | 同步任务结果 |

## 递进搜索 S1/S2/S3

- 层级源（ov_context / wiki）：沿链深挖，`nextDecision` 从真实导航派生（wiki_nav 查表 / ovDirections / ovDecisionCode 结果级信号 A5，禁硬编码）。
- 扁平源（mem0 / ov_session）：恒 `no_direction`，carry 回 S1 重搜。
- **carry 语义**：已验证检索证据允许跨源携带——带 `sources` 按 sources 执行；不带则按 carry 来源收窄。

## 模块

```
console/
  server.js            后端：node:http + REST + 调度器 + 检索/OV/配置路由注入
  search-api.js        检索 API 端点层（/search /next /read /status /source-* /sync）
  search/              检索引擎：engine / rank / embed / local-scan / remote / source-spec
                       + 锚点管线：query-lexicon / query-plan / anchor-resolve / content-match / content-rank
  store/               总表：db(10 表) / wiki-import / session-sync / session-ready /
                       source-catalog / sync-queue / wiki-mount / atomic / health
  guide/               导航：next / carry / read / ov-direction / wiki-nav
  lib/                 ov-import.js（OV 批级 commit 导入）/ wiki-assets.js（资产注册）/ llm-presets / seed / maps
  web/index.html       单页 UI（四页：概览 / 数据源 / 记录 / 配置）
```

## OV 导入 + 配置 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 控制台状态、调度器、最近导入、当前模型 |
| GET/POST | `/api/ov/status` · `/api/ov/sessions` | OV 导入状态 / 会话列表 |
| POST | `/api/ov/run` · `/pause` · `/resume` · `/stop` · `/reset` · `/config` | OV 导入控制与配置 |
| POST | `/api/import` | 手动导入 `{force?, extract?}` |
| GET | `/api/sessions` | 已同步会话 |
| GET/POST | `/api/model` · `/api/model-presets` | 解析模型切换 / 预设 |
| GET/POST | `/api/ov-vlm` | OV VLM 参数读写（写前自动备份 `.bak-console`） |
| GET/POST | `/api/mem0/status` · `/config` · `/model` · `/write` · `/pause` · `/stop` · `/resume` · `/retry` · `/activate` · `/search` | mem0 导入与检索 |
| GET/POST | `/api/embedding-presets` · `/api/wiki-model-presets` | 向量/模型预设 |
| GET/POST | `/api/wiki/assets` · `/toggle` · `/description` · `/cancel` · `/pick-folder` | Wiki 资产管理（只读注册 + 启停/描述） |
| GET | `/api/logs` · `/api/timeouts` | 最近日志 / 超时信息 |

## 数据

- `console/.data/deep-search.db`：检索总表（`ov_chunks` / `wiki_blocks` / `sync_jobs` 等 10 表），**不入库**（`.gitignore`）。
- `console/.dsh/wiki-assets.json`：Wiki 资产注册表（`id`/`name`/`enabled`/`code`/`description`/`state`/`lastUpdate`），**不入库**。
- OV 导入运行状态：`ov-state.json` / `ov-progress.json` / `ov-done.json` / `ov-done-parts.json`，**不入库**。

## 依赖服务

- **OV** `1933`（生产）/ `1934`（沙盒）——`ov_context` 数据 + 批级 commit 目标。
- **mem0** `8915`——场景记忆检索（只读）。
- **模型 / embedding**——由 `console-config.json` 的 `model` / `embedding` 段配置（本机 IP，不入库；模板见 `llm-wiki-asset/config.example.yaml`）。

## 环境要求

- Node ≥ 22（需 `node:sqlite`）。
- `zstd` 命令在 PATH（OV session 解压用；macOS `/opt/homebrew/bin/zstd`，服务调用时已自动加子进程 PATH）。

## 运行

```bash
DEEPSEARCH_CONSOLE_PORT=6600 node server.js     # 生产 6600
DEEPSEARCH_CONSOLE_PORT=6601 node server.js     # 沙盒 6601
```

## 日志

- 运行日志：`console-6600.log`（`.gitignore`）。
- 导入/检索日志：控制台透传 OV 导入与引擎输出。
