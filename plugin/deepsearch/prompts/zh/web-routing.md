# deep_search_web 结果后指引

> 本指引只处理已创建的 web run。首次选 route 看 system-guide；真实社媒数据不属于 web claim。

## 【三个证据渠道】

- `general_web`：通用网页、新闻、百科，走 Wigolo direct。
- `official_docs`：官方文档、发行说明、API 参考，走 Wigolo direct。
- `restricted_web`：Google / YouTube / X 等受限站点，走 Wigolo restricted；`claim.question` 带目标域名。

一个 claim 只声明真正需要的渠道。不要堆多个标签，也不要把社媒抓取写进 claim。

## 【研究循环】

有 `next_pending_claim` 时调用 `deep_search_step`；完成一轮取证后调用 `deep_search_reflect`。reflect 判定继续时回到 step，判定停止时调用 `deep_search_report`。证据为空或 claim 为 uncertain 时如实报告。

## 【还需要社媒时】

先取得 `social` route 的方法与平台目录。单平台定向用 crawl；多平台或 web+crawl 混合用 fanout。crawl 结果由 agent 与 web 报告统一综合，不写入 web run。

## 【网关异常】

按结果中的 `stop_reason`、diagnostics 与 remediation 恢复。网关不可达、超时或降级不等于没有相关内容。
