/**
 * transcript.js — DSH session → KRouter transcript 桥接
 *
 * 把 DSH 的 session.v4.jsonl.zstd（多帧 zstd 拼接）转成 KRouter
 * import_sessions.py 的 read_claude() 能读的 claude-code 形 JSONL，再走 `--file`
 * 单文件导入管线学进 vault。
 *
 * 关键契约（已端到端验证，见 subagent spec e08b0cfb）：
 *  - session.v4.jsonl.zstd 是 MANY 拼接 zstd 帧（magic 28 B5 2F FD），每帧必须单独解压。
 *  - emit `origin:{kind:"human"}` 于每条 user 记录 → read_claude 才认这是真人输入的轮。
 *  - 绝不 emit `queue-operation` → 否则 read_claude 丢掉全部轮次。
 *  - 注入的 harness 上下文（runtime context / file policy / browser 门禁等）预先过滤，
 *    它们不是人打的字，会污染蒸馏。read_claude 自带 NOISE regex 只覆盖少数前缀，
 *    所以这里加一层 DSH 专属 denylist。
 *  - `--file` 走 scheduled 分支 ⇒ 受 consent 闸门管（consent.js）。调用方必须先确认
 *    consentStatus().consented === true 才导入；本模块不重复检查隐私，由 hooks.js 把关。
 *
 * 写 vault 发生在 import_sessions.py 内部；本模块只产出临时 JSONL + 调 CLI。
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const KROUTER_HOME = process.env.KROUTER_HOME || join(process.env.HOME || "", ".KRouter");
const IMPORT_CLI = join(KROUTER_HOME, "current", "skill", "krouter", "scripts", "import_sessions.py");

/** DSH session transcript 候选文件名，按优先级（v4 当前，向后兼容 v3/无版本）。 */
const TRANSCRIPT_NAMES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"];

/**
 * 由 sessionId 解析 DSH transcript 绝对路径。
 * 布局：~/.dsh/sessions/<workspace-slug>/session-<id>/session.v4.jsonl.zstd。
 * 不依赖 session 对象暴露路径（不可假定字段），扫描 sessions 下各 slug 的 session-<id> 目录。
 * @param {string} sessionId
 * @param {string} [dshHome] 测试可注入
 * @returns {string|null} 找到的 transcript 路径，或 null
 */
