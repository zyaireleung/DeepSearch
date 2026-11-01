# CHANGELOG

DeepSearch 插件（`deep-search`，DSH host）版本记录。

> 版本记录与生产插件副本同步：`~/DeepSearch/plugin/deepsearch/`（生产生效以 `~/.dsh/profiles/web/node_modules/deep-search` 副本为准）。
> Console（127.0.0.1:6600）版本记录见 `DeepSearch/console/CHANGELOG.md`，本文件只记插件。

---

## 0.4.0 — 2026-11-01 · 工作区源码回写 0.3.1 形态 + 强锚点候选管线合并

### 背景

工作区 `src/` 落后生产 0.3.1 一个版本：0.3.1 已含 source-routing + `deep_search_read`（第 5 工具），但工作区 `src/` 仅有 0.2.0 四工具形态 + 本轮强锚点改动（加在落后源码上）。正确路径 = 先回写 0.3.1 形态（read/routing）到工作区 `src/`，再合并强锚点候选管线。

### 变更

#### 回写 0.3.1 形态（read / source-routing）

1. `src/api/routes.ts`：+`read` 路由（POST /read）。
2. `src/api/client.ts`：+`read(req)` → POST /read（ReadResponse 契约）。
3. `src/api/contract.ts`：+`ReadRequest`/`ReadResponse` 类型。
4. `src/guidance.ts`：+`normalizeRoutingSource`/`parseSourceRouting`/`renderSourceRouting`/`renderReadGuide`（source-routing.md 消费；`READ_GUIDE_NEEDS=["ov_session","wiki"]`）。
5. `src/tools.ts`：`deepSearch` 第 3 参 sourceRoutingText→page.routing；`deepSearchRead` 第 5 工具；`buildTools` 第 3 参透传 + readTool（id 必填 + source enum）。
6. `src/index.ts`：`buildTools(client, prompts.tools, prompts.sourceRouting)`；日志 5 工具。
7. `src/prompts/loader.ts`：SlotName +"source-routing"；loadSlots 返回 sourceRouting；TOOL_KEYS +`deep_search_read.*` 键。
8. `prompts/zh/source-routing.md`：新建（S1/S2 路线定稿）。
9. `prompts/zh/tools.md`：`deep_search.out.page` +routing 说明；+`deep_search_read` 段。
10. `prompts/zh/system-guide.md`：+【来源路线指引】段。
11. `src/selfcheck-source-routing.ts`：新建（28 断言）；selfcheck 链接入。

#### 合并强锚点候选管线（本轮定稿）

12. `src/api/contract.ts`：+`SearchRequest.anchors`（`AnchorCandidate[]`）+`AnchorCandidate`/`AnchorStatus`/`AnchorResolution`。
13. `src/tools.ts`：deep_search 参数 +`anchors`（minItems 1 + 子对象 required:["text","required"]）+ 转发。
14. `src/prompts/loader.ts`：TOOL_KEYS +`deep_search.param.anchors` +`deep_search.out.anchorResolution`。
15. `prompts/zh/tools.md`：+anchors 参数契约 +anchorResolution 输出。
16. `prompts/zh/system-guide.md`：query 定稿措辞（对象名/计划/命令/文件名/路径/会话 ID 放 anchors；方案/流程/现状不当锚点）。
17. `src/selfcheck-tools.ts`：+anchors 转发断言 +anchorResolution 契约断言 +`deepSearchRead` 断言。
18. `src/prompts/selfcheck.ts`：system-guide 断言改（anchors + deep_search + 首轮先读源目录）。

### 版本

19. `package.json`：`0.2.0` → `0.4.0`（生产 0.3.1 已含 read/routing，本轮锚点升次版本）。

### 验证

- build（tsc）exit 0；lib/ 含 read/routing/anchors 编译产物。
- selfcheck 8 文件全 PASS（api/selfcheck、api/selfcheck-mode、selfcheck-tools 12、selfcheck-guidance、selfcheck-catalog、selfcheck-guidance-catalog、selfcheck-source-routing 28、prompts/selfcheck 7）。
- 沙盒真实验证（host lib → 沙盒 Console 6601）10 项 PASS：带锚点 explain→anchorResolution、routing 裁剪（恒有方法块 + read 后提示条件）、无锚点不回归、deep_search_read 全文 + guide。

