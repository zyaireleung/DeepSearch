# LLM WiKi

用 LLM 把多份 AIGC / 技术文档提炼成**可检索、可复用、跨文档累积的 Obsidian 知识库**。

## 这个资产是什么

`LLM WiKi/` 是一个**自包含、可移动**的运行资产：把源文档放进 `raw/`，跑一次全流程，就得到一份带条目页、分类索引、向量检索、概览与导入日志的知识库。整个资产不依赖任何资产外路径，复制到任何位置即可运行。

## 目录结构

| 路径 | 作用 |
|---|---|
| `raw/` | 源文档（要解析的对象）。文档清单由脚本扫描此目录获得，往里放文件即加文档 |
| `scripts/` | 运行脚本：`run_fullflow.py`（全流程入口）+ 6 个阶段脚本 + `runtime.py`（共享运行模块） |
| `assetize.py` | 资产化工具：把任意文档目录原地改造成本资产（见下） |
| `prompts/` | 各环节 LLM 提示词（可自行维护） |
| `schema/` | 分类定义（`classification.md`）、12 个分类模板（`templates/`）、错误码表（`error-codes.md`） |
| `config.yaml` | 唯一配置：模型模板、环节→模型、LLM 重试策略、embedding 服务、流程参数 |
| `entities/` | 产物：条目页（每页 = 一个知识条目，含 frontmatter 与内容块） |
| `index.md` | 产物：条目索引（按分类分组） |
| `sources_index.md` | 产物：源文档索引（文档 × 引用次数） |
| `log.md` | 产物：导入日志（每批一节，含状态/导入简要/更新简要/出错/变更） |
| `overview.md` | 产物：知识库概览（现状 + 趋势，由 LLM 生成） |
| `cursor.json` | 产物：已解析文档游标（增量更新依据） |
| `.vectors.json` | 产物：内容块向量（按块粒度，供检索） |
| `.tmp/` | 运行中间产物与批次诊断库（`log/<批次>/` 的 errors/llm_responses 等可溯源） |

## 资产化任意文档目录

把手头一个普通文档目录（比如一堆 AIGC/技术资料）一键变成可运行资产，无需手动搭骨架：

```bash
python3 assetize.py <PATH_TO_DOC_DIR>
```

动作：
1. 目标目录**原地改造**：其中除 `raw/` 外的全部内容移入 `raw/`（多级目录保留，目录合并、文件覆盖）；
2. 从本资产复制骨架：`scripts/` `prompts/` `schema/` `config.yaml` `README.md` `cursor.json` `.tmp/`；
3. 完成即资产，直接 `cd <目录> && python3 scripts/run_fullflow.py`。

判定：目标目录已具备完整资产骨架（`scripts/` + `config.yaml` + `prompts/` + `schema/`）→ 视为已资产化，跳过不操作；否则**无论是否已有同名 `raw/` 目录，都执行资产化**——没有 `raw/` 则新建并移入全部内容，已有 `raw/` 则其内容保留合并、其余内容移入。目标为资产自身时拒绝执行。

产物（`entities/`、`index.md`、`sources_index.md`、`log.md`、`overview.md`）**无需预置空白**——首次解析流程完成后自然生成。

## 怎么启动

前置：本地 LLM 服务与 embedding 服务可用（`config.yaml` 的 `model_templates` 与 `embedding` 段指向它们）。

```bash
cd LLM\ WiKi

# 全流程（S1 候选提取 → S2 收敛 → S3 分类 → S4 内容提取 → S5 建页+向量 → S6 索引/日志/游标 → S7 概览）
# 默认增量：只解析 cursor.json 尚未解析的新增文档；无新增则跳过
python3 scripts/run_fullflow.py

# 只处理指定文档（raw/ 相对路径或文件名；显式指定会强制处理，不受游标限制）
python3 scripts/run_fullflow.py --docs "raw 下的相对路径.md,另一个.md"

# 从已有 S3 分类结果恢复（跳过 S1/S2/S3）
python3 scripts/run_fullflow.py --resume-from-s3 <S3 输出目录>
```

单阶段脚本可单独运行（`python3 scripts/run_s1s2.py --help` 等查看参数）。

## 目的是什么

把零散的多份文档沉淀成一个**以条目为中心的作业型知识库**：同一事物跨文档聚合、内容按块组织、向量化后可检索、索引/概览/日志齐全，后续新增文档可增量累积而不必重跑历史。

## 会生成什么

- `entities/`：条目页（每页一个知识条目，内容块按分类模板落位）
- 块级向量（`.vectors.json`）——内容变化重建、相同复用、孤儿清理
- `index.md` / `sources_index.md`：条目与源文档索引
- `overview.md`：知识库概览（概要/地图/总览分析/变化趋势）
- `log.md`：导入日志（批次状态、导入/更新简要、出错/变更记录）
- `cursor.json`：已解析文档游标

流程中间产物与出错现场在 `.tmp/`（有出错记录的批次保留全部现场供溯源；无错误的批次只保留 S4 产物与诊断库）。

## 错误可溯源

各环节错误统一记录到批次诊断库 `.tmp/log/<批次>/`（`errors.jsonl` 锚点 + `llm_responses.jsonl` 原始返回），出错时可凭锚点一路溯源到现场，不产生无根的错误记录。
