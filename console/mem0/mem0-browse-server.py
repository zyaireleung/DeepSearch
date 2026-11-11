#!/usr/bin/env python3
"""mem0-browse-server-6610: 只读浏览 mem0(嵌入式 Chroma) 记忆 —— 读 DeepSearch 重建后的【新库】

与旧 mem0-browse-server.py(:8917，读 ~/TencentDB-Agent-Memory/.data/mem0 旧库) 功能完全一致，
唯一区别是默认连 DeepSearch 侧重建库（与 canonical 6610 search_server.py 同一个 chroma-data）。

- 用与 mem0 search_server 相同的 venv(chromadb 1.5.9)直连 chroma-data，完全同版本
- 只提供 GET 只读端点，不写任何数据
- 自带一个零依赖 HTML 表格页(分页/user_id 过滤/语义搜索/详情)

用法:
  MEM0_SANDBOX_ROOT=/Users/zyaire/DeepSearch/.data/mem0 \
  /Users/zyaire/TencentDB-Agent-Memory/.data/mem0/venv/bin/python mem0-browse-server-6610.py --port 6620

端点:
  GET /                    HTML 表格页
  GET /api/health
  GET /api/collections     [{name, count}]
  GET /api/records?collection=tdai_mem&page=1&page_size=50&user_id=
  GET /api/records/{id}
  GET /api/search?q=...&limit=10&collection=tdai_mem   (语义搜索, 经 108:8810 WeMM 嵌入)
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

# 新库：DeepSearch 侧重建库（与 6610 search_server 同一 chroma-data）
MEM0_DIR = os.environ.get("MEM0_SANDBOX_ROOT") or "/Users/zyaire/DeepSearch/.data/mem0"
CHROMA_PATH = os.environ.get("MEM0_SANDBOX_CHROMA") or os.path.join(MEM0_DIR, "chroma-data")
COLLECTION = "tdai_mem"
EMBED_URL = "http://192.168.1.108:8810/v1"
EMBED_MODEL = "WeMM-Embedding-2B-MLX-4bit"
EMBED_DIMS = 1024

# unset 代理（与 mem0 search_server 一致：DSH 环境 http_proxy 干扰 8810/Chroma）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"):
    os.environ.pop(k, None)

from chromadb import PersistentClient  # noqa: E402
from chromadb.config import Settings  # noqa: E402
from openai import OpenAI  # noqa: E402

_CLIENT = None
_EMB = None
_STATE = {"ready": False, "error": ""}

_META_KEYS = ("data", "user_id", "agent_id", "hash", "created_at", "updated_at")


def build():
    """进程启动时一次性初始化"""
    global _CLIENT, _EMB
    _CLIENT = PersistentClient(
        path=CHROMA_PATH,
        settings=Settings(anonymized_telemetry=False, allow_reset=False),
    )
    _EMB = OpenAI(base_url=EMBED_URL, api_key="asdf")
    _STATE["ready"] = True


def _col(name):
    return _CLIENT.get_collection(name)


def _embed(text):
    # WeMM 是 Matryoshka 模型, 必须显式 dimensions=1024（与 mem0 的 embedding_dims 一致）
    r = _EMB.embeddings.create(model=EMBED_MODEL, input=[text], dimensions=EMBED_DIMS)
    return r.data[0].embedding


def _serialize(rid, meta, doc):
    meta = meta or {}
    return {
        "id": rid,
        "data": meta.get("data") or (doc or ""),
        "user_id": meta.get("user_id"),
        "agent_id": meta.get("agent_id"),
        "hash": meta.get("hash"),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "metadata": {k: v for k, v in meta.items() if k not in _META_KEYS},
    }


def list_collections():
    out = []
    for c in _CLIENT.list_collections():
        try:
            cnt = c.count()
        except Exception:
            cnt = None
        out.append({"name": c.name, "count": cnt})
    return out


def records(collection, page, page_size, user_id):
    col = _col(collection)
    where = {"user_id": user_id} if user_id else None
    if where:
        total = len(col.get(where=where, include=[])["ids"])
    else:
        total = col.count()
    offset = (page - 1) * page_size
    res = col.get(limit=page_size, offset=offset, include=["metadatas", "documents"], where=where)
    items = []
    for i, rid in enumerate(res["ids"]):
        meta = res["metadatas"][i] if res["metadatas"] else {}
        doc = res["documents"][i] if res["documents"] else None
        items.append(_serialize(rid, meta, doc))
    return {"total": total, "page": page, "page_size": page_size, "records": items}


def record_by_id(collection, rid):
    col = _col(collection)
    res = col.get(ids=[rid], include=["metadatas", "documents"])
    if not res["ids"]:
        return None
    meta = res["metadatas"][0] if res["metadatas"] else {}
    doc = res["documents"][0] if res["documents"] else None
    return _serialize(rid, meta, doc)


def search(collection, q, limit):
    col = _col(collection)
    emb = _embed(q)
    res = col.query(query_embeddings=[emb], n_results=limit, include=["metadatas", "documents", "distances"])
    items = []
    ids = res["ids"][0] if res.get("ids") else []
    for i, rid in enumerate(ids):
        meta = res["metadatas"][0][i] if res.get("metadatas") else {}
        doc = res["documents"][0][i] if res.get("documents") else None
        dist = res["distances"][0][i] if res.get("distances") else None
        score = round(1.0 / (1.0 + dist), 4) if dist is not None else None
        item = _serialize(rid, meta, doc)
        item["score"] = score
        items.append(item)
    return items


_HTML = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>mem0 browse (新库)</title>
<style>
 body{font:14px/1.5 -apple-system,sans-serif;margin:16px;background:#fafafa}
 h1{font-size:18px}
 .bar{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}
 input,select,button{padding:5px 8px;font-size:13px}
 table{border-collapse:collapse;width:100%;background:#fff}
 th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
 th{background:#f0f0f0;position:sticky;top:0}
 td.c{max-width:520px;word-break:break-word}
 .page{display:flex;gap:10px;align-items:center;margin:8px 0;font-size:13px}
 #detail{position:fixed;right:12px;top:12px;width:460px;max-height:86vh;overflow:auto;background:#fff;
   border:1px solid #ccc;border-radius:6px;padding:14px;box-shadow:0 4px 18px rgba(0,0,0,.15);display:none}
 #detail h3{margin:0 0 8px}
 .k{color:#666;font-size:12px;margin-top:6px}
 pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f7;padding:8px;border-radius:4px}
 .muted{color:#888;font-size:12px}
</style>
</head>
<body>
<h1>mem0 记忆浏览（只读 · 新库 DeepSearch）</h1>
<div class="bar">
  <select id="col"></select>
  <input id="uid" placeholder="user_id 过滤（可空）" style="width:220px">
  <input id="q" placeholder="语义搜索内容…" style="width:280px">
  <button id="btnSearch">搜索</button>
  <button id="btnBrowse">浏览</button>
</div>
<div class="page">
  <span id="info"></span>
  <button id="prev">← 上一页</button>
  <button id="next">下一页 →</button>
  <span id="pageNo"></span>
</div>
<table>
 <thead><tr><th style="width:120px">ID</th><th class="c">内容</th><th>User</th><th>Agent</th><th style="width:160px">Created（北京时间）</th></tr></thead>
 <tbody id="tbody"></tbody>
</table>
<div id="detail"></div>
<script>
let state={page:1,pageSize:50,total:0,mode:'browse'};
async function j(u){const r=await fetch(u);if(!r.ok)throw new Error(r.status+' '+u);return r.json();}
async function loadCols(){const c=await j('/api/collections');const s=document.getElementById('col');
 s.innerHTML=c.map(x=>`<option value="${x.name}">${x.name} (${x.count})</option>`).join('');
 const best=c.reduce((a,b)=>((b.count||0)>(a.count||0)?b:a),c[0]);
 if(best)s.value=best.name;
 if(!s.value)return; await browse();}
function esc(x){return String(x??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function fmtT(iso){if(!iso)return '--';var d=new Date(iso);if(isNaN(d))return String(iso).slice(0,19);
 var o={};new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(d).forEach(function(x){o[x.type]=x.value;});
 return o.year+'-'+o.month+'-'+o.day+' '+o.hour+':'+o.minute+':'+o.second;}
async function browse(){const col=document.getElementById('col').value;
 const uid=document.getElementById('uid').value.trim();
 const u=`/api/records?collection=${encodeURIComponent(col)}&page=${state.page}&page_size=${state.pageSize}`+(uid?`&user_id=${encodeURIComponent(uid)}`:'');
 const d=await j(u);state.total=d.total;state.mode='browse';render(d.records);
 document.getElementById('info').textContent=`共 ${d.total} 条，第 ${d.page} 页`;
 document.getElementById('pageNo').textContent=`${(d.page-1)*state.pageSize+1}–${Math.min(d.page*state.pageSize,d.total)}`;
 document.getElementById('prev').disabled=d.page<=1;
 document.getElementById('next').disabled=d.page*state.pageSize>=d.total;}
async function doSearch(){const q=document.getElementById('q').value.trim();if(!q)return;
 const col=document.getElementById('col').value;
 const d=await j(`/api/search?q=${encodeURIComponent(q)}&limit=30&collection=${encodeURIComponent(col)}`);
 state.total=d.length;state.mode='search';
 document.getElementById('info').textContent=`搜索「${q}」命中 ${d.length} 条`;
 render(d,true);}
function render(rows,isSearch){
 const tb=document.getElementById('tbody');tb.innerHTML='';
 rows.forEach(r=>{const tr=document.createElement('tr');
  tr.innerHTML=`<td class="muted">${esc(r.id.slice(0,8))}</td>
   <td class="c">${esc(r.data)}${isSearch&&r.score!=null?`<br><span class="muted">score ${r.score}</span>`:''}</td>
   <td>${esc(r.user_id)}</td><td>${esc(r.agent_id)}</td>
   <td class="muted">${esc(fmtT(r.created_at))}</td>`;
  tr.style.cursor='pointer';
  tr.onclick=async()=>{const col=document.getElementById('col').value;
    const d=await j(`/api/records/${encodeURIComponent(r.id)}?collection=${encodeURIComponent(col)}`);
    showDetail(d);};
  tb.appendChild(tr);});}
function showDetail(d){const el=document.getElementById('detail');
 const extra=Object.entries(d.metadata||{}).map(([k,v])=>`<div class="k">${esc(k)}</div><div>${esc(typeof v==='object'?JSON.stringify(v):v)}</div>`).join('');
 el.innerHTML=`<h3>记忆详情</h3>
  <div class="k">ID</div><pre>${esc(d.id)}</pre>
  <div class="k">内容</div><pre>${esc(d.data)}</pre>
  <div class="k">user_id</div><div>${esc(d.user_id)}</div>
  <div class="k">agent_id</div><div>${esc(d.agent_id)}</div>
  <div class="k">hash</div><div>${esc(d.hash)}</div>
  <div class="k">created_at（北京时间）</div><div>${esc(fmtT(d.created_at))}</div>
  <div class="k">updated_at（北京时间）</div><div>${esc(fmtT(d.updated_at))}</div>${extra}
  <div style="margin-top:10px"><button onclick="document.getElementById('detail').style.display='none'">关闭</button></div>`;
 el.style.display='block';}
document.getElementById('btnBrowse').onclick=()=>{state.page=1;browse();};
document.getElementById('btnSearch').onclick=doSearch;
document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
document.getElementById('uid').addEventListener('keydown',e=>{if(e.key==='Enter'){state.page=1;browse();}});
document.getElementById('prev').onclick=()=>{if(state.page>1){state.page--;state.mode==='browse'?browse():doSearch();}};
document.getElementById('next').onclick=()=>{if(state.page*state.pageSize<state.total){state.page++;state.mode==='browse'?browse():doSearch();}};
loadCols();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _text(self, code, text, ctype="text/html; charset=utf-8"):
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg):
        self._json(400, {"ok": False, "error": str(msg)[:300]})

    def do_GET(self):
        if not _STATE["ready"]:
            self._err(_STATE["error"] or "not ready")
            return
        path = self.path.split("?", 1)[0]
        qs = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        try:
            if path == "/":
                self._text(200, _HTML)
            elif path == "/api/health":
                self._json(200, {"ok": True, "ready": True})
            elif path == "/api/collections":
                self._json(200, list_collections())
            elif path == "/api/records":
                collection = (qs.get("collection") or [COLLECTION])[0]
                page = max(1, int((qs.get("page") or ["1"])[0]))
                page_size = max(1, min(500, int((qs.get("page_size") or ["50"])[0])))
                user_id = (qs.get("user_id") or [""])[0] or None
                self._json(200, records(collection, page, page_size, user_id))
            elif path.startswith("/api/records/"):
                collection = (qs.get("collection") or [COLLECTION])[0]
                rid = unquote(path[len("/api/records/"):])
                item = record_by_id(collection, rid)
                if item is None:
                    self._json(404, {"ok": False, "error": "not found"})
                else:
                    self._json(200, item)
            elif path == "/api/search":
                q = (qs.get("q") or [""])[0]
                if not q.strip():
                    self._err("q 必填")
                    return
                collection = (qs.get("collection") or [COLLECTION])[0]
                limit = max(1, min(50, int((qs.get("limit") or ["10"])[0])))
                self._json(200, search(collection, q, limit))
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            self._err(e)

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=6620)
    args = ap.parse_args()
    try:
        build()
    except Exception as e:
        _STATE["error"] = str(e)[:300]
        print("[mem0-browse-6610] init error:", _STATE["error"], flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mem0-browse-6610] listening 127.0.0.1:{args.port} ready={_STATE['ready']} chroma={CHROMA_PATH}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()