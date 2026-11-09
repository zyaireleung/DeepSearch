"""fanout 协调器：web 多站点真并行 + crawl 平台串行队列，跨子类同时推进。

并发格局（path-1 定稿，2026-11-08 实测）：
  - web 分支：Wigolo 无状态 HTTP，ThreadPoolExecutor 并发打 gateway，互不干扰。
  - crawl 分支：两个 MediaCrawler 并行抢同一 Thorium CDP 会双双崩，故**串行队列**逐个跑。
  - web 与 crawl 队列之间**并发**（不同后端不抢资源）。

取消语义在 agent 侧：fanout 只跑本轮传入的 branches，单轮无内部循环、无跨轮状态；
某分支信息够则 agent 下一轮不重发（取消=不发起）。每分支返回 {start,end,status} 供汇总与断言。
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import crawl
import evidence
import gateway


def _run_web(branch, base_url, token):
    """web 分支：打一次 gateway，返回 dedupe 后证据。"""
    start = time.time()
    try:
        resp = gateway.call_gateway(base_url, token, {
            "run_id": branch.get("run_id", "fanout"),
            "query": branch["query"],
            "evidence_needs": branch.get("evidence_needs", ["general_web"]),
            "intent": branch.get("intent", "general"),
            "limit": branch.get("limit", 5),
        })
        added = evidence.dedupe(resp.get("results", []))
        return {"ok": True, "status": "ok", "start": start, "end": time.time(),
                "results": added, "count": len(added), "diagnostics": resp.get("diagnostics")}
    except gateway.GatewayError as e:
        return {"ok": False, "status": "error", "start": start, "end": time.time(),
                "error": str(e), "count": 0}
    except Exception as e:  # 单分支失败不连坐
        return {"ok": False, "status": "error", "start": start, "end": time.time(),
                "error": "%s: %s" % (type(e).__name__, e), "count": 0}


def _run_crawl(branch):
    """crawl 分支：串行队列里逐个跑 MediaCrawler（save_root 由调用方预分配）。
    兜异常——单平台崩溃（subprocess/JSON/网络）绝不能杀死串行队列里后续平台。"""
    start = time.time()
    save_root = branch.get("save_root")
    if not save_root:
        return {"ok": False, "status": "error", "start": start, "end": time.time(),
                "error": "crawl branch needs save_root", "count": 0}
    try:
        r = crawl.run_crawl(branch["platform"], branch.get("type", "search"), save_root,
                            creator_id=branch.get("creator_id"),
                            specified_id=branch.get("specified_id"),
                            keywords=branch.get("keywords"),
                            timeout=branch.get("timeout", 600))
    except Exception as e:  # 一败不连坐：捕获后继续队列下一个平台
        return {"ok": False, "status": "error", "start": start, "end": time.time(),
                "error": "%s: %s" % (type(e).__name__, e), "count": 0}
    end = time.time()
    out = {"ok": bool(r.get("ok")), "status": "ok" if r.get("ok") else "error",
           "start": start, "end": end,
           "raw_records": r.get("raw_records", []), "count": r.get("count", 0),
           "output_dir": r.get("output_dir"), "new_files": r.get("new_files", [])}
    if not r.get("ok"):
        out["error"] = r.get("error")
    return out


def run_fanout(branches, base_url, token, max_web_workers=8):
    """并发跑一批 branches：web 并发、crawl 串行、跨类并发。

    branches: [{id, kind:"web"|"crawl", ...}]。返回逐分支结果列表（顺序与输入一致），
    每项含 {id, kind, ok, status, start, end, durationMs, ...}。
    """
    results = [None] * len(branches)
    web_idx = [i for i, b in enumerate(branches) if b.get("kind") == "web"]
    crawl_idx = [i for i, b in enumerate(branches) if b.get("kind") == "crawl"]

    def run_web_pool():
        if not web_idx:
            return
        with ThreadPoolExecutor(max_workers=min(max_web_workers, len(web_idx))) as ex:
            futs = {ex.submit(_run_web, branches[i], base_url, token): i for i in web_idx}
            for f, i in futs.items():
                r = f.result()
                r["id"] = branches[i].get("id")
                r["kind"] = "web"
                r["durationMs"] = int((r["end"] - r["start"]) * 1000)
                results[i] = r

    def run_crawl_queue():
        # ponytail: crawl 串行队列；真并发需先解 MediaCrawler CDP 隔离（多实例毁登录态复用），非本轮目标
        for i in crawl_idx:
            r = _run_crawl(branches[i])
            r["id"] = branches[i].get("id")
            r["kind"] = "crawl"
            r["durationMs"] = int((r["end"] - r["start"]) * 1000)
            results[i] = r

    t_web = threading.Thread(target=run_web_pool)
    t_crawl = threading.Thread(target=run_crawl_queue)
    t_web.start()
    t_crawl.start()
    t_web.join()
    t_crawl.join()
    # 保序且不丢项：每个输入 branch 必有对应结果（失败也已构造 error 结果），供调用方按 index 对齐
    for i, r in enumerate(results):
        if r is None:  # 兜底：未被执行到的分支（不应发生）标 error，绝不错位
            results[i] = {"id": branches[i].get("id"), "kind": branches[i].get("kind"),
                          "ok": False, "status": "error", "start": 0, "end": 0, "durationMs": 0,
                          "count": 0, "error": "branch not executed"}
        results[i]["id"] = branches[i].get("id")
        results[i]["kind"] = branches[i].get("kind")
    return results
