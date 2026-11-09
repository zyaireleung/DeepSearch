import json
import os
import signal
import sqlite3
import time
from typing import Optional


def estimate_tokens(text: str) -> int:
    text = text or ""
    if all(ord(ch) < 0x80 for ch in text):
        return (len(text) + 3) // 4
    units = 0
    for ch in text:
        cp = ord(ch)
        if cp < 0x80 or cp < 0x1100:
            units += 1
        elif (0x1100 <= cp <= 0x11FF or 0x3000 <= cp <= 0x30FF or
              0x3130 <= cp <= 0x318F or 0x31F0 <= cp <= 0x31FF or
              0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF or
              0xAC00 <= cp <= 0xD7AF or 0xF900 <= cp <= 0xFAFF or
              0xFF00 <= cp <= 0xFFEF or 0x20000 <= cp <= 0x2EBEF):
            units += 6
        elif cp > 0xFFFF:
            units += 8
        else:
            units += 1
    return (units + 3) // 4


def read_synced_rows(source_db: str, session_cursors: dict, until_ms: Optional[int] = None) -> list[dict]:
    connection = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        records = connection.execute("""
          SELECT id, session_id, time_ms, iso_time, role, content
          FROM synced
          WHERE content IS NOT NULL AND trim(content) <> ''
          ORDER BY session_id ASC, time_ms ASC, id ASC
        """).fetchall()
    finally:
        connection.close()
    accepted = []
    for row_id, session_id, time_ms, iso_time, role, content in records:
        timestamp = int(time_ms or 0)
        if until_ms is not None and timestamp > until_ms:
            continue
        cursor = session_cursors.get(session_id)
        if cursor and (timestamp, row_id) <= (int(cursor["timeMs"]), str(cursor["id"])):
            continue
        accepted.append({"id": row_id, "sessionId": session_id, "timeMs": timestamp,
                         "isoTime": iso_time or "", "role": role or "user", "content": content})
    by_session = {}
    for row in accepted:
        by_session.setdefault(row["sessionId"], []).append(row)
    return [row for _, rows in sorted(by_session.items(), key=lambda item: (item[1][0]["timeMs"], item[1][0]["id"])) for row in rows]


def build_plan(rows: list[dict], token_budget: int, limit_batches: int) -> list[dict]:
    """按【token】贪心分批（Option B：batch = LLM 抽取窗口，由 pendingTokenBudget 定）。

    贪心分批，整条消息不拆分、不截断；单条消息超预算单独成批（不拆散）。
    每批拼成 embedding 检索输入后，再由 _segment_messages 按消息贪心分段，
    保证发往 8810 的单个 input[i] 长度受控（_add_to_vector_store 检索步骤的解耦）。
    """
    grouped, plan = {}, []
    for row in rows:
        grouped.setdefault(row["sessionId"], []).append(row)
    for session_id, messages in sorted(grouped.items(), key=lambda item: (item[1][0]["timeMs"], item[1][0]["id"])):
        pending, pending_tokens, session_batches = [], 0, []
        for message in messages:
            message_tokens = estimate_tokens(message["content"])
            if pending and pending_tokens + message_tokens > token_budget:
                session_batches.append(pending)
                pending, pending_tokens = [], 0
            pending.append(message)
            pending_tokens += message_tokens
            if message_tokens > token_budget:
                session_batches.append(pending)
                pending, pending_tokens = [], 0
        if pending:
            session_batches.append(pending)
        for index, batch_messages in enumerate(session_batches, start=1):
            if limit_batches and len(plan) >= limit_batches:
                return plan
            plan.append({"sessionId": session_id, "part": index, "partTotal": len(session_batches),
                         "messages": batch_messages, "messageIds": [row["id"] for row in batch_messages],
                         "messageCount": len(batch_messages),
                         "tokenEstimate": sum(estimate_tokens(row["content"]) for row in batch_messages)})
    return plan