### 运维说明

- 本版仅工作区源码 + lib；生产同步（插件 0.4.0 → 生产 node_modules + 镜像副本；Console 0.7.3 → 生产 6600）待沙盒验证确认后执行。

---

## 0.3.1 — 2026-11-01 · read 后提示 条件呈现修正（ov_session/wiki 触发）

### 背景

0.3.0 落地后，用户纠正 `read 后提示` 的呈现规则：**不是恒有**，也不按「可 next 的层级源（ov_context / wiki）」触发，而是只在结果列表含**被截断、需 deep_search_read 读全文的源（ov_session / wiki）**时才显示；ov_context / mem0 内容已全量在检索结果中返回，read 用不上，不触发。

### 变更

1. `src/guidance.ts`：`READ_GUIDE_NEEDS` 从 `["ov_context","wiki"]` 改为 `["ov_session","wiki"]`（read 后提示 依赖类别锚定到 deep_search_read 实际适用的源）；`ROUTING_ALWAYS` 仍不含 read 后提示，`renderSourceRouting` 按 `layeredHit` 条件呈现。
2. `src/selfcheck-source-routing.ts`：翻转 3b 组断言——单源 ov_context 不含 read 后提示块、单源 ov_session 含 read 后提示块（原为相反）。
3. `package.json`：版本 `0.3.0` → `0.3.1`。

### 验证

- source-routing 自检：26/26 PASS（沙盒，新增 4 断言 + 调整 3）。
- 编译产物运行时：7 场景全 PASS（mem0+wiki 含 / ov_session 含 / ov_context 不含 / mem0 不含 / ov_session+ov_context 含 / wiki+ov_context 含 / 空命中不含）。
- 生产冒烟（真实 deep_search）：仅 ov_context 不含、仅 ov_session 含、仅 wiki 含、混合（mem0+ov_context+ov_session）含——4 用例全符合新规则。

### 运维说明

- 生产同步：两处 `lib/guidance.js`（`~/.dsh/profiles/web/node_modules/deep-search` + 镜像副本）md5 一致（`6fe33b0f`）；`package.json` 两处版本一致（`0.3.1`）。
- 备份：`deepsearch-routing-readguide-20261101-054900`（恒有版 388c92cb）+ `deepsearch-version-0.3.1-20261101-050022`（0.3.0 package.json）+ `deepsearch-changelog-0.3.1-20261101-050149`（0.3.0 CHANGELOG）。
- 热重载：`dev_reload_package("deep-search")`（清 7 模块、重建 1 fiber，免全量重启）。
- 回退：备份文件覆盖对应路径 + 重启 DSH。

---

## 0.3.0 — 2026-10-31 · source-routing 路线指引 + deep_search_read 全文读取

### 背景

0.2.1 之后，`deep_search` 返回结果缺少下一步决策指引——Agent 只能凭检索导引（prompt）自行判断是否继续（修改 query / 扩大范围 / deep_search_next / read），来源类别（mem0 / ov_context / ov_session / wiki）的路线（S1/S2）未随结果呈现。用户定稿 source-routing：结果页按本轮**实际命中来源类别**裁剪路线说明，恒有【修改 query 方法】【扩大/更换范围检索方法】【read 后提示】，供 Agent 做下一步决策。

### 变更

#### 新增

1. `prompts/zh/source-routing.md`：定稿 S1/S2 路线——mem0（扁平源，不做 next/read）/ ov_context（层级源，可 next）/ ov_session（扁平源，可 read）/ wiki（层级源，可 read+next）+ 恒有【修改 query 方法】【扩大/更换范围检索方法】【read 后提示】；具体 Wiki 资产及适用内容看【当前源目录】（source-catalog），不硬编码资产名。
2. `deep_search_read` 新工具（第 5 工具）：读取已返回结果全文——ov_session/wiki 返回 DB 全文（闭环检索结果的 400 字截断）；mem0/ov_context 内容已全量在检索结果中返回，本工具返回 `available=false` 与诚实说明，不虚构可用性。

