# CHANGELOG

DeepSearch Console（127.0.0.1:6600，OV 导入模块）版本记录。

> llm-wiki 资产（8126）版本记录见 llm-wiki 项目目录；本文件只记 DeepSearch 控制台（OV 批级 commit 导入）的版本演进。
>
> 旧版 CHANGELOG（llm-wiki V_2.0~V_2.2.0，md5 `68668614…`）备份于 `~/ToDo/.backups/prod-ov-faildetach-20261026-091524/CHANGELOG.md.llmwiki-2.2.0.bak`，可回退。

---

## V_0.7.3 — 2026-11-01 · span 签名排序链 v2 + 强锚点候选管线

### 背景

V_0.7.2 之后 host 插件 0.4.0 引入强锚点（anchors）候选管线（检索对象不漂移保护）。生产 Console 此前是旧 tier 链（tier→exact→hit→ov→semanticScore），无 span 签名排序 v2、无锚点解析。本次首次引入。

### 变更

#### 新增

1. `search/query-lexicon.js`：query 词法（锚点/技术标识识别原料）。
2. `search/query-plan.js`：query 规划。
3. `search/anchor-resolve.js`：锚点解析（resolved / technical / ambiguous / unresolved；仅 resolved + technical 进 strong 数组）。
4. `search/content-match.js`：内容匹配。
5. `search/content-rank.js`：span 签名 v2（保留空格段→段内原子化→贪心最长连续 span 保序非重叠→span 签名字典序降序）。

#### 修改

6. `search/engine.js`：排序链改为 `anchorSignature → spanSignature → anchorHits → atomExactCount → semanticConf(min→mean) → candidate.id`；`explain=true` 时返回 `anchorResolution`。
7. `search/rank.js`：接入 span 排序（旧 tier 链保留）。
8. `search-api.js`：`/search` 接入锚点解析与 span 排序。
（`server.js` 不动）

### 验证

- 沙盒 6601：41/41（34 旧不回归 + 7 新）。
- host 0.4.0 沙盒真实验证 10 项 PASS（带锚点 explain→anchorResolution；routing 裁剪；无锚点不回归；deep_search_read 全文 + guide）。

### 运维说明

- 备份：`~/ToDo/.backups/deepsearch-040-sync-20261101-1111/`（console/ 含 search 全量 + search-api.js + server.js + CHANGELOG）。
- 回退：恢复备份 `search/` + `search-api.js` + 重启 6600。

---

## V_0.7.2 — 2026-10-31 · /read 全文读取端点（deep_search_read 前置依赖）

### 背景

V_0.7.1 修复 query="" 混排后，host 插件 0.3.0 新增 `deep_search_read` 工具（读取已返回结果全文），需 Console 提供 `/read` 端点——按结果身份（source+id）取回全文。此前沙盒 Console（6601）已实现 `/read`（source-routing 开发时），但生产 Console（6600）未同步——`deep_search_read` 调生产 Console `/read` 返回 HTTP 404。

### 变更

#### 新增

1. `guide/read.js`：`readResult`——按结果身份取回全文。诚实范围（沙盒实测）：`ov_session`（`SELECT id, session_id, time_ms, role, text FROM ov_chunks WHERE id=?`）/`wiki`（`wiki:<asset>:<block>` 解析 → `SELECT ... FROM wiki_blocks WHERE asset_id=? AND block_key=?`）返回 DB 全文（`available=true` + text/title/meta）；`mem0`/`ov_context` 内容已全量在检索结果（engine 不截断 text/abstract），无独立 get-by-id/get-by-uri 端点 → `available=false` + 诚实 reason（不虚构可用性）。

#### 修改

2. `search-api.js`：+`import { readResult } from "./guide/read.js"`；+`handleRead(req, res, body)`（`json(res, 200, { read: readResult(db, body, ovCfg) })`）；+`/read` 路由（GET/POST）。
3. `server.js`：路由白名单加 `/read`。

### 验证

- `deep_search_read`（生产 6600）：wiki 结果 → `available:true` + 全文 + title/meta + `guide`（read 后提示"全文仍不足时：提取可信锚点后重新 deep_search；若该结果 next.available=true 才可 deep_search_next"）——/read 生效。
- 四源 ok：mem0/ov_context/ov_session/wiki（重启 6600 后 deep_search_status）。
- host 插件 0.3.0 冒烟：deep_search 结果附 `routing`（命中来源裁剪 + 恒有修改 query/扩大更换）PASS。

### 运维说明

- 生产同步：Console `/read` 3 文件（`guide/read.js` + `search-api.js` + `server.js`）。
- 备份：`dsh backup/DeepSearch/deepsearch-console-read-20261031-1406`（原 server.js + search-api.js；guide/read.js 同步前不存在）。
- 重启 6600（新 PID，health `{"ok":true,"port":6600}`）后生效。
- 回退：备份文件覆盖对应路径 + 重启 6600。

