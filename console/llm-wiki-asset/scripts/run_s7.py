#!/usr/bin/env python3
"""S7：基于当前知识库和本批次变更生成 overview.md。"""
import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime import call_stage, class_names, config as load_config, emit_error, extract_json  # noqa: E402


def section(text, title):
    match = re.search(rf"## {re.escape(title)}\n\n(.*?)(?=\n## |\n---|\Z)", text, re.S)
    return match.group(1).strip() if match else "（无）"


def distribution(asset, names):
    counts = defaultdict(int)
    for path in (asset / "entities").glob("*.md") if (asset / "entities").exists() else []:
        match = re.search(r'^type:\s*"?([^"\n]+)"?', path.read_text(encoding="utf-8"), re.M)
        if match:
            counts[match.group(1).strip()] += 1
    number = {name: key for key, name in names.items()}
    rows = [f"- {number.get(name, '?')}.{name}：{count} 页" for name, count in sorted(counts.items(), key=lambda pair: int(number.get(pair[0], 99)))]
    return "\n".join(rows) or "（无分类分布）"


def changes(asset, batch, names):
    path = asset / ".tmp" / "log" / batch / "operations.jsonl"
    if not path.exists():
        return "（本轮无页面变更）"
    number = {int(key): value for key, value in names.items()}
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        data = json.loads(line)
        class_id = int(data.get("class_id", 0))
        rows.append(f"- {data.get('entry','')}（{class_id}.{number.get(class_id, '?')}，{data.get('operation','update')}）")
    return "\n".join(rows[:20]) or "（本轮无页面变更）"


def load_ops(asset, batch):
    """本批次页面操作映射：entry → operation（create/update/migrate）。"""
    path = asset / ".tmp" / "log" / batch / "operations.jsonl"
    ops = {}
    if not path.exists():
        return ops
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        data = json.loads(line)
        ops[data.get("entry", "")] = data.get("operation", "update")
    return ops


def samples(asset, limit, titles_limit, basic=True, titles=True, ops=None, rotate=False):
    """样本通道：按 s7.input 配置注入基础信息/小标题/op 标注，按 strategy 取页。

    rotate=True 时按分类轮转取页（组内按基础信息量降序）；否则按量降序取前 limit。

    2026-10-23 用户定稿（B4）：ops 提供时只取本批 create/update 的页面
    （"本批唯一"），不取全库——全库信息由旧 overview 承载，避免永远只取
    特定最丰富页、丢失新增页信息。ops 为 None 时兼容旧行为取全库。
    """
    rows = []
    for path in sorted((asset / "entities").glob("*.md")) if (asset / "entities").exists() else []:
        text = path.read_text(encoding="utf-8")
        title_match = re.search(r'^title:\s*"?([^"\n]+)"?', text, re.M)
        entry = title_match.group(1).strip() if title_match else path.stem
        # 本批唯一：operations 用逻辑 entry（frontmatter title），不能用 safe 文件名。
        if ops is not None and entry not in ops:
            continue
        type_match = re.search(r'^type:\s*"?([^"\n]+)"?', text, re.M)
        entry_type = type_match.group(1).strip() if type_match else "Unknown"
        info = re.search(r"## 基本信息\n(.*?)(?=\n## |\Z)", text, re.S)
        if not info:
            continue
        body = info.group(1).strip()
        if not body:
            continue
        headings = re.findall(r"^##### (.+)$", body, re.M)[:titles_limit]
        rows.append((entry, entry_type, body, headings))
    if rotate:
        by_type = defaultdict(list)
        for row in rows:
            by_type[row[1]].append(row)
        for group in by_type.values():
            group.sort(key=lambda item: -len(item[2]))
        selected = []
        while len(selected) < limit:
            progressed = False
            for entry_type in sorted(by_type):
                group = by_type[entry_type]
                if group:
                    selected.append(group.pop(0))
                    progressed = True
                    if len(selected) == limit:
                        break
            if not progressed:
                break
        rows = selected
    else:
        rows.sort(key=lambda item: -len(item[2]))
        rows = rows[:limit]
    rendered = []
    for name, entry_type, body, headings in rows:
        parts = [f"知识点：{name}"]
        if ops and name in ops:
            parts.append(f"（{ops[name]}）")
        if basic:
            parts.append(body)
        if titles and headings:
            parts.append("；".join(headings))
        rendered += parts + [""]
    return "\n".join(rendered).strip() or "（无有效样本）"


