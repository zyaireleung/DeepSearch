#!/usr/bin/env python3
"""S4：为一个条目提取内容块，或为一篇文档生成全文梗概。"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime import call_stage, emit_error, emit_response, resolve_docs, set_batch, template_boards  # noqa: E402


def load_doc(doc):
    return (BASE / "raw" / doc).read_text(encoding="utf-8")


def parse_blocks(raw):
    """解析 S4A LLM 返回为块数组。直接全文找 JSON 数组并深度匹配。

    不做围栏剥离：LLM 返回的数组正文里可能内嵌 ```json 代码示例，
    先剥围栏会把内嵌代码误当外层结构（曾导致合法返回被误判"未找到数组"）。
    """
    text = str(raw or "").strip()
    if not text:
        return [], "空返回"
    start = text.find("[")
    if start < 0:
        return [], "未找到 JSON 数组"
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "[":
            depth += 1
        elif text[index] == "]":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(text[start:index + 1])
                except json.JSONDecodeError as exc:
                    return [], f"JSON 解析失败: {exc}"
                return (value, "ok") if isinstance(value, list) else ([], "返回不是数组")
    return [], "JSON 数组未闭合"


def extract_blocks(doc, entry, form, class_id=None):
    if form == "multi":
        if class_id is None:
            raise ValueError("multi 提取需要 class_id")
        prompt = (BASE / "prompts" / "s4_extract_261017.md").read_text(encoding="utf-8")
        if not (BASE / "schema" / "templates" / f"{class_id:02d}.md").exists():
            raise FileNotFoundError(f"分类模板不存在: {class_id:02d}.md")
        prompt = prompt.replace("{template_blocks}", template_boards(class_id))
        stage = "s4a_multi"
    else:
        prompt = (BASE / "prompts" / "s4_extract_individual_261017.md").read_text(encoding="utf-8")
        stage = "s4a_single"
    prompt = prompt.replace("{条目名}", entry).replace("{content}", load_doc(doc))
    started = time.time()
    response = call_stage(stage, prompt, context={"doc": doc, "entry": entry})
    elapsed = int((time.time() - started) * 1000)
    if response is None:
        emit_response("S4A", doc, entry, "", "llm_failed", "LLM 调用失败（E05 已记录）")
        return {"doc": doc, "entry": entry, "form": form, "blocks": [], "ms": elapsed, "llm_failed": True}
    blocks, reason = parse_blocks(response)
    status = "ok" if blocks else "empty"
    emit_response("S4A", doc, entry, str(response), status, reason)
    if not blocks:
        code = "E04" if reason in ("ok", "空返回") else "E03"
        emit_error(
            code, "S4A", {"type": "条目", "doc": doc, "entry": entry},
            f"提取结果为空：{reason}（原始返回见 llm_responses.jsonl）",
            BASE,
        )
    return {"doc": doc, "entry": entry, "form": form, "blocks": blocks, "ms": elapsed,
            "llm_failed": False, "parse_note": reason}


def extract_whole(doc):
    prompt = (BASE / "prompts" / "s4_whole_261017.md").read_text(encoding="utf-8")
    response = call_stage("s4b", prompt.replace("{content}", load_doc(doc)),
                          context={"doc": doc, "entry": "全文梗概"})
    if response is None:
        emit_response("S4B", doc, "全文梗概", "", "llm_failed", "LLM 调用失败（E05 已记录）")
        return {"doc": doc, "entry": "全文梗概", "form": "whole", "markdown": "", "llm_failed": True}
    text = str(response).strip()
    fence = re.search(r"```(?:markdown)?\s*(.*?)```", text, re.S)
    return {"doc": doc, "entry": "全文梗概", "form": "whole",
            "markdown": (fence.group(1) if fence else text).strip()}


def main():
    parser = argparse.ArgumentParser(description="S4 内容提取")
    parser.add_argument("--doc", required=True, help="raw/ 相对路径或文件名")
    parser.add_argument("--entry", default="", help="条目名；whole 形式不需要")
    parser.add_argument("--class-id", type=int, help="multi 形式的分类模板序号")
    parser.add_argument("--form", choices=("multi", "single", "whole"), default="multi")
    parser.add_argument("--out", default="", help="输出 JSON 文件；省略则写到标准输出")
    args = parser.parse_args()
    if os.environ.get("LLMWIKI_TMP_ROOT") and os.environ.get("LLMWIKI_BATCH"):
        set_batch(Path(os.environ["LLMWIKI_TMP_ROOT"]), os.environ["LLMWIKI_BATCH"])
    try:
        doc = resolve_docs(BASE, [args.doc])[0]
    except ValueError as exc:
        parser.error(str(exc))
    args.doc = doc
    if args.form == "whole":
        record = extract_whole(args.doc)
    else:
        if not args.entry:
            parser.error("multi 和 single 形式都需要 --entry")
        if args.form == "multi" and args.class_id is None:
            parser.error("multi 形式需要 --class-id")
        record = extract_blocks(args.doc, args.entry, args.form, args.class_id)
        if args.class_id is not None:
            record["class_id"] = args.class_id
    output = json.dumps(record, ensure_ascii=False, indent=2)
    if args.out:
        destination = Path(args.out).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(output, encoding="utf-8")
        print(destination)
    else:
        print(output)


if __name__ == "__main__":
    main()
