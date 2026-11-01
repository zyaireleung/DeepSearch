# dsh-console — TencentDB 控制台

把「dsh 对话 → 指定模型解析 → 录入 TDAI 数据库 → dsh 对话时自动调取」这条链路
包成一个可视化控制台：手动开关、设置解析模型、三种导入模式（自动读取 / 循环定时 / 手动导入）、
支持 dsh `session.jsonl.zstd`、循环定时可设。

## 形态

独立轻量 Web 控制台，随 `bin/tdai-local.sh` 五件套联动启停：
- 默认 `127.0.0.1:8126`，本机访问
- `TDAI_CONSOLE=0 ./tdai-local.sh start` 可单独禁掉控制台（四件套照常）
- 后端零第三方依赖（仅 Node 内置模块），前端单页原生 HTML+JS

## 架构

```
dsh-console/
  server.js              后端：node:http + REST API + 调度器 + 模型切换
  console-config.json    运行时配置（模式/间隔/目标/解析模型）
  web/index.html         单页 UI（5 面板：概览/导入管理/解析模型/调取工具/日志）
```

复用底层引擎（未改动上游代码）：
- 导入：`agents/asset-import.ts --source dsh`（原生解析 `session.jsonl.zstd`，自带增量去重）
- 解析模型：`MemoryCore/tdai-gateway.local.yaml` 的 `llm` 段（改后重启 core 生效）
- 调取：MemoryCore `8420 /v3/atomic/search`（可配成 dsh 工具，不依赖 tdai-memory provider）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 四件套+console 状态、调度器、最近导入、当前模型、嗅探 agent |
| GET | `/api/logs` | 最近 300 条运行日志 |
| POST | `/api/config` | 保存配置（scheduler/import/model 任一）并重载调度器 |
| POST | `/api/import` | 手动导入 `{force?, extract?}` |
| POST | `/api/model` | 切换解析模型 `{baseUrl, apiKey, model}` → 写 yaml → 重启 core |
| GET | `/health` | 健康检查 |

## 三种导入模式

- **自动读取**：fs.watch 递归监听 sessions 目录，新增 `session.jsonl.zstd` 稳定 2s 后增量导入
- **循环定时**：按设定间隔（分钟）自动增量导入
- **手动导入**：点按钮立即跑一次；`--force` 全量重导

## 解析模型 vs 对话模型

两者独立：
- 解析模型 = MemoryCore `tdai-gateway.local.yaml` 的 `llm`（本控制台管这个）
- dsh 对话模型 = MemoryProxy `config.yaml` 的 `upstream`（不在本控制台范围）

切换解析模型会自动备份 `tdai-gateway.local.yaml.bak-console` 再改写，并重启 core(8420)。

## 联动启停

```bash
./bin/tdai-local.sh start     # 五件套 + 控制台一起起
./bin/tdai-local.sh stop      # 一起停
./bin/tdai-local.sh status    # console :8126 ✓/✗
TDAI_CONSOLE=0 ./tdai-local.sh start   # 只起四件套，不起控制台
```

控制台启动时自动从 `~/.dsh/.credentials.yaml` 读 `PROXY_USER_KEY` 作为 `TDAI_USER_KEY`，
资产导入鉴权无需手动配置。

## 环境要求

- `zstd` 命令在 PATH（asset-import 解压 `session.jsonl.zstd` 用）；macOS 装于 `/opt/homebrew/bin/zstd`，
  控制台调用时已自动把 `/opt/homebrew/bin` 加入子进程 PATH
- Node ≥ 22（`~/.local/node22/bin`），tsx 由 MemoryProxy 子包提供

## 日志

- 控制台运行日志：`~/.tdai-logs/console.log`
- 导入引擎日志：同上（server 透传 asset-import 输出）
- 导入去重 state：仓库根 `.asset-import-state.json`
