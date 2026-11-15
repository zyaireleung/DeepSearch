/**
 * mcp.js — KRouter MCP stdio 桥（主动工具的统一通道）
 *
 * 为什么走 MCP 而不是各脚本各 spawn：krouter_note/correct/learn 的写入语义
 * （team.writing 并发闸、capture_ledger 变更记录、git commit、redact 脱敏、
 * undo run id）全部编码在 mcp_server.py 里，自己重实现必然漂移。MCP server
 * 默认 stdio 模式 WRITE=True，8 个 canonical 工具一次拿全，各自的内部门控
 * （learn_on/skill_list/HTTP-only changes）由它自己 graceful 返回。
 *
 * 协议（实测 mcp_server.py:772 serve_stdio）：newline-delimited JSON-RPC。
 *   → {"jsonrpc":"2.0","id":N,"method":"initialize","params":{clientInfo}}
 *   → {"jsonrpc":"2.0","id":N,"method":"tools/list","params":{}}
 *   → {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{name,arguments}}
 * 每个请求一行，每行一个响应，按 id 配对。
 *
 * 生命周期：懒 spawn（首次工具调用才起 Python，进程常驻，复用 mcp_server.py
 * 自己的 route worker 池 + frontmatter 缓存）。dispose 时 terminate。崩溃/超时
 * 自动重启一次；再失败则该次调用返回 isError，绝不抛到 DSH 启动路径。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const KROUTER_HOME = process.env.KROUTER_HOME || join(process.env.HOME || "", ".KRouter");
const MCP_SERVER = join(KROUTER_HOME, "current", "skill", "krouter", "scripts", "mcp_server.py");

/** 单次工具调用的超时（ms）。检索类通常 <2s；模型步骤（learn draft）可能数十秒。 */
const CALL_TIMEOUT_MS = 60000;
/** spawn 后等待 initialize 响应的超时（ms）。 */
const INIT_TIMEOUT_MS = 15000;

/**
 * KRouter MCP stdio 客户端。
 * 一个实例 = 一个常驻 mcp_server.py 子进程。
 */
