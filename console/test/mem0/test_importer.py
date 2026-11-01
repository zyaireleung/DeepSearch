import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMPORTER = ROOT / "mem0" / "importer.py"
SEARCH_SERVER = ROOT / "mem0" / "search_server.py"


def load_importer():
    spec = importlib.util.spec_from_file_location("mem0_importer", IMPORTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_search_server():
    spec = importlib.util.spec_from_file_location("mem0_search_server", SEARCH_SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_session_a_db(directory):
    """创建恰好 187 条 session-a 行的 fixture（不含 session-b 等时间戳行）。"""
    db_path = pathlib.Path(directory) / "ov-ingest-state.db"
    db = sqlite3.connect(db_path)
    db.executescript("""
      CREATE TABLE synced (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_path TEXT NOT NULL,
        time_ms INTEGER, iso_time TEXT, role TEXT, content TEXT,
        ov_done INTEGER NOT NULL DEFAULT 0, vector_done INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL
      );
    """)
    rows = []
    for i in range(187):
        rows.append((f"a-{i:03d}", "session-a", "fixture/a", 1000 + i,
                     "2026-01-01T00:00:00Z", "user" if i % 2 == 0 else "assistant",
                     "xxxx", 1, 1, 0, None, 1000 + i))
    db.executemany("INSERT INTO synced VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    db.commit()
    db.close()
    return db_path


def make_synced_db(directory):
    db_path = make_session_a_db(directory)
    db = sqlite3.connect(db_path)
    # Same timestamp validates the cursor tie-breaker by id.
    rows = [
      ("b-a", "session-b", "fixture/b", 2000, "2026-01-01T00:00:02Z", "user", "xxxx", 1, 1, 0, None, 2000),
      ("b-b", "session-b", "fixture/b", 2000, "2026-01-01T00:00:02Z", "assistant", "xxxx", 1, 1, 0, None, 2000),
    ]
    db.executemany("INSERT INTO synced VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    db.commit()
    db.close()
    return db_path


def _serialized_len(messages):
    """等价 Mem0 parse_messages()：把整批消息拼成一个字符串后的长度。
    这正是会作为单个 input[0] 发给 8810 的形状，是本次事故的直接触发量。"""
    return sum(len(f"{m.get('role') or 'user'}: {m.get('content') or ''}\n") for m in messages)


def _has_mem0():
    """真实 mem0 可导入检测：本地 console/mem0/ 目录会遮蔽安装包，
    须先插 site-packages 再 from mem0 import Memory（与 importer._ensure_mem0 一致）。"""
    import sys
    try:
        import site
        for p in site.getsitepackages():
            if p and p not in sys.path:
                sys.path.insert(0, p)
    except Exception:
        pass
    try:
        from mem0 import Memory  # noqa: F401
        return True
    except Exception:
        return False


HAS_MEM0 = _has_mem0()


class _MockModelServer:
    """本地 mock OpenAI 兼容端点：捕获 /embeddings 请求体，返回固定向量；
    /chat/completions 返回最小抽取 JSON。用于在【不碰真实 LLM / 不碰真实 8810】
    的前提下，跑真实 mem0 add() 路径并观测实际发出的 input 形状。"""

    def __init__(self, dims=8):
        self.dims = dims
        self.embed_bodies = []
        self.llm_bodies = []
        self._server = None
        self._thread = None
        self.port = 0

    def _handle(self):
        from http.server import BaseHTTPRequestHandler

        dims = self.dims

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _read_body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def do_POST(self):
                body = self._read_body()
                if self.path.endswith("/embeddings"):
                    import json
                    payload = json.loads(body.decode("utf-8"))
                    self.server.embed_bodies.append(payload)  # type: ignore[attr-defined]
                    inputs = payload.get("input", [])
                    data = [{"embedding": [0.0] * dims, "index": i} for i in range(len(inputs))]
                    out = json.dumps({"object": "list", "data": data, "model": payload.get("model", "mock"),
                                      "usage": {"prompt_tokens": 0, "total_tokens": 0}}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                elif self.path.endswith("/chat/completions"):
                    import json
                    self.server.llm_bodies.append(json.loads(body.decode("utf-8")))  # type: ignore[attr-defined]
                    out = json.dumps({
                        "choices": [{"message": {"role": "assistant", "content": json.dumps({"memory": [{"text": "probe memory"}]})}}]
                    }).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                else:
                    self.send_response(404)
                    self.end_headers()

        return Handler

    def start(self):
        import http.server
        import threading

        handler = self._handle()
        # 绑定到临时端口（回环）；绝不使用已知服务端口（18088/8810/8915/8096/13000/3000）。
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self._server.server_address[1]
        # 让 handler 能访问捕获列表
        self._server.embed_bodies = self.embed_bodies  # type: ignore[attr-defined]
        self._server.llm_bodies = self.llm_bodies  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


class ImporterPlanningTests(unittest.TestCase):
    def test_session_batches_are_token_bounded_and_never_cross_sessions(self):
        """token 分批契约（Option B：batch = LLM 窗口，由 pendingTokenBudget 定）。"""
        importer = load_importer()
        with tempfile.TemporaryDirectory() as tmp:
            db_path = make_synced_db(tmp)
            rows = importer.read_synced_rows(str(db_path), {})
            plan = importer.build_plan(rows, token_budget=50, limit_batches=0)
        a_batches = [b for b in plan if b["sessionId"] == "session-a"]
        self.assertEqual([b["messageCount"] for b in a_batches], [50, 50, 50, 37])
        self.assertTrue(all(len({m["sessionId"] for m in b["messages"]}) == 1 for b in plan))

    def test_segment_messages_greedy_keeps_whole_messages(self):
        """检索 embedding 分段（消息级贪心）：每子组 serialized ≤ budget，
        且绝不在消息中间切——单条超限单独成组（不拆分、不截断）。"""
        importer = load_importer()
        messages = [{"id": f"m{i}", "role": "user" if i % 2 == 0 else "assistant", "content": "xxxx"}
                    for i in range(20)]
        groups = importer._segment_messages(messages, char_budget=60)
        self.assertGreater(len(groups), 1, "应切出多个子组")
        for group in groups:
            self.assertLessEqual(len(importer._serialize_messages(group)), 60)
            # 每个子组只含完整消息（无中间拆分：组内 id 严格递增）
            ids = [m["id"] for m in group]
            self.assertEqual(ids, [f"m{int(x[1:])}" for x in ids])
        # 所有消息恰好被划分一次（不丢、不重、顺序保持）
        flat = [m["id"] for g in groups for m in g]
        self.assertEqual(flat, [f"m{i}" for i in range(20)])

    def test_segment_messages_single_oversized_becomes_own_group(self):
        """单条超预算消息不拆分：独立成组（可超预算），绝不截断。"""
        importer = load_importer()
        messages = [{"id": "big", "role": "user", "content": "x" * 500}]
        groups = importer._segment_messages(messages, char_budget=60)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0][0]["content"], "x" * 500)  # 整条保留
        self.assertEqual(len(importer._serialize_messages(groups[0])), 500 + len("user: \n"))

    def test_segment_messages_empty(self):
        importer = load_importer()
        self.assertEqual(importer._segment_messages([], 100), [])
        self.assertEqual(importer._segment_messages([], 0), [])

    def test_cjk_estimator_matches_the_ov_formula(self):
        importer = load_importer()
        self.assertEqual(importer.estimate_tokens('abcd'), 1)
        self.assertEqual(importer.estimate_tokens('中文'), 3)
        self.assertEqual(importer.estimate_tokens('a中'), 2)

    def test_equal_timestamp_uses_id_as_cursor_tie_breaker(self):
        importer = load_importer()
        with tempfile.TemporaryDirectory() as tmp:
            db_path = make_synced_db(tmp)
            rows = importer.read_synced_rows(str(db_path), {
                'session-b': {'timeMs': 2000, 'id': 'b-a'},
            })
        self.assertEqual([row['id'] for row in rows if row['sessionId'] == 'session-b'], ['b-b'])

    def test_cutoff_keeps_only_source_rows_at_or_before_cutoff(self):
        importer = load_importer()
        with tempfile.TemporaryDirectory() as tmp:
            db_path = make_synced_db(tmp)
            rows = importer.read_synced_rows(str(db_path), {}, until_ms=1024)
        self.assertEqual([row['id'] for row in rows], [f'a-{i:03d}' for i in range(25)])

    def test_failed_batch_is_retried_first_without_replaying_successes(self):
        importer = load_importer()
        class FakeMemory:
            calls = []
            fail_once = True
            def add(self, messages, **_kwargs):
                ids = [message["id"] for message in messages]
                FakeMemory.calls.append(ids)
                if FakeMemory.fail_once and ids[0] == "a-050":
                    FakeMemory.fail_once = False
                    raise RuntimeError("forced provider failure")
                return {"results": [{"memory": "fixture-memory"}]}
        with tempfile.TemporaryDirectory() as tmp:
            db_path = make_synced_db(tmp)
            config = {"pendingTokenBudget": 50, "userId": "fixture-user", "agentId": "fixture-agent"}
            first = importer.run_import(root=tmp, source_db=str(db_path), config=config, memory_factory=FakeMemory)
            self.assertEqual(first["failedBatches"][0]["messageIds"], [f"a-{i:03d}" for i in range(50, 100)])
            self.assertEqual(first["failedBatches"][0]["attempts"], 1)
            self.assertEqual(first["sessionCursors"]["session-a"]["id"], "a-186")
            second = importer.run_import(root=tmp, source_db=str(db_path), config=config, memory_factory=FakeMemory)
        self.assertEqual(second["failedBatches"], [])
        self.assertEqual(FakeMemory.calls[5], [f"a-{i:03d}" for i in range(50, 100)])
        self.assertEqual(FakeMemory.calls.count([f"a-{i:03d}" for i in range(50)]), 1)

    def test_mem0_runtime_config_uses_mem0_llm_and_shared_embedding(self):
        server = load_search_server()
        cfg = {
          'mem0Model': {'baseUrl': 'http://llm.test/v1', 'apiKey': 'llm-key', 'model': 'llm-x', 'maxTokens': 1234},
          'model': {'embedding': {'baseUrl': 'http://embed.test/v1', 'apiKey': 'embed-key', 'model': 'embed-x', 'dimensions': 768}},
        }
        runtime = server.runtime_config(cfg)
        self.assertEqual(runtime['llm']['model'], 'llm-x')
        self.assertEqual(runtime['embedding']['dimensions'], 768)
        self.assertEqual(runtime['embedding']['apiKey'], 'embed-key')

    def test_sanitize_proxy_env_removes_proxy_and_no_proxy(self):
        """根因：mem0.add() 的 OpenAI embedder 构造时，httpx2 会误解析 no_proxy 中的
        `[::1]` 为 URL pattern，抛 `httpx2.InvalidURL: Invalid port: ':1]'`。
        与旧 8915 服务一致：构造 Memory 前清理全部代理环境。"""
        importer = load_importer()
        original = {k: os.environ.get(k) for k in
                    ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy")}
        try:
            os.environ["http_proxy"] = "http://127.0.0.1:7890"
            os.environ["https_proxy"] = "http://127.0.0.1:7890"
            os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1,token.sensenova.cn,ark.cn-beijing.volces.com,api.tavily.com,[::1]"
            os.environ["no_proxy"] = "localhost,127.0.0.1,::1,token.sensenova.cn,ark.cn-beijing.volces.com,api.tavily.com,[::1]"
            importer._sanitize_proxy_env()
            for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"):
                self.assertNotIn(key, os.environ)
        finally:
            for key, value in original.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_write_probe_record_exports_real_vector_and_metadata(self):
        """probe 记录（search_server queryReady 依赖）在成功 add 后写出真实记忆向量+metadata。
        计划 L785 'probe records as today'：重建必须保留旧管线行为；现无任何代码写它=缺口。"""
        importer = load_importer()
        import base64, struct

        class _FakeCollection:
            def query(self, query_embeddings=None, n_results=None, where=None, include=None):
                # 仿 chroma query 响应：embeddings/metadatas 双层嵌套（[query][result]）
                return {"ids": [["mem-1"]],
                        "embeddings": [[[0.1, 0.2, 0.3, 0.4]]],
                        "metadatas": [[{"user_id": "usr-p", "agent_id": "agt-p"}]]}

        class _FakeStore:
            collection = _FakeCollection()

        class _FakeMemory:
            vector_store = _FakeStore()

        with tempfile.TemporaryDirectory() as tmp:
            importer._write_probe_record(_FakeMemory(), tmp, "usr-p", "agt-p", 4)
            probe_path = os.path.join(tmp, "probe-records.jsonl")
            self.assertTrue(os.path.exists(probe_path), "应写出 probe-records.jsonl")
            rec = json.loads(open(probe_path, encoding="utf-8").readline())
            self.assertIn("vector_b64", rec)
            self.assertEqual(rec["metadata"], {"user_id": "usr-p", "agent_id": "agt-p"})
            vec = list(struct.unpack("<4f", base64.b64decode(rec["vector_b64"])))
            self.assertAlmostEqual(vec[0], 0.1)


class ImporterIntegrationTests(unittest.TestCase):
    def test_progress_failure_retry_and_cursor_persistence(self):
        importer = load_importer()
        snapshots, completed = [], []
        class FakeMemory:
            fail_once = True
            def add(self, messages, **_kwargs):
                ids = [message['id'] for message in messages]
                if FakeMemory.fail_once and ids[0] == 'a-050':
                    FakeMemory.fail_once = False
                    raise RuntimeError('forced provider failure')
                completed.extend(ids)
                return {'results': [{'memory': 'fixture-memory'}]}
        with tempfile.TemporaryDirectory() as tmp:
            db_path = make_session_a_db(tmp)
            def checkpoint(_batch, state):
                snapshots.append((state['done'], state['sessionCursors']['session-a']['id']))
            state = importer.run_import(
                root=tmp, source_db=str(db_path),
                config={'pendingTokenBudget': 50, 'userId': 'fixture-user', 'agentId': 'fixture-agent'},
                memory_factory=FakeMemory, after_attempt=checkpoint,
            )
            self.assertEqual(snapshots, [(1, 'a-049'), (1, 'a-099'), (2, 'a-149'), (3, 'a-186')])
            self.assertEqual(state['plannedTotal'], 4)
            self.assertEqual(state['failedBatches'][0]['attempts'], 1)
            state = importer.run_import(
                root=tmp, source_db=str(db_path),
                config={'pendingTokenBudget': 50, 'userId': 'fixture-user', 'agentId': 'fixture-agent'},
                memory_factory=FakeMemory,
            )
        self.assertEqual(state['failedBatches'], [])
        self.assertEqual(sorted(completed), [f'a-{i:03d}' for i in range(187)])
        self.assertEqual(len(completed), 187)


@unittest.skipUnless(HAS_MEM0, "mem0 不可导入（需 venv python），跳过真实路径形状验收")
class ImporterRealShapeTests(unittest.TestCase):
    """Option B 真实验收（真实 mem0 add() + 本地 mock 端点，不碰真实 LLM/8810）：
    验证 ① LLM 只被调用一次（整批=60k 窗口保留）；② 检索 embedding 被按消息贪心分段，
    每个 input[i] ≤ 预算；③ 没有消息被拆分。这是"60k LLM + 分段 8810"的直接判据。"""

    def test_option_b_keeps_single_llm_and_segments_embed_input(self):
        importer = load_importer()
        server = _MockModelServer()
        server.start()
        try:
            base = f"http://127.0.0.1:{server.port}/v1"
            with tempfile.TemporaryDirectory() as tmp:
                db_path = make_session_a_db(tmp)
                config = {
                    "pendingTokenBudget": 200,   # 187 条 'xxxx' ≈ 187 token → 一批（整窗口给 LLM）
                    "embedSearchCharBudget": 100,  # 检索每子组 serialized ≤100 → 强制分段
                    "userId": "fixture-user",
                    "agentId": "fixture-agent",
                    "mem0Model": {"baseUrl": base, "model": "mock-llm", "apiKey": "asdf"},
                    "model": {"embedding": {"baseUrl": base, "model": "mock-embed", "dimensions": 8, "apiKey": "asdf"}},
                }
                state = importer.run_import(root=tmp, source_db=str(db_path), config=config, limit_batches=1)
                self.assertEqual(state['failed'], 0, state.get('failedBatches'))
                # probe 记录：search_server queryReady 依赖（计划 L785 'as today'）
                probe_path = os.path.join(tmp, "probe-records.jsonl")
                self.assertTrue(os.path.exists(probe_path), "probe 记录应在成功 add 后写出")
                rec = json.loads(open(probe_path, encoding="utf-8").readline())
                self.assertEqual(rec["metadata"], {"user_id": "fixture-user", "agent_id": "fixture-agent"})
                self.assertIn("vector_b64", rec)
            # ① LLM 只调用一次：整批（60k 窗口）一次抽取，未被拆成多次
            self.assertEqual(len(server.llm_bodies), 1, "LLM 应只调用一次（整批窗口保留）")
            # ② 检索 embedding 被分段：捕获到多条 ≥50 字符的输入（窗口片段），且每条 ≤ 预算+余量
            search_inputs = [len(inp) for p in server.embed_bodies for inp in p.get("input", []) if len(inp) >= 50]
            self.assertGreaterEqual(len(search_inputs), 2, "检索应被切成多段")
            for p in server.embed_bodies:
                for inp in p.get("input", []):
                    self.assertLessEqual(len(inp), 100 + 30, f"embed input[i] 过长: {len(inp)} chars")
        finally:
            server.stop()