def _align_rows_to_batch_limit(rows: list[dict], token_budget: int, limit_rows: int) -> list[dict]:
    """limit_rows 批对齐（对齐 OV ov-import.js _buildPlan 语义）：
    逐会话按 token 贪心切批 → 只累加【完整批】到 limit_rows（消息总数）上限；
    不截断批、不跨会话拼接。避免 rows[:N] 消息级硬切把会话切两半。
    边界（B）：若「第一批都还没装、该会话第一批就 > 剩余额度」→ 照取该整批
    （不拒绝、不截断、防单会话超 N 永远导入不了的死锁）；后续批超额度则停。
    limit_rows<=0 表示增量全部，原样返回。
    """
    if limit_rows <= 0:
        return rows
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["sessionId"], []).append(row)
    ordered = sorted(grouped.items(), key=lambda kv: (kv[1][0]["timeMs"], kv[1][0]["id"]))
    selected: list[dict] = []
    total = 0
    for _session_id, messages in ordered:
        pending: list[dict] = []
        pending_tokens = 0
        batches: list[list[dict]] = []
        for message in messages:
            message_tokens = estimate_tokens(message["content"])
            if pending and pending_tokens + message_tokens > token_budget:
                batches.append(pending)
                pending, pending_tokens = [], 0
            pending.append(message)
            pending_tokens += message_tokens
            if message_tokens > token_budget:
                batches.append(pending)
                pending, pending_tokens = [], 0
        if pending:
            batches.append(pending)
        for batch in batches:
            count = len(batch)
            if not selected and total == 0 and count > limit_rows:
                # 第一批就超 N：照取整批（不拒绝/不截断，防死锁）
                selected.extend(batch)
                total += count
                continue
            if total + count <= limit_rows:
                selected.extend(batch)
                total += count
            else:
                return selected  # 后续批会突破 N → 停（整会话/整批留给下次）
    return selected


def _serialize_messages(messages: list[dict]) -> str:
    """等价 Mem0 parse_messages()：把消息列表拼成检索/抽取输入字符串。"""
    return "".join(f"{(m.get('role') or 'user')}: {m.get('content') or ''}\n" for m in messages)


def _split_long_message(message: dict, char_budget: int) -> list[dict]:
    """把一条超预算消息按 char_budget 切成多片（2026-11-03 事故修复）。

    事故根因：旧逻辑"单条超预算独立成组且不截断"，把 9.4 万字符单条整条发给 8810
    → 单次超长前向 → 超 3GB（MLX_MEM_LIMIT）→ 8810 崩 → 24 批连锁 502。
    修复：超预算单条按预算切片，每片 serialized ≤ char_budget。

    - 切片保留原 message.id（可归因回源消息）与 role；content 为该片文本。
    - 尽量在标点/空白断开（回看窗口 = 预算一半），无断点则硬切（保证不超预算）。
    - 不丢字符：各片 content 顺序拼接 == 原文。
    """
    role = message.get("role") or "user"
    text = message.get("content") or ""
    if not text:
        return [message]
    prefix = f"{role}: "
    # 预留 prefix + 尾部换行的空间，保证每片 serialized 严格 ≤ char_budget
    body_budget = char_budget - len(prefix) - 1
    if body_budget <= 0:
        body_budget = max(1, char_budget - 1)
    slices, content_slices = [], []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + body_budget, n)
        piece = text[i:end]
        if end < n:
            # 非末片：在预算后段找标点/空白断点，避免词中间硬切
            cut = -1
            for sep in ("\n", "。", "！", "？", "；", ".", "!", "?", ";", " "):
                pos = piece.rfind(sep)
                if pos > body_budget // 2 and pos > cut:
                    cut = pos
            if cut > 0:
                piece = piece[: cut + 1]
        content_slices.append(piece)
        i += len(piece)
    for piece in content_slices:
        slices.append({"id": message.get("id"), "role": role, "content": piece})
    return slices or [message]


def _segment_messages(messages: list[dict], char_budget: int) -> list[list[dict]]:
    """检索 embedding 按【消息级贪心 + 超预算单条切片】分段：每子组 serialized ≤ char_budget。

    多条消息之间：整条为最小单元，累加直到超预算切组（绝不在消息边界内拆散）。
    单条消息超预算：按 char_budget 切成多片（不再整条发 8810，防超长前向爆内存）。
    每个子组 serialized 严格 ≤ char_budget（修复前"单条可超预算"的例外已移除）。
    """
    if char_budget <= 0:
        return [messages] if messages else []
    groups, current, cur_len = [], [], 0
    for message in messages:
        message_len = len(f"{(message.get('role') or 'user')}: {message.get('content') or ''}\n")
        if current and cur_len + message_len > char_budget:
            groups.append(current)
            current, cur_len = [], 0
        if message_len > char_budget:
            # 单条超预算：切成多片，每片独立成组（不再整条放行）
            if current:
                groups.append(current)
                current, cur_len = [], 0
            for piece in _split_long_message(message, char_budget):
                groups.append([piece])
            continue
        current.append(message)
        cur_len += message_len
    if current:
        groups.append(current)
    return groups


