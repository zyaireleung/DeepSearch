#!/usr/bin/env python3
"""CLI bridge between the deep-search 插件 and core modules.

Usage: cli.py <start|step|reflect|report|crawl> '<json-args>'
Reads GATEWAY_URL / GATEWAY_TOKEN(/DEEPSEARCH_GATEWAY_TOKEN_FILE) / DEEPSEARCH_STATE_DIR from env.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state
import gateway
import evidence
import transition
import sink
import crawl
import fanout


def _read_token_file(path):
    """gateway token 走文件（不入 config/patch 明文）。相对路径按插件根（cli.py 上三级）解析。"""
    if not path:
        return ""
    expanded = os.path.expanduser(path)
    if not os.path.isabs(expanded):
        plugin_root = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        expanded = os.path.join(plugin_root, expanded)
    try:
        with open(expanded, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:5678")
TOKEN = (os.environ.get("GATEWAY_TOKEN")
         or _read_token_file(os.environ.get("DEEPSEARCH_GATEWAY_TOKEN_FILE")))
# 内化后 self-contained：默认状态目录 = 本目录/.state/（web-research/.state/）
STATE_DIR = (os.environ.get("DEEPSEARCH_STATE_DIR")
             or os.environ.get("RESEARCH_RUNNER_STATE_DIR")
             or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".state"))


def _path(run_id):
    return os.path.join(os.path.abspath(STATE_DIR), "%s.json" % run_id)


def _normalize_claim(c):
    """Ensure a Planner claim has required fields (audit: start must accept claims)."""
    if not isinstance(c, dict) or "id" not in c or "question" not in c:
        raise ValueError("claim needs id + question: %r" % c)
    return {
        "id": c["id"],
        "question": c["question"],
        "required_evidence": c.get("required_evidence", ["general_web"]),
        "priority": c.get("priority", "medium"),
        "depends_on": c.get("depends_on", []),
        "status": "pending",
    }


def _fail(run_id, reason, remediation=None):
    """Terminal failure with structured state (C1: gateway unreachable).

    remediation: 网关类失败的修复指引（告诉调用方怎么拉起依赖），非网关失败为 None。
    """
    out = {"ok": False, "stop_reason": reason}
    if remediation:
        out["remediation"] = remediation
    try:
        s = state.load(_path(run_id))
    except FileNotFoundError:
        return out
    s["status"] = "failed"
    s["stop_reason"] = reason
    state.save(_path(run_id), s)
    out["state"] = s
    return out


# 网关依赖的修复指引（DSH/设备重启后 n8n 可能掉线；进程拉起走 plugin-service-manager 按钮，
# workflow 激活 n8n 重启后可能回到 inactive 需在 n8n UI 手动 Activate）。
_GATEWAY_DOWN_REMEDIATION = (
    "n8n 网关未运行（healthz 不通）。修复："
    "①DSH 设置→plugin-service-manager→n8n server→启动（或在 n8n 目录 nohup n8n start，需 nvm v24 node）；"
    "②启动后确认 http://localhost:5678/healthz 返回 ok；"
    "③若 healthz 通但仍报 gateway_error/http 404，说明 research-gateway workflow 未激活，"
    "到 n8n UI 把 research-gateway workflow 点 Activate。三步后重试本工具。"
)


def cmd_start(a):
    claims = [_normalize_claim(c) for c in a.get("claims", [])]
    s = state.new_run(a["run_id"], a["question"], a.get("budgets"))
    s["claims"] = claims
    if a.get("intent"):
        s["intent"] = a["intent"]
    s["config_version"] = None  # backfilled after first gateway call
    s = transition.advance(s, "planning")
    state.save(_path(a["run_id"]), s)
    return {"ok": True, "state": s, "next_pending_claim": transition.top_pending(s)}


def cmd_step(a):
    run_id = a["run_id"]
    s = state.load(_path(run_id))
    # C1: explicit health precheck before any gateway call
    if not gateway.health_check(GATEWAY_URL):
        return _fail(run_id, "gateway_unreachable", _GATEWAY_DOWN_REMEDIATION)
    claim = transition.top_pending(s)
    if not claim:
        stop, reason = transition.should_stop(s)
        return {"ok": True, "state": s, "evidence_added": 0,
                "next_pending_claim": None, "should_stop": stop, "stop_reason": reason}
    payload = {"run_id": s["run_id"], "query": claim["question"],
               "evidence_needs": claim["required_evidence"],
               "intent": s.get("intent", "general"), "limit": 5}
    try:
        resp = gateway.call_gateway(GATEWAY_URL, TOKEN, payload)
    except gateway.GatewayError as e:
        return _fail(run_id, "gateway_error: %s" % e, _GATEWAY_DOWN_REMEDIATION)
    s["config_version"] = s["config_version"] or resp.get("diagnostics", {}).get("config_version")
    added = evidence.dedupe(resp.get("results", []))
    before = len(s["evidence"])
    s["evidence"] = evidence.attach_claim(s["evidence"] + added, claim["id"],
                                          [e["url"] for e in added])
    s["gateway_calls"] += 1
    s["no_progress_rounds"] = 0 if added else s.get("no_progress_rounds", 0) + 1
    s = transition.advance(s, "searching")
    state.save(_path(run_id), s)
    # 落盘到 Crawler Result/.tmp（按渠道分两类）：media→社媒类，wigolo/wigolo_restricted→其他类
    try:
        _sink_step(claim, added, resp)
    except Exception as e:  # 落盘失败不阻断检索主流程
        print("sink warning: %s" % e, file=sys.stderr)
    return {"ok": True, "state": s, "evidence_added": len(s["evidence"]) - before,
            "next_pending_claim": transition.top_pending(s),
            "diagnostics": resp.get("diagnostics")}


def _sink_step(claim, added, resp):
    """step 拿到 gateway 证据后按渠道落盘。"""
    needs = claim.get("required_evidence") or []
    if "social_signal" in needs:
        category = "社媒类"
        data_social = [sink.map_media_record(r) for r in added]
        data_general = None
    else:
        category = "其他类"
        data_social = None
        data_general = [sink.map_wigolo_record(r) for r in added]
    sink.write_tmp(category=category,
                   meta={"query": claim.get("question"), "tool": "deep_search_web",
                         "action": "web", "channel": "+".join(needs)},
                   data_social=data_social, data_general=data_general, raw_files=[])


def cmd_crawl(a):
    """直调 MediaCrawler（绕过 claim/gateway），直接抓进 Crawler Result/.tmp/<rid>/raw/。"""
    alloc = sink.allocate()  # 先建 raw 目录，MediaCrawler 经 --save_data_path 直接写这里
    r = crawl.run_crawl(a["platform"], a["type"], alloc["save_root"],
                        creator_id=a.get("creator_id"), specified_id=a.get("specified_id"),
                        keywords=a.get("keywords"))
    if r.get("ok"):
        r["retrieval_id"] = alloc["rid"]
        r["tmp_dir_rel"] = alloc["rel"]
        try:
            sink.write_tmp(category="社媒类",
                           meta={"query": a.get("keywords") or a.get("creator_id") or a.get("specified_id"),
                                 "tool": "deep_search_crawl", "action": a["type"], "platform": a["platform"]},
                           data_social=[sink.map_media_record(x) for x in r["raw_records"]],
                           data_general=None, raw_files=r["new_files"],
                           rid=alloc["rid"], raw_dir=alloc["save_root"])
        except Exception as e:  # 落盘失败不掩盖抓取结果
            print("sink warning: %s" % e, file=sys.stderr)
    return r


def cmd_fanout(a):
    """并行编排：web 分支并发打 gateway + crawl 分支串行队列，跨子类同时推进（path-1）。"""
    branches = a.get("branches") or []
    # crawl 分支先各预分配独立 raw 目录（工作区内），供 MediaCrawler --save_data_path 直写
    allocs = {}
    for b in branches:
        if b.get("kind") == "crawl":
            al = sink.allocate()
            b["save_root"] = al["save_root"]
            allocs[b.get("id")] = al
    out = fanout.run_fanout(branches, GATEWAY_URL, TOKEN)
    # 逐分支落盘（失败不掩盖其它分支）
    for b, r in zip(branches, out):
        try:
            al = allocs.get(b.get("id"))
            if r.get("kind") == "crawl":
                if r.get("ok"):
                    r["retrieval_id"] = al["rid"]
                    r["tmp_dir_rel"] = al["rel"]
                sink.write_tmp(category="社媒类",
                               meta={"query": b.get("keywords") or b.get("platform"),
                                     "tool": "deep_search_fanout", "action": b.get("type", "search"),
                                     "platform": b.get("platform")},
                               data_social=[sink.map_media_record(x) for x in r.get("raw_records", [])],
                               data_general=None, raw_files=r.get("new_files", []),
                               rid=al["rid"] if al else None, raw_dir=al["save_root"] if al else None)
            elif r.get("kind") == "web":
                results = r.get("results", [])
                sink.write_tmp(category="其他类",
                               meta={"query": b.get("query"), "tool": "deep_search_fanout",
                                     "action": "web", "channel": "+".join(b.get("evidence_needs", ["general_web"]))},
                               data_social=None,
                               data_general=[sink.map_wigolo_record(x) for x in results],
                               raw_files=[])
        except Exception as e:  # 落盘失败不掩盖分支结果
            print("sink warning: %s" % e, file=sys.stderr)
    return {"ok": True, "branches": out,
            "summary": {"total": len(out), "ok": sum(1 for r in out if r.get("ok")),
                        "failed": sum(1 for r in out if not r.get("ok"))}}


def cmd_reflect(a):
    run_id = a["run_id"]
    s = state.load(_path(run_id))
    s = transition.apply_decisions(s, a["decisions"], a.get("new_claims"))
    s = transition.advance(s, "reflecting")
    stop, reason = transition.should_stop(s)
    if stop:
        s["status"] = "completed"
        s["stop_reason"] = reason
    state.save(_path(run_id), s)
    return {"ok": True, "state": s, "should_stop": stop, "stop_reason": reason}


def cmd_report(a):
    s = state.load(_path(a["run_id"]))
    return {"ok": True, "markdown": transition.render_report(s)}


if __name__ == "__main__":
    sub = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    out = {"start": cmd_start, "step": cmd_step, "reflect": cmd_reflect,
           "report": cmd_report, "crawl": cmd_crawl, "fanout": cmd_fanout}[sub](args)
    print(json.dumps(out, ensure_ascii=False))