---

## V_0.7.1 — 2026-10-31 · query="" 混排修复（tier 链恢复）

### 背景

V_0.7.0 的四源混排存在不可比 bug：`search/engine.js` `normalizeResult` 硬编码 `rankFeaturesLocal({ query: "" })`，query 从不传入 → 所有结果 tier=4/hit=0/ov=0/exact=false → **tier 链死亡**，混排退化为纯 `semanticScore(cos)` 降序。两重影响：

1. **跨源不可比** → mem0（L2 变换抬高分数）霸榜、ov_context（线性 2s−1 给出最低分）必被清零；
2. **收窄判定失真** → `narrowVerdict` 的 `hardHit(tier===1||exact)` 恒 false，narrowed 退化为纯 cos 比值。

### 修复

- `normalizeResult` 增加可选第 6 参 `query=""`（向后兼容），`executeSearch` 调用补传 `req.query`，`rankFeaturesLocal` 用真实 query 计算 hit/ov/exact。
- 恢复 tier → exact → hit → ov → semanticScore 排序链与 hardHit 收窄判定。

### 验证

- 沙盒 6601：B1–B6 前后对比，ov_context 全题涌现（0 → 4/8/6/9/12），mem0 不再霸榜（B2 仅 1 条），B1/B4 从 miss → narrowed（B3 类从 1 → 3 例）；现有测试 25/25 PASS。
- 生产 6600：B3 从无 ov_context → 9 条（决定性），B1/B3/B4 narrowed + 多源，mem0 不再霸榜（B2 仅 2 条）；/status 四源 ok。
- 生产与沙盒行为方向一致，数据差异致具体构成略异（正常）。

### 运维说明

- 备份：`~/dsh backup/DeepSearch/deepsearch-engine-queryfix-20261031-122454`（search/ 全量，md5 核对一致）。
- 回退：恢复备份 `search/engine.js` + 重启 Console 6600。

---


## V_0.7.0 — 2026-10-30 · deep_search 检索总表引擎（OV 导入模块 → 四源检索服务）

### 背景

deep_search 插件（替代 tdai-memory-inject）要求 Console 6600 作为检索总表**唯一写者**（WRITE_BOUNDARY=console-only），把 L0/L1 弃用后的四源（ov_context / ov_session / mem0 / wiki）统一为递进检索服务。V_0.6.0 控制台只做 OV 批级 commit 导入，无检索面；本次新增 `search/`、`store/`、`guide/` 三大检索模块与检索 API 端点。

### 变更

#### 新增检索模块（10-29 沙盒验证 → 10-30 生产同步）

1. **`search/`（新）**：`engine.js`（executeSearch / selectCapabilities / fullSource / narrowVerdict / normalizeResult）、`rank.js`（排序链）、`embed.js`（WeMM 1024 维 + int8 量化）、`local-scan.js`（scanOvsession / scanWiki）、`remote.js`（ovFind / mem0Search）、`source-spec.js`。
2. **`store/`（新）**：`db.js`（总表 10 表）、`wiki-import.js`（importAllWiki + populateWikiToc §8.8.1 条目池 + populateWikiNav §8.8 四层深挖链）、`session-sync.js`（OV 会话同步）、`session-ready.js`（.meta.json commit_count 判据）、`source-catalog.js`（buildSourceCatalog 源目录）、`sync-queue.js`（enqueueSync / runSyncQueue）、`wiki-mount.js`、`atomic.js`、`health.js`。
3. **`guide/`（新）**：`next.js`（nextDecision）、`carry.js`、`ov-direction.js`、`wiki-nav.js`（screenToc 分词命中）。
4. **`lib/wiki-assets.js`（新）**：资产注册/启用/描述管理（enabledWikiAssets → assetId）。
5. **`search-api.js`（新）**：端点 `GET|POST /search` · `GET|POST /next` · `GET /status` · `GET /source-stats` · `POST /sync` · `GET /sync/:jobId`（契约 ①.8）。
6. **`server.js`**：注入检索 API；`/source-stats` 真实探测（probeSources：mem0 /health、OV /sessions、ov_session/wiki 表计数）；OV 端点改配置驱动 `process.env.DEEP_SEARCH_OV_URL || oc.ovImport?.ovBaseUrl || 1933`（生产 1933 / 沙盒 1934 各自正确）。
7. **`web/index.html`**：四页结构（概览 / 数据源 / 记录 / 配置），对接 /source-stats 与 /status 真实数据（概览为 nav 第一项独立于 MEMORY SYSTEMS 分组；数据源 4 张独立卡，字段=服务端口/上次同步时间+大数字；记录=rec-toggle+table.rec；配置=参数组合管理+筛选排序参数管理）。

#### 检索语义（定稿）