def install_segmentized_search(memory, char_budget: int):
    """把 mem0.add(infer=True) 黑盒内的【检索步骤】解耦：整批给 LLM，但检索 embedding 按消息分段。

    Option B 目标：LLM 看完整 60k 窗口（一次抽取），8810 只收消息级小段（不触发病态分配）。
    mem0 的 _add_to_vector_store 在解析前无条件把整批拼成一个字符串做 embed(parsed,"search")，
    这是 50GB 触发点。此处包装 embedding_model.embed（search 动作 + 超预算 → 按消息分段）
    和 vector_store.search（消费分段结果、逐段检索、合并去重），其余流水线（LLM 抽取、
    hash 去重、历史、实体关联）完全复用 mem0，不重写。

    返回句柄：begin_batch(messages) / end_batch() 供调用方在每次 add 前后设置/清除本批消息，
    使 embed 包装器能按消息边界分段。
    """
    emb = memory.embedding_model
    vec = memory.vector_store
    orig_embed = emb.embed
    orig_search = vec.search
    state = {"queries": [], "vectors": []}

    def embed_wrapper(text, memory_action=None):
        batch = getattr(emb, "_seg_batch", None)
        if (memory_action == "search" and batch):
            groups = _segment_messages(batch, char_budget)
            queries = [_serialize_messages(g) for g in groups]
            state["queries"] = queries
            state["vectors"] = [orig_embed(q, "search") for q in queries]
            return state["vectors"][0]
        return orig_embed(text, memory_action)

    def search_wrapper(query, vectors, top_k=5, filters=None):
        if state["vectors"]:
            queries, vecs = state["queries"], state["vectors"]
            state["queries"], state["vectors"] = [], []
            merged = {}
            for q, v in zip(queries, vecs):
                for result in orig_search(q, [v], top_k, filters):
                    if result.id and result.id not in merged:
                        merged[result.id] = result
            return list(merged.values())
        return orig_search(query, vectors, top_k, filters)

    emb.embed = embed_wrapper
    vec.search = search_wrapper

    class _Segmenter:
        def begin_batch(self, messages):
            emb._seg_batch = messages

        def end_batch(self):
            emb._seg_batch = None
            state["queries"], state["vectors"] = [], []

    return _Segmenter()


COLLECTION = "tdai_mem"

LANG_FOLLOW_INSTR = (
    "CRITICAL: Respond in the SAME LANGUAGE and SCRIPT as the input messages.\n"
    "Match the language of the user's messages exactly - if they write in Chinese, extract in Chinese.\n"
    "Do NOT translate or transliterate into English unless the input is already in English.\n"
    "Technical terms, proper nouns, brand names preserved in original form.\n"
    "Maintain all quality standards (contextual richness, temporal grounding) regardless of language."
)

OLD_FIELDS = ("cursorTs", "plannedEndTs", "currentId", "failedIds")


def now_ms() -> int:
    return int(time.time() * 1000)


def default_state() -> dict:
    return {"schemaVersion": 2, "sessionCursors": {}, "failedBatches": [], "plannedTotal": 0,
            "done": 0, "failed": 0, "doneSessions": [], "currentBatch": None, "lastError": None,
            "planSnapshot": []}


def _plan_snapshot(ordered: list[dict]) -> list[dict]:
    """原队列轻量快照：仅留 sessionId/part/messageIds，暂停后 resume 复用，防按 live 重切。"""
    return [{"sessionId": b["sessionId"], "part": b.get("part", 1),
             "messageIds": list(b["messageIds"])} for b in ordered]


def _batches_from_snapshot(snap: list[dict], source_db: str) -> list[dict]:
    """由 planSnapshot 重建完整批（按 messageIds 回查 content），保持原队列批组成不变。"""
    by_id = {}
    for row in read_synced_rows(source_db, {}):
        by_id[row["id"]] = row
    out = []
    for s in snap:
        msgs = [by_id[mid] for mid in s["messageIds"] if mid in by_id]
        if not msgs:
            continue  # 源已归档删除的批跳过
        out.append({"sessionId": s["sessionId"], "part": s["part"], "partTotal": s.get("partTotal", s["part"]),
                    "messages": msgs, "messageIds": list(s["messageIds"]),
                    "messageCount": len(msgs),
                    "tokenEstimate": sum(estimate_tokens(r["content"]) for r in msgs)})
    return out


