#!/usr/bin/env python3
"""独立 Mem0 检索常驻服务（canonical tracked 6610，读取重建后的 mem0 库）。

用法: venv/bin/python mem0/search_server.py --port 6610
端点: POST /search  {"query": "...", "limit": 5}  →  {"ok", "query", "items"}
      GET  /health  →  {"ok", "configured", "queryReady", "error"}

读取运行时设置：
  - 配置：MEM0_CONFIG_PATH（console-config.json）→ runtime_config(cfg) 纯助手
  - 数据：全部可变文件在 MEM0_ROOT（chroma-data / mem0-history.db）
  - 只读 query-ready 探针：MEM0_PROBE_RECORDS

健康语义（保留 2026-10-07 修正）：configured=Memory.from_config 成功；
queryReady=用已有 probe 向量做一次无 embed 的过滤查询成功（真可读性，非仅配置构造）。

仅绑定 127.0.0.1；不暴露写端点。集合名 tdai_mem 不变；用户/代理过滤保留。
"""
import argparse
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 与旧服务一致的默认回退；生产经 MEM0_ROOT / MEM0_CONFIG_PATH env 显式传入
MEM0_DIR = os.environ.get("MEM0_ROOT") or os.path.join(os.path.dirname(__file__), "..", "..", ".data", "mem0")
MEM0_CONFIG_PATH = os.environ.get("MEM0_CONFIG_PATH") or ""
CHROMA_PATH = os.environ.get("MEM0_SANDBOX_CHROMA") or os.path.join(MEM0_DIR, "chroma-data")
COLLECTION = "tdai_mem"
PROBE_RECORDS = os.environ.get("MEM0_PROBE_RECORDS") or ""

# unset 代理（DSH 环境 http_proxy 干扰 8810/Chroma）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"):
    os.environ.pop(k, None)


