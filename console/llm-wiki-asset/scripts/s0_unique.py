#!/usr/bin/env python3
"""s0_unique.py —— S0 源文档唯一化（生产模板版，2026-10-22 沙盒 TDD 定稿）。

职责：S1 之前对本批源文档做重名检测；重名 → 逐级前缀改名，保证 raw/ 登记名全局唯一。

规则（用户拍板 2026-10-22 + Test_v10 2026-10-17/18 设计）：
  - 重名候选 = 前缀式「近目录段_原名」逐级向根侧加长：
      raw/a/README.md   → ① a_README.md → ② raw_a_README.md
      raw/x/y/guide.md  → ① y_guide.md → ② x_y_guide.md → ③ raw_x_y_guide.md
  - 对照集 = index.md 条目页名 ∪ sources_index.md 历史源文档名 ∪ 本批已分派名（新增）；
  - 让路方 = 新源文档（历史条目页/历史源文档永不被改名）；
  - 本批多个同名 → 排序后第一个保留原名，其余改名；
  - 物理改名目标 = raw/<唯一名>（平铺到 raw 根），留痕 changes.jsonl「源文档变更」；
  - 唯一化失败（异常数据）→ emit_error(E01)，该文档跳过不入批次。
"""
import re
from pathlib import Path

from runtime import emit_change, emit_error, set_batch  # noqa: E402


# ---------- 对照集 ----------

def _wiki_names(asset, filename, pattern):
    """从 index.md / sources_index.md 提取登记名（生产 run_s6 格式 [[名]] ×N）。"""
    p = asset / filename
    if not p.exists():
        return set()
    names = set()
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.search(pattern, line)
        if m:
            names.add(m.group(1).strip())
    return names


def load_existing(asset):
    """对照集：index.md 条目页名 ∪ sources_index.md 历史源文档名。"""
    return (_wiki_names(asset, "index.md", r"\[\[([^\]]+)\]\]")
            | _wiki_names(asset, "sources_index.md", r"\[\[([^\]]+)\]\]"))


# ---------- 唯一名候选序列 ----------

def unique_name(rel_path, existing):
    """rel_path → (新相对路径, 是否改名)；全占 → (None, True)。

    existing: 已占用名集合（历史登记名 ∪ 本批已分派名 ∪ 物理占用名）。
    不改名 → 返回原相对路径；改名 → 平铺唯一名（raw 根文件名）。
    候选从最近目录段开始逐级加长，最后 raw_ 垫底兜底。
    """
    p = Path(rel_path)
    name = p.name
    if name not in existing:
        return str(rel_path), False
    dir_parts = [seg for seg in p.parts[:-1] if seg and seg != "."]
    candidates = []
    for i in range(1, len(dir_parts) + 1):
        candidates.append("_".join(dir_parts[-i:]) + "_" + name)
    tail = "_".join(dir_parts) + "_" + name if dir_parts else name
    candidates.append("raw_" + tail)
    for cand in candidates:
        if cand not in existing:
            return cand, True
    return None, True


def _physical_names(asset, except_rel):
    """raw/ 下所有文件 basename（排除本批源文档自身），防止改名目标撞物理文件。"""
    raw = asset / "raw"
    if not raw.exists():
        return set()
    except_name = Path(except_rel).name
    return {p.name for p in raw.rglob("*") if p.is_file() and p.name != except_name}


# ---------- 批次计划 ----------

def plan_batch(asset, docs, batch="default"):
    """对本批 docs 逐一唯一化。

    对照集 = 历史登记名 ∪ 本批已分派名 ∪ 物理占用名（本批外文件）。
    返回 [(原名, 唯一名, 是否改名)]；唯一化失败（E01）的文档跳过不入列表。
    """
    asset = Path(asset)
    live = set(load_existing(asset))
    set_batch(asset / ".tmp", batch)
    plan = []
    for rel in docs:
        rel = str(rel)
        src = asset / "raw" / rel
        if not src.exists():
            continue  # docs 来自 resolve_docs，理论上都存在
        taken = set(live) | _physical_names(asset, rel)
        taken |= {Path(new).name for _, new, _ in plan}  # 本批已分派登记名
        name, renamed = unique_name(rel, taken)
        if name is None:
            emit_error("E01", "S0唯一化", {"type": "源文档", "entry": rel},
                       f"源文档命名冲突：{rel} 与已有源文档/条目页重名且自动唯一化失败",
                       asset)
            continue  # 跳过，不阻断批次（人工裁决）
        live.add(Path(name).name)
        plan.append((rel, name, renamed))
    return plan


def apply_renames(asset, plan, batch="default"):
    """物理改名：raw/<原名> → raw/<唯一名>（平铺 raw 根）；留痕 changes.jsonl。"""
    asset = Path(asset)
    raw = asset / "raw"
    set_batch(asset / ".tmp", batch)
    for old, new, renamed in plan:
        if not renamed:
            continue
        src = raw / old
        dst = raw / new
        if not src.exists():
            continue
        if dst.exists():
            emit_error("E01", "S0唯一化", {"type": "源文档", "entry": old},
                       f"改名目标已存在：{new}（异常数据，需人工裁决）", asset)
            continue
        src.rename(dst)
        emit_change("源文档变更", f"{old} → {new}", "唯一化：与已有源文档/条目页重名")


if __name__ == "__main__":
    # 自检：候选序列（对齐用户拍板示例）
    print("a/README.md 候选:", [n for n, _ in
          [(unique_name("a/README.md", {"README.md"})),
           (unique_name("a/README.md", {"README.md", "a_README.md"}))]])
    print(unique_name("a/README.md", {"README.md"}))                          # ('a_README.md', True)
    print(unique_name("a/README.md", {"README.md", "a_README.md"}))           # ('raw_a_README.md', True)
    print(unique_name("x/y/guide.md", {"guide.md", "y_guide.md", "x_y_guide.md"}))  # ('raw_x_y_guide.md', True)
