# DeepSearch 检索导引

> 首轮先读【当前源目录】。目录列出当前可用的源、启用的 `wiki:<code>` 及其说明；目录外的源不可臆造。需要继续时，只使用本轮结果实际给出的 `carry` 或 `next`。

## 【查什么】

- **想起某件事，但对象不清楚**：使用 `deep_search`，优先 `method: "fuzzy_mem0_find"` 或 `method: "fuzzy_full"`，从记忆和蒸馏上下文中找线索。
- **找已经定下的结论、偏好、决策**：使用 `deep_search`，`sources: ["ov_context"]`；有可信 `sessionId` 时一并传入以聚焦。
- **找原话、过程、时间顺序、文件名或路径片段**：使用 `deep_search`，`sources: ["ov_session"]`，`precision: "literal"`。query 以可信的专名、文件名、路径片段、数字等锚点为主，不要附加“在哪/路径/位置”等泛意图词。
- **找某个知识库里的正文**：使用 `deep_search`，`sources: ["wiki:<code>"]`；`<code>` 必须来自【当前源目录】。不知道资产归属时，使用 `sources: ["wiki"]` 搜全部启用 Wiki。
- **需要跨来源确认**：使用 `deep_search`；先以 `sources: ["mem0","ov_context"]` 定位对象，缺原文再加 `ov_session`，缺知识正文再加对应 `wiki:<code>`。
- **已找到层级结果，想顺着真实关系继续展开**：仅当结果 `next.available=true` 时，使用 `deep_search_next({ id, direction })`；`id` 与 `direction` 都来自该结果。
- **确认源是否可用、数据是否同步或可能陈旧**：使用 `deep_search_status`；检索出现 `unavailable` 时也先查它。
- **维护 Wiki 或会话的本地镜像索引**：使用 `deep_search_sync`；普通检索不调用，默认先 `dryRun: true`。

## 【参数怎么组合】

- `query`：本轮要找的对象及其问题方面。命令、文件名、路径、端口、版本号、会话 ID 等能唯一指对象的技术标识，以及已确认的明确名称，优先保留并放入 `anchors` 作为候选。方案、流程、现状、验证、沙盒等通常只是要了解的方面，保留在 query 中但不当锚点。普通专名、泛词（不唯一指对象）只写 query，不放进 anchors。复合名称仅在整体能唯一指向同一对象时才作为一个锚点；不确定则只写 query，不编造别名或 ID。
- `sources`：明确选择来源；例如 `["mem0","ov_context"]`、`["ov_session"]`、`["wiki:history-wiki"]`。`wiki:<code>` 的 `code` 由目录给出。
- `method`：不确定对象时使用 `fuzzy_mem0_find` 或 `fuzzy_full`；已明确来源时使用 `sources`，不同时传 `method` 与 `sources`。
- `sessionId`：仅可信来源可用——用户原话直接包含 / `ov_context` 结果自带 / `ov_session` 结果自带 / 检索结果内容自身明确携带。没有确信的 `sessionId` 就不要传；不能凭来源或文本猜造。需要会话筛选却缺失时会返回 `SESSION_ID_REQUIRED`。
- `carry`：上一轮已验证的检索证据与上下文。原样回传，不编造。带 `sources` 时按 `sources` 执行（可跨源，`carry` 不限定来源、不与 `sources` 求交集）；不带 `sources` 时按 `carry` 来源收窄。
- `deep_search_next({ id, direction })`：只在结果的 `next.available=true` 时调用；一次只选一个方向。

## 【数据源里有什么】

- `mem0`：碎片化场景记忆，适合先找线索和已知偏好；没有层级方向。
- `ov_context`：已提交会话蒸馏出的结构化上下文，适合结论、共识、决策；可按真实关系继续。
- `ov_session`：已同步的历史会话原文块，适合原话、过程与时序；没有方向，不能沿链深挖。
- `wiki`：所有已启用 Wiki 的知识点集合，适合不确定资产归属时的集合检索；知识点是结构化内容集合（内容块、知识点页、总览页、关联与引用），可按真实关系继续。
- `wiki:<code>`：一个已启用 Wiki 资产。`code` 是工具参数；资产用途与范围看【当前源目录】中的动态说明。

## 【来源路线指引】

`deep_search` 返回的结果页会附带 `routing`：按本轮**实际命中的来源类别**（mem0 / ov_context / ov_session / wiki），从 `source-routing.md` 裁剪对应来源的路线说明，并恒有【修改 query 方法】与【扩大/更换范围检索方法】。需要扩大/更换范围时，先读【当前源目录】（source-catalog）确定具体来源与说明，不靠来源名或 `wiki:<code>` 臆测内容。

## 【检索结果信息不足或者相关度不高时】

检索按“首轮检索 → 次轮检索 → 深入扩散”循环，每步都以实际返回结果为准，不猜测未执行的来源、`carry`、`sessionId`、`id` 或 `direction`。

**首轮检索：定位线索。** 使用 `deep_search`，按目的选择 `method` 或 `sources`。检查实际查过哪些来源、哪些结果有用、还缺什么；`method` 是已经执行的来源组合，其中包含的来源不能误当成尚未检索。

**次轮检索：带着线索补证。** 有相关结果但信息不全，携带其返回的 `carry`，结合新锚点与信息缺口选择下一轮范围：缺原话、过程、时序查 `ov_session`；缺结论、决策查 `ov_context`，需要场景记忆可组合 `mem0`；缺知识内容查 `wiki:<code>`，归属不明查 `wiki`。已有可信 `sessionId` 时可聚焦会话。结果偏题则调整 query 或换来源，不必强带无关结果；同源重查应有新线索或范围变化。

**深入扩散：沿有用结果展开。** `ov_context`、`wiki` 的结果提供可用方向（`next.available=true`）时，用 `deep_search_next` 沿实际返回的层级、关联或引用继续；`mem0`、`ov_session` 没有此类方向，转入次轮检索。每次返回后重新判断：信息够了就停止，不足就继续展开或回到次轮补证。

**参数约束：** `method` 与 `sources` 二选一；`carry` 原样传递，标识与方向只取自真实结果，避免重复走过的关系（`visited`）。源不可用时用 `deep_search_status` 排查，不把故障当作“没有相关内容”。