def _row_by_id(row_id: str, source_db: str) -> Optional[dict]:
    """按 id 查单行（批完成判定用，只读）。"""
    try:
        con = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT id, time_ms FROM synced WHERE id=?", (row_id,)).fetchone()
        finally:
            con.close()
        return {"id": r[0], "timeMs": int(r[1] or 0)} if r else None
    except Exception:
        return None


def load_state(state_path: str) -> dict:
    if not os.path.exists(state_path):
        return default_state()
    try:
        with open(state_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return default_state()
    if any(k in data for k in OLD_FIELDS):
        raise RuntimeError("旧版全局游标状态不可续跑（cursorTs/plannedEndTs/currentId/failedIds）：请全新重建，勿转换全局时间戳为会话游标。")
    base = default_state()
    base.update({k: v for k, v in data.items() if k in base})
    return base


def save_state(state_path: str, state: dict) -> None:
    tmp = state_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, state_path)


def _fetch_rows_by_ids(source_db: str, ids: list) -> list:
    if not ids:
        return []
    connection = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        placeholders = ",".join("?" for _ in ids)
        records = connection.execute(
            f"SELECT id, session_id, time_ms, iso_time, role, content FROM synced WHERE id IN ({placeholders})",
            ids).fetchall()
    finally:
        connection.close()
    by_id = {row_id: {"id": row_id, "sessionId": session_id, "timeMs": int(time_ms or 0),
                      "isoTime": iso_time or "", "role": role or "user", "content": content}
             for row_id, session_id, time_ms, iso_time, role, content in records}
    return [by_id[i] for i in ids if i in by_id]


def _build_retry_batches(failed_batches: list, source_db: str) -> list:
    batches = []
    for fb in sorted(failed_batches, key=lambda b: b.get("failedAt", 0)):
        rows = _fetch_rows_by_ids(source_db, fb.get("messageIds", []))
        if not rows:
            continue
        batches.append({
            "sessionId": fb["sessionId"],
            "part": fb.get("part", 1),
            "partTotal": fb.get("part", 1),
            "messages": rows,
            "messageIds": list(fb.get("messageIds", [])),
            "messageCount": len(rows),
            "tokenEstimate": sum(estimate_tokens(r["content"]) for r in rows),
            "retry": True,
        })
    return batches


def _find_failure(failed_batches: list, message_ids: list):
    return next((fb for fb in failed_batches if fb.get("messageIds") == list(message_ids)), None)


def _record_failure(failed_batches: list, batch: dict, error: Exception) -> None:
    ts = now_ms()
    existing = _find_failure(failed_batches, batch["messageIds"])
    if existing is not None:
        existing["attempts"] = int(existing.get("attempts", 0)) + 1
        existing["error"] = str(error)
        existing["lastAttemptAt"] = ts
    else:
        failed_batches.append({
            "sessionId": batch["sessionId"],
            "part": batch.get("part", 1),
            "messageIds": list(batch["messageIds"]),
            "messageCount": batch.get("messageCount", len(batch["messageIds"])),
            "tokenEstimate": batch.get("tokenEstimate", 0),
            "error": str(error),
            "attempts": 1,
            "status": "failed",
            "failedAt": ts,
            "lastAttemptAt": ts,
        })


def _ensure_mem0():
    """导入真实 mem0 包：本地 console/mem0/ 目录会遮蔽安装包，故把 venv site-packages 置前。"""
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


def _sanitize_proxy_env() -> None:
    """构造 mem0 前清理代理环境。

    根因（2026-11-02 定位）：mem0.add() 的 OpenAI embedder/llm client 构造时，
    httpx2 会把 no_proxy 中的 `[::1]` 误当作 URL pattern 解析，抛
    `httpx2.InvalidURL: Invalid port: ':1]'`。与旧 8915 搜索服务 / search_server.py
    一致：构造 Memory 前删除全部代理变量。importer 的网络目标（LLM 18088、embed 8810）
    均为直连，不受代理影响。
    """
    for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"):
        os.environ.pop(key, None)


