# Crawler Result 落盘模板（网络检索功能）

对外检索（DSH deepsearch 插件 + n8n + Wigolo + MediaCrawler）的结果落盘样式。
工作区实例目录 = `<工作区>/Crawler Result/{.tmp,Form,Report}`；本目录是插件内置参考模板，
两边一致，落盘/生成时照此填写。

## 目录层级

```
Crawler Result/
├── .tmp/                              # 插件自动落盘（原始抓取中间件）
│   └── <YYMM>/                        # 年月合并，如 2610
│       └── <日>/
│           └── <HHMM><检索ID>/         # 纯数字时间 + 检索ID，如 0822r26101608225f3a
│               ├── meta.md            # 元信息（检索动作产生，机器索引）
│               ├── result.md          # 数据信息 + 来源信息（分节，按类别只留 applicable）
│               └── raw/               # 插件落盘原始件（jsonl / 整页原文）
├── Form/                              # agent 生成：信息汇总表格
│   └── <...>.form.md
└── Report/                            # agent 生成：结合 Form 的分析报告
    └── <...>.report.md
```

## 检索ID

`r` + YYMMDDHHMM + 4位随机，如 `r26101608225f3a`。唯一、区分每次检索结果、人眼可读、排序即时间序。

## 分类

两类，数据信息与来源信息不同：

| 类别 | 渠道 | 数据信息 | 来源信息 |
|---|---|---|---|
| 社媒类 | MediaCrawler | 多重信息（点赞/评论/收藏/转发/作品列表…） | URL + 发布时间戳 + 用户昵称/用户ID + 作品量/粉丝量 |
| 其他类 | Wigolo | 整页信息 | URL + 发布时间戳 + 发布用户（名称/ID） + 站点 |

## 谁写什么

- `.tmp/`：插件自动落盘（meta.md + result.md + raw/）
- `Form/`、`Report/`：agent 读 `.tmp` 后生成
- **按需**：只为解决其他问题的检索，可不生成 Form/Report，只读 `.tmp` 本次结果即可

## 限长规则（统一，不分类）

- Form 主表「检索结果」：≤100 字梗概
- Form 主表下详情：**恒显示**每行一条 `检索ID：<详情>`，≤2000 字截断（截断末尾标 …[已截断，全文见详情链接]）

## 模板文件

| 文件 | 用途 |
|---|---|
| `tmp-meta.md` | `.tmp/.../meta.md` 模板 |
| `tmp-result.md` | `.tmp/.../result.md` 模板（社媒/其他两类分节，用哪类留哪类） |
| `form.md` | `Form/*.form.md` 模板 |
| `report.md` | `Report/*.report.md` 模板 |

## 缺失值纪律

平台不提供标 `N/A`，抓取失败标 `null`，不留空、不猜值。
