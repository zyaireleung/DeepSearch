# DeepSearch 工具说明（调用前必读）

> 插件会在需要调用某工具前被动呈现匹配的完整小节，说明适用场景、执行方式、上下游衔接与停止条件；真正发起调用时，参数由 DSH 原生工具 schema 呈现，其文案来自 `tools.md`。

## deep_search

> 本地全部数据源信息检索

### 【查什么】

- **想起某件事，但对象不清楚**：优先使用 `method: "fuzzy_mem0_find"` 或 `method: "fuzzy_full"`，从记忆和蒸馏上下文中找线索。
- **找已经定下的结论、偏好、决策**：使用 `sources: ["ov_context"]`；有可信 `sessionId` 时一并传入以聚焦。
- **找原话、过程、时间顺序、文件名或路径片段**：使用 `sources: ["ov_session"]`，query 以可信专名、文件名、路径片段、数字等锚点为主。
- **找某个知识库里的正文**：使用 `sources: ["wiki:<code>"]`；`<code>` 必须来自【当前源目录】。不知道资产归属时搜全部 `wiki`。
- **需要跨来源确认**：先用 mem0 / ov_context 定位，缺原文再查 ov_session，缺知识正文再查相应 wiki。

### 【参数怎么组合】

- `query` 写“对象 + 要了解的方面”；技术标识、版本号、会话 ID 等能唯一指对象的内容才适合成为 anchors。
- 对象不明确用 `method`；来源明确用 `sources`。两者二选一，不同时传。
- `sessionId` 只用用户明确给出、或真实结果携带的可信值，不推测。
- `carry`、`visited`、结果 id 与 direction 都必须原样取自上轮结果，不自行构造。

### 【数据源里有什么】

- `mem0`：碎片化场景记忆、已知偏好与线索；没有层级方向。
- `ov_context`：会话蒸馏出的结构化结论、共识、决策；可沿真实关系展开。
- `ov_session`：历史会话原文块，适合原话、过程与时序；没有层级方向。
- `wiki`：已启用知识库里的内容块、知识点、总览、关联与引用。
- `wiki:<code>`：具体启用资产；code 与用途以【当前源目录】为准。

### 【来源路线指引】

结果页的 `routing` 会按本轮实际命中的来源裁剪下一步路线，并给出修改 query、扩大或更换范围的方法。只在结果含 ov_session / wiki 这类被截断内容时，才会提示 `deep_search_read`。

### 【检索结果信息不足时】

先判断缺口：缺原话查 ov_session；缺结论查 ov_context；缺知识正文查 wiki；同源结果偏题则改 query，不盲目带回旧 visited。层级结果有 `next.available=true` 才用 `deep_search_next`；本机源仍不足、或问题本质需要外部最新信息时，转 `deep_search_web`。

## deep_search_next

> 沿 deep_search 已返回结果的真实关系继续展开

### 【什么时候展开】

只有某条结果明确返回 `next.available=true`，且 agent 需要继续查看它的上层、同级、引用或目录关系时才调用。mem0 / ov_session 是扁平源，没有方向，不使用本工具。

### 【沿什么展开】

使用结果真实返回的 `id` 与 `next.directions`。一次只选一个方向：up / across / back / global / root / auto；方向未返回时不猜造。已有 step、method、origin、params 等导航载荷时原样传递。

### 【展开后怎么走】

读取本轮 `next` 返回的新载荷：若已得到所需正文则停止；若又返回可用方向，可继续一层；若只有定位信息，可结合真实 carry 回到 `deep_search` 重新检索；若需要读取截断正文，转 `deep_search_read`。

### 【什么时候停止】

`next.available=false`、目标内容已经出现、重复回到已访问节点、或继续展开不再缩小问题时停止。不要用 next 代替一次新的关键词检索。

## deep_search_read

> 读取 deep_search 结果中被截断的全文

### 【什么时候读】

结果来自 ov_session / wiki，摘要不足以支撑回答、需要核对原话或完整正文时读取。只有真实返回过的结果 id 才能读。

### 【读的是什么】

- ov_session：对应历史会话原文块的完整文本。
- wiki：对应知识库内容块的完整正文与可用元数据。
- mem0 / ov_context：结果中已经是全量内容，read 会诚实返回 `available=false`，不是读取失败。

### 【怎么读】

直接传结果 id；source 可由 id 推导，只有明确需要时才指定。不要凭标题、URL 或自己拼接的字符串伪造 id。

### 【读完怎么做】

