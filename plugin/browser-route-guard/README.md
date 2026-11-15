# browser-route-guard

DSH 插件（v0.2.0，sandbox 候选）：**浏览器工具默认锁定**。每个用户回合内，必须

1. 成功执行 `skill(name="browser-route")`；
2. 调用 `browser_route_select(taskKind=..., reason=...)`；
3. 之后只能使用与 route 匹配的浏览器工具。

route 由插件根据 `taskKind` 计算，模型无法直接指定：

| taskKind | route | 对应工具面 |
|---|---|---|
| `frontend-test` | `playwright` | bash 中的 `playwright-cli` / `playwright` |
| `general-web` | `obscura` | `mcp__obscura__browser_*`（`browser_close` 除外） |
| `human-handoff` | `dsh-ego` | `ego_*`（dsh-ego-browser 插件） |
| `ego-lite-exception` | `ego-lite` | bash 中的 `ego-browser` |

门禁通过 `ctx.tools.guard(exec => string | undefined)` 在工具 body 之前生效；
skill 解锁只认 `tools/result` 中 `result.isError === false` 的真实成功；
`session/event (session, event)` 收到 `user/message` 时清空上一回合许可。

新用户消息会清空许可；`mcp__obscura__browser_close` 是唯一显式拆解例外。

**边界**：bash 分类器是声明式 token 扫描，`node -e` / `python -c` / `$(...)` / `eval` /
Selenium / 直连 CDP 不在检测范围；只覆盖明确命中的 `playwright-cli` / `ego-browser` /
`mcp__obscura__browser_*` / `ego_*` 调用形式。

测试与同步步骤见本 sandbox 运行包根目录的 `TESTING.md`
（`browser-route-guard-20261113-003643/TESTING.md`）。