8. **排序链**：tier → exact → hit → ov → semanticScore（禁加权，前级同才看后级）；tier=字面等级。
9. **截断/收窄**：相对截断 `max(top1×0.85, 0.48)`；收窄判定=top1≥质量线且区分度 或 tier1/exact→narrowed。
10. **递进搜索 S1/S2/S3**：层级源（ov_context/wiki）沿链深挖（nextDecision 从真实导航派生：wiki_nav 查表 / ovDirections / ovDecisionCode 结果级信号 A5，禁硬编码）；扁平源（mem0/ov_session）恒 no_direction，carry 回 S1 重搜。
11. **carry 语义**：已验证检索证据允许跨源携带（带 sources 按 sources、无 sources 按 carry 来源收窄）。
12. **会话就绪**：OV sessions 目录 `<root>/<sid>/.meta.json` 的 commit_count>0（或 last_commit_at 非空，或 history archive_*/.done）→ 就绪；否则 ov_context 源 unavailable + error.code=session_not_ready。
13. **源分层身份透传**：normalizeResult 保留 wiki assetId/blockKey/entry/board 与 OV uri/level/sessionId（V40 修复，否则 carry/next 依赖丢失，host 校验 reject 全部 wiki 结果）。
14. **wiki 资产说明模型**：`{code, description}`，源 id `wiki:<code>`（如 wiki:history-wiki），内部查库经 enabledWikiAssets；/source-catalog 只读 + 每启用就绪资产，capabilitiesForRequest 唯一能力选择器；ov_session 恒 no_direction。

#### 生产同步（10-30）

15. 生产 wiki 注册表 = 仅 History Wiki（enabled/code=history/description，test2/test4 移除）。
16. /sync 全源填充：wiki 4062 块 / toc 757 / nav 5359 + session 59156 块（490 会话）。
17. 生产 Console 6600 重启（DEEPSEARCH_CONSOLE_PORT=6600）+ 生产 OV 端点 1933。

### 验证

- 沙盒 6601：V 矩阵 V1-V30 全 PASS（wiki 29==29 / find 无 query_plan / SESSION_ID_REQUIRED / 四源 / explain 六键 / 唯一写者 / 红绿黄 / visited / carry / 精度公式 / session_not_ready / /source-stats 真实）。
- 真实语料回归：C1（ov_session 单源，int8 排序真实，阴性 3/3 miss）✅；C2（指定历史会话，Console 确定性过滤，15/20 目标会话）✅；C5（fuzzy_full 四源混排，complete=true，isFullSource=true）✅；C3 ⚠️ 部分（mem0+ov_context 召回 ✓，收窄判定 3 阴性 1 假阳性）；C4 ❌ RED（wiki_nav 表空，四层深挖链不可遍历）。
- console 自检 84+host 13 全 PASS；生产 6600 全程健康，/status 四源 ok。
- 累计修真实 bug 10+：POST 请求体（fetch 禁 GET body→COORDINATOR_DOWN）、V11 /sync 删除对账（syncWiki removed）、V12 故障组合（raw.ok===false 判 unavailable）、V13/V14 next 硬编码（computeNext 真实导航）、V15 screenToc 分词命中、V20 /sync/:jobId result 回显、V40 normalizeResult 源分层身份透传。

### 运维说明

- 备份：`~/dsh backup/DeepSearch/deepsearch-prod-sync-20261030-163439`（console 全量+插件+DSH profile）。
- 沙盒镜像：`.sandbox-run/deep-search-console-20261029-054149`（6601）。
- 回退：备份覆盖 + 重启 Console 6600。

---

## V_0.6.0 — 2026-10-28 · commit 上下文撑爆修复（36 批 400 根因）

### 背景

`session-547417a4`（1765 条）与 `session-7203b693`（1543 条）经控制台批量 commit 时全部 400 `Prompt too long: ~1.9M–2.17M tokens exceeds max context window of 262144`。跨层根因有两个，单修一层会复发：

1. **根因 A（console 语义反转）**：`_absKeepRecent` 把 `keep_recent_count` 当作「上下文尾巴大小」，按 `totalInputTokenBudget` 贪心压缩保留后缀。但 OV 侧 `keep_recent_count` 语义是「归档边界」（`split_idx = live − keep_recent_count`），压小它 = 归档更多 = 提取 prompt 更大；且 OV `hydrate_for_extraction` 只处理归档消息、根本不带保留尾巴，预算约束本身不成立。
2. **根因 B（OV 无上限单批）**：失败会话 `.meta.json` 的 `auto_commit_policy=null` → `resolve_extraction_batch_limits` 返回 `ExtractionBatchLimits()`（enabled=False）→ `plan_extraction_batches` 把全部归档消息塞进**一个**提取批 → 1.9M token 超窗 400。

### 变更

#### `lib/ov-import.js`（console）