把全文与原结果、claim 或当前回答目标对照：正文足够则用于回答或证据判定；出现新实体或线索时，把真实标识带回 `deep_search` 继续检索；发现正文与摘要不一致时，以正文为准并说明差异。

### 【什么时候不该读】

mem0 / ov_context 已全量返回时；摘要已经足够回答时；没有真实结果 id 时；想查另一个对象时——这些情况应直接回答或重新 `deep_search`。

## deep_search_status

> 检查协调器与设备内数据源健康状态

### 【什么时候检查】

检索返回 unavailable / timed_out、怀疑某源断开、数据可能陈旧、或多次检索异常为空时检查。不要把服务故障误判成“没有相关内容”。

### 【检查什么】

检查协调器、mem0、ov_context、ov_session、wiki 的可用状态、同步时间与错误说明。本工具不检索内容，也不会修复或同步数据。

### 【检查后怎么处理】

源正常：回到检索，调整 query / sources。源不可用：换可用来源或等待恢复。数据陈旧：评估是否需要 `deep_search_sync`。协调器不可达：先恢复 Console，再重试检索。

## deep_search_sync

> 维护 Wiki 与会话等本地镜像索引

### 【什么时候同步】

确认数据源目录或索引需要刷新、已有新资源需要纳入检索、或 status 明确显示同步陈旧时使用。普通“没有搜到”不能直接推导为需要同步。

### 【同步什么】

同步 Console 管理的 Wiki / 会话镜像或请求的资源范围。具体目标以预览返回为准；本工具不是内容检索工具，不会直接给出答案。

### 【如何安全执行】

先 `dryRun=true` 预览影响范围；真实写入、全量 rebuild 或可能覆盖现有索引前必须取得明确授权。不要把“查询没结果”与“需要全量重建”混为一谈。

### 【同步后怎么确认】

queued 只表示任务已提交，不代表完成。等待同步完成后用 `deep_search_status` 检查状态，再用原 query 重跑 `deep_search` 验证结果变化。

## deep_search_web

> 网络信息综合检索

### 【查什么】

设备内 `deep_search` 查不到，或问题本质需要最新、权威、设备外信息时使用：通用网页、官方文档、GitHub、博客、被墙站点与公开网页中的舆情报道。适合需要多个子问题、多个渠道互证的研究任务。

### 【怎么查】

先把问题拆成 claims，并为每个 claim 选择真正需要的 `required_evidence`。调用 `deep_search_web` 创建任务后，按 `deep_search_step → deep_search_reflect` 循环：step 取证，reflect 判定 supported / refuted / uncertain，必要时追加子问题；全部 claim 完成或触发断路器后用 `deep_search_report` 汇总。

### 【去哪里查】

- `general_web`：通用网页、新闻、百科，走 Wigolo direct。
- `official_docs`：官方文档、发行说明、API 参考，走 Wigolo direct。
- `restricted_web`：Google / YouTube / X 等被墙站点，走 Wigolo restricted；`claim.question` 带目标域名。

web claim 只认上面三个渠道，没有社媒渠道。社媒数据一律走 `deep_search_crawl`（单平台定向）或 `deep_search_fanout`（多分支并行，可 web+crawl 混编），不放进 `deep_search_web` 的 claim。

### 【怎么规划研究路线】

先列出可独立判定的 claims，给每个 claim 一个证据类型，不堆无关渠道。优先解决高优先级且无依赖的 claim；有依赖的 claim 等前置问题有结论后再检索。每轮只推进真实待办 claim，证据不足就反思缺什么，而不是重复同一 query。

### 【网关不可用时】

若返回 `gateway_unreachable`：到 DSH 的 plugin-service-manager 启动 n8n server，确认 `http://localhost:5678/healthz` 正常。healthz 正常但 webhook 404：到 n8n UI 激活 research-gateway workflow。按返回的 remediation 修复后重试。

## deep_search_step

> 对网络研究任务的下一个待办 claim 执行一轮取证

### 【什么时候执行】

`deep_search_web` 已创建 run，并返回 `next_pending_claim` 时执行。没有待办 claim、任务已完成或已触发停止条件时不调用。

### 【本轮做什么】

读取最高优先级待办 claim，按其 `required_evidence` 调网关选择渠道，把本轮新证据去重入库并关联到 claim。它只负责一轮取证，不负责判定 claim 真伪。

### 【结果怎么判断】

查看 `evidence_added`、证据内容、诊断信息和 `next_pending_claim`。只要实际完成了一个 claim 的取证轮，无论新增证据是否为 0，都转 `deep_search_reflect` 判定本轮证据；step 自身不判定 claim，也不直接生成报告。