def parse_object(raw):
    """S7 两阶段 LLM 返回必须为 JSON 对象；解析失败返回 None。"""
    value = extract_json(raw)
    return value if isinstance(value, dict) else None


def render(summary, analysis):
    return "\n".join([
        "# Overview", "", "## 🌟 概要", "", str(summary.get("概要", "暂时为空")), "",
        "## 🗺️ 地图", "", str(summary.get("地图", "暂时为空")), "",
        "### 📊 总览分析", "", "### 领域迁移 (Trend)", "", str(analysis.get("领域迁移", "暂时为空")), "",
        "### 知识张力 (Tension)", "", str(analysis.get("知识张力", "暂时为空")), "",
        "### 认知空白 (Gap)", "", str(analysis.get("认知空白", "暂时为空")), "",
        "## 📈 变化趋势", "", str(analysis.get("变化趋势", "暂时为空")), "", "---", "", "*Generated by llm-wiki*", "",
    ])


def generate(asset, batch):
    asset = Path(asset).resolve()
    config = load_config(asset)
    options = config.get("s7", {}).get("input", {})
    rotate = options.get("strategy") == "rotation"
    basic = bool(options.get("basic_info", True))
    titles = bool(options.get("titles_info", False))
    ops = load_ops(asset, batch) if options.get("include_ops") else None
    names = class_names(asset)
    previous = (asset / "overview.md").read_text(encoding="utf-8") if (asset / "overview.md").exists() else ""
    prompt1 = (asset / "prompts" / "s7_overview_1_261018.md").read_text(encoding="utf-8")
    prompt1 = (prompt1.replace("{历史概要}", section(previous, "🌟 概要"))
               .replace("{class_defs}", (asset / "schema" / "classification.md").read_text(encoding="utf-8"))
               .replace("{class_distribution}", distribution(asset, names))
               .replace("{本轮变化}", changes(asset, batch, names)))
    response1 = parse_object(call_stage("s7_overview1", prompt1, asset=asset, context={"doc": "overview"}))
    if not response1:
        emit_error("E03", "S7", {"type": "条目", "entry": "overview"},
                   "S7 第一阶段未返回有效 JSON 对象（原始返回见 llm_responses.jsonl）", asset)
        raise RuntimeError("S7 第一阶段未返回有效 JSON 对象")

    prompt2 = (asset / "prompts" / "s7_overview_2_261018.md").read_text(encoding="utf-8")
    prompt2 = (prompt2.replace("{summary_map}", f"概要：{response1.get('概要','')}\n\n地图：{response1.get('地图','')}")
               .replace("{samples}", samples(asset, int(options.get("pages", 18)),
                                             int(options.get("titles_per_page", 8)),
                                             basic=basic, titles=titles, ops=ops, rotate=rotate))
               .replace("{历史总览分析}", section(previous, "📈 变化趋势")))
    response2 = parse_object(call_stage("s7_overview2", prompt2, asset=asset, context={"doc": "overview"}))
    if not response2:
        emit_error("E03", "S7", {"type": "条目", "entry": "overview"},
                   "S7 第二阶段未返回有效 JSON 对象（原始返回见 llm_responses.jsonl）", asset)
        raise RuntimeError("S7 第二阶段未返回有效 JSON 对象")
    output = render(response1, response2)
    (asset / "overview.md").write_text(output, encoding="utf-8")
    print(asset / "overview.md")


def main():
    parser = argparse.ArgumentParser(description="S7 概览生成")
    parser.add_argument("--asset", default=".", help="资产根目录")
    parser.add_argument("--batch", required=True, help="S6 已完成的批次标签")
    args = parser.parse_args()
    generate(args.asset, args.batch)


if __name__ == "__main__":
    main()
