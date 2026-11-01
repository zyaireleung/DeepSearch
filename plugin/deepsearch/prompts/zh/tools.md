# 工具文案（键 = <tool>.description / .param.<n> / .out.<path>）
# 缺键加载即报错（V21）；新增键须同步 src/prompts/loader.ts 的 TOOL_KEYS 与 src/tools.ts 注册。

# --- deep_search ---
deep_search.description: 检索 mem0、ov_context、ov_session 和已启用的 Wiki 资产。必填 query；可用 sources 指定来源，或用 method 选择预设组合。返回 page（各源执行状态、混排结果、可续查的 carry/next）。
deep_search.param.query: 必填非空字符串；本轮检索词或问题。例如 {"query":"文件名片段","sources":["ov_session"]}。
deep_search.param.sources: 可选字符串数组；值为 mem0、ov_context、ov_session、wiki 或当前源目录中的 wiki:<code>。wiki=所有已启用资产；wiki:<code>=指定资产，可与其他源或多个资产组合。未传且无 carry 时使用 method 对应的模板（默认 fuzzy_full）；传入 carry 但未传 sources 时，按 carry 的来源收窄。不要把 <code> 当成字面值传入。
deep_search.param.precision: 可选 auto / literal / semantic，默认 auto。当前 Console 执行器尚未按此参数切换检索能力，不能仅凭 literal 断言结果是字面精确匹配。
deep_search.param.sessionId: 可选字符串；仅传用户明确给出的会话 ID、ov_context/ov_session 结果自带的 ID，或结果内容明确携带的 ID，不推测。fuzzy_mem0_search 必须传。当前显式 sources=["ov_session"] 不保证按此参数过滤会话；需要限定 ov_session 会话时，使用含 sessionId 的有效 carry 且不传 sources。
deep_search.param.includeSearch: 可选布尔值，默认 false；兼容字段。当前不改变实际选择的来源或检索模式，不要依靠它增加搜索能力。
deep_search.param.method: 可选字符串，默认 fuzzy_full；fuzzy_mem0_find=mem0+ov_context，fuzzy_mem0_search=同组合且必须有 sessionId，fuzzy_full=mem0+ov_context+ov_session+wiki。例如 {"query":"项目名称","method":"fuzzy_mem0_find"}。fuzzy_* 可与 sources 同传，此时 sources 覆盖模板的来源；通常二选一更明确。exact_single/exact_hybrid 当前宿主拒绝其所需的 sources、Console 又要求 sources，暂不可形成有效调用。
deep_search.param.carry: 可选 CarryPayload 数组，形如 [结果中的 carry]；每项必须是上一轮返回的原对象（含 source/id/kind 等），不可自造。带 sources 时按 sources 检索，carry 不限制来源；不带 sources 时按 carry 来源收窄。单条结果的 carry 对象需包进数组，不能直接传对象。
deep_search.param.visited: 可选字符串数组，取自上轮 page.visited；列入其中的能力本轮会被跳过。只有确实要防止重扫时才回传；换 query 重查同源时不要盲目沿用。
deep_search.param.explain: 可选布尔值，默认 false；true 在结果中附带分项解释，不改变排序。
deep_search.param.anchors: 可选对象锚点候选数组；只传用户明确给出或真实结果已确认的名称、工件或技术标识，不传方案、流程、现状等问题方面。每项 {text, required}：required=true 表示直接回答必须覆盖该对象，false 表示仅缩小范围的技术限定。Console 仅将可唯一解析的候选作为强锚点，歧义或未解析候选自动降级，不影响 query 的正常检索；不传保持旧排序，传入时必须至少一项且每项 text 非空、required 为布尔值。
deep_search.out.page: 返回页对象：level、method、isFullSource、complete、verdict、visited、sources、results；需要续查时使用其中真实返回的标识，不自行生成。routing 为按本轮实际命中来源类别（mem0/ov_context/ov_session/wiki）从 source-routing.md 裁剪的来源路线指引，含恒有的【修改 query 方法】与【扩大/更换范围检索方法】，供下一步决策；具体 Wiki 资产及适用内容看当前源目录（source-catalog），不硬编码资产名。
deep_search.out.verdict: narrowed=达到收窄判据；miss=本轮未达到收窄判据（不等于零结果）；invalid_request=请求参数无效，查看 error。
deep_search.out.complete: 本轮执行完成标记；unavailable 也可能使其为 true，是否真正查到某源须看 sources[].status，不能只看 complete。
deep_search.out.sources: 每源执行记录，含 id/mode/status/count；status 可为 searched、skipped、unavailable、timed_out、degraded、disabled，异常时查看 note/error/hint。skipped 可能由 visited 造成，不等于已在本轮检索。
deep_search.out.results: 混排结果数组；每项含 id/source/title/snippet/score，可有 carry、explain 和 next。carry 是单个对象；next.available=true 时仅用该结果 next.directions 中的方向及其 id 调 deep_search_next。
deep_search.out.anchorResolution: explain=true 且传 anchors 时返回 query 级锚点解析结果；每项 {text, required, status, canonical?, catalogId?}，status 为 resolved（唯一 wiki 绑定）/ technical（技术标识）/ ambiguous（多记录）/ unresolved（未解析）。只有 resolved/technical 参与强锚点排序；ambiguous/unresolved 仍保留普通 query 相关性匹配。

# --- deep_search_next ---
deep_search_next.description: 根据 deep_search 某条结果的 id 与可用方向，查询该结果的关系导航。必填 id 和 direction；返回 next（可用方向、导航载荷或不可用原因），不是新的 deep_search 结果页。
deep_search_next.param.id: 必填字符串；直接使用要展开的 deep_search 结果 id。例如 {"id":"<返回的结果id>","direction":"up"} 中的占位值必须替换为真实 id。
deep_search_next.param.direction: 必填字符串，每次一个；合法值 up / across / back / global / root / auto，且应选自该结果 next.directions。next.available=false 或方向未返回时不要自行猜造。
deep_search_next.param.step: 可选 S1 / S2 / S3；已有明确步数时传，其他情况省略。
deep_search_next.param.method: 可选字符串；已有原检索方法标识时传，其他情况省略；不是参数组合对象。
deep_search_next.param.visited: 可选字符串数组；已有实际返回的 visited 时传，防止重复导航；不手工生成能力标识。
deep_search_next.param.origin: 可选字符串；已有可信的起点标识时传，不用来代替必填 id。
deep_search_next.param.query: 可选字符串；用于需要按当前 query 筛选的目录或索引导航。
deep_search_next.param.params: 可选对象；OV 跳转约束 contextType / category / level / detail，仅按已返回的载荷传入，不自行拼造。
deep_search_next.param.inline: 可选布尔值，默认 false；true 请求直接附带内容而非仅返回导航信息。
deep_search_next.param.limit: 可选正整数；限制本次返回数量。
deep_search_next.out.next: 导航响应，含 available/directions，可有 decisionCode/payload/suggest/reason；available=false 时读 reason，payload 只是返回的导航载荷，不能假定已经取得正文。

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