def _build_memory(root: str, config: dict):
    Memory = _ensure_mem0()
    _sanitize_proxy_env()
    m0m = config.get("mem0Model") or {}
    emb = (config.get("model") or {}).get("embedding") or {}
    llm_url = m0m.get("baseUrl") or "http://127.0.0.1:18088/v1"
    llm_model = m0m.get("model") or "Qwen3.8-27B-4bit"
    llm_api = m0m.get("apiKey") or "asdf"
    emb_url = emb.get("baseUrl") or "http://192.168.1.108:8810/v1"
    emb_model = emb.get("model") or "WeMM-Embedding-2B-MLX-4bit"
    emb_dims = int(emb.get("dimensions") or 1024)
    emb_api = emb.get("apiKey") or "asdf"
    # 对齐工作旧服务（mem0 2.2.1）：llm config 不含 max_tokens（该字段会破坏 openai provider 端口解析）
    return Memory.from_config({
        "llm": {"provider": "openai", "config": {"model": llm_model, "api_key": llm_api,
            "openai_base_url": llm_url}},
        "embedder": {"provider": "openai", "config": {"model": emb_model, "api_key": emb_api,
            "openai_base_url": emb_url, "embedding_dims": emb_dims}},
        "vector_store": {"provider": "chroma", "config": {"collection_name": COLLECTION,
            "path": os.path.join(root, "chroma-data")}},
        "history_db_path": os.path.join(root, "mem0-history.db"),
    })


def _write_probe_record(memory, root: str, user_id: str, agent_id: str, dimensions: int) -> None:
    """写出 search_server queryReady 探针记录（真实记忆向量 + user/agent metadata）。

    计划 L785 "probe records as today"：重建须保留旧管线行为。旧管线（tdai-memory-inject /
    mem0-prod-run / 旧 search server）实际无人写此文件=缺口；此为重建补全：成功 add 后从
    chroma 导出一条真实记忆的向量 + metadata，base64(float32)。chroma 的 get 不返回
    embeddings（本版本），故用 query（返回真实存储向量，双层嵌套 [query][result]）。
    search_server 的 verify_query_ready 用无 embed 过滤查询验证可读性。尽力而为，失败不阻塞导入。
    """
    probe_path = os.environ.get("MEM0_PROBE_RECORDS") or os.path.join(root, "probe-records.jsonl")
    if not probe_path:
        return
    try:
        coll = getattr(getattr(memory, "vector_store", None), "collection", None)
        if coll is None:
            return
        res = coll.query(query_embeddings=[[0.0] * int(dimensions or 1024)], n_results=1,
                         where={"$and": [{"user_id": {"$eq": user_id}},
                                         {"agent_id": {"$eq": agent_id}}]},
                         include=["embeddings", "metadatas"])
        ids = res.get("ids") or []
        if not (ids and ids[0]):
            return
        # chroma query 响应：embeddings/metadatas 为 numpy/list，形如 [[vec]]（每 query 的结果列表）
        emb_list = (res.get("embeddings") or [[]])[0]
        if hasattr(emb_list, "ndim"):                 # numpy：shape [n_results, dim]
            emb0 = emb_list[0] if emb_list.ndim >= 2 else emb_list
            emb0 = emb0.tolist()
        elif isinstance(emb_list, (list, tuple)) and emb_list and isinstance(emb_list[0], (list, tuple)):
            emb0 = list(emb_list[0])
        else:
            emb0 = list(emb_list)
        meta_list = (res.get("metadatas") or [[]])[0]
        if isinstance(meta_list, (list, tuple)) and meta_list and isinstance(meta_list[0], dict):
            meta0 = meta_list[0]
        elif isinstance(meta_list, dict):
            meta0 = meta_list
        else:
            meta0 = meta_list or {}
        import base64, struct
        vec = [float(x) for x in emb0]
        vector_b64 = base64.b64encode(struct.pack("<%df" % len(vec), *vec)).decode()
        meta = meta0 or {}
        rec = {"vector_b64": vector_b64,
               "metadata": {"user_id": meta.get("user_id", user_id),
                            "agent_id": meta.get("agent_id", agent_id)}}
        os.makedirs(os.path.dirname(os.path.abspath(probe_path)), exist_ok=True)
        with open(probe_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # probe 是尽力而为，失败不阻塞导入


def _write_mem0_count(memory, root: str) -> None:
    """写出 mem0-count.json（"Mem0 记忆总量" 只读快照，server.js mem0CountSnapshot 读取）。

    2026-11-02 用户："生产已导入 7 批为何记忆总量仍为空？"——旧管线从未写该文件（缺口），
    server 无快照 → UI 恒"—"。修复：run_import 结束时（含 stopped/partial-completed）从
    Chroma 集合 count() 取库内记忆条数写入 {count, at}。collection 缺失/失败跳过，不阻塞导入。
    """
    count_path = os.path.join(root, "mem0-count.json")
    try:
        coll = getattr(getattr(memory, "vector_store", None), "collection", None)
        if coll is None:
            return
        n = int(coll.count())
        import datetime
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        tmp = count_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"count": n, "at": at}, f)
        os.replace(tmp, count_path)
    except Exception:
        pass  # 尽力而为，失败不阻塞导入