#### 修改

3. `src/guidance.ts`：+normalizeRoutingSource / parseSourceRouting / renderSourceRouting / renderReadGuide（source-routing.md 消费：来源类别归一化、分节解析、按命中来源裁剪、顺序固定、read 后提示提取）。
4. `src/prompts/loader.ts`：SlotName 加 "source-routing"；loadSlots 返回 sourceRouting（整段文档）。
5. `src/tools.ts`：deepSearch 第 3 参 sourceRoutingText→page.routing；deepSearchRead 第 3 参→read.guide；buildTools 第 3 参透传 + readTool（id 必填 + source enum）。
6. `src/index.ts`：buildTools(client, prompts.tools, prompts.sourceRouting)。
7. `lib/api/client.js` + `lib/api/routes.js`：read 路由（POST /read）+ client.read。
8. `prompts/zh/tools.md`：deep_search.out.page 追加 routing 说明 + deep_search_read 段。
9. `prompts/zh/system-guide.md`：新增【来源路线指引】段。

#### 自检

10. `src/selfcheck-source-routing.ts`：19 断言（裁剪/归一化/顺序/空命中/未知源/read 提示）；selfcheck 链接入。

### 验证

- source-routing 自检：19/19 PASS（沙盒，裁剪/归一化/顺序/空命中/未知源/read 提示全过）。
- deep_search_read 契约：5 工具 schema 同构（type/additionalProperties/required/properties）+ client.read→POST /read 调用成功；不破坏现有 4 工具工具集校验。
- dsh 启动影响验证：装配元数据（inject=["tools"]）/ 加载 / apply 注册（5 工具）/ 作用域审计 / DSH 启动红线（apply 绝不抛错）全 PASS。
- 沙盒基础 = 生产 0.2.1（inject + required 工具级数组都有），source-routing 已基于生产基础。

### 运维说明

- 生产同步：`~/.dsh/profiles/web/node_modules/deep-search`（正式）+ 镜像副本 `~/DeepSearch/plugin/deepsearch/`。
- 备份：`dsh backup/DeepSearch/deepsearch-sourcerouting-20261031-1354`（原生产 10 文件）。
- 回退：备份文件覆盖对应路径 + 重启 DSH。

---

## 0.2.1 — 2026-10-31 · Codex 路由最终复验闭环

### 背景

0.2.0 的验证覆盖启动路径（fiber `injectKeys=["tools"]`、`epoch=":99"`、`deep_search_status` 正常、工具列表含四工具），但**尚未用 Codex 路由实际复验**。此前 `tools.js` required 修复后，codex 子智能体仍报 `Invalid schema for function 'deep_search': true is not of type "array"`——静态 schema 已干净，运行时却仍走旧 schema，必须查清并闭环。

### 根因（为何"改了还报错"）

0.2.0 之前启动注册是坏的（cordis 缺 `inject:["tools"]`，`apply()` 早于 tools 服务抛错被吞），codex 子智能体拿到的 `deep_search` 来自**手动探针（`deepsearch_register_probe`）注册进 host 全局 registry 的旧 schema**（`properties.query.required=true` 布尔未删除）。因此只改 `tools.js` 静态内容、不修启动注册时，干净 schema 永远进不了运行时注册路径，子智能体仍拿旧 schema → 仍报错。教训：**仅静态校验/热重载"成功" ≠ 修复生效，必须确认新 schema 进入实际运行时注册路径**。

### 变更

无代码变更（0.2.0 已含 `inject` 声明 + required 修正）；本版为**最终验证闭环**与运维记录。

### 验证（Codex 路由复验）

