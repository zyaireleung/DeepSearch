/**
 * llm-bridge.js — 把 DSH 的模型通道借给 python 子进程
 *
 * 为什么需要它：nightly.py 的模型步骤跑在 python 子进程里，碰不到 cordis 服务；
 * 而 DSH 的 provider（provider 路由 / 凭据 / 重试 / 配额 / 模型校验）只在 Node 宿主
 * 进程里、经 ctx.llm 暴露。中间必须有一个边界 —— 这里就是那条边界：
 * 起一个只监听 127.0.0.1 的 OpenAI 兼容端点，python 侧的 llm.py 把它当成一条普通的
 * OpenAI 兼容通道（它本来就有这条通道），请求进来后转成 ctx.llm.stream()。
 *
 * 于是：
 * - provider / 端点 / 凭据 / 重试全由 DSH 决定（配的是 sensenova 就是 sensenova）
 * - python 侧不持有任何 key（env 里只有一个占位值）
 * - 失败按 DSH 的稳定 code 回给 python（NO_ADAPTER / MISSING_CREDENTIAL / RATE_LIMIT / QUOTA）
 * - 订阅通道由 KROUTER_HOST_CLI=0 关死，不会再静默掉回 claude
 */

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const MAX_BODY = 32 * 1024 * 1024;
// llm.py 自己的 TIMEOUT = 900s；桥比它早一点收手，好让 python 收到一个明确的错，
// 而不是自己先超时、把原因吞掉。
const CALL_TIMEOUT_MS = 870_000;

/**
 * "provider:model" → { provider, model }；没有冒号时 provider 为空（由调用方补）。
 * @param {string} raw
 * @returns {{provider: string, model: string}|null}
 */
export function splitSelection(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const i = s.indexOf(":");
  if (i > 0) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  return { provider: "", model: s };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * OpenAI messages → DSH GenerateOptions.messages（内容块形式）。
 * llm.py 只发一条 user；其余角色照实映射，空内容丢弃。
 */
export function toMessages(raw) {
  const out = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const m of list) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "system" ? "system" : "user";
    let text = "";
    if (typeof m?.content === "string") text = m.content;
    else if (Array.isArray(m?.content)) {
      text = m.content
        .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .join("");
    } else if (m?.content != null) text = String(m.content);
    if (!text) continue;
    out.push({ role, content: [{ type: "text", text }] });
  }
  return out;
}

/**
 * 起桥。只监听回环，端口由系统分配（0），不固定端口。
 * @param {object} ctx - 插件 ctx（只用到 ctx.llm / ctx.logger）
 * @param {() => string} getSelectionRaw - 返回当前 "provider:model"（每次请求实时取，配置页改了立刻生效）
 * @returns {{ready: Promise<number>, baseURL: string, describe: () => string, dispose: () => void}}
 */
