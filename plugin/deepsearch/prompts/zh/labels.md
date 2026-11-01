# 短文案与错误纠正语（键 = error.hint / direction / source / verdict 等）
# 缺键加载即报错（V21/V25）；文案引用 code 全在注册表，新增 code 须补 guide+suggest。

# --- error.hint（可执行纠正语，非失败通知）---
error.invalid_request: 请求参数不合法，请检查 query/sources/precision/sessionId 后重试。
error.session_id_required: 先用 ov_context_find 检索，取结果里的 sessionId 再带 sessionId 重试；或问用户是哪个会话。
error.session_not_ready: 该会话尚未 commit，改用 ov_session 或 ov_context_find；勿重试同一 sessionId。
error.param_conflict: method 与 sources/precision 互斥，二选一。
error.coordinator_down: Console 不可用，本轮无法检索；如需检索请稍后重试（插件不越权自同步）。
error.timed_out: 该源超时，已有部分结果可用；如需该源结果请缩小 query 或减少源后重试。
error.mem0_rank_uncomparable: mem0 分数不可比，已排在末尾；需要跨源排名请以 tier/exact/hit/ov 为准。
error.session_filter_no_match: 该会话下无匹配蒸馏结论；改用 ov_session 查原文或 ov_context_find 去掉会话过滤。

# --- direction ---
direction.up: 沿层级上溯（架构更概括层）。
direction.across: 同层扩展（相关联/同主题）。
direction.back: 回源（uri/provenance 展开）。
direction.global: 跳出当前上下文到全局。
direction.root: 资产/目录根（总览切片）。
direction.auto: 由当前步上下文决定方向集（跨步失效）。

# --- source ---
source.ov_context_find: 结构化历史记忆（ov_context）。
source.ov_context_search: 结构化历史记忆（ov_context，修订 6 起解析为 ov_context_find）。
source.ov_session: 对话原文。
source.mem0: 场景记忆。
source.wiki: 结构化知识点。

# --- verdict ---
verdict.narrowed: 已收窄到可推进的范围。
verdict.miss: 未命中，建议换 query 或扩源。
verdict.invalid_request: 请求不合法，按 error.hint 纠正。