def load_config():
    """读取 MEM0_CONFIG_PATH 的 JSON；失败返回 {}。"""
    if not MEM0_CONFIG_PATH:
        return {}
    try:
        with open(MEM0_CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def runtime_config(cfg):
    """纯助手：从 console-config 提取 mem0 运行时的 llm + embedding 设置。
    llm 来自 cfg.mem0Model；embedding 来自 cfg.model.embedding（与 importer 共享行为）。"""
    m0m = cfg.get("mem0Model") or {}
    emb = (cfg.get("model") or {}).get("embedding") or {}
    return {
        "llm": {
            "baseUrl": m0m.get("baseUrl") or "http://127.0.0.1:18088/v1",
            "apiKey": m0m.get("apiKey") or "asdf",
            "model": m0m.get("model") or "Qwen3.8-27B-4bit",
            "maxTokens": int(m0m.get("maxTokens") or 20000),
        },
        "embedding": {
            "baseUrl": emb.get("baseUrl") or "http://192.168.1.108:8810/v1",
            "apiKey": emb.get("apiKey") or "asdf",
            "model": emb.get("model") or "WeMM-Embedding-2B-MLX-4bit",
            "dimensions": int(emb.get("dimensions") or 1024),
        },
    }


_CONFIG = load_config()
_RUNTIME = runtime_config(_CONFIG)
USER_ID = _CONFIG.get("userId") or os.environ.get("MEM0_USER_ID") or "usr-v3182h5u29"
AGENT_ID = _CONFIG.get("agentId") or os.environ.get("MEM0_AGENT_ID") or "agt-v318rqt0be"

_MEM = None
_STATE = {"configured": False, "queryReady": False, "error": ""}


def _ensure_mem0():
    """导入真实 mem0 包：本地 console/mem0/ 目录会遮蔽安装包，故把 venv site-packages 置前。
    惰性调用（build() 内），纯 runtime_config/模块加载无需 mem0。"""
    import sys
    try:
        import site
        for p in site.getsitepackages():
            if p and p not in sys.path:
                sys.path.insert(0, p)
    except Exception:
        pass
    from mem0 import Memory
    return Memory


def load_probe():
    """真实导出记录的 probe 向量 + 隔离 metadata；无 embed、无网络。"""
    if not PROBE_RECORDS:
        return None
    try:
        with open(PROBE_RECORDS, encoding="utf-8") as f:
            rec = json.loads(f.readline())
        return rec
    except Exception as e:
        _STATE["error"] = "probe load: " + str(e)[:120]
        return None


def build():
    """进程启动时一次性初始化（唯一慢的部分）。"""
    global _MEM
    Memory = _ensure_mem0()
    _MEM = Memory.from_config({
        "llm": {"provider": "openai", "config": {
            "model": _RUNTIME["llm"]["model"], "api_key": _RUNTIME["llm"]["apiKey"],
            "openai_base_url": _RUNTIME["llm"]["baseUrl"],
            "max_tokens": _RUNTIME["llm"]["maxTokens"]}},
        "embedder": {"provider": "openai", "config": {
            "model": _RUNTIME["embedding"]["model"], "api_key": _RUNTIME["embedding"]["apiKey"],
            "openai_base_url": _RUNTIME["embedding"]["baseUrl"],
            "embedding_dims": _RUNTIME["embedding"]["dimensions"]}},
        "vector_store": {"provider": "chroma", "config": {
            "collection_name": COLLECTION, "path": CHROMA_PATH}},
        "history_db_path": os.path.join(MEM0_DIR, "mem0-history.db"),
    })
    _STATE["configured"] = True


def verify_query_ready():
    """无 embed 的过滤查询自检：真实可读性判据。崩溃=读事故段（测试失败，进程退出）。"""
    rec = load_probe()
    if not rec:
        _STATE["queryReady"] = False
        return
    try:
        vec = base64.b64decode(rec["vector_b64"])
        import numpy as np
        qv = np.frombuffer(vec, dtype=np.float32).tolist()
        where = {"$and": [
            {"user_id": {"$eq": rec["metadata"]["user_id"]}},
            {"agent_id": {"$eq": rec["metadata"]["agent_id"]}},
        ]}
        res = _MEM.vector_store.collection.query(
            query_embeddings=[qv], n_results=1, where=where)
        if not res.get("ids") or len(res["ids"][0]) != 1:
            raise RuntimeError("probe query returned empty")
        _STATE["queryReady"] = True
    except Exception as e:
        _STATE["error"] = "queryReady probe: " + str(e)[:200]
        _STATE["queryReady"] = False


def search(query, limit):
    filters = {"user_id": USER_ID, "agent_id": AGENT_ID}
    res = _MEM.search(query, limit=limit, filters=filters)
    items = []
    for r in res.get("results", []):
        items.append({
            "content": r.get("memory", ""),
            "score": r.get("score", None),
            "metadata": r.get("metadata") or {},
        })
    return items


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/search":
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not _STATE["queryReady"]:
            self._json(503, {"ok": False, "error": "index not query-ready", "state": _STATE})
            return
        try:
            n = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(n) or b"{}")
            query = str(body.get("query") or "").strip()
            if not query:
                self._json(400, {"ok": False, "error": "query 必填"})
                return
            limit = max(1, min(20, int(body.get("limit") or 5)))
            items = search(query, limit)
            self._json(200, {"ok": True, "query": query, "items": items})
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)[:300]})

    def do_GET(self):
        if self.path == "/health":
            ok = _STATE["configured"] and _STATE["queryReady"]
            self._json(200 if ok else 503, {
                "ok": ok, "configured": _STATE["configured"],
                "queryReady": _STATE["queryReady"], "error": _STATE["error"]})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # 静默
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=6610)
    args = ap.parse_args()
    try:
        build()
        verify_query_ready()
    except Exception as e:
        _STATE["error"] = str(e)[:300]
        print("[mem0-search-server] init error:", _STATE["error"], flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("[mem0-search-server] listening 127.0.0.1:%d configured=%s queryReady=%s" % (
        args.port, _STATE["configured"], _STATE["queryReady"]), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
