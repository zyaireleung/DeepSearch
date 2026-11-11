# 工具文案（键 = <tool>.description / .param.<n> / .out.<path>）
# 缺键加载即报错（V21）；新增键须同步 src/prompts/loader.ts 的 TOOL_KEYS 与 src/tools.ts 注册。

# --- deep_search ---
deep_search.description: 检索 mem0、ov_context、ov_session 和已启用的 Wiki。必填 query；用 sources 指定来源，或用 method 选择预设组合。返回各源状态、混排结果及可续查标识。
deep_search.param.query: 必填非空字符串；写要查的对象和信息缺口。
deep_search.param.sources: 可选字符串数组；可用 mem0、ov_context、ov_session、wiki 或当前源目录中的 wiki:<code>。wiki 表示全部资产；未传时按 method 或 carry 确定来源。
deep_search.param.precision: 可选 auto / literal / semantic，默认 auto；当前执行器不保证按此字段切换检索方式。
deep_search.param.sessionId: 可选字符串；只传用户给出或结果真实携带的会话 ID。fuzzy_mem0_search 必须传；限定 ov_session 时应使用含 sessionId 的 carry。
deep_search.param.includeSearch: 可选布尔值，默认 false；兼容字段，当前不改变来源或检索方式。
deep_search.param.method: 可选字符串，默认 fuzzy_full。fuzzy_mem0_find=mem0+ov_context；fuzzy_mem0_search=同组合且需要 sessionId；fuzzy_full=全部来源。传 sources 时以 sources 为准。
deep_search.param.carry: 可选 CarryPayload 数组；逐项原样传入上一轮结果中的 carry，不自行构造。未传 sources 时按 carry 来源收窄。
deep_search.param.visited: 可选字符串数组；原样取自上一轮 page.visited，仅在需要跳过已访问能力时传入。
deep_search.param.explain: 可选布尔值，默认 false；true 返回分项解释，不改变排序。
deep_search.param.anchors: 可选对象数组，每项 {text, required}。只传能唯一指向对象的可信技术标识或明确名称。
deep_search.out.page: 返回 level、method、complete、verdict、visited、sources、results 和按命中来源裁剪的 routing；续查时只使用真实返回的标识。
deep_search.out.verdict: narrowed=已收窄；miss=未达到收窄判据，不等于零结果；invalid_request=参数无效。
deep_search.out.complete: 表示本轮结束；是否成功检索各源仍须查看 sources[].status。
deep_search.out.sources: 每源执行状态与结果数；异常时查看 note、error 或 hint。
deep_search.out.results: 混排结果；可含 carry、explain 和 next。next.available=true 时，用该结果 id 和 next.directions 调用 deep_search_next。
deep_search.out.anchorResolution: explain=true 且传 anchors 时返回锚点状态；ambiguous 或 unresolved 时更换更明确的标识。

# --- deep_search_next ---
deep_search_next.description: 沿 deep_search 结果的关系或目录继续导航。必填 id 和 direction；返回导航载荷、结构化数据或不可用原因。
deep_search_next.param.id: 必填字符串；原样使用要展开的 deep_search 结果 id。
deep_search_next.param.direction: 必填字符串；每次选择该结果 next.directions 中的一个方向。
deep_search_next.param.step: 可选 S1 / S2 / S3；结果已有明确步数时原样传入。
deep_search_next.param.method: 可选字符串；结果已有原检索方法标识时原样传入。
deep_search_next.param.visited: 可选字符串数组；原样传入已访问节点，避免重复导航。
deep_search_next.param.origin: 可选字符串；结果已有可信起点时原样传入。
deep_search_next.param.query: 可选字符串；用于筛选目录或索引导航。
deep_search_next.param.pattern: 可选字符串；glob 传文件名通配，grep 传内容正则；这两个方向必须提供。
deep_search_next.param.params: 可选对象；传入当前方向需要的路径、分页或范围约束。
deep_search_next.param.inline: 可选布尔值，默认 false；true 请求附带内容。
deep_search_next.param.limit: 可选正整数；限制返回数量。
deep_search_next.out.next: 返回 available、directions 及可选 payload、suggest、reason。关系导航返回定位载荷；目录与搜索方向返回结构化数据。

# --- deep_search_status ---
deep_search_status.description: 查询协调器及各源的健康快照；无参数。返回 status，不检索内容，也不触发同步。
deep_search_status.out.status: 包含 coordinator、sources、snapshotAt；各源记录含 source/status，可有 synced/lastSuccessfulSyncAt/note。源不可用或 stale 与检索无命中是不同状态。

