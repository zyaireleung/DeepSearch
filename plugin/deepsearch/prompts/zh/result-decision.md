## 检索结果后怎么决策

拿到任一检索结果（本地 deep_search / 公开网页 web / 登录态社媒 crawl / fanout 多分支）后，按此决策，不要因为 verdict 或"跑了一遍"就停：

1. **信息是否足够回答当前任务？** verdict（miss/narrowed）**仅作参考**，由你判断返回内容是否真的回答了 query——相关但答不上 = 仍不足。
2. **本地仍有真实价值**（next.available=true / 有未读全文）→ **串行深入**：deep_search_next / deep_search_read。
3. **fanout 多分支后**：逐分支判断哪个已足够、哪个仍不足。**已足够的分支下一轮不再重发**（取消=不重发，零成本，非中途打断）；仍不足的分支连同其它新需要一起，作为下一轮 deep_search_fanout 的 branches。
4. **本路线已榨干仍不足** → **重新选路线**：调 deep_search_guide({route}) 取新路线的 guide+目录，再调其入口工具。公开网页→route:"web"，社媒→route:"social"，历史结论→route:"local"。不得从入口工具直接互跳。
5. 跨路线换工具、或扩范围到别的站点/平台，同样先过 deep_search_guide 取该路线方法说明（同一路线内换 query 不必重过 guide）。
