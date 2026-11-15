---
tools: krouter_page
layer: project
---

# 项目页（krouter_page layer=project）

**形态**：整页写入。同一 `slug` 再调就是原地重写。
**落盘**：`01 项目/<slug>/<slug>.md`（**两层**：目录与文件同名）；召回分类由所在区决定，不用你写。

## 写出来的文件

```markdown
---
title: "<项目名>"
status: active
triggers: <用户会问出来的词>; <词>
---

# <项目名>

一句话：这是什么、给谁用、解决什么。

- 目标 / 不做什么
- 当前状态（一句话 + 日期）
- 关键事实（路径、端口、启动方式、仓库位置）
- 相关页面：[[…]]
```

frontmatter 只有 `title` / `status` / `triggers` 三个键是工具写的，其余键（`type`、`date`…）不由它产生。
`triggers` 写成 `a; b; c`，写用户会真的问出来的词。

## 硬规则

1. **整页覆盖**。写之前先想清楚这页原来有什么、要不要保留；拿不准就先读那一页。
2. `body` 必填且写全 —— 它不做内容合并，给一半就是覆盖一半。
3. 不搬原文：正文用自己的话。
4. 想让这一页本身作废（掉出召回）：写 `status: superseded`。
   用户改主意、要一条**旧结论**立刻作废并留链：用 `krouter_correct`。
5. 别在 `body` 里再写一段 `---` frontmatter，那会变成正文。