- 子智能体路由 `openai-codex/gpt-5.6-terra`，prompt 要求检查工具集并实际调用 `deep_search_status`。
- 结果：`deep_search`/`deep_search_next`/`deep_search_status`/`deep_search_sync` 四工具均在工具集；`deep_search_status` 正常返回（coordinator up、mem0/ov_context/ov_session/wiki 4 源 ok）；**无** `Invalid schema`/`true is not of type "array"` 报错；收尾 `CODEX_VALIDATION_DONE`。
- 结论：0.2.0 修复在 Codex 路由下生效，`dsh-llm-openai-codex` 可正常使用 `deep_search*` 工具。

### 教训记忆

- lesson `0mvvdiqo`：双根因（cordis 缺 `inject` + 属性级 `required:true`），双修后 codex 复验通过。
- lesson `0mvvedta`：修复后必须用目标路由（codex）实际复验、确认新 schema 进入运行时注册路径；仅静态校验/热重载不足。

---

## 0.2.0 — 2026-10-31 · 启动自动注册修复 + Codex schema 修复

### 背景

插件启动后 `deep_search` 四工具不出现，只能靠 `deepsearch_register_probe`（staging 工具）用 live ctx 执行 `register()` 补注册，重启即丢。用户诉求：启动时自动注册走通，不能每次手动。

### 根因

`src/index.ts` 只导出 `{apply, name, register}`，**缺 `inject` 声明**。cordis `registry.plugin` 用 `Inject.resolve(plugin.inject)` 得空 map → fiber 不等待任何服务 → 在 `Promise.all` 并行加载下，于 `dsh-tools`（自身 `inject:["systemPrompt"]`）provide `tools` 之前执行 `apply` → `ctx.tools` 属性访问抛 `cannot get property "tools" without inject` → 被 `apply` 的 try/catch 吞掉 → 工具永不注册。

### 变更

#### `src/index.ts`

1. 新增 `export const inject = ["tools"] as const;`（标准 cordis 插件模式，与 dsh-tool-todo/goal/web/fs 一致）。cordis 等 `tools` 服务就绪后才执行 `apply`，`ctx.tools` 可解析，工具自动注册。

#### `src/tools.ts`

2. `required` 字段修正：把 `parameters` 内每个 property 的非标 `required:true` 布尔删除，改为工具级 `required: string[]`（property 名列表）。原布尔形式触发 Codex 后端 "Invalid schema … true is not of type array"。

#### 漂移消除

3. 生产副本（`~/.dsh/profiles/web/node_modules/deep-search`）`tools.js` 的 required 修复原只在生产副本、源码缺 —— 已回写 `src/tools.ts`，重建后工作区 `lib/` 与生产副本 6 文件 md5 全一致。

### 验证

- 构建 `tsc` exit 0；工作区 `lib/` 与生产副本 6 文件 md5 全一致。
- 重启前启动路径模拟（import → unwrapExports → `Inject.resolve(["tools"])` → `{tools:null}` 守卫）+ 一致性审计 + 热重载证据通过。
- **DSH 重启后全新进程终极验证（无 probe 参与）**：fiber `injectKeys=["tools"]`、`hasToolsInStore=true`、`epoch=":99"`（tools uid 99 就绪后 apply 执行）、`state=2` 无 error；`deep_search_status` 正常（coordinator up、4 源 ok）；工具列表已含 deep_search 四工具。startup apply() 自动注册闭环，不再需要 `deepsearch_register_probe`。

### 运维说明

- 备份：`~/.dsh/profiles/web/node_modules/deep-search/lib/index.js.bak-v49-20261031032649`（pre-inject）、`tools.js.bak-required-fix-20261031-0317`（pre-required-fix）。
- 回退：备份文件覆盖对应路径 + 重启 DSH。

---

## 0.1.0 — 2026-10-30 · 初始版本

- host 插件：注册 `deep_search` / `deep_search_next` / `deep_search_status` / `deep_search_sync` 四工具 + 检索导引注入 + 侧边栏只读卡片（适配层，转发 DeepSearch Console :6600）。
- 生产同步：Console 6600（mode=production，`deepsearch.config.json`）、插件生产副本、wiki（4062 块 / toc 757 / nav 5359）、session（59156 块）。
- 沙盒验证：V1–V30 全 PASS，C1/C2/C5 PASS（C3/C4 部分/待办）。