def _stop_kind(root: str) -> Optional[str]:
    """返回暂停/停止的真实意图，兼容旧布尔格式。"""
    try:
        with open(os.path.join(root, "mem0-control.json"), encoding="utf-8") as f:
            ctrl = json.load(f)
    except Exception:
        return None
    cmd = ctrl.get("cmd")
    if cmd in ("pause", "stop"):
        return cmd
    if bool(ctrl.get("paused")):
        return "pause"
    if bool(ctrl.get("stopped")) or bool(ctrl.get("stop")):
        return "stop"
    return None


def _is_stopped(root: str) -> bool:
    return _stop_kind(root) is not None


class _StopRequested(Exception):
    """SIGTERM 的可控中断：由 run_import 收尾，而不是让进程直接死亡。"""


def _install_sigterm():
    """让 server 的 pause/stop SIGTERM 立即中断当前批，并正常写 state/count/run.json。"""
    requested = {"value": False}

    def _handler(_signum, _frame):
        requested["value"] = True
        raise _StopRequested()

    previous = signal.signal(signal.SIGTERM, _handler)
    return requested, previous


def _finalize(state: dict) -> None:
    state["doneSessions"] = sorted({sid for sid in state["sessionCursors"]
                                    if not any(fb.get("sessionId") == sid for fb in state["failedBatches"])})


def _emit_run_json(state: dict, outcome: str, *, stopped_by_user: bool = False) -> None:
    run_json = os.environ.get("MEM0_RUN_JSON")
    if not run_json:
        return
    try:
        os.makedirs(os.path.dirname(run_json), exist_ok=True)
        with open(run_json, "w", encoding="utf-8") as f:
            json.dump({"outcome": outcome, "done": state["done"], "failed": state["failed"],
                       "plannedTotal": state["plannedTotal"], "failedBatches": len(state["failedBatches"]),
                       "stoppedByUser": stopped_by_user}, f, ensure_ascii=False)
    except Exception:
        pass