# --- deep_search_sync ---
deep_search_sync.description: 向 Console 提交索引同步任务；无参或 dryRun=true 为预览，dryRun=false 才可能真实写入。不用于普通检索；执行写入前须取得明确授权。
deep_search_sync.param.dryRun: 可选布尔值，默认 true（预览且不落库）；只有明确授权真实同步时才传 false。
deep_search_sync.param.rebuild: 可选布尔值，默认 false；true 请求全量重建，仍受 dryRun 控制；不要将其与“查询没有结果”混同。
deep_search_sync.out.result: 返回任务提交结果（jobId/state/dryRun/target）；state=queued 仅代表已排队，不代表同步完成。此工具当前不提供按 jobId 查询任务完成状态的参数。

# --- deep_search_read ---
deep_search_read.description: 读取 deep_search 某条已返回结果的全文内容。必填 id；source 可缺省（由 id 前缀推导）。ov_session/wiki 返回 DB 全文（闭环检索结果的 400 字截断）；mem0/ov_context 内容已全量在检索结果中返回，本工具返回 available=false 与诚实说明，不虚构可用性。
deep_search_read.param.id: 必填字符串；要读取全文的 deep_search 结果 id（ov_session=chunk id；wiki=wiki:<asset>:<block>；ov_context=ov_context:<uri>）。
deep_search_read.param.source: 可选字符串；结果源（ov_session/wiki/ov_context/mem0），缺省由 id 前缀推导。
deep_search_read.out.read: 读取响应，含 id/source/available；available=true 时有 text（全文）与可选 title/meta；available=false 时读 reason（诚实说明，不虚构可用性）。

# --- deep_search_web（网络检索）---
deep_search_web.description: 开启一次公开网络研究任务（DSH + n8n + Wigolo）。必填 run_id 与 question；intent 调整研究优先级，claim.required_evidence 选择证据渠道。返回 state 与 next_pending_claim，后续用 deep_search_step 逐轮取证。
deep_search_web.param.run_id: 必填字符串；本次检索任务的唯一 id（如 r2611071104a1b2）。
deep_search_web.param.question: 必填字符串；本次检索要回答的问题原文。
deep_search_web.param.intent: 可选字符串，technical / social / code / general，默认 general。只影响研究优先级，不启用社媒抓取；真实社媒数据走 crawl 或 fanout。
deep_search_web.param.claims: 可选对象数组，把问题拆成子问题；每项 {id, question, required_evidence?, priority?, depends_on?}。required_evidence 是决定走哪个渠道的主信号（general_web / official_docs / restricted_web）；一个 claim 只声明它真正需要的能力，不要堆多个能力标签（会扩大路由范围，可能触发双跑）。查官方文档/通用 Web 用 general_web 或 official_docs；查被墙站点（google/youtube/x/instagram）用 restricted_web 并在 question 带目标域名（如 site:youtube.com ...）。社媒数据不放进 deep_search_web 的 claim——单平台定向用 deep_search_crawl，公开网页与社媒混编或多分支并行用 deep_search_fanout。
deep_search_web.out.state: 检索任务状态（claims/evidence/round/budget/status）。ok=false 时读 stop_reason（gateway_unreachable / gateway_error）。
deep_search_web.out.next_pending_claim: 下一个待取证的 claim（含 id/question/required_evidence）；null 表示当前无待办，转 deep_search_reflect 判定或 deep_search_report 出报告。

# --- deep_search_step（网络检索）---
deep_search_step.description: 对 deep_search_web 开启的任务执行一轮取证：取下一个待办 claim 调 n8n 网关选渠道检索，证据去重入库。必填 run_id。返回新增证据数与下一个待办 claim；连续两轮无新增会触发 no_progress 停止。
deep_search_step.param.run_id: 必填字符串；deep_search_web 返回的 run_id。
deep_search_step.out.state: 更新后的检索任务状态（新增证据已带 claims 标注来源 claim）。
deep_search_step.out.evidence_added: 本轮新增去重证据条数；0 表示本轮无进展。
deep_search_step.out.next_pending_claim: 下一个待取证 claim；null 表示已无待办。
deep_search_step.out.diagnostics: 网关诊断（config_version 等）；ok=false 时读 stop_reason。