export function findSessionFile(sessionId, dshHome) {
  if (!sessionId) return null;
  const home = dshHome || process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  let slugs;
  try {
    slugs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const dirName = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
  for (const slug of slugs) {
    const sdir = join(root, slug, dirName);
    if (!existsSync(sdir)) continue;
    for (const name of TRANSCRIPT_NAMES) {
      const p = join(sdir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** 解压所有拼接 zstd 帧并拼接为文本。 */
export function decompressFrames(buf) {
  const frames = [];
  for (let i = 0; (i = buf.indexOf(ZSTD_MAGIC, i)) !== -1; i += 4) frames.push(i);
  let out = "";
  for (let k = 0; k < frames.length; k++) {
    const start = frames[k];
    const end = k + 1 < frames.length ? frames[k + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      /* 跳过无法解码的帧 */
    }
  }
  return out;
}

/** 解析 JSONL 文本 → 事件数组（跳过坏行）。 */
export function parseEvents(text) {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const iso = (ms) => new Date(ms).toISOString(); // DSH `time` = epoch ms → ISO 8601

// 自动注入的 harness 上下文，不是人打的字。read_claude 自带 NOISE regex 只匹配少数前缀，
// 这里补一层 DSH 专属 denylist（对齐已验证原型）。
const INJECTED =
  /^\s*(<[-\w!][^>]*>|=====|【[^】]*】|#\s|\[model changed|Time sampled|Current runtime context|Browser time zone|Continue the interrupted task|This session is being continued|Current DSH file policy|Approval prompts are disabled|Delegation depth|You are a delegated subagent|Current DeepSeek Harness|Current working directory|Background subagent|Current runtime context)/i;

function pathStem(p) {
  const base = String(p).split("/").pop() || "";
  return base.replace(/\.zstd$/, "").replace(/\.jsonl$/, "");
}

/**
 * 转换：DSH session.v4.jsonl.zstd → claude-code 形 JSONL 字符串。
 * 每个 turn 取最后一条非注入 user 文本作 prompt，取该 turn 末条 assistant 非推理文本作答。
 * tool/call + tool/result 有意丢弃：read_claude 忽略它们，蒸馏只要 ask/answer 文字。
 * @param {string} dshZstdPath
 * @returns {string} JSONL（每行一个 JSON 记录，末尾带换行）
 */
export function convertDshToKrouter(dshZstdPath) {
  const events = parseEvents(decompressFrames(readFileSync(dshZstdPath)));

  const out = [];
  let cwd = "";
  let sid = pathStem(dshZstdPath);
  let title = "";
  for (const d of events) {
    if (d.type === "session") {
      cwd = d.cwd || cwd;
      sid = d.id || sid;
    } else if (d.type === "session/title" && d.data?.title) {
      // 优先用户自设 title 而非 fallback
      if (d.data.source?.kind === "user" || !title) title = d.data.title;
    }
  }

  let prompt = null;
  let promptTs = null;
  let lastAnswerText = null;
  let lastAnswerTs = null;

  const flush = () => {
    if (prompt && promptTs) {
      out.push({
        type: "user",
        origin: { kind: "human" }, // 标记真人输入轮（read_claude 必需）
        timestamp: iso(promptTs),
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      });
      if (lastAnswerText && lastAnswerTs) {
        out.push({
          type: "assistant",
          timestamp: iso(lastAnswerTs),
          message: { role: "assistant", content: [{ type: "text", text: lastAnswerText }] },
        });
      }
    }
    prompt = promptTs = lastAnswerText = lastAnswerTs = null;
  };

  // 走轮次：turn/start 界定一轮；curTurn==null 时忽略所有消息。
  let inTurn = false;
  for (const d of events) {
    if (d.type === "turn/start") {
      flush();
      inTurn = true;
      continue;
    }
    if (d.type === "turn/end") {
      flush();
      inTurn = false;
      continue;
    }
    if (!inTurn) continue;

    if (d.type === "user/message") {
      // 取本 turn 最后一条非注入 text block 作 prompt
      const blocks = (d.data?.content || []).filter((b) => b.type === "text");
      for (const b of blocks) {
        const t = (b.text || "").trim();
        if (t && !INJECTED.test(t)) {
          prompt = t;
          promptTs = d.time;
        }
      }
    } else if (d.type === "assistant/message") {
      // read_claude 只吃 type:"text" block；跳过 reasoning + tool-call
      const blocks = (d.data?.message?.content || []).filter((b) => b.type === "text");
      for (const b of blocks) {
        const t = (b.text || "").trim();
        if (t) {
          lastAnswerText = t;
          lastAnswerTs = d.time;
        }
      }
    }
  }
  flush();

  // claude-code 形 header/footer 记录，read_claude 认识：
  if (cwd) out.unshift({ type: "cwd", cwd }); // read_claude 在任意行读 d.cwd
  if (title) out.push({ type: "custom-title", customTitle: title });

  return out.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

/**
 * 为 ③ turn hook（learn_from_turn）产出一份临时 claude-code 形 transcript。
 *
 * Claude Code 的 turn hook 拿得到宿主原生 transcript_path，读"本轮 agent 取用/用了什么"
 * 喂夜间 learn_mentions（本地、无模型、轻量）。DSH 的 session/event 不给 transcript_path，
 * 这里自己扫 session 文件 → convertDshToKrouter → 写临时 JSONL，把路径交给 session_hook.py turn，
 * 让 learn_from_turn 不再因路径为空而跳过。
 *
 * 隐私：调用方（hooks.js）必须先过 transcript+consent 双闸门才调用本函数——它读会话内容。
 * learn_from_turn 本体侧另有 learn_on() 闸门（独立于 consent）。
 *
 * @param {string} sessionId
 * @param {{dshHome?:string}} [opts]
 * @returns {{ok:boolean, path?:string, lines?:number, reason?:string}}
 *   ok=true 且 path=null：无可学真人轮次（空会话），调用方按"跳过"处理。
 *   ok=false：找不到 session/转换失败，调用方按"安全降级"处理。
 */
export function turnTranscript(sessionId, opts = {}) {
  if (!sessionId) return { ok: false, reason: "no sessionId" };
  const dshPath = findSessionFile(sessionId, opts.dshHome);
  if (!dshPath) return { ok: false, reason: "no session file" };

  let jsonl;
  let lines;
  try {
    jsonl = convertDshToKrouter(dshPath);
    lines = jsonl.split("\n").filter(Boolean).length;
  } catch (e) {
    return { ok: false, reason: `convert failed: ${e?.message ?? String(e)}` };
  }
  if (lines === 0) return { ok: true, path: null, lines: 0, reason: "empty" };

  const tmp = join(tmpdir(), `dsh-krouter-turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  try {
    writeFileSync(tmp, jsonl, "utf-8");
  } catch (e) {
    return { ok: false, reason: `write tmp failed: ${e?.message ?? String(e)}` };
  }
  return { ok: true, path: tmp, lines };
}

/**
 * 夜间批量导入：枚举 DSH_HOME 下 mtime ≥ since 的会话，逐个转换成临时 claude-code JSONL，
 * 一次传给 import_sessions.py（多个 --file，scheduled 分支，distill 生效）。
 *
 * 为什么不调单文件 importSession()：那会 spawn N 次 CLI，每次都重建 Python 解释器 +
 * 重扫 vault，夜间会话多时又慢又重。这里一次 CLI 吃全部临时文件，KRouter collect()
 * 自己按 (session, day) 分页去重。
 *
 * 不按 prompt 时间戳做日期过滤（ponytail）：--file 分支 import_sessions.py 自己把
 * since/until 放宽到 1970..today 整段收，KRouter 的 covered_by/superseded_by 去重兜底。
 *
 * @param {{vault:string, since:Date, dshHome?:string, local?:boolean, dryRun?:boolean, processEnv?:object, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, sessions:number, lines:number, stdout:string, stderr:string, rc:number, error?:string}>}
 */
export async function importDshSince(o) {
  const { vault, since, dshHome, local = false, dryRun = false, processEnv = process.env, timeoutMs = 300000 } = o;
  if (!vault || !(since instanceof Date)) {
    return { ok: false, sessions: 0, lines: 0, stdout: "", stderr: "", rc: 2, error: "vault 与 since 必填" };
  }
  if (!existsSync(IMPORT_CLI)) {
    return { ok: false, sessions: 0, lines: 0, stdout: "", stderr: "", rc: 2, error: "import_sessions.py 不可用" };
  }

  // 枚举近期有改动的会话（复用 findSessionFile 的布局假设：sessions/<slug>/<dir>/session.v*.jsonl.zstd）
  const home = dshHome || processEnv.DSH_HOME || join(processEnv.HOME || "", ".dsh");
  const root = join(home, "sessions");
  if (!existsSync(root)) {
    return { ok: true, sessions: 0, lines: 0, stdout: '{"import":"empty","reason":"no dsh sessions root"}', stderr: "", rc: 0 };
  }
  const cutoff = since.getTime();
  const dshPaths = [];
  for (const slug of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const slugDir = join(root, slug);
    for (const sdir of readdirSync(slugDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      for (const name of TRANSCRIPT_NAMES) {
        const p = join(slugDir, sdir, name);
        if (!existsSync(p)) continue;
        try {
          if (statSync(p).mtimeMs >= cutoff) dshPaths.push(p);
        } catch { /* stat 失败跳过 */ }
        break; // 每个 session 目录只取最高优先级那一个 transcript
      }
    }
  }
  if (dshPaths.length === 0) {
    return { ok: true, sessions: 0, lines: 0, stdout: '{"import":"empty","reason":"no recent dsh sessions"}', stderr: "", rc: 0 };
  }

  // 转换每个会话 → 临时 JSONL；空转换跳过
  const tmpFiles = [];
  let lines = 0;
  try {
    for (const dshPath of dshPaths) {
      let jsonl;
      let n;
      try {
        jsonl = convertDshToKrouter(dshPath);
        n = jsonl.split("\n").filter(Boolean).length;
      } catch { continue; } // 单个转换失败不拖垮整批
      if (n === 0) continue;
      const tmp = join(tmpdir(), `dsh-krouter-nightly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
      writeFileSync(tmp, jsonl, "utf-8");
      tmpFiles.push(tmp);
      lines += n;
    }
  } catch (e) {
    for (const t of tmpFiles) { try { rmSync(t, { force: true }); } catch {} }
    return { ok: false, sessions: 0, lines: 0, stdout: "", stderr: "", rc: 2, error: `转换失败: ${e?.message ?? String(e)}` };
  }
  if (tmpFiles.length === 0) {
    return { ok: true, sessions: 0, lines: 0, stdout: '{"import":"empty","reason":"no human turns"}', stderr: "", rc: 0 };
  }

  const args = [IMPORT_CLI, "--vault", vault];
  for (const t of tmpFiles) args.push("--file", t);
  args.push("--delete-input"); // collect() 读完内存后自行删 caller-owned 临时副本
  if (local) args.push("--local");
  if (dryRun) args.push("--dry-run");

  const env = { ...processEnv, KROUTER_VAULT: vault, OBSIDIAN_VAULT: vault };
  const result = await new Promise((resolve) => {
    const proc = spawn("python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { proc.kill(); settled = true; resolve({ stdout, stderr: stderr + " [timeout]", rc: 124 }); }
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (rc) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, rc: rc ?? 1 }); } });
    proc.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr: stderr + e.message, rc: 1 }); } });
  });

  // --delete-input 是 import_sessions.py 的 caller-owned 契约：collect() 读完即删。
  // 兜底再清一遍，防 rc!=0 提前退出时残留（幂等）。
  for (const t of tmpFiles) { try { rmSync(t, { force: true }); } catch {} }

  return {
    ok: result.rc === 0,
    sessions: tmpFiles.length,
    lines,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    rc: result.rc,
  };
}

