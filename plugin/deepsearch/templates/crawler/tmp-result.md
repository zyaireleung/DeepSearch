# 检索结果（result）

## 数据信息·社媒（MediaCrawler 多重信息）

<!-- 每条作品/内容一行；缺失标 N/A，抓取失败标 null，勿编造。原始全文见 raw/。 -->

| 作品标题 | 点赞 | 评论 | 收藏 | 转发 | 发布时间 | 作品链接 |
|---|---|---|---|---|---|---|
<!--row:social:start-->
| <title> | <likes> | <comments> | <collects> | <shares> | <publish_time> | <url> |
<!--row:social:end-->

### 作品列表（type=creator 时）
| 作品标题 | 发布时间 | 互动量小计 | 链接 |
|---|---|---|---|
<!--row:social:start-->
| <title> | <publish_time> | <engagement> | <url> |
<!--row:social:end-->

## 来源信息·社媒

| 用户昵称 | 用户ID | 作品量 | 粉丝量 | 主页 | 备注 |
|---|---|---|---|---|---|
<!--row:social_src:start-->
| <user_nickname> | <user_id> | <works_count> | <fans_count> | <homepage> | <note> |
<!--row:social_src:end-->

---

## 数据信息·其他（Wigolo 整页信息）

<!-- 整页抽取的正文要点。完整原文在 raw/。 -->

| 页面标题 | 正文要点（≤2000 字） | 页面链接 |
|---|---|---|
<!--row:general:start-->
| <page_title> | <points> | <url> |
<!--row:general:end-->

## 来源信息·其他

| 页面URL | 发布时间戳（信息本身发布时间） | 发布用户（名称/ID） | 站点 |
|---|---|---|---|
<!--row:general_src:start-->
| <url> | <publish_time> | <author> | <site> |
<!--row:general_src:end-->