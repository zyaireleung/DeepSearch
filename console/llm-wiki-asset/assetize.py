#!/usr/bin/env python3
"""资产化工具：把任意文档目录原地改造成 LLM WiKi 资产。

用法：
    python3 assetize.py <目标目录>

流程：
  1. 目标目录已具备资产骨架（scripts/ + config.yaml + prompts/ + schema/）→ 已资产化，不操作；
  2. 否则资产化：
     a. 目标目录下除 raw/ 外的全部内容移动进 raw/（多级目录保留；目录合并、文件覆盖）；
     b. 从本资产复制骨架（scripts/prompts/schema/config.yaml/README.md/cursor.json/.tmp）。
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

SELF = Path(__file__).resolve().parent  # 本资产（骨架模板源）
SKELETON_DIRS = ("scripts", "prompts", "schema")
SKELETON_FILES = ("config.yaml", "README.md")


def is_asset(path):
    """资产骨架标志：scripts/ + config.yaml + prompts/ + schema/ 齐备。"""
    return all((path / name).exists() for name in (*SKELETON_DIRS, "config.yaml"))


def merge_move(src, dst):
    """把 src 移入 dst：目录递归合并（内容并入同名目录）、文件覆盖。"""
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            merge_move(child, dst / child.name)
        src.rmdir()
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            dst.unlink()
        shutil.move(str(src), str(dst))


def assetize(target):
    # 沙盒 E2E 注入的可控延迟：默认 0，生产不设置该变量，正常路径零变化。
    try:
        delay = float(os.environ.get("WIKI_ASSETIZE_TEST_DELAY_SEC", "0"))
    except ValueError:
        delay = 0
    if delay > 0:
        time.sleep(delay)
    if target == SELF or SELF in target.parents:
        sys.exit(f"拒绝：目标目录是本资产自身（{SELF}）")
    if not target.exists():
        sys.exit(f"目标目录不存在：{target}")
    if not target.is_dir():
        sys.exit(f"目标不是目录：{target}")
    if is_asset(target):
        print(f"已资产化：{target}（具备资产骨架，无需操作）")
        return
    # a. 原内容 → raw/（跳过 raw 自身；目录合并、文件覆盖）
    raw = target / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    moved = 0
    for child in sorted(target.iterdir()):
        if child.name == "raw":
            continue
        merge_move(child, raw / child.name)
        moved += 1
    # b. 复制资产骨架
    for name in SKELETON_DIRS:
        shutil.copytree(SELF / name, target / name,
                        ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
    for name in SKELETON_FILES:
        shutil.copy2(SELF / name, target / name)
    (target / "cursor.json").write_text(
        json.dumps({"version": 1, "documents": {}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    (target / ".tmp").mkdir(parents=True, exist_ok=True)
    print(f"资产化完成：{target}")
    print(f"  raw/ 已接收 {moved} 项原内容（多级目录保留，目录合并/文件覆盖）")
    print("  骨架已就位：scripts/ prompts/ schema/ config.yaml README.md cursor.json .tmp/")
    print(f"  下一步：cd {target} && python3 scripts/run_fullflow.py")


def main():
    parser = argparse.ArgumentParser(description="把文档目录原地改造成 LLM WiKi 资产")
    parser.add_argument("target", help="目标目录（将原地变成资产）")
    args = parser.parse_args()
    assetize(Path(args.target).expanduser().resolve())


if __name__ == "__main__":
    main()