export class KrouterMcp {
  /** @param {{vault:string, label?:string, callTimeoutMs?:number, onLog?:(lvl:string,msg:string)=>void}} opts */
  constructor(opts) {
    this.vault = opts.vault || "";
    this.label = opts.label || "";
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.onLog = opts.onLog || (() => {});
    this.proc = null;
    this.nextId = 1;
    /** @type {Map<number,{resolve:Function,reject:Function,timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    this.initPromise = null;
    this.starting = false;
  }

  /** mcp_server.py 是否存在（不可用时主动工具全部 graceful 降级）。 */
  static available() {
    return existsSync(MCP_SERVER);
  }

  /** 起子进程并完成 initialize 握手。幂等（并发调用共享同一个 initPromise）。 */
  _ensure() {
    if (this.proc && this.proc.exitCode === null) return this.initPromise || Promise.resolve();
    if (this.starting) return this.initPromise;
    if (!this.vault || !KrouterMcp.available()) {
      return Promise.reject(new Error("krouter mcp unavailable (no vault or mcp_server.py missing)"));
    }

    this.starting = true;
    this.initPromise = new Promise((resolve, reject) => {
      let settled = false;
      const argv = ["python3", MCP_SERVER, "--vault", this.vault];
      if (this.label) argv.push("--label", this.label);

      let proc;
      try {
        proc = spawn(argv[0], argv.slice(1), {
          env: { ...process.env, KROUTER_VAULT: this.vault, OBSIDIAN_VAULT: this.vault },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        this.starting = false;
        return reject(e);
      }
      this.proc = proc;

      // 不让常驻 MCP 子进程钉住 Node 事件循环（headless Agent 完成后要能自然退出）：
      // ChildProcess 本体 + 三条 stdio pipe 各自 unref。调用仍照常收发（ref 状态不影响
      // 数据流动，只影响"事件循环是否为它保持存活"）。web/desktop 常驻场景事件循环本就不空，无影响。
      // 崩溃/主动 dispose 仍走 _kill() 兜底，语义不变。
      try { proc.unref(); } catch {}
      try { proc.stdin?.unref(); } catch {}
      try { proc.stdout?.unref(); } catch {}
      try { proc.stderr?.unref(); } catch {}

      const initTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.starting = false;
        this._kill();
        reject(new Error("krouter mcp initialize timeout"));
      }, INIT_TIMEOUT_MS);

      let buffer = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        // newline-delimited JSON-RPC：逐行派发
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          this._dispatch(msg, initTimer, () => {
            if (!settled) { settled = true; this.starting = false; clearTimeout(initTimer); resolve(); }
          });
        }
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        // mcp_server.py 把访问日志写 stderr（json 行），不是错误；只在崩溃排查时有价值
        const s = String(d || "").trim();
        if (s) this.onLog("info", `krouter mcp stderr: ${s.slice(0, 200)}`);
      });

      proc.on("error", (e) => {
        if (!settled) { settled = true; this.starting = false; clearTimeout(initTimer); reject(e); }
        this._failAll(new Error(`krouter mcp process error: ${e.message}`));
      });

      proc.on("close", (code) => {
        this.proc = null;
        this.initPromise = null;
        this._failAll(new Error(`krouter mcp exited (code=${code})`));
      });

      // 发 initialize 握手
      this._send({ jsonrpc: "2.0", id: this.nextId++, method: "initialize",
        params: { clientInfo: { name: "dsh-krouter" } } });
    });

    return this.initPromise;
  }

  /**
   * 派发一行响应：initialize(id 匹配握手) 或普通请求(id 配对 pending)。
   */
  _dispatch(msg, initTimer, initResolve) {
    const id = msg.id;
    if (id === undefined || id === null) return; // 通知，忽略
    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }
    // initialize 的响应：它在 _ensure 里没进 pending（那时 pending 还没准备好就发了？不，
    // _send 在 promise 构造里同步发出，此刻 _dispatch 由 data 事件异步触发，pending 仍空）。
    // 所以 initialize 响应落在这里：视为握手成功。
    initResolve();
  }

  _send(obj) {
    try {
      this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch { /* stdin 已关闭，由 close 处理 */ }
  }

  _failAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  _kill() {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }

  /**
   * 调一个工具。返回 { ok, text, isError }，绝不抛（DSH 主动工具红线：失败返回文本）。
   * @param {string} name
   * @param {Record<string,any>} args
   */
  async callTool(name, args = {}) {
    if (!this.vault) {
      return { ok: false, text: "krouter: no vault configured (set vaultPath / KROUTER_VAULT)", isError: true };
    }
    if (!KrouterMcp.available()) {
      return { ok: false, text: `krouter: mcp_server.py not found at ${MCP_SERVER}`, isError: true };
    }
    let proc;
    try {
      await this._ensure();
      proc = this.proc;
    } catch (e) {
      // 起不来：重启一次再放弃
      this._kill();
      try {
        await this._ensure();
        proc = this.proc;
      } catch (e2) {
        return { ok: false, text: `krouter: mcp unavailable (${e2.message})`, isError: true };
      }
    }
    if (!proc) return { ok: false, text: "krouter: mcp process not running", isError: true };

    const id = this.nextId++;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __timeout: true });
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject: () => {}, timer });
      this._send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });

    if (result.__timeout) {
      // 超时：杀掉重启，避免僵尸请求堆积
      this.onLog("warn", `krouter mcp: ${name} timeout after ${this.callTimeoutMs}ms, restarting`);
      this._kill();
      return { ok: false, text: `krouter ${name}: timed out`, isError: true };
    }

    if (result.error) {
      return { ok: false, text: `krouter ${name}: ${result.error.message || "rpc error"}`, isError: true };
    }
    const content = result.result?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
      : "";
    return { ok: !result.result?.isError, text, isError: !!result.result?.isError };
  }

  /** 列出 server 暴露的工具（含它自己的内部门控后的可见集）。 */
  async listTools() {
    try {
      await this._ensure();
    } catch (e) {
      return { ok: false, tools: [], error: e.message };
    }
    const id = this.nextId++;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ __timeout: true }); }, INIT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject: () => {}, timer });
      this._send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    });
    if (result.__timeout) return { ok: false, tools: [], error: "timeout" };
    if (result.error) return { ok: false, tools: [], error: result.error.message };
    return { ok: true, tools: result.result?.tools || [] };
  }

  /** 干净关闭（DSH 插件 dispose 调用）。 */
  dispose() {
    this._failAll(new Error("krouter mcp disposed"));
    this._kill();
  }
}
