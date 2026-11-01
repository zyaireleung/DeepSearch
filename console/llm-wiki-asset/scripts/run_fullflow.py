#!/usr/bin/env python3
"""LLM WiKi 正式全流程入口。

依次运行 S1/S2、S3、S4、S5、S6、S7。除恢复时指定文档子集外，日常不需要任何参数。
全部输入和输出都相对于此资产目录；阶段脚本是唯一的执行边界。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SCRIPTS = BASE / "scripts"
sys.path.insert(0, str(SCRIPTS))
from runtime import doc_key, docs, resolve_docs  # noqa: E402


def run(command, env):
    printable = " ".join(str(part) for part in command)
    print(f"\n$ {printable}")
    completed = subprocess.run(command, cwd=BASE, env=env, text=True)
    if completed.returncode:
        raise SystemExit(f"阶段失败（退出码 {completed.returncode}）：{printable}")


def newest(parent, prefix):
    candidates = [path for path in parent.glob(f"{prefix}-*") if path.is_dir()]
    if not candidates:
        raise FileNotFoundError(f"未找到运行产物：{parent}/{prefix}-*")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def source_filename(doc):
    return Path(doc).name


def load_parsed_documents():
    """读 cursor.json 已解析文档集合（raw/ 相对路径）。"""
    path = BASE / "cursor.json"
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return set((data.get("documents") or {}).keys())
    except Exception:
        return set()


def filter_new_docs(docs, parsed):
    """增量过滤：只保留 cursor 尚未解析的文档（源文档不可变，副本更新=新路径=新文档）。"""
    return [doc for doc in docs if doc not in parsed]


# 锚点 stage → 需保留的中间产物目录名（errors.jsonl 的 stage 字段指向的出错现场）。
# 真实 stage 值覆盖（2026-10-22 枚举全部 emit_error 调用点）：
#   S1 / S2 / S1S2            → flow_stage1（runtime f"S{stage[1:]}" + run_s1s2 显式）
#   S3                        → flow_classify（run_s3 + runtime）
#   S4A / S4a_multi / S4a_single / S4b → flow_s4（run_s4 显式 + runtime）
#   S5写入 / S5向量 / S5-s5_* / S5写入（s5_*）→ flow_s4 + flow_s5（run_s5 显式 + 解析失败 + 批次中止）
#   S7 / S7_overview1 / S7_overview2 → 无独立中间产物
def anchor_dirs_for_stage(stage):
    if stage.startswith("S1S2") or stage in ("S1", "S2"):
        return {"flow_stage1"}
    if stage.startswith("S3"):
        return {"flow_classify"}
    if stage.startswith("S4"):
        return {"flow_s4"}
    if stage.startswith("S5"):
        return {"flow_s4", "flow_s5"}
    return set()  # S7 及未知 stage：无中间产物保留


def cleanup_intermediates(batch, generated_dirs):
    """S8：按 log.md 出错记录锚点精准清理中间产物。

    语义（用户拍板 2026-10-22）：读本批 errors.jsonl 的 stage 锚点，
    只保留锚点指向的中间产物目录供溯源；与锚点无关的中间产物一律清理。
       - 无错误          → 全部清理（flow_stage1/flow_classify/flow_s4/flow_s5）
       - S1/S2/S1S2 错误  → 保留 flow_stage1
       - S3 错误          → 保留 flow_classify
       - S4* 错误         → 保留 flow_s4
       - S5* 错误         → 保留 flow_s4 + flow_s5
       - S7 错误          → 无独立中间产物（log/ 恒为诊断库保留）
    """
    tmp = BASE / ".tmp"
    log_dir = tmp / "log" / batch
    errors_path = log_dir / "errors.jsonl"
    keep = set()
    if errors_path.exists() and errors_path.stat().st_size > 0:
        for line in errors_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                # 只按 error 级记录保留锚点现场；warn（如 E04 提取空结果=业务可接受）
                # 不是出错现场，不触发中间产物保留。
                if str(row.get("level", "error")) != "error":
                    continue
                stage = str(row.get("stage", ""))
            except Exception:
                continue
            keep |= anchor_dirs_for_stage(stage)
    # 全部候选中间产物：generated_dirs（stage1/classify）+ flow_s4 + flow_s5
    candidates = [path for path in generated_dirs if path.exists()]
    candidates += [tmp / "flow_s4" / batch, tmp / "flow_s5" / batch]
    removed = []
    for path in candidates:
        if not path.exists():
            continue
        if path.parent.name in keep:  # 目录名（flow_s4 等）匹配锚点保留集
            continue
        shutil.rmtree(path)
        removed.append(str(path))
    return removed


def load_s3_results(directory, docs, tag):
    results = []
    for doc in docs:
        path = directory / f"{doc_key(doc)}__{tag}.json"
        if not path.exists():
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        classes = record.get("batch5") or {}
        for entry in record.get("entries") or []:
            class_id = classes.get(entry)
            if isinstance(class_id, int):
                results.append((doc, entry, class_id))
    return results


def main():
    parser = argparse.ArgumentParser(description="运行完整 LLM WiKi 处理链")
    parser.add_argument("--docs", default="", help="逗号分隔 raw/ 相对路径或文件名；默认全部")
    parser.add_argument("--resume-from-s3", default="", help="恢复时指定已有 S3 输出目录")
    args = parser.parse_args()

    requested = [item.strip() for item in args.docs.split(",") if item.strip()]
    try:
        docs = resolve_docs(BASE, requested)
    except ValueError as exc:
        parser.error(str(exc))
    if not docs:
        parser.error("raw/ 下没有可处理文档")
    # 增量解析：未显式 --docs 时，只处理 cursor.json 尚未解析的文档；
    # 显式指定 --docs 尊重用户选择（仍全跑指定文档）
    if not requested:
        parsed = load_parsed_documents()
        new_docs = filter_new_docs(docs, parsed)
        if not new_docs:
            print("无新增文档（cursor.json 已全部解析），跳过全流程")
            return
        if len(new_docs) < len(docs):
            print(f"[增量] 已解析跳过 {len(docs) - len(new_docs)} 个，新增处理 {len(new_docs)} 个")
        docs = new_docs

    batch = f"fullflow-{time.strftime('%Y%m%d-%H%M%S')}"

    # S0：源文档分类分流（S1 之前）——S1-S7 只处理文本文档，
    # 图片/视频/音频/Office/PDF/压缩包等提前分流（将来走各自支线流程）。
    from s0_classify import classify_docs, select_text  # noqa: E402

    categories = classify_docs(BASE, docs)
    shunted = {cat: rels for cat, rels in categories.items()
               if cat != "text" and rels}
    if shunted:
        summary = "；".join(f"{cat} {len(rels)} 个" for cat, rels in shunted.items())
        print(f"[S0] 分流非文本文档 {sum(len(v) for v in shunted.values())} 个（{summary}），"
              f"S1-S7 只处理文本 {len(categories['text'])} 个")
    text_docs = select_text(categories, docs)
    if text_docs is None:
        raise SystemExit("指定文档均为非文本类别（走各自支线流程），S1-S7 无文本可处理")
    docs = text_docs

    # S0：源文档唯一化（S1 之前；重名 → 逐级前缀改名，对照集含本批已分派名）
    # 对照集 = index.md 条目页名 ∪ sources_index.md 历史源文档名 ∪ 本批已分派名；
    # 物理改名 raw/ 文件并留痕 changes.jsonl「源文档变更」；失败文档 E01 跳过。
    from s0_unique import apply_renames, plan_batch  # noqa: E402

    s0_plan = plan_batch(BASE, docs, batch=batch)
    if s0_plan:
        apply_renames(BASE, s0_plan, batch=batch)
        docs = [new for _, new, _ in s0_plan]
        renamed = [(old, new) for old, new, r in s0_plan if r]
        if renamed:
            print(f"[S0] 源文档改名 {len(renamed)} 个：" +
                  "；".join(f"{old} → {new}" for old, new in renamed))
    elif docs:
        raise SystemExit("本批源文档全部命名冲突（E01），需人工裁决后重试")

    environment = dict(os.environ)
    environment["LLMWIKI_TMP_ROOT"] = str(BASE / ".tmp")
    environment["LLMWIKI_BATCH"] = batch
    selected = ",".join(docs)

    if args.resume_from_s3:
        s3_dir = Path(args.resume_from_s3).expanduser().resolve()
        if not s3_dir.is_dir():
            parser.error(f"S3 输出目录不存在: {s3_dir}")
        s3_tag = next((path.name.split("__", 1)[1][:-5] for path in s3_dir.glob("*__*.json")), "CLS")
        generated_dirs = []
    else:
        s1_tag = f"S1S2-{batch}"
        run([sys.executable, str(SCRIPTS / "run_s1s2.py"), "--docs", selected, "--tag", s1_tag], environment)
        s1_dir = newest(BASE / ".tmp" / "flow_stage1", s1_tag)
        s3_tag = f"S3-{batch}"
        run([sys.executable, str(SCRIPTS / "run_s3.py"), "--input", str(s1_dir), "--docs", selected, "--tag", s3_tag], environment)
        s3_dir = newest(BASE / ".tmp" / "flow_classify", s3_tag)
        generated_dirs = [s1_dir, s3_dir]

    s4_dir = BASE / ".tmp" / "flow_s4" / batch
    s4_dir.mkdir(parents=True, exist_ok=False)
    records = []
    for doc, entry, class_id in load_s3_results(s3_dir, docs, s3_tag):
        output = s4_dir / f"{doc_key(doc)}__{entry}.json"
        run([
            sys.executable, str(SCRIPTS / "run_s4.py"), "--doc", doc,
            "--entry", entry, "--class-id", str(class_id), "--form", "multi", "--out", str(output),
        ], environment)
        record = json.loads(output.read_text(encoding="utf-8"))
        if record.get("blocks"):
            record["source_doc"] = source_filename(doc)
            records.append(record)

    s5_input = s4_dir / "records.json"
    s5_input.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    s5_output = s4_dir / "s5-results.json"
    run([
        sys.executable, str(SCRIPTS / "run_s5.py"), "--input", str(s5_input),
        "--asset", str(BASE), "--out", str(s5_output),
    ], environment)

    processed_sources = sorted(docs)
    run([
        sys.executable, str(SCRIPTS / "run_s6.py"), "--asset", str(BASE), "--batch", batch,
        "--docs", ",".join(processed_sources),
    ], environment)
    run([
        sys.executable, str(SCRIPTS / "run_s7.py"), "--asset", str(BASE), "--batch", batch,
    ], environment)
    removed = cleanup_intermediates(batch, generated_dirs)
    if removed:
        print("\n[S8] 已清理中间产物（诊断库保留）：")
        for path in removed:
            print(f"  - {path}")
    print(f"\n完成：{batch}")


if __name__ == "__main__":
    main()
