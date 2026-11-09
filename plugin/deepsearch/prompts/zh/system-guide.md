# DeepSearch 检索路由

> 首次按用户问题选 route；续查按当前信息缺口重选 route。调用 `deep_search_guide({ route })` 取得对应方法与目录；参数由 DSH 原生工具 schema 提供。

## 【三类 route】

- `local`：本机沉淀的历史对话、记忆与知识库。
- `web`：公开网页、官方文档、代码托管、博客、受限站点或外部互证。
- `social`：登录态社媒中的搜索词、内容 ID、创作者主页或多平台口碑。

**判据**：可能已在本机沉淀选 `local`；需要公开外部信息选 `web`；需要真实社媒数据选 `social`。网页与社媒混合时，先取 `web`，再取 `social` 且带 `include_fanout:false`，两份目录都拿到、共享编排说明只出现一次。不要猜工具名。
