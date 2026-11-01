# 来源路线（S1/S2）

## mem0
根据当前的场景线索，可按下面的【修改 query 方法】重新检索，或保持 query 但【扩大/更换范围检索】；不做 deep_search_next/read。

## ov_context
根据当前的结论线索，可按下面的【修改 query 方法】重新检索，或保持 query 但【扩大/更换范围检索】；若需据此查看关联，且该结果 next.available=true，可用 deep_search_next。

## ov_session
根据当前历史对话，可按下面的【修改 query 方法】重新检索，或保持 query 但【扩大/更换范围检索】；摘录不足可用 deep_search_read；不做 deep_search_next。

## wiki
根据当前内容检索，可按下面的【修改 query 方法】重新检索，或保持 query 但【扩大/更换范围检索】；摘录不足可用 deep_search_read；若需据此查看关联，且该结果 next.available=true，可用 deep_search_next。具体 Wiki 资产及适用内容查看【当前源目录】（source-catalog）。

## 修改 query 方法
1. 重新组合关键词；
2. 更换部分关键词；
3. 调整关键词顺序；
4. 根据用户问题或当前结果中已有的可信语义，替换为相近关键词。

## 扩大/更换范围检索方法
查看【当前源目录】（source-catalog），根据当前信息缺口及各来源说明，自行选择扩大或更换检索范围。

## read 后提示
全文仍不足时：提取可信锚点后重新 deep_search；若该结果 next.available=true 才可 deep_search_next。
