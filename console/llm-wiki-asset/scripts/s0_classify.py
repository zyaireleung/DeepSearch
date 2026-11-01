#!/usr/bin/env python3
"""s0_classify.py —— S0 源文档分类分流（2026-10-22 用户拍板，配置驱动版）。

职责：S1 之前把 raw/ 源文档按类别分流；S1-S7 只处理文本文档，
图片/视频/音频/Office/PDF/压缩包等提前分流，为将来各自的支线流程留接口。

语义（用户拍板）：白名单允许进入——只有 classify 配置中列出的后缀
允许进入对应支线；未列出的后缀一律分流（不进入任何支线）。
配置来源：资产 config.yaml 的 classify 段；缺省用内置默认（对齐模板）。

config.yaml 结构：
  classify:
    text:
      enabled: true
      extensions: [md, markdown, txt]      # 无点号；保存时前后端统一归一化
    image:
      enabled: false
      extensions: [png, jpg, jpeg, ...]
    ...（video/audio/office/pdf/archive 同理；enabled: false = 预留支线）

接口：
  classify_docs(asset, docs=None) -> {类别: [相对路径]}（按 docs() 顺序保留）
  select_text(categories, docs)   -> 文本子集；显式指定非文本 → None（调用方报错）
"""
from pathlib import Path

from runtime import config  # noqa: E402

# 内置默认（模板 config.yaml 同步一致的兜底；资产 config 无 classify 段时用）
DEFAULT_CLASSIFY = {
    "text": {"enabled": True, "extensions": ["md", "markdown", "txt"]},
    "image": {"enabled": False, "extensions": [
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic", "tiff"]},
    "video": {"enabled": False, "extensions": [
        "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"]},
    "audio": {"enabled": False, "extensions": [
        "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]},
    "office": {"enabled": False, "extensions": [
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"]},
    "pdf": {"enabled": False, "extensions": ["pdf"]},
    "archive": {"enabled": False, "extensions": ["zip", "tar", "gz", "7z", "rar", "bz2"]},
}
CATEGORIES = tuple(DEFAULT_CLASSIFY.keys()) + ("other",)


def _norm_ext(value):
    """后缀归一化：去点号、去空格、转小写（支持全/半角逗号由前端解析）。"""
    return str(value).strip().lower().lstrip(".")


def load_classify(asset):
    """读资产 config.yaml 的 classify 段；缺省/非法 → 内置默认。"""
    try:
        raw = config(asset).get("classify") or {}
    except Exception:
        return DEFAULT_CLASSIFY
    merged = {}
    for cat, default in DEFAULT_CLASSIFY.items():
        entry = raw.get(cat) or {}
        merged[cat] = {
            "enabled": bool(entry.get("enabled", default["enabled"])),
            "extensions": [_norm_ext(e) for e in entry.get("extensions", default["extensions"])],
        }
    return merged


def _ext_map(classify):
    """类别配置 → {后缀(无点): 类别}。"""
    mapping = {}
    for cat, entry in classify.items():
        for ext in entry["extensions"]:
            mapping[ext] = cat
    return mapping


def _category_by_ext(rel, ext_map):
    ext = Path(rel).suffix.lower().lstrip(".").strip()
    return ext_map.get(ext)


def classify_docs(asset, docs=None):
    """把源文档列表按类别分流（白名单语义：未列后缀 → other，不探测放行）。"""
    root = Path(asset).resolve()
    if docs is None:
        raw = root / "raw"
        docs = sorted(str(path.relative_to(raw)) for path in raw.rglob("*")
                      if path.is_file() and not path.name.startswith("."))
    classify = load_classify(asset)
    ext_map = _ext_map(classify)
    result = {cat: [] for cat in CATEGORIES}
    for rel in docs:
        rel = str(rel)
        cat = _category_by_ext(rel, ext_map)
        if cat is None:
            cat = "other"  # 白名单语义：未列出后缀一律分流到 other
        result[cat].append(rel)
    return result


def select_text(categories, docs):
    """从分类结果中取文本子集（保持 docs 原顺序）。

    显式 --docs 指定了非文本（全部被分流）→ 返回 None，调用方应报错提示走支线。
    """
    text_set = set(categories["text"])
    selected = [doc for doc in docs if doc in text_set]
    if not selected and docs:
        return None
    return selected
