#!/usr/bin/env python3
"""S6：更新游标、源文档索引、条目索引和批次日志。"""
import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import class_names, parse_frontmatter  # noqa: E402


def scan_pages(asset):
    pages = []
    for path in sorted((asset / "entities").glob("*.md")) if (asset / "entities").exists() else []:
        fm, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
        sources = fm.get("sources", [])
        if not isinstance(sources, list):
            sources = [sources] if sources else []
        pages.append({
            "name": fm.get("title") or path.stem,
            "type": fm.get("type") or "Unknown",
            "sources": [re.sub(r"\[\[|\]\]", "", source) for source in sources],
        })
    return pages


def write_indexes(asset, pages, batch):
    source_counts = defaultdict(int)
    for page in pages:
        for source in page["sources"]:
            source_counts[source] += 1
    sources = ["# 源文档索引", ""]
    sources.extend(f"[[{name}]] ×{count}" for name, count in sorted(source_counts.items()))
    _write(asset, batch, asset / "sources_index.md", "\n".join(sources) + "\n")

    names = class_names(asset)
    order = {name: int(number) for number, name in names.items()}
    groups = defaultdict(list)
    for page in pages:
        groups[page["type"]].append(page)
    index = ["# Wiki Index", "", f"*{len(pages)} entities across {len(groups)} categories*", ""]
    for category in sorted(groups, key=lambda value: order.get(value, 99)):
        index.append(f"## {category}")
        for page in sorted(groups[category], key=lambda item: item["name"].lower()):
            suffix = f" ×{len(page['sources'])}" if len(page["sources"]) > 1 else ""
            index.append(f"- [[{page['name']}]]{suffix}")
        index.append("")
    _write(asset, batch, asset / "index.md", "\n".join(index) + "\n")


