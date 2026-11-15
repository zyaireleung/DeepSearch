/**
 * direct.js — skill / changes 的 Python 直连通道（绕过 stdio MCP）
 *
 * 为什么需要：mcp_server.py 的 stdio 模式只暴露 5 个核心工具
 * （ask/status/note/correct/learn）。krouter_skill / krouter_changes 在 stdio 层
 * graceful off——skill 仅当库里有技能才出现，changes 仅 HTTP 团队服务器暴露
 * （mcp_server.py tools() / call()）。
 *
 * 但 DSH 侧 register.js 把这两个只读工具注册给了 Agent；若一律走 stdio，调用就
 * 撞 "unknown tool"。二者其实都是**本地、无模型**的读，直接 spawn 对应 Python
 * 实现即可，无需经 MCP server：
 *   - changes → team.changes(vault,…)+team.describe：读本库变更台账（记忆变更记录）
 *   - skill   → skills.listing/show：读本库技能（无技能时 graceful 报"没有技能"）
 *
 * 与 stdio 的语义差异（有意为之，服务 DSH 本地用户）：
 *   changes 在 stdio 是 HTTP-only，但台账数据本就在本库；直连让本地用户也能查，
 *   与文档 B4「changes 返回 journal 台账行」一致。skill 沿用本体 skills.py 的
 *   门控（learn off / 无技能 → graceful 提示），不越权。
 *
 * 全部只读，绝不写 vault、不碰 git、不起模型。失败一律 graceful 返回 isError。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const KROUTER_HOME = process.env.KROUTER_HOME || join(process.env.HOME || "", ".KRouter");
const SCRIPTS = join(KROUTER_HOME, "current", "skill", "krouter", "scripts");

/** 单次直连超时（ms）。都是本地读，快。 */
const TIMEOUT_MS = 15000;

/**
 * 跑一段 Python 代码（cwd=KRouter scripts，继承 KROUTER_VAULT/OBSIDIAN_VAULT env）。
 * 约定：脚本自己 print 结果文本；非 0 退出或超时 → isError。
 * @param {string} code Python 源码（读 os.environ 拿 vault）
 * @param {Record<string,string|undefined>} env 额外 env（一般不用）
 * @returns {Promise<{ok:boolean,text:string,isError:boolean}>}
 */
function runPy(code, env = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let proc;
    try {
      proc = spawn("python3", ["-c", code], {
        cwd: SCRIPTS,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ ok: false, text: `krouter: 直连启动失败: ${e?.message ?? String(e)}`, isError: true });
    }
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish({ ok: false, text: `krouter: 直连超时（${TIMEOUT_MS}ms）`, isError: true });
    }, TIMEOUT_MS);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, text: `krouter: 直连进程错误: ${e?.message ?? String(e)}`, isError: true });
    });
    proc.on("close", (codeNum) => {
      clearTimeout(timer);
      const text = (out || "").trim();
      if (codeNum !== 0 && !text) {
        return finish({ ok: false, text: `krouter: 直连退出 ${codeNum}${err ? `: ${err.trim().slice(0, 200)}` : ""}`, isError: true });
      }
      // 有 stdout 就当结果（本体 graceful 消息也可能伴随非 0；以文本为准）
      finish({ ok: codeNum === 0, text: text || err.trim(), isError: codeNum !== 0 && !text });
    });
  });
}

/**
 * krouter_changes — 本库变更台账（team.changes + team.describe）。
 * @param {{vault:string}} opts
 * @param {{page?:string, who?:string, text?:string, limit?:number}} args
 */
export function directChanges(opts, args = {}) {
  if (!opts?.vault) return Promise.resolve({ ok: false, text: "krouter_changes: no vault configured", isError: true });
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit) || 20)));
  const q = (s) => String(s ?? "").replace(/'/g, "\\'");
  const code = [
    "import os, sys",
    "sys.path.insert(0, os.getcwd())",
    "from pathlib import Path",
    "import team",
    `raw = os.environ.get("KROUTER_VAULT") or os.environ.get("OBSIDIAN_VAULT") or ""`,
    "if not raw:",
    "    print('krouter_changes: no vault configured (set KROUTER_VAULT)', file=sys.stderr); sys.exit(2)",
    `rows = team.changes(Path(raw).expanduser(), '${q(args.page)}', '${q(args.who)}', '${q(args.text)}', ${limit})`,
    "print(team.describe(rows))",
  ].join("\n");
  return runPy(code);
}

/**
 * krouter_skill — 本库技能（skills.listing / skills.show）。
 * 无 id → 列出技能摘要；有 id → 取全文。沿用本体门控（learn off / 无技能 → graceful）。
 * @param {{vault:string}} opts
 * @param {{id?:string}} args
 */
export function directSkill(opts, args = {}) {
  if (!opts?.vault) return Promise.resolve({ ok: false, text: "krouter_skill: no vault configured", isError: true });
  const sid = String(args.id ?? "").trim();
  const code = [
    "import os, sys",
    "sys.path.insert(0, os.getcwd())",
    "from pathlib import Path",
    "import skills",
    `raw = os.environ.get("KROUTER_VAULT") or os.environ.get("OBSIDIAN_VAULT") or ""`,
    "if not raw:",
    "    print('krouter_skill: no vault configured (set KROUTER_VAULT)', file=sys.stderr); sys.exit(2)",
    "vault = Path(raw).expanduser()",
    "found = skills.listing(vault) if hasattr(skills, 'listing') else []",
    `sid = ${JSON.stringify(sid)}`,
    "if not found:",
    "    print('krouter_skill: 库里还没有技能（技能由经验卡在夜间沉淀；learn 开启后才会有）。')",
    "    sys.exit(0)",
    "if not sid:",
    "    rows = '; '.join(f\"{s['id']} = {s['name']} ({s.get('use_when','')})\" for s in found)",
    "    print('krouter_skill 可取的技能：' + rows)",
    "    sys.exit(0)",
    "text = skills.show(vault, sid) if hasattr(skills, 'show') else ''",
    "if not text:",
    "    known = ', '.join(s['id'] for s in found) or 'none'",
    "    print(f'krouter_skill: no skill {sid!r}; the skills are: {known}')",
    "    sys.exit(0)",
    "print(text)",
  ].join("\n");
  return runPy(code);
}