# --- deep_search_reflect（网络检索）---
deep_search_reflect.description: 对已取证 claim 做判定并推进状态机，可补充新子问题。必填 run_id 与 decisions（每个 {claim_id, verdict}，verdict 取 supported / refuted / uncertain）；可选 new_claims 追加子问题。全部 claim 判定完或触发预算/无进展断路器时任务 completed。
deep_search_reflect.param.run_id: 必填字符串；deep_search_web 返回的 run_id。
deep_search_reflect.param.decisions: 必填对象数组；每项 {claim_id, verdict}，verdict 取 supported / refuted / uncertain。只判定已取证 claim，未取证的不判定。
deep_search_reflect.param.new_claims: 可选对象数组；追加子问题 [{id, question, required_evidence?, priority?, depends_on?}]，id 不得与已有 claim 重复。
deep_search_reflect.out.should_stop: true 表示任务应结束（读 stop_reason：max_rounds / max_gateway_calls / max_minutes / no_progress / no_pending）。
deep_search_reflect.out.state: 判定后的检索任务状态。

# --- deep_search_report（网络检索）---
deep_search_report.description: 汇总一次网络检索任务的报告（markdown）。必填 run_id。返回报告正文；证据为空时也会如实呈现，不虚构。
deep_search_report.param.run_id: 必填字符串；deep_search_web 返回的 run_id。
deep_search_report.out.markdown: 报告 markdown（问题 / claims 判定 / 证据清单含支撑 claim）。落盘的 .tmp 明细见 Crawler Result/.tmp。

# --- deep_search_crawl（网络检索单发）---
deep_search_crawl.description: 单发社媒抓取（直调 MediaCrawler，绕过 claim/网关）。必填 platform 与 type；search 需 keywords，detail 需 specified_id，creator 需 creator_id。返回新产 jsonl 的解析记录并落盘到 Crawler Result/.tmp。依赖 Thorium(9222) 在跑且平台登录态有效；抓取失败/超时会返回 ok=false 与错误。
deep_search_crawl.param.platform: 必填字符串；规范平台 ID 为 xhs / zhihu / douyin / bilibili / weibo / kuaishou / tieba；短别名 dy / bili / wb / ks 也接受。动态平台目录存在时以其中值为准。
deep_search_crawl.param.type: 必填字符串；search（关键词搜索）/ detail（指定内容 ID）/ creator（指定创作者主页）。
deep_search_crawl.param.creator_id: type=creator 时必填字符串；创作者主页 ID。
deep_search_crawl.param.specified_id: type=detail 时必填字符串；内容 ID（多个用英文逗号分隔）。
deep_search_crawl.param.keywords: type=search 时必填字符串；搜索关键词。
deep_search_crawl.out.raw_records: 新产 jsonl 解析出的记录（title/likes/comments/collects/shares/publish_time/url；平台不提供的字段标 N/A，抓取失败标 null）。
deep_search_crawl.out.new_files: 本次新产/追加的 jsonl 文件路径（已复制进 .tmp 的 raw/）。
deep_search_crawl.out.count: 新增记录条数；ok=false 时读 error。

# --- deep_search_fanout（网络检索并行编排）---
deep_search_fanout.description: 编排一轮多分支设备外检索。一次调用返回全部分支的状态、时间、结果或错误。
deep_search_fanout.param.branches: 必填数组；本轮要推进的分支列表。每项 kind="web"（公开网页，字段 query 必填、evidence_needs/intent/limit 可选）或 kind="crawl"（登录态社媒，字段 platform 与 type 必填、search 需 keywords、detail 需 specified_id、creator 需 creator_id）；两项都带 id 便于对齐结果。
deep_search_fanout.out.branches: 逐分支结果数组，顺序同输入。每项含 id、kind、ok、status、start、end、durationMs，web 分支另含 results（证据数组）与 count，crawl 分支另含 raw_records、count、output_dir；失败分支含 error，单分支失败不影响其它分支。
deep_search_fanout.out.summary: 汇总 {total, ok, failed}——本轮分支总数、成功数、失败数，供快速判断是否还需下一轮。

# --- deep_search_guide（三类 route 的被动工具引导）---
deep_search_guide.description: 按当前信息缺口选择 route，返回匹配入口工具及方法说明。web/social 默认附共享 fanout 方法，include_fanout=false 可关闭；对应目录由 deferred context 呈现，参数由 DSH 原生工具 schema 提供。
deep_search_guide.param.route: 必填字符串；当前信息缺口所属路线，只能是 local / web / social。
deep_search_guide.param.include_fanout: 可选布尔；默认 true。web/social 是否附共享 fanout 方法。混合场景先取 web（默认），再取 social({include_fanout:false})，避免重复文案。
deep_search_guide.out.result: 返回对象只含 route、tool、guide；guide 含入口工具小节，web/social 默认另含共享 fanout 小节（include_fanout=false 时不含）。不返回 catalog、catalogSource 或 parameters；目录由 deferred context 呈现。