1. **`_absKeepRecent` 语义修正**：改为 `keepRecent = liveCount − batchSize`（实时重读 OV live 消息数，归档数恒等于本批计划数），删除 `totalInputTokenBudget` 贪心压缩逻辑与双预算口径。
2. **`_splitBatches` 预算兜底**：`pendingTokenBudget || 150000` → `|| 60000`（单一安全预算，60000 ≪ 262144 窗口）。
3. **`status()`**：移除 `totalInputTokenBudget || 180000` 暴露。

#### `console-config.json`

4. 删除 `totalInputTokenBudget: 180000`（失去唯一引用），保留 `pendingTokenBudget: 60000`。

#### OV `session/extraction_batch.py`（site-packages，防升级覆盖见下）

5. **空 policy 默认上限**：`resolve_extraction_batch_limits` 在 policy 缺失或无阈值时返回 `ExtractionBatchLimits(max_message_tokens=60000)`（`DEFAULT_EXTRACTION_BATCH_TOKEN_LIMIT`），不再静默允许无上限单批全量 prompt。
6. **派生切分**：新增 `split_oversized_messages` / `_split_parts_by_token` / `_split_text_by_token_budget` / `_split_oversized_part`（TextPart / ContextPart / ToolPart 支持）。单条归档消息 > 上限时拆成 `{parent}#c{i}` 派生消息（`source_message_ids=[parent]`，追加 `[chunk i/n]` 标记，`CHUNK_MARKER_TOKEN_RESERVE=12` 预留给标记），**原始归档一字不动**；确定性 + 幂等（同一输入恒同切分，跨重启可复算）。

#### `ov-patch-check.sh`（新增）

7. 启动自检脚本（A–E 五哨兵：默认上限 / 空 policy 兜底 / console 单一预算 / 预算 60000 / 归档=本批语义），`--strict` 模式缺失任一哨兵 exit 1。site-packages 补丁在 `uv tool upgrade` 时会被覆盖，脚本用于升级/启动前检测退化。

### 明确不动

- `web/index.html`（前端未改）。
- OV `session.py`、`message/`、`auto_commit_policy.py`（提取批规划之外未动）。
- 原始归档 `history/archive_*/messages.jsonl`（派生切分只发生在提取 prompt 层）。
- oMLX 18088、WeMM 8810、ingest 脚本。

### 验证

- 沙盒 OV 合成用例 **13/13 PASS**（空 policy 默认上限 / 多批 ≤60000 / 单条 150k→3 chunk 且原始不变 / 边界 60000-60001 / 幂等 / ToolPart）。
- 真实事故数据（镜像 547417a4）：原版 1 批 2,067,977 token（复现生产 400）→ 补丁版 **39 批、最大 59,893 ≤ 60000、无 oversized**。
- 沙盒端到端（镜像会话，空 `memory_types` 跳过 VLM）：36 批全 completed、每批归档==batchSize、0 个 400、live 归零。
- 反例：live 同条数不同前缀 → 现有 live-重读机制按新前缀归档，无错归无丢失（无需 ID/hash 校验）。
- 生产严格自检 **PASS**（A–E 全绿）；`node --check` / `py_compile` 语法 OK。
- 生产源 SHA：`ov-import.js` `b735a68b…`→`363780d3…`；`extraction_batch.py` `aff96ad8…`→`faa50e55…`；`console-config.json` `52174994…`→`589db33e…`；新增 `ov-patch-check.sh` `3c9457d5…`。

### 运维说明

- **备份**：`~/dsh backup/OpenViking/ov-context-blowup-fix-sync-20261028-025431/`（console 5 件 + OV `extraction_batch.py`，含 `SHA256.txt`）；补丁 diff 留存于 `~/.sandbox-run` 镜像与 `.sandbox-run/ov-fix-backup-20261028/patch-*-v3.diff`。
- **回退**：备份文件覆盖对应路径 + 重启对应服务。
- **重启**：OV 1933 与 console 6600 均需重启（Python/ESM 模块启动时加载）。单服务控制：`lsof -iTCP:<port>` 取 PID → kill → 各自启动命令；**禁止按名 pkill**。
- **失败会话恢复**：从 OV live 重建计划（非旧 36/14 批），按 60000 token 重切；验收 `已归档 + 当前 live = 初始总量`（3308 条守恒）、0 个 400、每批归档==batchSize。
- **上游建议**：向 OpenViking 提交「提取批默认上限」PR，使空 policy 兜底进入官方代码（本地补丁会被 `uv tool upgrade` 覆盖，自检脚本为本地止损手段）。

---

## V_0.5.0 — 2026-10-27 · 失败批次只认 OV 任务中心真 failed

### 背景

旧 true-uncommitted 分支把「非 failed 终态 + live>0」误判为失败批次并重放，违反用户定稿「失败列表只认 OV 任务中心真实 status=failed」。本次将任务中心状态与落盘证据解耦：状态决定是否可成为失败卡片，证据决定该确认失败如何处置。

### 变更（`lib/ov-import.js`）