def run_import(*, root: str, source_db: str, config: dict, memory_factory=None, limit_batches: int = 0,
               until_ms: Optional[int] = None, failed_only: bool = False, after_attempt=None,
               limit_rows: int = 0) -> dict:
    state_path = os.path.join(root, "mem0-state.json")
    state = load_state(state_path)
    # 配置读取路径统一：mem0Import 嵌套优先，顶层回退（防止 CLI(嵌套) 与 run_import(顶层) 不一致）
    m0cfg = config.get("mem0Import") or {}
    token_budget = int(m0cfg.get("pendingTokenBudget") or config.get("pendingTokenBudget") or 60000)
    # embed 按【字符】贪心分批（用户定 2026-11-04：30k 字符上限防 8810 MLX 显存超限崩溃）；LLM 仍按 60k token
    seg_budget = int(m0cfg.get("embedSearchCharBudget") or config.get("embedSearchCharBudget") or 30000)
    user_id = config.get("userId") or os.environ.get("MEM0_USER_ID") or "usr-v3182h5u29"
    agent_id = config.get("agentId") or os.environ.get("MEM0_AGENT_ID") or "agt-v318rqt0be"

    retry_batches = _build_retry_batches(state["failedBatches"], source_db)
    retry_ids = {mid for b in retry_batches for mid in b["messageIds"]}

    # ── resume 复用原队列：state 有未跑完的 planSnapshot 就沿用它，不按 OV live 重新切批。
    # 保证「暂停保留原队列 + 继续从作废批续跑」，OV 新增消息/limit_rows 变化都不影响原队列。
    snap = state.get("planSnapshot") or []
    cursors = state["sessionCursors"]
    # 批完成判定：游标只在完整批末条推进，故「批末条 ≤ 该会话游标(timeMs,id)」= 已完成。
    def _batch_done(s):
        cur = cursors.get(s["sessionId"])
        if not cur:
            return False
        row = _row_by_id(s["messageIds"][-1], source_db)
        if not row:
            return True  # 源已归档删除=视作已处理
        return (row["timeMs"], str(row["id"])) <= (int(cur["timeMs"]), str(cur["id"]))
    remaining_snap = [s for s in snap if not _batch_done(s)]
    if remaining_snap:
        new_batches = _batches_from_snapshot(remaining_snap, source_db)
    else:
        rows = read_synced_rows(source_db, state["sessionCursors"], until_ms)
        # 导入数量（同 OV ovImportN 语义）：limit_rows>0 限制消息总数但【批对齐】；0=增量全部。
        if limit_rows > 0:
            rows = _align_rows_to_batch_limit(rows, token_budget, limit_rows)
        new_batches = build_plan([r for r in rows if r["id"] not in retry_ids], token_budget, limit_batches)

    ordered = retry_batches if failed_only else (retry_batches + new_batches)
    # 新规划（非 resume）才存快照；resume 沿用旧快照不覆盖（保留原始队列边界）
    if not remaining_snap and not failed_only:
        state["planSnapshot"] = _plan_snapshot(new_batches)

    # 进度累积（resume 复用原队列）：plannedTotal=原队列全量、done 种子=已完成批数，
    # 避免每次 run 把 done 归零→进度卡回退。
    if remaining_snap:
        state["plannedTotal"] = len(snap)
        state["done"] = len(snap) - len(remaining_snap)
    else:
        state["plannedTotal"] = len(ordered)
        state["done"] = 0
    # 进度卡单位=批数（同 OV 进度卡"已完成 X 批"）：total 必须=批数而非消息条数。
    # resume 复用原队列：total=种子+本轮剩余批数=原队列全量，进度卡累积显示（3→12）不回退。
    state["total"] = state["done"] + len(ordered)
    state["failed"] = 0
    # 规划完即预设【第一批】为当前处理：前端进度卡一显示"当前处理"就是 sess·批 1/N，
    # 而非 null→"—"（否则第1批处理完之前一直显示"—"，用户看到"完成1批后才改样式"）。
    if ordered:
        _b0 = ordered[0]
        state["currentBatch"] = {"sessionId": _b0["sessionId"], "part": _b0["part"],
                                 "partTotal": _b0.get("partTotal", _b0["part"])}
    else:
        state["currentBatch"] = None
    # 规划一完成就落盘：前端进度卡首次显示即读取真实【批数】+ 当前处理，不等第一批处理完。
    save_state(state_path, state)

    memory = memory_factory() if memory_factory is not None else None
    segmenter = None
    any_failure = False
    stopped = False
    stop_signal, previous_sigterm = _install_sigterm()
    for batch in ordered:
        if stop_signal["value"] or _is_stopped(root):
            stopped = True
            break
        state["currentBatch"] = {"sessionId": batch["sessionId"], "part": batch["part"],
                                 "partTotal": batch.get("partTotal", batch["part"])}
        interrupted_batch = False
        try:
            if memory is None:
                memory = _build_memory(root, config)
                if seg_budget > 0 and hasattr(memory, "embedding_model") and hasattr(memory, "vector_store"):
                    segmenter = install_segmentized_search(memory, seg_budget)
            if segmenter is not None:
                segmenter.begin_batch(batch["messages"])
            try:
                memory.add(batch["messages"], user_id=user_id, agent_id=agent_id, infer=True, prompt=LANG_FOLLOW_INSTR)
            finally:
                if segmenter is not None:
                    segmenter.end_batch()
            state["done"] += 1
            emb_dim = int(((config.get("model") or {}).get("embedding") or {}).get("dimensions") or 1024)
            _write_probe_record(memory, root, user_id, agent_id, emb_dim)
            fb = _find_failure(state["failedBatches"], batch["messageIds"])
            if fb is not None:
                state["failedBatches"].remove(fb)
        except _StopRequested:
            # 直接暂停/停止：当前批未完成，不记失败、不推进游标；恢复时从这批重新处理。
            stopped = True
            interrupted_batch = True
        except Exception as exc:
            any_failure = True
            state["failed"] += 1
            _record_failure(state["failedBatches"], batch, exc)
        finally:
            if not interrupted_batch and not batch.get("retry"):
                last = batch["messages"][-1]
                state["sessionCursors"][batch["sessionId"]] = {"timeMs": last["timeMs"], "id": last["id"]}
            # 不清 currentBatch：保留本批 session·批 N/M 给前端轮询显示（OV 一致），
            # 下一批开始会覆盖、run 结束再清。否则批间落盘为 null → 前端"当前处理 —"。
            save_state(state_path, state)
            # 每批刷 mem0-count.json（coll.count 快照）：导入过程中"记忆总量"实时跳，
            # 暂停/停止也是已落地记忆的当前值（复用已打开 collection，开销毫秒级，失败不阻塞）。
            if memory is not None:
                _write_mem0_count(memory, root)
            if after_attempt is not None:
                after_attempt(batch, state)
        if interrupted_batch:
            break

    state["currentBatch"] = None  # run 结束清空"当前处理"（进度卡随后隐藏，OV 一致）
    _write_mem0_count(memory, root)
    _finalize(state)
    save_state(state_path, state)
    stop_kind = _stop_kind(root) if stopped else None
    outcome = ("paused" if stop_kind == "pause" else "stopped") if stopped else ("partial-completed" if any_failure else "completed")
    _emit_run_json(state, outcome, stopped_by_user=(stop_kind == "stop"))
    signal.signal(signal.SIGTERM, previous_sigterm)
    return state


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="mem0-importer", description="OpenViking synced → Mem0 导入")
    ap.add_argument("--root", default=os.environ.get("MEM0_ROOT", ""), help="可写库根（state/history/chroma 落此）")
    ap.add_argument("--source-db", default=os.environ.get("MEM0_SOURCE_DB", ""), help="源 synced 库（只读）")
    ap.add_argument("--config", default=os.environ.get("MEM0_CONFIG_PATH", ""), help="console-config.json（mem0Model/model/pendingTokenBudget）")
    ap.add_argument("--dry-run", action="store_true", help="只规划，不写库、不调模型")
    ap.add_argument("--limit-batches", type=int, default=0, help="限制批数（0=全部）")
    ap.add_argument("--budget", type=int, default=0, help="每批 token 预算（缺省用 config.pendingTokenBudget）")
    ap.add_argument("--until", type=int, default=0, help="仅解析 time_ms < 此值（毫秒；0=全部）")
    ap.add_argument("--failed-only", action="store_true", help="仅重试失败批（不解析新消息）")
    ap.add_argument("--limit-rows", type=int, default=0, help="导入数量=消息条数（0=增量全部；同 OV 导入 ovImportN 语义）")
    args = ap.parse_args(argv)
    cfg = {}
    if args.config and os.path.exists(args.config):
        with open(args.config, encoding="utf-8") as f:
            cfg = json.load(f)
    root = args.root or os.environ.get("MEM0_ROOT") or os.getcwd()
    source_db = args.source_db or os.environ.get("MEM0_SOURCE_DB") or ""
    if not source_db:
        print(json.dumps({"ok": False, "reason": "no source-db"}, ensure_ascii=False)); return 2
    m0cfg = cfg.get("mem0Import") or {}
    token_budget = args.budget or int(m0cfg.get("pendingTokenBudget") or 60000)
    if args.dry_run:
        rows = read_synced_rows(source_db, {})
        if args.limit_rows > 0:
            # dry-run 也用批对齐，与真实导入（run_import）口径一致
            rows = _align_rows_to_batch_limit(rows, token_budget, args.limit_rows)
        plan = build_plan(rows, token_budget, args.limit_batches)
        print(json.dumps({
            "dryRun": True, "plannedTotal": len(plan), "tokenBudget": token_budget,
            "sessions": [{"sessionId": b["sessionId"], "messageCount": b["messageCount"],
                          "part": b["part"], "partTotal": b["partTotal"]} for b in plan],
        }, ensure_ascii=False))
        return 0
    state = run_import(root=root, source_db=source_db, config=cfg,
                       limit_batches=args.limit_batches, until_ms=(args.until or None),
                       failed_only=args.failed_only, limit_rows=args.limit_rows)
    print(json.dumps({"ok": True, "plannedTotal": state.get("plannedTotal"), "done": state.get("done"),
                      "failed": state.get("failed"),
                      "failedBatches": state.get("failedBatches")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