### 【下一步怎么走】

完成取证轮 → `deep_search_reflect`；调用前已无待办 claim → 不虚构后续动作；网关故障 → 按 remediation 恢复。是否继续取证或生成报告，只由 reflect 的真实判定结果决定。

## deep_search_reflect

> 反思本轮证据并推进 claim 状态

### 【什么时候反思】

某 claim 已完成至少一轮取证、需要判断证据是否足够，以及是否还需新增子问题时调用。未取证 claim 不提前判定。

### 【判定什么】

- `supported`：已有证据足以支持 claim。
- `refuted`：已有证据足以反驳 claim。
- `uncertain`：证据不足、冲突或无法可靠判断。

判定必须对应实际证据，不能为了结束任务把 uncertain 强行标 supported。

### 【反思后怎么走】

全部 claim 已判定 → `deep_search_report`。仍有待办 → `deep_search_step`。当前 claim uncertain 且缺口明确 → 追加针对缺口的新 claim，再进入 step。触发 max_rounds / max_gateway_calls / max_minutes / no_progress 时停止扩张并诚实报告限制。

## deep_search_report

> 汇总网络研究任务中的问题、claim 判定与证据

### 【什么时候生成】

全部 claim 已判定，或任务因预算、时间、no_progress 等断路器停止时生成。中间仍有可继续推进的待办 claim 时不要提前 report。

### 【汇总什么】

汇总研究问题、各 claim 的状态、真实证据 URL 与支撑关系、未解决项及停止原因。证据为空或某 claim uncertain 时如实呈现，不虚构结论。

### 【报告怎么使用】

工具返回 `markdown` 正文供 agent 整理成最终回答；`.tmp` 中的 meta / result / raw 是证据底座。需要面向用户的 Form / Report 时，再按模板生成，不把报告正文误当原始证据。

## deep_search_crawl

> 网络社媒信息独立检索

### 【查什么】

已经锁定“某个平台 + 具体搜索词 / 内容 ID / 创作者主页”，只需要这批社媒数据时使用。例如先通过文件名找到原始 URL，再从 URL 提取内容 ID，抓指定作品详情与评论。目标不明确时，改走 `deep_search_web`；公开网页与社媒需求混用时，改走 `deep_search_fanout`。

### 【怎么查】

选择平台与抓取类型：search 用 keywords；detail 用 specified_id；creator 用 creator_id。缺少对应 selector 会失败。工具绕过网关直调 MediaCrawler，只读取本次新建或追加的 jsonl 行，复制原始产物到 `.tmp/raw/` 并渲染 result.md。

### 【去哪里查】

规范平台 ID 为 xhs / zhihu / douyin / bilibili / weibo / kuaishou / tieba；也接受短别名 dy / bili / wb / ks。动态平台目录存在时以其中值为准。依赖 Thorium 9222 正常、目标平台登录态有效；平台受限、登录过期或风控时应停止并说明，不伪造抓取结果。

### 【和 fanout 怎么选】

- 公开网页与社媒都要、或多个社媒平台一起跑 → `deep_search_fanout`（web 分支 + crawl 分支并行编排）。
- 只跑单个社媒平台的定向抓取 → `deep_search_crawl`。
- 社媒是综合研究的一部分，需要与网页、官方文档共同判断 → 用 `deep_search_fanout` 混编；若已单发 crawl，由 agent 与 web 报告统一综合，不写入 web run。

### 【抓取后怎么做】

先核对 `count`、`new_files`、`raw_records` 与 `.tmp` 落盘；字段缺失保持 N/A / null。抓到原始记录后，可直接回答特定问题；需要综合研究时，由 agent 与其它检索结果统一判断，不虚构写入 web run。

## deep_search_fanout

> 编排一轮多分支设备外检索

### 【什么时候用】

需要多个公开网页分支、多个社媒平台，或网页与社媒混合检索时使用。单个 web 研究任务用 `deep_search_web`；单个社媒平台定向抓取用 `deep_search_crawl`。

### 【branches 怎么发】

每个分支只负责一个独立问题，并使用唯一 `id`。web 分支传 `query`；crawl 分支传 `platform`、`type` 及对应 selector。站点与平台只用当前目录提供的真实值。

### 【执行约束】

web 分支并行；crawl 分支因共用 Thorium 登录态而串行；web 与 crawl 同时推进。不要把多个 crawl 拆成并行工具调用。

### 【结果后怎么走】

逐分支检查 `ok`、`count`、结果与错误，由 agent 统一综合。下一轮只重发仍不足或值得重试的分支；信息已足够的分支不再重发。