def mark_cursor(asset, documents, batch):
    path = asset / "cursor.json"
    cursor = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "documents": {}}
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    for document in documents:
        cursor.setdefault("documents", {})[document] = {"parsed_at": timestamp, "last_batch": batch}
    cursor["updated_at"] = timestamp
    _write(asset, batch, path, json.dumps(cursor, ensure_ascii=False, indent=2) + "\n")


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            if line.strip():
                rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _write(asset, batch, path, text):
    """写文件；失败时记录 E06 到批次诊断库（不中断 S6 其他产物）。"""
    try:
        path.write_text(text, encoding="utf-8")
        return True
    except OSError as exc:
        batch_dir = asset / ".tmp" / "log" / batch
        batch_dir.mkdir(parents=True, exist_ok=True)
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "code": "E06", "level": "error",
               "stage": "S6写入", "target": str(path),
               "anchor": f"写盘失败：{path.name}（{exc}）", "cause": str(exc), "impact": "产物缺失"}
        with (batch_dir / "errors.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return False


def format_documents(documents, limit=10):
    """导入文档简要：≤10 全列，>10 省略取代表并标注（省略 N）。"""
    if not documents:
        return ""
    shown = documents[:limit]
    text = f"导入文档（{len(documents)}）· " + " · ".join(shown)
    omitted = len(documents) - len(shown)
    return text + (f" · （省略 {omitted}）" if omitted else "")


def select_operation_entries(rows, limit=10):
    """按 entry 去重（保留最终状态），分类轮转取代表，最多 limit 个。

    同批次同一条目可能经历多次写入（创建→增量→迁移），摘要以最终状态为准。
    """
    by_entry = {}
    for row in rows:
        by_entry[row["entry"]] = row
    rows = list(by_entry.values())
    by_class = defaultdict(list)
    for row in rows:
        by_class.setdefault(row["class_id"], []).append(row)
    for group in by_class.values():
        group.sort(key=lambda row: (-row["page_size"], row["entry"]))
    selected = []
    while len(selected) < limit:
        progressed = False
        for class_id in sorted(by_class):
            group = by_class[class_id]
            if group:
                selected.append(group.pop(0))
                progressed = True
                if len(selected) == limit:
                    break
        if not progressed:
            break
    return selected


def format_operations(rows, label, limit=10):
    """页面操作简要：label（N）· 条目…；省略时标注（省略 K）。"""
    if not rows:
        return ""
    selected = select_operation_entries(rows, limit)
    names = [row["entry"] for row in selected]
    text = f"{label}（{len(rows)}）· " + " · ".join(names)
    omitted = len(rows) - len(selected)
    return text + (f" · （省略 {omitted}）" if omitted else "")


def write_log(asset, batch, documents):
    """把本批次记录追加到资产 log.md。

    定稿格式（2026-10-17）：log.md 无总标题，每批一节 `## [时间] 导入类别`，
    最新批次在最顶部；状态 ✅成功N（失败>0 附 ❌失败M）；导入简要/更新简要
    ≤10 全列、>10 省略标注；出错/变更记录恒在表格。锚点分层：log.md 只放
    anchor 级，完整错误存 .tmp/log/<批次>/errors.jsonl。
    """
    batch_dir = asset / ".tmp" / "log" / batch
    summary = {}
    summary_path = batch_dir / "summary.json"
    if summary_path.exists():
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except Exception:
            summary = {}
    errors = read_jsonl(batch_dir / "errors.jsonl")
    operations = read_jsonl(batch_dir / "operations.jsonl")
    changes = read_jsonl(batch_dir / "changes.jsonl")

    import_type = summary.get("import_type", "手动导入")
    ts = str(summary.get("ts", time.strftime("%Y-%m-%d %H:%M")))[:16].replace("T", " ")
    ok = summary.get("ok_count", len(operations))
    # 失败数 = S5 自身失败（summary.fail_count）+ 其他环节的 error 级错误
    # （S4 提取失败等在 S5 之外发生，只落在 errors.jsonl，不进 summary）
    non_s5_errors = [row for row in errors
                     if row.get("level") == "error" and not str(row.get("stage", "")).startswith("S5")]
    fail = summary.get("fail_count", 0) + len(non_s5_errors)
    status = f"✅ 成功 {ok}" + (f"；❌ 失败 {fail}" if fail else "")
    lines = [f"## [{ts}] {import_type}", "", "### 📊 Execution Summary", "", f"- **状态**: {status}", ""]

    documents = summary.get("imported_documents") or documents
    brief = format_documents(documents)
    if brief:
        lines.append(f"- **导入简要**: {brief}")
        lines.append("")

    created = [row for row in operations if row.get("operation") == "create"]
    updated = [row for row in operations if row.get("operation") == "update"]
    update_parts = [part for part in (
        format_operations(created, "创建条目页"),
        format_operations(updated, "更新条目页"),
    ) if part]
    if update_parts:
        lines.append(f"- **更新简要**: {'；'.join(update_parts)}")
        lines.append("")

    lines += ["### 📝 出错记录", "", "| 代码 | 级别 | 出错说明 | 影响 |", "| --- | --- | --- | --- |"]
    if errors:
        lines.extend(f"| {row.get('code', '')} | {row.get('level', 'error')} | {row.get('anchor', '')} | {row.get('impact', '')} |" for row in errors)
    else:
        lines.append("| — | — | 无错误 | — |")
    lines.append("")

    lines += ["### 📝 变更记录", "", "| 类别 | 变更说明 | 影响 |", "| --- | --- | --- |"]
    if changes:
        lines.extend(f"| {row.get('category', '')} | {row.get('desc', '')} | {row.get('impact', '')} |" for row in changes)
    else:
        lines.append("| — | 无变更 | — |")
    lines.append("")

    # 无总标题：新节插到文件最前（最新批次在顶部）；兼容剥离历史 "# 导入日志" 头
    new_section = "\n".join(lines).rstrip("\n")
    path = asset / "log.md"
    previous = path.read_text(encoding="utf-8").strip("\n") if path.exists() else ""
    if previous.startswith("# 导入日志"):
        previous = previous[len("# 导入日志"):].lstrip("\n")
    body = new_section + ("\n\n" + previous if previous else "")
    _write(asset, batch, path, body + "\n")


def main():
    parser = argparse.ArgumentParser(description="S6 批次收尾")
    parser.add_argument("--asset", default=".", help="资产根目录")
    parser.add_argument("--batch", required=True, help="本批次标签")
    parser.add_argument("--docs", default="", help="逗号分隔的已处理 raw/ 相对路径")
    args = parser.parse_args()
    asset = Path(args.asset).expanduser().resolve()
    docs = [value.strip() for value in args.docs.split(",") if value.strip()]
    mark_cursor(asset, docs, args.batch)
    pages = scan_pages(asset)
    write_indexes(asset, pages, args.batch)
    write_log(asset, args.batch, docs)
    print(json.dumps({"cursor": True, "sources_index": len(pages), "index": len(pages), "log": str(asset / 'log.md')}, ensure_ascii=False))


if __name__ == "__main__":
    main()