1. **状态门禁**：`_reconcileTerminalBatch()` 仅当 OV 任务中心 `status=failed` 才可能登记失败卡片；`completed`/`cancelled`/`cancelling`/`blocked`/`unknown` 一律返回 `not-failed`（不登记、不重放、不重提）。
2. **landed 判定**：`completed` 仅在 `_inspectBatchEvidence()` 证明归档有消息时返回 `landed`（真成功可记账）；`completed`+无证据返回 `not-failed`，不伪造成功。
3. **failed 按证据三分**：归档有消息→`restored-live`（复用恢复路径追回 live 并清空归档，卡片 `failed+restored`）；归档空+live>0→`pending-live`（不重放，live 是下轮信号）；归档空+live=0→`unrecoverable`（不盲重提）。
4. **`_syncDetached()` 统一走 `_reconcileTerminalBatch`**：failed→升级真失败；completed→仅 landed 补记账，否则移除占位；cancelled/cancelling/blocked/unknown→移除占位+诊断；不可达→保持 detached+blocked。
5. **task-not-found 修复**：`_waitTask()` 连续查无不再调用 `_recordFailure()`（原会污染 `failedBatches`/`failed` 计数），只写 `lastError`+日志并返回 false。
6. **`_planSort`**：restored failed 最高优先级（早失败在前），未恢复 failed 居中，普通会话按 `created_at`；detached/unknown/superseded 不入排序。

### 明确不动

- `web/index.html`（前端未改）。
- `ov-state.json`/`ov-progress.json`/`ov-done.json`/`ov-done-parts.json`（审计/展示数据，队列去重仍靠 OV live）。
- OV 1933、oMLX 18088、WeMM 8810。

### 验证

- 沙盒主套件 74/74（含 W1 task-not-found×5 回归：不新增失败记录、`failed` 计数不变、不重放）。
- 历史 failstate 回归 15/15（G3/G3b 已按新契约更新）。
- 语法 OK；生产源 SHA `d8486e1d…`→`b735a68b…`。

### 运维说明

- **备份**：`~/dsh backup/OpenViking/ov-failed-only-reconciliation-sync-20261027-200916/`（含 `SHA256.txt`）。
- **回退**：备份 `ov-import.js.prod` 覆盖 + 重启 6600。
- **重启**：`lsof -tiTCP:6600` → kill → `DEEPSEARCH_CONSOLE_PORT=6600 node server.js`；冒烟 `/health` + `/api/ov/status`（`failedBatches:[]`、`running:false`）。

---

## V_0.4.0 — 2026-10-27 · 断开批次完成后清理失败卡片

### 变更

- `_syncDetached()` 发现断开占位任务已 `completed` 时，补记账后从 `failedBatches` 删除该占位，而不再转为 `superseded`。
- 清理历史遗留的已完成任务占位记录；不改 done 账本、计划、OV 服务或 VLM 配置。

### 验证

- 沙盒真实 OV 回归 122/122 通过（含断开→完成、失败链、重发、unknown 与 UI 验收）。
- 生产同步前确认该历史批次已存在于 `ov-done-parts.json` 与 `ov-done.json`，删除仅影响失败卡片展示。

---

## V_0.3.0 — 2026-10-26 · OpenViking VLM 参数卡片 + max_tokens=131072

### 背景

OV commit 流程的 VLM 提取阶段（Phase 2）依赖 `ov.conf` 的 `vlm` 段配置。生产 `ov.conf` 此前未设 `max_tokens`（回退默认 32768），批量 commit 时生成多条 memory document 余量不足。沙盒验证 `max_tokens=131072` 后（`task_id=c8458666`，`status=completed`，`memories_extracted=1`，`completion_tokens=1153` 远低于上限），同步至生产。

### 变更（`web/index.html` 4349→4430 行 +71，`server.js` 2641→2715 行 +74）

#### 前端（`web/index.html`）

1. **OpenViking VLM 参数卡片**：新增完整 VLM 配置编辑区，包含 Provider / Base URL / API Key / Model / Temperature / Thinking / Max Tokens / Timeout / Max Retries / Max Concurrent / Reasoning Effort。
2. **默认值参考面板**：`📋 VLM 默认值参考` 可折叠面板，展示 `DEFAULT_OV_VLM` 全量默认值，区分「可修改」与「保持默认」字段。
3. **重启提示**：`⚠️ 修改后需重启 OV 服务（port 1933）才能生效`。
4. **`applyOvVlm()`**：POST `/api/ov-vlm`，snake_case 写入 `ov.conf.vlm` 段，toast 提示「需重启 OV 服务生效」。
5. **`loadOvVlm()`**：GET `/api/ov-vlm` 回填卡片 + 默认值面板。
6. **预设保存/加载**：`applyOvPreset()` / `saveOvPreset()` 覆盖全部 VLM 字段。
7. **导航入口**：模型配置页 `loadOvVlm()` 自动加载。