/**
 * 调 import_sessions.py 单文件导入（scheduled 分支，受 consent 闸门）。
 * 内部先转 DSH session → 临时 JSONL，导入完删除临时文件。
 * @param {{vault:string, dshPath:string, dryRun?:boolean, local?:boolean, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, rc:number, lines?:number, error?:string}>}
 */
export function importSession(o) {
  const { vault, dshPath, dryRun = false, local = false, timeoutMs = 120000 } = o;
  return new Promise((resolve) => {
    if (!vault || !dshPath) {
      resolve({ ok: false, stdout: "", stderr: "", rc: 2, error: "vault 与 dshPath 必填" });
      return;
    }
    if (!existsSync(dshPath)) {
      resolve({ ok: false, stdout: "", stderr: "", rc: 2, error: `session 文件不存在: ${dshPath}` });
      return;
    }
    if (!existsSync(IMPORT_CLI)) {
      resolve({ ok: false, stdout: "", stderr: "", rc: 2, error: "import_sessions.py 不可用" });
      return;
    }

    // 转换 → 临时 JSONL
    let jsonl;
    let lines = 0;
    try {
      jsonl = convertDshToKrouter(dshPath);
      lines = jsonl.split("\n").filter(Boolean).length;
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: "", rc: 2, error: `转换失败: ${e?.message ?? String(e)}` });
      return;
    }
    if (lines === 0) {
      // 没有可学的真人轮次，直接成功返回（不调 CLI、不写 vault）
      resolve({ ok: true, stdout: '{"import":"empty","reason":"no human turns"}', stderr: "", rc: 0, lines: 0 });
      return;
    }

    const tmp = join(tmpdir(), `dsh-krouter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
    try {
      writeFileSync(tmp, jsonl, "utf-8");
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: "", rc: 2, error: `写临时文件失败: ${e?.message ?? String(e)}` });
      return;
    }

    const args = [IMPORT_CLI, "--vault", vault, "--file", tmp];
    if (local) args.push("--local");
    if (dryRun) args.push("--dry-run");

    let stdout = "";
    let stderr = "";
    let settled = false;
    const env = { ...process.env, KROUTER_VAULT: vault, OBSIDIAN_VAULT: vault };
    const proc = spawn("python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill();
        settled = true;
        cleanup();
        resolve({ ok: false, stdout, stderr: stderr + " [timeout]", rc: 124, lines });
      }
    }, timeoutMs);

    const cleanup = () => {
      try {
        rmSync(tmp, { force: true });
      } catch {}
    };

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (rc) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ ok: rc === 0, stdout: stdout.trim(), stderr: stderr.trim(), rc: rc ?? 1, lines });
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, stdout, stderr: stderr + e.message, rc: 1, lines });
    });
  });
}
