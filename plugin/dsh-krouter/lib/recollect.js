/**
 * 被动召回：把最后一条 user 文本交给 KRouter 本体，产出可注入的 block。
 *
 * 判定与渲染全归本体——直接跑它 Claude Code prompt hook 的同一个脚本 recollect.py：
 *   命中：它打印紧凑正文（HEAD + 至多 PER_PROMPT 页 + TAIL）→ 原样注入；
 *   未命中：它什么都不打印 → 静默放行，不占上下文。
 * 桥不复制任何门（别名路第二把钥匙、partial / confidence / margin / tier / 页面 type 过滤、
 * 重叠消歧、冷触发词排序、每句两页上限）——规则只有一份，本体升级桥自动跟着变。
 * 宁可少注入也不猜：本体没把握就零输出，桥绝不二次拼凑。
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { parseReceipt, pythonArgv, resolveRecollect, resolveVault, resolveRouter, runRoute } from "./route.js";

export const KROUTER_SOURCE_KIND = "krouter";

/** 前台胶囊只认 direct/related/session-start；委托路不分两层，统一按 related 折。 */
const STATE = "related";

/**
 * receipt 里给机器看的键：索引 sha256、观测时间、内部路由状态、同义重复的路径。
 * 只删这些；未知键（recall:/kb:/suggestions: 等正文载体）一律保留——宁可多留也不误删正文。
 */
const NOISE_KEYS = new Set([
  "receipt_version",
  "observed_at",
  "requested_route",
  "query",
  "retrieval_status",
  "source_sha256",
  "canonical_map",
  "canonical_map_sha256",
  "subconscious",
  "subconscious_sha256",
  "subconscious_rows",
  "route",
  "canonical_id",
  "canonical_source",
  "canonical_match",
  "open_page",
]);

/** 裁掉机器字段与其缩进续行；出处路径去掉 vault 绝对前缀（模型要的是能引用的相对路径）。 */
export function trimReceipt(text, vault = "") {
  const out = [];
  let skip = false;
  for (const line of text.split("\n")) {
    const m = /^([a-z][a-z0-9_]*):/.exec(line);
    if (m) {
      skip = NOISE_KEYS.has(m[1]);
      if (skip) continue;
    } else if (skip && /^\s+\S/.test(line)) {
      continue; // 被删键的续行
    } else {
      skip = false;
    }
    out.push(vault && line.startsWith("source: ") ? line.replace(`source: ${vault}/`, "source: ") : line);
  }
  return out.join("\n").trim();
}

/**
 * @param {string} text  最后一条 user 消息纯文本
 * @param {{vault?:string, router?:string, recollectPath?:string, timeoutMs?:number}} opts
 * @returns {{ok:boolean, hit:boolean, state?:string, block?:string, reason?:string}}
 *   ok=false: 本体不可达/异常（桥静默放行，绝不阻断对话）
 *   hit=false: 本体没递东西（zero output），不注入
 *   hit=true: block 为可注入正文，已去除首尾空白
 */
export function recollect(text, opts = {}) {
  const q = String(text || "").trim();
  if (!q) return { ok: true, hit: false, reason: "empty" };

  const vault = resolveVault(opts.vault);
  if (!vault) return { ok: false, hit: false, reason: "set KROUTER_VAULT (or OBSIDIAN_VAULT) or vaultPath" };

  // ── 第一路：canonical 直锁 ────────────────────────────────────────────────
  // recollect.py 只认库里的别名表/触发表，不读 canonical_sources.psv；人点头过的权威锁
  // 是这套系统里可信度最高的一层，丢了它就等于把「别名表 / 每日总结」这类问句打回弱召回。
  // 只认 memory: direct（canonical-match）；related 一律交给第二路，避免两套门各判一次。
  const run = runRoute({ route: "search", query: q, vault, router: opts.router, timeoutMs: opts.timeoutMs ?? 20000 });
  if (run.ok) {
    const block = String(run.stdout || "").trim();
    if (block && String(parseReceipt(block).memory || "").startsWith("direct")) {
      return { ok: true, hit: true, state: "direct", block: trimReceipt(block, vault) };
    }
  }

  // ── 第二路：原版 Claude Code 路 ───────────────────────────────────────────
  const script = resolveRecollect(opts.recollectPath);
  if (!script) {
    return { ok: false, hit: false, reason: "recollect.py not found. install KRouter to ~/.KRouter" };
  }


  const isPy = String(script).endsWith(".py");
  // `--` 之后一律当位置参数：用户消息以 "-" 开头时不会被 argparse 当成选项。
  const args = isPy ? ["--vault", vault, "--", q] : [q];
  // 与 route.js 同形：vault 两写；其余 env 透传（KROUTER_STATE_DIR 决定它读写哪份状态）。
  const env = { ...process.env, KROUTER_VAULT: vault, OBSIDIAN_VAULT: vault };
  const timeoutMs = opts.timeoutMs ?? 20000;
  const result = isPy
    ? spawnSync(...pythonArgv(script, args), { encoding: "utf8", timeout: timeoutMs, cwd: dirname(script), env })
    : spawnSync(script, args, { encoding: "utf8", timeout: timeoutMs, env });

  if (result.status !== 0) {
    const why = String(result.stderr || result.error || `exit ${result.status}`).trim();
    return { ok: false, hit: false, reason: why.slice(0, 300) || "recollect failed" };
  }

  const out = String(result.stdout || "").trim();
  // 本体未命中走 print("")：只有空白，等同于零输出。
  if (!out) return { ok: true, hit: false, reason: "empty-output" };
  return { ok: true, hit: true, state: STATE, block: out };
}