#### 后端（`server.js`）

8. **`OV_CONFIG_PATH`**：`~/.openviking/ov.conf`（env `OV_CONFIG_PATH` 可覆盖）。
9. **`DEFAULT_OV_VLM`**：12 字段默认值（excl. `media`）。
10. **`readOvVlm()` / `writeOvVlm()`**：读写 `ov.conf.vlm`，写入前自动备份 `.bak-console`。
11. **`validateOvVlmBody()`**：字段校验（temperature 0-2、timeout 正数、max_tokens 正数/null 等）。
12. **`GET /api/ov-vlm`**：返回 `{ vlm, defaults }`。
13. **`POST /api/ov-vlm`**：校验 → 合并用户字段到现有 vlm → 写入 `ov.conf` → 返回更新后 vlm。

#### 配置（`ov.conf`）

14. **`vlm.max_tokens`**：从无（默认 32768）→ `131072`。

### 明确不动

- `console-config.json`（pendingTokenBudget=150000 保留）。
- `ov-state.json` / `ov-progress.json` / `ov-done-parts.json`（committedMessages=10297 累计账本保持）。
- `vlm.model` / `vlm.api_base` / `vlm.api_key` 等其余 VLM 字段（生产保持 Qwen3.8-27B-4bit @ 127.0.0.1:18088）。
- `lib/ov-import.js` 未动。

### 验证

- 沙盒 OV 1934（独立数据目录）：`max_tokens=131072` 写入 `ov-sandbox.conf`，commit `task_id=c8458666`，`status=completed`，`memories_extracted=1`，`token_usage.llm.completion_tokens=1153`，耗时 121.98s。
- 生产 API：`GET /api/ov-vlm` 返回 `vlm.max_tokens=131072`，`defaults.max_tokens=null`。
- 冒烟：HTTP 200 / 273372B。

### 运维说明

- **备份**：`~/ToDo/.backups/prod-vlm-card-20261026-130900/`
  - `console/web/index.html` md5 `354868a9a253844533f10d8f4fed62ab`，4349 行
  - `console/server.js`（2641 行原始）
  - `ov.conf`（`vlm.max_tokens` 未设）
  - 回退：备份文件覆盖 + 重启 6600 + 重启 OV 1933。
- **覆盖范围**：
  - `web/index.html`（4430 行）
  - `server.js`（2715 行）
  - `ov.conf` → `vlm.max_tokens=131072`
- **重启**：
  - Console 6600：`lsof -iTCP:6600 -t | xargs kill` → `DEEPSEARCH_CONSOLE_PORT=6600 nohup node server.js`
  - OV 1933：`lsof -iTCP:1933 -t | xargs kill` → `NO_PROXY="*" no_proxy="*" openviking-server --config ~/.openviking/ov.conf`