export function startLlmBridge(ctx, getSelectionRaw) {
  let port = 0;
  let resolveReady = () => {};
  const ready = new Promise((r) => {
    resolveReady = r;
  });

  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };

    try {
      const url = req.url || "";

      // 只读探测：llm.py 的 catalog_ids() 会来拉模型列表（拿不到也不影响调用）
      if (req.method === "GET" && url.startsWith("/v1/models")) {
        let providers = [];
        try {
          // ctx.get() 而不是 ctx.llm：cordis 下直接读未 inject 的服务会抛
          // "cannot get property X without inject"，get() 只返回 undefined。
          providers = ctx?.get?.("llm")?.listProviders?.() ?? [];
        } catch {
          providers = [];
        }
        const data = Array.isArray(providers)
          ? providers.map((p) => (typeof p === "string" ? { id: p } : p))
          : [];
        return send(200, { object: "list", data });
      }

      if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
        return send(404, { error: { code: "NOT_FOUND", message: `${req.method} ${url}` } });
      }

      let size = 0;
      const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > MAX_BODY) {
          return send(413, { error: { code: "TOO_LARGE", message: `body > ${MAX_BODY} bytes` } });
        }
        parts.push(part);
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf-8") || "{}");
      } catch {
        return send(400, { error: { code: "BAD_JSON", message: "body is not JSON" } });
      }

      // provider 以配置页的选择为准；body 里若自带 "provider:model" 则尊重它（便于单步调试）
      const picked = splitSelection(getSelectionRaw?.() ?? "") || { provider: "", model: "" };
      let provider = picked.provider;
      let model = picked.model;
      const asked = typeof body?.model === "string" ? splitSelection(body.model) : null;
      if (asked?.provider) {
        provider = asked.provider;
        model = asked.model;
      } else if (asked?.model) {
        model = asked.model;
      }
      if (!model) {
        return send(400, {
          error: { code: "MISSING_MODEL", message: "nightlyModel 为空：没有模型可选" },
        });
      }
      if (!provider) {
        return send(400, {
          error: {
            code: "NO_ADAPTER",
            message: `nightlyModel 未带 provider 前缀（当前 "${getSelectionRaw?.() ?? ""}"），应形如 sensenova:sensenova-6.8-flash`,
          },
        });
      }

      const llm = ctx?.get?.("llm");
      if (typeof llm?.stream !== "function") {
        return send(503, {
          error: { code: "NO_ADAPTER", message: "ctx.llm 不可用（dsh-llm 未挂载）" },
        });
      }

      const messages = toMessages(body?.messages);
      if (!messages.length) {
        return send(400, { error: { code: "NO_MESSAGES", message: "messages 为空" } });
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
      if (typeof timer?.unref === "function") timer.unref();

      let text = "";
      let usageIn;
      let usageOut;
      let failure = null;
      try {
        for await (const chunk of llm.stream({ provider, model, messages, signal: ac.signal })) {
          if (chunk?.type === "text-delta") {
            text += chunk.text ?? "";
          } else if (chunk?.type === "usage") {
            const u = chunk.usage ?? chunk;
            usageIn = num(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens) ?? usageIn;
            usageOut = num(u.outputTokens ?? u.completionTokens ?? u.completion_tokens) ?? usageOut;
          } else if (chunk?.type === "finish") {
            if (chunk.kind === "error" || chunk.kind === "aborted") {
              failure = chunk.failure ?? { code: String(chunk.kind) };
            }
            break;
          }
        }
      } catch (e) {
        failure = { code: e?.code ?? "UPSTREAM", message: e?.message ?? String(e) };
      } finally {
        clearTimeout(timer);
      }

      if (failure) {
        const code = failure.code || failure.name || "UPSTREAM";
        ctx?.logger?.warn?.(`dsh-krouter: llm bridge 调用失败 ${provider}/${model} → ${code}`);
        return send(502, { error: { code, message: failure.message || code, provider, model } });
      }
      if (!text) {
        return send(502, { error: { code: "EMPTY", message: "provider 返回空文本", provider, model } });
      }

      return send(200, {
        id: `chatcmpl-bridge-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: usageIn ?? 0,
          completion_tokens: usageOut ?? 0,
          total_tokens: (usageIn ?? 0) + (usageOut ?? 0),
        },
      });
    } catch (e) {
      try {
        send(500, { error: { code: "BRIDGE", message: e?.message ?? String(e) } });
      } catch {
        /* 连接已断，无处可回 */
      }
    }
  });

  server.on("error", (e) => {
    ctx?.logger?.warn?.(`dsh-krouter: llm bridge 启动失败: ${e?.message ?? String(e)}`);
    resolveReady(0);
  });

  server.listen(0, HOST, () => {
    const a = server.address();
    port = typeof a === "object" && a ? a.port : 0;
    ctx?.logger?.info?.(`dsh-krouter: llm bridge 监听 ${HOST}:${port}（python 模型步骤 → DSH provider）`);
    resolveReady(port);
  });
  if (typeof server.unref === "function") server.unref();

  return {
    ready,
    get baseURL() {
      return port ? `http://${HOST}:${port}/v1` : "";
    },
    describe() {
      return port ? `http://${HOST}:${port}/v1` : "(starting)";
    },
    dispose() {
      try {
        server.close();
      } catch {
        /* 已关 */
      }
    },
  };
}
