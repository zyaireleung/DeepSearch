#!/usr/bin/env python3
"""S1/S2：从源文档提取候选条目，并用固定规则收敛。"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import (BatchAbort, call_stage, defaults, doc_key, emit_error,  # noqa: E402
                     emit_response, extract_list, resolve_docs, set_batch)

S1_PROMPT = BASE / "prompts" / "s2_step1_2step_261017.md"
S2_PROMPT = BASE / "prompts" / "s2_filter_261016.md"


def call_list(stage, doc, label, prompt):
    started = time.time()
    response = call_stage(stage, prompt, context={"doc": doc, "entry": label})
    elapsed = int((time.time() - started) * 1000)
    if response is None:
        emit_response("S1S2", doc, label, "", "llm_failed", "LLM 调用失败")
        return [], {"stage": stage, "doc": doc, "label": label, "ms": elapsed, "status": "llm_failed"}
    values = extract_list(response)
    if not isinstance(values, list):
        emit_response("S1S2", doc, label, str(response), "parse_fail", "返回不是 JSON 数组")
        emit_error("E03", "S1S2", {"type": "提取", "doc": doc, "entry": label}, "返回不是 JSON 数组", BASE)
        return [], {"stage": stage, "doc": doc, "label": label, "ms": elapsed, "status": "parse_fail"}
    entries = [str(value).strip() for value in values if str(value).strip()]
    emit_response("S1S2", doc, label, str(response), "ok", "")
    return entries, {"stage": stage, "doc": doc, "label": label, "ms": elapsed, "status": "ok", "returned": len(entries)}


def main():
    parser = argparse.ArgumentParser(description="运行 S1 候选提取和 S2 条目收敛")
    parser.add_argument("--docs", default="", help="逗号分隔 raw/ 相对路径或文件名；默认全部")
    parser.add_argument("--tag", default="S1S2", help="本次运行产物标签")
    args = parser.parse_args()
    if os.environ.get("LLMWIKI_TMP_ROOT") and os.environ.get("LLMWIKI_BATCH"):
        set_batch(Path(os.environ["LLMWIKI_TMP_ROOT"]), os.environ["LLMWIKI_BATCH"])

    requested = [item.strip() for item in args.docs.split(",") if item.strip()]
    try:
        chosen = resolve_docs(BASE, requested)
    except ValueError as exc:
        parser.error(str(exc))
    samples = max(1, int(defaults().get("samples", 1)))
    run_dir = BASE / ".tmp" / "flow_stage1" / f"{args.tag}-{time.strftime('%Y%m%d-%H%M%S')}"
    run_dir.mkdir(parents=True, exist_ok=False)
    s1_template = S1_PROMPT.read_text(encoding="utf-8")
    s2_template = S2_PROMPT.read_text(encoding="utf-8")
    calls = []
    try:
        for doc in chosen:
            source = (BASE / "raw" / doc).read_text(encoding="utf-8")
            candidates, call = call_list("s1", doc, "候选", s1_template.replace("{content}", source))
            calls.append(call)
            # defaults.samples is the uniform product setting. Multiple samples are merged before S2.
            merged = list(candidates)
            for sample in range(2, samples + 1):
                values, call = call_list("s1", doc, f"候选·s{sample}", s1_template.replace("{content}", source))
                calls.append(call)
                for value in values:
                    if value not in merged:
                        merged.append(value)
            final, call = call_list("s2", doc, "filter·s1", s2_template.replace("{content}", source).replace("{candidates}", json.dumps(merged, ensure_ascii=False)))
            calls.append(call)
            record = {"candidates": {"extraction": merged}, "filter·s1": {"extraction": final}}
            (run_dir / f"{doc_key(doc)}__{args.tag}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[{doc}] 候选 {len(merged)} → 收敛 {len(final)}")
    except BatchAbort as exc:
        emit_error("E02", "S1S2", {"type": "批次", "entry": "批次中止"}, exc.reason, BASE)
        (run_dir / "run.json").write_text(json.dumps({
            "tag": args.tag, "docs": chosen, "samples": samples,
            "calls": len(calls), "aborted": True, "reason": exc.reason,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit(f"S1/S2 批次中止: {exc.reason}") from exc
    (run_dir / "calls.json").write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "run.json").write_text(json.dumps({"tag": args.tag, "docs": chosen, "samples": samples,
                                                    "calls": len(calls), "complete": True}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[S1/S2 output] {run_dir}")


if __name__ == "__main__":
    main()