- **NO_PROXY 修复**：生产 OV 启动命令已加 `NO_PROXY="*"，规避 httpx 0.28.1 的 `[::1]` 解析 bug。

---

## V_0.2.0 — 2026-10-26 · 表头品牌更名（TencentDB → DeepSearch）+ 精简

### 背景

DeepSearch console 已作为 OV 导入控制台独立运行（127.0.0.1:6600），但表头仍显示历史名称「TencentDB 控制台」与旧端口「127.0.0.1:8126」；右上角刻度角标「TDAI·MEM·CTRL」沿用早期仪器隐喻；右侧服务状态灯（core / knowledge / panel / proxy / console ✓）监控的是 llm-wiki 8126 那套服务栈，对当前 6600 OV 控制台无信息量。本次统一表头语义。

### 变更（`web/index.html` 4369→4349 行，md5 `0ea285fd…` → `354868a9…`）

1. `<title>`：`TencentDB 控制台` → `DeepSearch 控制台`（L6）。
2. 表头主标题：`TencentDB <em>控制台</em>` → `DeepSearch <em>控制台</em>`（L380）。
3. 表头副标题：`127.0.0.1:8126` → `127.0.0.1:6600`（L381）。
4. 删除 `.banner::after` CSS 规则：右上角「TDAI·MEM·CTRL」刻度角标不再渲染（L49-52）。
5. 删除 `<div class="status-dots" id="svcDots">` 元素（L383）。
6. 删除 `renderDots()` 函数与 `loadStatus()` 内的 `renderDots()` 调用；core / knowledge / panel / proxy / console 服务状态灯整体退场。
7. 清理已无引用的 CSS：`.status-dots` / `.dot` / `.dot i` / `.dot.up i` / `.dot.up` / `@keyframes lamp`（L56-62）。

### 明确不动

- `server.js`：`/api/status` 仍返回 `services` 字段（前端已不消费，后端保留无影响）；`TencentDB` / `8126` 出现在注释、环境变量、llm-wiki 服务引用（8420/8421/8123/8096）处，均非表头语义，不改。
- L1034「导入走 8126 后端集成」是 llm-wiki 导入说明文案，非表头，不改。
- `console-config.json` / `ov-state.json` / `ov-progress.json` / `ov-done-parts.json`（committedMessages = 10297 保持）。
- 8126 llm-wiki 控制台 / 8810 WeMM / 1933 OV 服务 / 18088 oMLX VLM。

### 验证

- 关键词残留检查：`TencentDB` / `TDAI·MEM·CTRL` / `127.0.0.1:8126` / `svcDots` / `renderDots` / `status-dots` 全 0 命中。
- 冒烟：HTTP 200 / 269910B（较 V_0.1.0 减小 1104B，CSS/JS 精简）；`DeepSearch 控制台` 与 `127.0.0.1:6600` 各命中 1。
- API 状态保持：`committedMessages: 10297`、`queueErrors: []`、`failedBatches: 0`、`running/paused/stopping` 全 false、`lastError` 空、调度器下次导入 19:00:00（`_recoverStaleRun` 未误触发）。
- 重启姿势：`lsof -iTCP:6600 -t` 取 PID 82455 → kill → 端口 1.5s 释放 → `DEEPSEARCH_CONSOLE_PORT=6600 nohup node server.js`，新 PID 95896。

### 运维说明

- **备份**：`~/ToDo/.backups/prod-header-rename-20261026-0930/console/web/index.html`（md5 `0ea285fd38d9f6aaba7b062a8a23c576`，271014B，4369 行）。
- **回退**：`cp` 备份文件回生产 `console/web/index.html` + 重启 6600。
- **覆盖范围**：仅 `web/index.html`（md5 `354868a9a253844533f10d8f4fed62ab`，4349 行）；`lib/ov-import.js` 未动。

---

## V_0.1.0 — 2026-10-26 · OV 导入失败重试 + detached 队列错误层

### 背景

DeepSearch console 承载 OV 批级 commit 导入（预规划批队列、断点续传、审计账本）。生产运行中暴露四个缺口：

1. 非正常重启无自动恢复（state 残留 running 导致下次启动卡死）。
2. OV 任务挂起时控制台盲等 30 分钟（taskTimeoutMs 总等待超时 + taskStallMs 停滞检测误判 VLM 慢提取为停滞）。
3. 失败批次卡片只有错误文本，无法反查 OV 任务中心。
4. OV 连接断开时把未知结果误标成失败，重试可能重复提交或丢失审计。

### 需求（用户定稿）

1. **失败批次只认 OV 任务中心真实 `status=failed`**，控制台不再编造失败。
2. **失败卡片只同步 OV 三核心信息**：序号 = task_id / 所属会话 = resource_id / 错误状态 = error；失败时间、重试次数、消息条数为队列任务展示；卡片顺序 = 队列优先排序。
3. **重试语义** = 把失败批消息改回"未 commit"（恢复 archive 到 live），再由队列重 commit。
4. **队列错误层与失败批次层分离**：
   - commit 4xx（Bad Request）→ 队列错误（`queueErrors`），不进失败批次；
   - commit 连接故障 → 队列暂停（不产生 failed / detached）；
   - 任务轮询断开 → detached 临时记录（状态机外展示字段）。
5. **detached 四分支定性**（OV 连通后复查）：failed → 升级真失败 / completed → 补记账 / 查无 + live → 安全重发 / 查无 + archive → unknown 不盲重发 / 仍断 → 保持暂停 / running → 继续等。
6. **taskTimeoutMs 退场**：不再产生"总等待超时"失败；`_waitTask` 无限等 OV 终态，连接故障归队列层（用户原话"这个 30 分钟的超时已经无效了"）。

### 变更（`lib/ov-import.js` 654→1073 行，`web/index.html` 4352→4369 行）

#### 后端

1. **`OvClient.taskInfo` 错误分类**：404 → null（任务中心可达但查无 → unknown）；其他网络/5xx → 抛错（连接故障 → 队列层处理）。
2. **`_recordDetached`**（新增）：detached 记录，同 key 已有只更新时间戳不累积；`_recordFailure` 恢复误删的 attempts 行。
3. **`_syncDetached`**（新增）：OV 连通后四分支定性，返回 `{blocked, message}`——
   - failed → 升级真失败 + `state.failed++`
   - completed → `_markBatchDone` 补记账 + 转 superseded
   - 任务查无 + live>0 且无 archive → unknown 待重发
   - 查无 + 有 archive → unknown 保留 archive 不盲重发
   - 仍断 → blocked + lastError"OpenViking 服务端已断开，无法继续任务" + 保持暂停
   - running → blocked 继续等
4. **`_waitTask`**（重写）：无限等 OV 终态，退出条件仅三——
   - completed
   - failed·cancelled → `_recordFailure=false`
   - 连接故障连续 3 次 → `_recordDetached` + 返回 'disconnected'
   - 另有 nullCount≥5（真实 404）→ unknown
   - 移除 taskStallMs 停滞检测与 30 分钟总等待超时。
5. **`_runLoop`**（改造）：新增 `skipMark`；`wr === 'disconnected'` → paused = true + lastError + 等 resume（`while paused && !_abort`），定性后 skipMark 不重复记账；commit catch 分类——4xx → queueErrors push + lastError + continue、连接故障 → paused + 等 resume；`if (ok && taskId && !skipMark)` 记账。
6. **`resume`**（改 async）：先 `_syncDetached`，blocked → `{ok:false,error}` 保持 paused；否则 paused = false `{ok:true}`。
7. **`_planSort`**：失败优先只认 `!f.detached && (f.status==='failed' || !f.status)`（兼容旧格式无 status）；detached / unknown / superseded 不参与排序。
8. **状态层**：`DEFAULT_STATE` 加 `queueErrors: []`；`status()` 暴露 `queueErrors`；`_shouldRestore` / `_restoreFailedBatch` / `_restoreFailedBatches` 全部跳过 detached（不误恢复）。
9. **幂等锚点**：恢复成功后清空 archive + `restoredCount` 断点续追（`_restoreFailedBatch` 读 archive messages.jsonl → POST `/api/v1/sessions/{id}/messages/batch`，≤100 条/批）。

#### 前端

10. **`ovFailCard` 改造**：detached 不聚合（key 含 ts）、序号 '-'、重试次数 'disconnected'、状态标记「已断开（队列暂停，待复查）」；序号列改 `task_id || seq || '—'` 可反查任务中心。
11. **`statusHtml` 状态机展示**：retried_success → "✓ 已重试成功"、retrying → "重试中（已恢复未 commit）"、unknown → "状态未知"、superseded → "已被后续失败取代"、detached → "已断开"；resolved 行 opacity:.55。
12. **F2 进度卡暂停文案**：用户砍掉，未实现。

### 验证（沙盒 OV 1934 + console 6601，判定证据为 OV 磁盘/API 真实状态，非 mock）

- **103/103 全绿**：failqueue 41（队列错误层 A1/A2/C1/D1-D5/E1/F）+ failloop 59（失败重试闭环）+ e2e 8 + restore 7 + test 4，0 FAIL。
- **失败由真实故障产生**：坏 VLM 端口 `127.0.0.1:18999`（空闲端口）真实 Connection error，非 mock。
- **测试不依赖真 LLM**：恢复 / 重 commit 阶段 fixture 用 `memory_policy={"memory_types":[]}` 跳过 Phase 2 VLM 提取（112 条 222s→2s，归档/live/状态机全真实），由 `fastenRecovery()` 动态改空数组加速；失败路径保持 `memory_types=["events"]` 真实提取。
- **判定证据**：OV 磁盘 `archive_NNN/messages.jsonl` 行数 + 任务中心 status/error + live 守恒式（已归档 + 剩余 live = 总数）。
- **串行测试**：共享 OV/状态文件禁并行（残留进程占用 OV 会导致 600s 死等超时）。
- 驱动脚本直接 import 控制台真实 `lib/ov-import.js`，复用同一套估算与切批代码。

### 运维说明

- **备份**：`~/ToDo/.backups/prod-ov-faildetach-20261026-091524/console/`
  - `lib/ov-import.js` md5 `79d47078…`
  - `web/index.html` md5 `66641b41…`
  - `console-config.json` md5 `175a5e6e…`
  - 同目录 `CHANGELOG.md.llmwiki-2.2.0.bak` md5 `68668614…`（旧 llm-wiki 版本记录）
  - 回退：备份目录整体恢复 + 重启 6600。
- **覆盖范围**：`lib/ov-import.js`（md5 `76c5d0f0…`，1073 行）、`web/index.html`（md5 `0ea285fd…`，4369 行）。
- **明确不动**：`console-config.json`（pendingTokenBudget = 150000、生产 ovApiKey 保留）、`ov-state.json` / `ov-progress.json` / `ov-done-parts.json`（committedMessages = 10297 累计账本保持）、生产 OV 1933 配置（VLM 不动，继续 18088 本机 oMLX）。
- **重启**：`lsof -iTCP:6600` 取 PID 20362 → kill → 端口 1s 释放 → `DEEPSEARCH_CONSOLE_PORT=6600 nohup node server.js`，新 PID 82455。
- **冒烟结果**：HTTP 200 / 271014B、前端 detached 渲染代码 4 处命中、`queueErrors: []` 内存合并 DEFAULT_STATE、failedBatches:0、plan:0、running/paused/stopping 全 False（`_recoverStaleRun` 未误触发）、committedMessages = 10297 保持、lastError 空、调度器下次导入 19:00。
- **未触碰**：8126 llm-wiki 控制台 / 8810 WeMM / 1933 OV 服务。
