#!/usr/bin/env python3
"""S3：将 S1/S2 已收敛的条目按固定分类 schema 分类。

正常由 run_fullflow.py 调用；在恢复场景可指定一次 S1/S2 运行目录。
所有输入、提示词和产物都位于本资产目录内。
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime import (BatchAbort, call_stage, doc_key, emit_error,  # noqa: E402
                     emit_response, extract_list, resolve_docs, set_batch, stage_option)

PROMPT_PATH = BASE / "prompts" / "s3_classify_261023.md"
SCHEMA_PATH = BASE / "schema" / "classification.md"


def chunks(items, size):
    for offset in range(0, len(items), size):
        yield items[offset:offset + size]


def load_entries(input_dir, doc):
    """Read the formal S1/S2 output for one document."""
    matches = sorted(input_dir.glob(f"{doc_key(doc)}__*.json"))
    if not matches:
        return []
    data = json.loads(matches[0].read_text(encoding="utf-8"))
    record = data.get("filter·s1") or data.get("filter") or {}
    entries = record.get("extraction") or []
    return [str(entry).strip() for entry in entries if str(entry).strip()]


def parse_paired_classes(raw, names):
    """解析 S3 配对格式输出 ["名称, 序号", "名称, 序号", …] → {名称: 序号}。

    兼容两种形态：字符串 "名称, 序号" / 两元数组 ["名称", 序号]。
    名称对齐校验：解析出的名称集合与 names 集合对比，
    返回 (result, missing, extra)：
      - result: {名称: 序号}（能对齐的）
      - missing: names 中有但 LLM 未输出的名称（精确缺失，E03 锚点用）
      - extra: LLM 输出但不在 names 中的名称（多余）
    解析失败（非数组/空）返回 ({}, [], [])。
    """
    import json as _json
    value = extract_list(raw)
    if not isinstance(value, list) or not value:
        return {}, [], []
    result, extra, bad = {}, [], []
    expected = {str(n).strip() for n in names}
    for item in value:
        if isinstance(item, str):
            # "名称, 序号" → rsplit 最后一个逗号
            if ", " not in item and "," not in item:
                bad.append(item)
                continue
            sep = ", " if ", " in item else ","
            name, _, serial = item.rpartition(sep)
            name, serial = name.strip(), serial.strip()
        elif isinstance(item, list) and len(item) >= 2:
            name = str(item[0]).strip()
            serial = item[1]
        else:
            bad.append(item)
            continue
        if name not in expected:
            extra.append(name)
            continue
        if name in result:
            extra.append(name)
            continue
        try:
            result[name] = int(serial)
        except (TypeError, ValueError):
            bad.append(name)
    missing = [n for n in names if str(n).strip() not in result]
    return result, missing, extra + bad


def classify_batch(doc, names, source_text, prompt_template, class_defs, batch_number):
    """分类一批条目；配对格式解析 + parse_fail 自动降级逐条重试。

    2026-10-23 用户定稿：
      - 输出格式 ["名称, 序号", ...]（配对数组）
      - parse_fail（缺失/多余/解析失败）→ 降级：对缺失条目逐条重试
        （单条必然 1:1 对齐），全部成功则批次 ok，不记 E03
      - 降级仍失败 → 记 E03，锚点精确到缺失/多余条目名
    """
    prompt = (prompt_template
              .replace("{names}", json.dumps(names, ensure_ascii=False))
              .replace("{class_defs}", class_defs)
              .replace("{content}", source_text))
    step = f"{doc}:batch{batch_number}"
    started = time.time()
    response = call_stage("s3", prompt, context={"doc": doc, "entry": step})
    elapsed = int((time.time() - started) * 1000)
    raw = str(response or "")
    if response is None:
        emit_response("S3", doc, step, "", "llm_failed", "LLM 调用失败（E02 已记录）")
        return {}, {"step": step, "ms": elapsed, "status": "llm_failed"}

    result, missing, extra = parse_paired_classes(raw, names)

    # 完整命中 → ok
    if not missing and not extra:
        emit_response("S3", doc, step, raw, "ok", "")
        return result, {"step": step, "ms": elapsed, "status": "ok", "returned": len(result)}

    # parse_fail：记录首轮问题，降级逐条重试缺失条目
    detail_missing = f"缺失条目 {missing}" if missing else "无缺失"
    detail_extra = f"多余条目 {extra}" if extra else "无多余"
    emit_response("S3", doc, step, raw, "parse_fail", f"{detail_missing}；{detail_extra}")

    # 降级：对每个缺失条目逐条重试（单条必然 1:1 对齐）
    downgraded_ms = 0
    downgrade_ok = True
    for name in list(missing):
        single_prompt = (prompt_template
                         .replace("{names}", json.dumps([name], ensure_ascii=False))
                         .replace("{class_defs}", class_defs)
                         .replace("{content}", source_text))
        step1 = f"{doc}:batch{batch_number}:single:{name[:20]}"
        s_start = time.time()
        r1 = call_stage("s3", single_prompt, context={"doc": doc, "entry": step1})
        downgraded_ms += int((time.time() - s_start) * 1000)
        if r1 is None:
            emit_response("S3", doc, step1, "", "llm_failed", "LLM 调用失败（E02 已记录）")
            downgrade_ok = False
            continue
        r2, m2, e2 = parse_paired_classes(str(r1), [name])
        if name in r2:
            result[name] = r2[name]
            emit_response("S3", doc, step1, str(r1), "ok", "")
        else:
            emit_response("S3", doc, step1, str(r1), "parse_fail", f"单条仍失败：{m2 or e2}")
            downgrade_ok = False

    if downgrade_ok and not extra:
        # 降级全部成功且无多余 → 批次整体 ok
        emit_response("S3", doc, step, raw, "ok(降级)", "逐条重试补齐缺失")
        return result, {"step": step, "ms": elapsed + downgraded_ms,
                        "status": "ok", "returned": len(result), "downgraded": True}

    # 降级仍失败或有多余 → 记 E03，锚点精确到缺失/多余条目名
    still_missing = [n for n in missing if n not in result]
    emit_error(
        "E03", "S3", {"type": "分类批次", "doc": doc, "batch": batch_number},
        f"{detail_missing}；{detail_extra}；逐条重试后仍失败" +
        (f"：{still_missing}" if still_missing else ""),
        BASE,
    )
    return result, {"step": step, "ms": elapsed + downgraded_ms,
                    "status": "parse_fail", "missing": missing, "extra": extra}


def main():
    parser = argparse.ArgumentParser(description="对一个 S1/S2 运行目录进行 S3 分类")
    parser.add_argument("--input", required=True, help="S1/S2 输出目录")
    parser.add_argument("--docs", default="", help="逗号分隔 raw/ 相对路径或文件名；默认全部")
    parser.add_argument("--tag", default="CLS", help="本次分类产物标签")
    args = parser.parse_args()

    if os.environ.get("LLMWIKI_TMP_ROOT") and os.environ.get("LLMWIKI_BATCH"):
        set_batch(Path(os.environ["LLMWIKI_TMP_ROOT"]), os.environ["LLMWIKI_BATCH"])

    input_dir = Path(args.input).expanduser().resolve()
    if not input_dir.is_dir():
        parser.error(f"S1/S2 输出目录不存在: {input_dir}")
    requested = [name.strip() for name in args.docs.split(",") if name.strip()]
    try:
        docs = resolve_docs(BASE, requested)
    except ValueError as exc:
        parser.error(str(exc))

    prompt_template = PROMPT_PATH.read_text(encoding="utf-8")
    class_defs = SCHEMA_PATH.read_text(encoding="utf-8")
    batch_sizes = stage_option("s3", "batch_sizes", [5])
    batch_size = int(batch_sizes[0])
    if batch_size < 1:
        raise ValueError("config.yaml stages.s3.batch_sizes 的首项必须大于 0")

    run_dir = BASE / ".tmp" / "flow_classify" / f"{args.tag}-{time.strftime('%Y%m%d-%H%M%S')}"
    run_dir.mkdir(parents=True, exist_ok=False)
    calls = []
    completed_docs = 0
    try:
        for doc in docs:
            entries = load_entries(input_dir, doc)
            if not entries:
                print(f"[{doc}] 无 S1/S2 收敛条目，跳过")
                continue
            source_path = BASE / "raw" / doc
            source_text = source_path.read_text(encoding="utf-8")
            classes = {}
            for index, batch in enumerate(chunks(entries, batch_size), 1):
                classified, call = classify_batch(doc, batch, source_text, prompt_template, class_defs, index)
                calls.append(call)
                classes.update(classified)
            record = {"entries": entries, "batch5": classes}
            (run_dir / f"{doc_key(doc)}__{args.tag}.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            completed_docs += 1
            print(f"[{doc}] {len(classes)}/{len(entries)} 条目已分类")
    except BatchAbort as exc:
        (run_dir / "run.json").write_text(json.dumps({
            "tag": args.tag, "input": str(input_dir), "completed_docs": completed_docs,
            "aborted": True, "reason": exc.reason, "calls": calls,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        raise SystemExit(f"S3 批次中止: {exc.reason}") from exc

    (run_dir / "calls.json").write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "run.json").write_text(json.dumps({
        "tag": args.tag, "input": str(input_dir), "docs": completed_docs,
        "batch_size": batch_size, "calls": len(calls), "complete": True,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[S3 output] {run_dir}")


if __name__ == "__main__":
    main()
