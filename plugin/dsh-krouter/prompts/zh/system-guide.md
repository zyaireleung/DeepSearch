# KRouter 记忆路由

> 每条消息里被注入的「已注入 KRouter 相关记忆」是自动召回：先读它，够回答就别调工具；它的正文自带判据，按正文说的办；和用户当次说法冲突时听用户的。
> 调用任一 krouter 工具时，宿主会先把该工具的用法说明送进上下文；**说明还没到，就还没执行**，说明到了会要求你重调一次。

## 【八条路由】

- 要原话、更长证据，或确认库里有没有 → `krouter_ask`
- 用户改主意、推翻旧说法 → `krouter_correct`
- 一句值得跨会话记住的事 → `krouter_note`
- 一页项目 / 资料 / 复盘 → `krouter_page`
- 一条换个题材也成立的教训 → `krouter_learn`
- 找已有流程 → `krouter_skill`；查谁改了什么 → `krouter_changes`；看健康与定时 → `krouter_status`
- 想先看规矩、或不确定该填什么 → `krouter_guide`

**判据**：一句话用 note，一页文档用 page，改旧结论用 correct，教训用 learn，查证用 ask。分不清先问 `krouter_guide`。选错工具会写坏库。