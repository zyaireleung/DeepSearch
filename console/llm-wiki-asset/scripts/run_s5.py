#!/usr/bin/env python3
"""S5 写入阶段：S4 产物 → 条目页创建 / 增量 / 迁移 + 块向量收尾。

正常由 run_fullflow.py 调用（--input 指向 S4 批次 records.json）；
可独立运行于单个 record 或 record 数组。全部输入、提示词与产物都位于资产目录内。

三条写入分支（按查重结果分派）：
  - 条目页不存在        → 创建分支（模板建页 + 块落位）；
  - 存在且分类未变      → 增量分支（标题重合块 LLM 合并重写，其余追加）；
  - 存在且分类已变      → 迁移分支（binary 判最终分类 → placement 落位 → 临时页/旧页覆盖）。

页面成功落盘后统一做块级向量收尾（复用 / 重建 / 孤儿清理）。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime import (  # noqa: E402
    BatchAbort, call_stage, config, docs, emit_change, emit_error, emit_operation,
    emit_response, extract_json, parse_frontmatter, set_batch, template_boards,
)

PROMPTS = {
    "binary": BASE / "prompts" / "s5_binary_261015.md",
    "placement": BASE / "prompts" / "s5_placement_261015.md",
    "merge": BASE / "prompts" / "s5_merge_261015.md",
}

# 英文分类名 → 序号（读旧页 frontmatter type 的反向映射，与 schema/templates/*.md 一致）
NAME_TO_NUM = {
    "Tool": 1, "Concept": 2, "Person": 3, "Org": 4, "Creation": 5,
    "Task": 6, "Goal": 7, "Place": 8, "Event": 9, "Character": 10,
    "Guide": 11, "Document": 12,
}
NUM_TO_NAME = {value: key for key, value in NAME_TO_NUM.items()}


# ---------- 注册表（查重 + 旧页读取） ----------

def _safe_name(name):
    return re.sub(r'[\\/:*?"<>|]', "-", name).strip()


class Registry:
    """条目注册表：扫描 entities/，提供查重与旧页读取。"""

    def __init__(self, vault_root):
        self.vault_root = Path(vault_root).resolve()
        self.entities_dir = self.vault_root / "entities"
        self._pages = {}

    def scan(self):
        self._pages = {}
        if not self.entities_dir.exists():
            return self
        for path in sorted(self.entities_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            fm, body = parse_frontmatter(text)
            name = fm.get("title") or path.stem
            self._pages[name] = {"path": path, "frontmatter": fm, "body": body,
                                 "blocks": _parse_blocks(body)}
        return self

    def exists(self, entry_name):
        if entry_name in self._pages:
            return True
        if self.entities_dir.exists():
            if (self.entities_dir / f"{_safe_name(entry_name)}.md").exists():
                return True
            for path in self.entities_dir.glob("*.md"):
                try:
                    fm, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
                    if fm.get("title") == entry_name:
                        return True
                except Exception:
                    continue
        return False

    def get(self, entry_name):
        """与 exists() 同路回退：先内存字典，再文件名（_safe_name，兼容大小写不敏感 FS），
        再 frontmatter title 扫描。修复：多源同名不同大小写条目在 macOS 上
        exists()=True（文件名命中）但 get()=None（字典 key 大小写不同）→ page["path"] 崩。"""
        if entry_name in self._pages:
            return self._pages[entry_name]
        if self.entities_dir.exists():
            path = self.entities_dir / f"{_safe_name(entry_name)}.md"
            if path.exists():
                text = path.read_text(encoding="utf-8")
                fm, body = parse_frontmatter(text)
                return {"path": path, "frontmatter": fm, "body": body,
                        "blocks": _parse_blocks(body)}
            for path in self.entities_dir.glob("*.md"):
                try:
                    fm, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
                    if fm.get("title") == entry_name:
                        text = path.read_text(encoding="utf-8")
                        _, body = parse_frontmatter(text)
                        return {"path": path, "frontmatter": fm, "body": body,
                                "blocks": _parse_blocks(body)}
                except Exception:
                    continue
        return None

    def old_type(self, entry_name):
        page = self._pages.get(entry_name)
        if not page:
            return None
        value = page["frontmatter"].get("type")
        if value is None:
            return None
        if str(value).isdigit():
            return int(value)
        return NAME_TO_NUM.get(value)

    def sibling_titles(self, source_doc):
        """全库 sources 含该 source_doc 的条目标题集（兄弟条目，双链候选）。
        source_doc 为 S0 唯一化后物理文档名；sources 行形态 `  - "[[名]]"`。"""
        titles = set()
        if not source_doc:
            return titles
        for name, page in self._pages.items():
            srcs = page["frontmatter"].get("sources") or []
            for s in srcs:
                clean = str(s).replace("[[", "").replace("]]", "").strip()
                if clean == source_doc:
                    titles.add(name)
                    break
        return titles


# ---------- S4 产物解析 ----------

def parse_s4a_blocks(blocks_json):
    """S4A 块列表（JSON 数组或已解析 list）→ 规范化块列表。
    空条目块（无小标题或正文为空）不建页，丢弃并标记。"""
    if isinstance(blocks_json, str):
        try:
            array = json.loads(blocks_json)
        except Exception:
            return [], "坏JSON"
    else:
        array = blocks_json
    if not isinstance(array, list):
        return [], "非数组"
    blocks, dropped = [], 0
    for item in array:
        if not isinstance(item, dict):
            dropped += 1
            continue
        title = str(item.get("小标题") or "").strip()
        body = str(item.get("正文") or "").strip()
        if not title or not body:
            dropped += 1
            continue
        blocks.append({"板块": str(item.get("板块") or "").strip(),
                       "小标题": title, "正文": body})
    return blocks, (f"丢弃{dropped}个空块" if dropped else "")


def make_record(entry, class_id, blocks, source_doc, form, note=""):
    return {"entry": entry, "class_id": int(class_id), "blocks": blocks,
            "source_doc": source_doc, "form": form, "note": note}


# ---------- 建页（分类模板 → frontmatter + 骨架） ----------

def load_template(class_id):
    path = BASE / "schema" / "templates" / f"{class_id:02d}.md"
    if not path.exists():
        return None, None
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    fm_raw = match.group(1) if match else ""
    body = text[match.end():] if match else text
    return fm_raw, body


def build_page(record, now=None):
    now = now or time.strftime("%Y-%m-%dT%H:%M")
    fm_raw, body_tpl = load_template(record["class_id"])
    if fm_raw is None:
        raise ValueError(f"模板不存在: {record['class_id']}")
    entry = record["entry"]
    sources = record.get("source_doc") or ""
    sources_line = f'  - "[[{sources}]]"' if sources else "  - "
    fm = (fm_raw
          .replace("{条目名}", entry)
          .replace("  - 标签1\n  - 标签2", "  - \n  - ")
          .replace("  - 标签1", "  - ")
          .replace("  - \"[[源文档1]]\"\n  - \"[[源文档2]]\"", sources_line)
          .replace("  - \"[[源文档1]]\"", sources_line)
          .replace("  - \"[[源文档2]]\"", "")
          .replace("2026-10-13T14:30", now))
    body = body_tpl
    body = re.sub(r"# 条目模板.*\n+", "", body)
    body = re.sub(r"##### .*\n+(正文内容\n+)+", "", body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return f"---\n{fm}\n---\n\n# {entry}\n\n{body}\n"


def entry_filename(entry):
    return f"{_safe_name(entry)}.md"


# ---------- 块写入（骨架填块 / 序号格式化） ----------

def split_skeleton(body):
    lines = body.splitlines()
    segments, current, buf = [], None, []
    for line in lines:
        if line.startswith("## "):
            if current is not None:
                segments.append({"板块": current, "segment": "\n".join(buf).rstrip()})
            current = line[3:].strip()
            buf = [line]
        else:
            buf.append(line)
    if current is not None:
        segments.append({"板块": current, "segment": "\n".join(buf).rstrip()})
    return segments


def format_body_numbers(text):
    """把同一段挤在一起的序号（"…。1. A…2. B…3. C…"）拆成 md 有序列表。
    仅当一行内出现 ≥2 个序号模式才拆；LLM 已输出的多行序号保持不动。"""
    if not text:
        return text
    out_lines = []
    for line in str(text).split("\n"):
        seqs = list(re.finditer(r"(^|[。；;])\s*(\d{1,2})[.、]\s+", line))
        if len(seqs) < 2:
            out_lines.append(line)
            continue
        for match in reversed(seqs[1:]):
            line = line[:match.start(2)] + "\n" + line[match.start(2):]
        out_lines.append(line)
    return "\n".join(out_lines)


def render_block(block):
    return f"##### {block['小标题']}\n\n{format_body_numbers(block['正文'])}"


def fill_blocks(body, blocks):
    """块列表填入骨架：每个块挂在对应板块下（##### 小标题 + 正文）。"""
    segments = split_skeleton(body)
    by_board = {}
    for block in blocks:
        by_board.setdefault(block.get("板块") or "未分类", []).append(block)
    out_parts, seen = [], set()
    for segment in segments:
        name = segment["板块"]
        seen.add(name)
        seg_lines = [line for line in segment["segment"].splitlines()
                     if not line.strip() or line.startswith("## ")]
        header = "\n".join(seg_lines).rstrip()
        out_parts.append(f"\n{header}")
        for block in by_board.get(name, []):
            out_parts.append("\n" + render_block(block))
    for name, block_list in by_board.items():
        if name in seen:
            continue
        out_parts.append(f"\n## {name}")
        for block in block_list:
            out_parts.append("\n" + render_block(block))
    text = "\n".join(out_parts)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def split_frontmatter(text):
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if match:
        return match.group(0), text[match.end():]
    return "", text


def _wikify_candidate_set(candidates, self_title):
    """候选标题去重、去自身（大小写不敏感）、非法值过滤。
    返回顺序：长度降序（长标题先处理，防子串串扰，如 dsh-safe.sh vs dsh-safe 受控沙盒）。"""
    seen, out = set(), []
    self_lower = (self_title or "").lower()
    for c in candidates or []:
        c = str(c).strip()
        if not c:
            continue
        key = c.lower()
        if key in seen or key == self_lower:
            continue
        seen.add(key)
        out.append(c)
    # 长度降序，同长度保持插入序（稳定）
    seen_len = {}
    for idx, c in enumerate(out):
        seen_len.setdefault(len(c), idx)
    return sorted(out, key=lambda c: (-len(c), seen_len[len(c)]))


def wikify_related(text, candidates, self_title=None):
    """正文中把 candidates 命中的全名（大小写不敏感）转 [[标题]]。

    判据（用户 2026-10-23 定）：
      1. 仅处理 candidates（= 同源兄弟条目集，即该源文档 related 集合）；
      2. 标题全名精确匹配，大小写不敏感（b1 ≡ B1）；
      3. 自身标题不链（页面标题本身及其大小写变体都跳过）；
      4. 已是 [[X]] 的不重复包裹（防嵌套）；
      5. 同名明文多处出现 → 每处都转。
    替换统一用候选标准标题（[[B1]]），不论正文原大小写。
    以 # 开头的标题行（###/##### 等）不处理——只转正文行文本，
    防块标题被包后 _parse_blocks/_validate_final 的块标题比对失配。
    一次性交替替换（候选按长度降序排分支）：re.sub 不回扫替换产物，
    长候选内的短候选子串不会被二次匹配 → 天然防嵌套。
    """
    if not text:
        return text
    ordered = _wikify_candidate_set(candidates, self_title)
    if not ordered:
        return text
    # 交替正则：named group 映射命中 → 标准标题；长度降序保证最长候选优先
    pattern = re.compile("|".join(
        f"(?P<w{idx}>{re.escape(c)})" for idx, c in enumerate(ordered)
    ), re.IGNORECASE)
    out = []
    for line in text.split("\n"):
        if line.lstrip().startswith("#"):
            out.append(line)
            continue
        # 先保护已有双链：[[X]] 整体占位，防嵌套
        protected = []
        def _shield(m):
            protected.append(m.group(0))
            return f"\x00SHIELD{len(protected)-1}\x00"
        guarded = re.sub(r"\[\[[^\]]*\]\]", _shield, line)
        def _repl(m):
            for idx, cand in enumerate(ordered):
                if m.group(f"w{idx}"):
                    return f"[[{cand}]]"
            return m.group(0)
        guarded = pattern.sub(_repl, guarded)
        for i, orig in enumerate(protected):
            guarded = guarded.replace(f"\x00SHIELD{i}\x00", orig)
        out.append(guarded)
    return "\n".join(out)


def apply_wikify(page_text, entry, source_doc, registry):
    """页面文本写盘前应用同源双链（仅正文，frontmatter 不动）。
    source_doc 为空或候选集空 → 原样返回。"""
    if not source_doc:
        return page_text
    candidates = registry.sibling_titles(source_doc)
    if not candidates:
        return page_text
    fm, body = split_frontmatter(page_text)
    new_body = wikify_related(body, candidates, self_title=entry)
    if new_body == body:
        return page_text
    return fm + new_body


# ---------- 源文档收尾（related + 全库双链重写，正式流程一部分） ----------

FRONTMATTER_TPL = """---
title: "{title}"
type: "raw"
tags:
  - 
  - 
related:
{related}
created: {now}
updated: {now}
---
"""


def upsert_related(text, related_list, title_fallback):
    """raw 文本头部插入/更新 related 字段。已有 frontmatter → 只增改 related；无 → 全套模板。
    幂等：已有 related 时整块替换（旧列表项行跳过），不重复累计。
    2026-10-23 由 S5 收尾调用：全源条目定稿后才写，空块丢弃/失败条目不进 related。"""
    now = time.strftime("%Y-%m-%dT%H:%M")
    related_yaml = "\n".join(f'  - "[[{t}]]"' for t in related_list) if related_list else "  - "
    if not text.startswith("---\n"):
        title = title_fallback
        return FRONTMATTER_TPL.format(title=title, related=related_yaml, now=now) + text
    fm_raw, body = text.split("\n---\n", 1)
    out, inserted = [], False
    for line in fm_raw.splitlines():
        strip = line.strip()
        if not inserted and (strip == "related:" or line.startswith("related:")):
            inserted = True
            out.append(line.split(":", 1)[0] + ":")
            for r in related_list:
                out.append(f'  - "[[{r}]]"')
            continue
        # 跳过旧 related 列表项（已由上方替换），防重复累计
        if inserted and strip.startswith("- "):
            continue
        out.append(line)
    if not inserted:
        # 无 related → 追加到 frontmatter 末尾（--- 结束前）
        out.append("related:")
        for r in related_list:
            out.append(f'  - "[[{r}]]"')
    return "\n".join(out) + "\n---\n" + body


def rewrite_entity_wikilinks(registry, dry_run=False):
    """全库实体页双链重写：每页 candidates = 自身全部 sources 的兄弟并集。

    幂等；补齐顺序创建/增量/迁移造成的先建页缺链（A1 先建时 A2 未存在，
    A1 没链 A2；A2 建成后重写全库，A1 补链 A2）。返回 {scanned, wikified, unchanged}。
    """
    stats = {"scanned": 0, "wikified": 0, "unchanged": 0}
    registry.scan()
    for name, page in registry._pages.items():
        stats["scanned"] += 1
        srcs = page["frontmatter"].get("sources") or []
        candidates = set()
        for s in srcs:
            clean = str(s).replace("[[", "").replace("]]", "").strip()
            if clean:
                candidates.update(registry.sibling_titles(clean))
        candidates.discard(name)
        if not candidates:
            stats["unchanged"] += 1
            continue
        fm, body = split_frontmatter(page["path"].read_text(encoding="utf-8"))
        new_body = wikify_related(body, candidates, self_title=name)
        if new_body == body:
            stats["unchanged"] += 1
            continue
        if not dry_run:
            page["path"].write_text(fm + new_body, encoding="utf-8")
        stats["wikified"] += 1
    return stats


def finalize_source_doc(source_doc, registry, dry_run=False):
    """S5 源文档收尾：全源条目处理完毕后调用。

    related = 当前 entities 中 sources 含该源文档的全部条目标题
    （= sibling_titles 全集，只含已成功落盘页：E04 空块丢弃不建页、
    失败不落盘 → 天然不在集合内）。写 raw frontmatter related。
    幂等：重复调用无变化（raw 与实体页都已定稿）。返回统计 dict。"""
    stats = {"source": source_doc, "raw": "missing", "related": 0, "rewrite": None}
    if not source_doc:
        return stats
    registry.scan()
    siblings = sorted(registry.sibling_titles(source_doc))
    raw_root = registry.vault_root / "raw"
    candidates = [p for p in raw_root.rglob("*.md")
                  if p.name == source_doc and not p.name.startswith(".")]
    if not candidates:
        return stats
    if not siblings:
        # 该源无产出条目（E04 空块丢弃/未建页）→ 不动 raw，related 不写
        # （与存量验收一致：tag-review 等 3 个无产出源保持原文件）
        stats["raw"] = "no_related"
        return stats
    path = candidates[0]
    text = path.read_text(encoding="utf-8")
    new_text = upsert_related(text, siblings, path.stem)
    stats["related"] = len(siblings)
    if new_text != text:
        if not dry_run:
            path.write_text(new_text, encoding="utf-8")
        stats["raw"] = "updated"
    else:
        stats["raw"] = "unchanged"
    # 实体页双链重写由调用方循环外统一执行一次（rewrite_entity_wikilinks 全库幂等）
    return stats


# ---------- 合并判定（恒定规则，纯脚本） ----------

STOP_CHARS = set("的了与和及或而于在把被对从向为是这那等之其所个以也又再并就才都还更最很极非常完整详细关于")


def normalize_title(text):
    text = unicodedata.normalize("NFKC", str(text)).lower()
    text = re.sub(r"[\s\u3000]+", "", text)
    text = re.sub(r"[^\w\u4e00-\u9fff\-]", "", text)
    return "".join(ch for ch in text if ch not in STOP_CHARS)


def core_grams(text, n=2):
    text = normalize_title(text)
    if not text:
        return set()
    if re.fullmatch(r"[a-z0-9\-]+", text):
        return set(text.replace("-", " ").split())
    return {text[i:i + n] for i in range(len(text) - n + 1)}


def overlap_ratio(a, b):
    ga, gb = core_grams(a), core_grams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / max(len(ga), len(gb))


def judge(a, b, threshold):
    """判定两小标题：'merge' | 'append'（纯标题判断，2026-10-23 用户定稿）。

    用户原则"只做有把握的"：标题是块的唯一身份，正文不参与判定
    （正文重叠会误判不同主题——审核数据实证 25/25 负样本正文重叠≥0.5）。
    1. 归一化后标题完全相同 → merge（有把握）
    2. 标题字面重叠 ≥ 0.85（同一标题仅个别字眼差异）→ merge（有把握）
    3. 其余 → append（保守：语义相近但不确定 → 多一块可接受，绝不冒险合并）
    """
    na, nb = normalize_title(a), normalize_title(b)
    if na and na == nb:
        return "merge"
    if overlap_ratio(a, b) >= 0.85:
        return "merge"
    return "append"


# ---------- S5 三个 LLM prompt 调用 ----------

def fmt_blocks(blocks, with_board=False):
    out = []
    for block in blocks:
        title, body = block.get("小标题", ""), block.get("正文", "")
        if with_board:
            out.append(f"- [{block.get('板块', '')}] {title}")
        else:
            out.append(f"- 小标题：{title}\n  正文：{body}")
    return "\n".join(out)


def _s5_call(stage, prompt, entry, parse_fail_note):
    """调用一次 S5 环节 LLM 并解析 JSON。返回 (obj, None) 或 (None, err)。
    LLM 调用失败由 runtime.call_stage 记录 E05（可能抛 BatchAbort）；
    解析失败就地记录 E03 + 原始返回。"""
    response = call_stage(stage, prompt, asset=BASE, context={"entry": entry})
    if response is None:
        emit_response("S5", "", entry, "", "llm_failed", "LLM 调用失败（E05 已记录）")
        return None, "LLM 调用失败"
    value = extract_json(response)
    if value is None:
        emit_response("S5", "", entry, str(response), "parse_fail", parse_fail_note)
        emit_error("E03", f"S5-{stage}", {"type": "条目", "entry": entry},
                   f"{parse_fail_note}（原始返回见 llm_responses.jsonl）", BASE)
        return None, parse_fail_note
    return value, None


def call_binary(entry, old_blocks, new_blocks, desc_a, desc_b):
    """① 判最终分类：→ {"分类序号": "甲"|"乙"}。"""
    prompt = (PROMPTS["binary"].read_text(encoding="utf-8")
              .replace("{条目名}", entry)
              .replace("{旧页块：每块小标题+正文}", fmt_blocks(old_blocks))
              .replace("{新块：每块小标题+正文}", fmt_blocks(new_blocks))
              .replace("{分类说明}", f"分类甲：{desc_a}\n\n分类乙：{desc_b}"))
    value, err = _s5_call("s5_binary", prompt, entry, "binary 返回不是含分类序号的 JSON 对象")
    if err or not isinstance(value, dict) or "分类序号" not in value:
        return None, err or f"缺分类序号: {str(value)[:80]}"
    return value, None


def call_placement(entry, target_boards, existing_blocks, pending_blocks):
    """② 落位判断：→ ["板块名，内容块标题", ...]。"""
    prompt = (PROMPTS["placement"].read_text(encoding="utf-8")
              .replace("{条目名}", entry)
              .replace("{除基础信息和影响外的全部板块及其说明}", target_boards)
              .replace("{目标侧已有块（排除基础信息和影响外的全部）：板块+小标题（供对齐与合并判断）}",
                       fmt_blocks(existing_blocks, with_board=True) if existing_blocks else "(无)")
              .replace("{待落位块（排除基础信息和影响外的全部）：小标题+正文}",
                       fmt_blocks(pending_blocks, with_board=False)))
    value, err = _s5_call("s5_placement", prompt, entry, "placement 返回不是 JSON 数组")
    if err or not isinstance(value, list):
        return None, err or f"非数组: {str(value)[:80]}"
    if len(value) != len(pending_blocks):
        return None, f"项数不符: {len(value)} vs 待分类 {len(pending_blocks)}"
    return value, None


def call_merge(old_block, new_block):
    """③ 合并重写：标题重合块 → {"小标题","正文"} 并集。"""
    prompt = (PROMPTS["merge"].read_text(encoding="utf-8")
              .replace("{旧小标题}", old_block["小标题"])
              .replace("{旧正文}", old_block["正文"])
              .replace("{新小标题}", new_block["小标题"])
              .replace("{新正文}", new_block["正文"]))
    value, err = _s5_call("s5_merge", prompt, new_block.get("小标题", ""),
                          "merge 返回不是含小标题/正文的 JSON 对象")
    if err or not isinstance(value, dict) or "小标题" not in value or "正文" not in value:
        return None, err or f"缺小标题/正文: {str(value)[:80]}"
    return value, None


# ---------- 增量引擎（分类不变：追加 / 合并） ----------

def _merge_sources(fm, source):
    """frontmatter 文本中合并一个来源（去重追加，不碰其他字段）。

    2026-10-23 用户需求：条目被再次抽取（跨文档同名合并）后，新来源
    必须追加进 sources。create 只填建页来源；incremental/migrate 之前
    fm 原样保留 → 后续来源丢失（109 个多来源条目实锤）。

    注意保持 fm 末尾换行：splitlines()+join 会丢尾 \n，导致
    `---` 与正文 `# 标题` 挤行、frontmatter 解析失败。
    """
    if not source:
        return fm
    entry = f'  - "[[{source}]]"'
    lines = fm.splitlines()
    tail = "\n" if fm.endswith("\n") else ""
    src_idx = None
    for i, line in enumerate(lines):
        if line.strip() == "sources:" or line.startswith("sources:"):
            src_idx = i
            break
    if src_idx is None:
        # 无 sources 字段：插到 created 之前（无 created 则追加到 frontmatter 末尾）
        insert_at = len(lines)
        for i, line in enumerate(lines):
            if line.startswith("created:"):
                insert_at = i
                break
        new_lines = lines[:insert_at] + ["sources:", entry] + lines[insert_at:]
        return "\n".join(new_lines) + tail
    # 已有 sources 块：收集现有条目（strip 后整行比较，去重）
    existing = set()
    j = src_idx + 1
    while j < len(lines) and lines[j].strip().startswith("-"):
        existing.add(lines[j].strip())
        j += 1
    if entry.strip() in existing:
        return fm
    new_lines = lines[:j] + [entry] + lines[j:]
    return "\n".join(new_lines) + tail


def _sources_from_frontmatter(fm):
    """提取 frontmatter sources 的原样文档名，供分类迁移保留旧来源。"""
    sources = []
    lines = fm.splitlines()
    for i, line in enumerate(lines):
        if line.strip() != "sources:" and not line.startswith("sources:"):
            continue
        j = i + 1
        while j < len(lines) and lines[j].strip().startswith("-"):
            value = lines[j].strip()[1:].strip().strip('"\\\'')
            match = re.fullmatch(r"\\[\\[(.*)\\]\\]", value)
            if match and match.group(1).strip():
                sources.append(match.group(1).strip())
            j += 1
        break
    return sources


def incremental(old_page_text, new_blocks, merge_fn=None, threshold=0.60, new_source=None):
    """旧页文本 + 新块 → 新页文本。返回 (new_text, ops)。

    new_source：本条记录来源文档，合并追加进 frontmatter sources
    （跨文档同名条目再次抽取时补齐来源，2026-10-23 用户需求）。
    """
    fm, body = split_frontmatter(old_page_text)
    if new_source:
        fm = _merge_sources(fm, new_source)
    body_lines = body.splitlines()
    while body_lines and (not body_lines[0].strip() or body_lines[0].startswith("# ")):
        body_lines.pop(0)
    body = "\n".join(body_lines).strip("\n")
    old_blocks = _parse_blocks(body)
    ops = []
    by_board = {}
    for block in old_blocks:
        by_board.setdefault(block["板块"], []).append(block)

    new_board_blocks = []
    for new_block in new_blocks:
        board = new_block.get("板块") or "未分类"
        merged = False
        for old_block in by_board.get(board, []):
            if judge(old_block["小标题"], new_block["小标题"], threshold) == "merge":
                if merge_fn:
                    # merge_fn = call_merge，返回 (dict, err)
                    merged_block, merge_err = merge_fn(old_block, new_block)
                    if merge_err or not isinstance(merged_block, dict):
                        # 2026-10-23 保守处理：丢弃新块、保留旧块、记告警。
                        # 旧实现降级 append（旧块不动+新块追加）→ 副本累积（重复块实锤）。
                        # 按用户原则"只做有把握的"：merge 失败即没把握 → 不冒险替换/追加。
                        ops.append({"action": "append(merge-fail,conservative)", "board": board,
                                    "title": new_block["小标题"], "dropped": True})
                    else:
                        ops.append({"action": "merge", "board": board,
                                    "old_title": old_block["小标题"], "new_title": new_block["小标题"]})
                        body = _remove_block(body, old_block)
                        new_board_blocks.append((board, render_block(merged_block)))
                else:
                    ops.append({"action": "append(merge-hit,no-fn)", "board": board,
                                "title": new_block["小标题"]})
                    new_board_blocks.append((board, render_block(new_block)))
                merged = True
                break
        if not merged:
            ops.append({"action": "append", "board": board, "title": new_block["小标题"]})
            new_board_blocks.append((board, render_block(new_block)))
    new_body = _merge_body(body, new_board_blocks)
    new_text = fm + f"# {_page_title(old_page_text)}\n\n" + new_body
    return new_text, ops


def _page_title(old_page_text):
    for line in old_page_text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def _remove_block(body, block):
    """删除被 merge 的那个旧块；同标题但正文不同的块保留。"""
    lines = body.splitlines()
    out, in_block, removed = [], False, False
    title = block.get("小标题", "")
    expected_body = block.get("正文", "").strip()
    current_title, current_body = None, []

    def flush():
        nonlocal removed
        if current_title is None:
            return
        matched = (not removed and current_title == title
                   and "\n".join(current_body).strip() == expected_body)
        if not matched:
            out.append(f"##### {current_title}")
            out.extend(current_body)
        else:
            removed = True

    prefix = []
    for line in lines:
        if line.startswith("##### "):
            if current_title is None:
                out.extend(prefix)
            else:
                flush()
            current_title, current_body = line[5:].strip(), []
        elif line.startswith("## "):
            if current_title is not None:
                flush()
                current_title, current_body = None, []
            prefix.append(line)
        elif current_title is None:
            prefix.append(line)
        else:
            current_body.append(line)
    if current_title is not None:
        flush()
    else:
        out.extend(prefix)
    return "\n".join(out).strip("\n")


def _parse_blocks(body):
    blocks = []
    cur_board, cur_title, buf = None, None, []
    for line in body.splitlines():
        if line.startswith("## "):
            if cur_title:
                blocks.append({"板块": cur_board, "小标题": cur_title,
                               "正文": "\n".join(buf).strip()})
            cur_board = line[3:].strip()
            cur_title, buf = None, []
        elif line.startswith("##### "):
            if cur_title:
                blocks.append({"板块": cur_board, "小标题": cur_title,
                               "正文": "\n".join(buf).strip()})
            cur_title = line[5:].strip()
            buf = []
        elif cur_title is not None:
            buf.append(line)
    if cur_title:
        blocks.append({"板块": cur_board, "小标题": cur_title,
                       "正文": "\n".join(buf).strip()})
    return blocks


def _merge_body(body, board_blocks):
    """旧正文 + 新块（按板块归位）→ 新正文。
    新块插入其板块段末尾；板块不存在则段尾新建 ## 板块。"""
    lines = body.splitlines()
    segments, current = [], None
    for line in lines:
        if line.startswith("## "):
            if current is not None:
                segments.append(current)
            current = {"board": line[3:].strip(), "lines": [line]}
        elif current is not None:
            current["lines"].append(line)
    if current is not None:
        segments.append(current)
    pending = {}
    for board, rendered in board_blocks:
        pending.setdefault(board or "未分类", []).append(rendered)
    for board, renders in pending.items():
        target = next((segment for segment in segments if segment["board"] == board), None)
        if target is None:
            target = {"board": board, "lines": ["## " + board]}
            segments.append(target)
        for rendered in renders:
            if target["lines"] and target["lines"][-1].strip():
                target["lines"].append("")
            target["lines"].extend(rendered.splitlines())
    out = []
    for index, segment in enumerate(segments):
        if index > 0 and out and out[-1].strip():
            out.append("")
        out.extend(segment["lines"])
    return "\n".join(out).strip("\n") + "\n"


# ---------- 迁移分支（分类变更：binary → placement → 覆盖） ----------

def class_desc(class_id):
    """从 schema/classification.md 取第 n 类说明行。"""
    for line in (BASE / "schema" / "classification.md").read_text(encoding="utf-8").splitlines():
        if re.match(rf"^\s*{class_id}\.\s", line):
            return line.strip()
    return f"(未找到第 {class_id} 类说明)"


def _board_names(boards_txt):
    names = set()
    for line in boards_txt.splitlines():
        line = line.strip()
        if line.startswith("- "):
            name = line[2:].split("：", 1)[0].strip()
            if name:
                names.add(name)
    return names


def _apply_placement(all_blocks, pending, place_result, boards_txt):
    """把 placement 结果（["板块名，内容块标题", ...]）应用到 pending 块。
    严格校验：项数一致、板块在模板清单内、覆盖率 100%；任一不满足抛 ValueError。"""
    if len(place_result) != len(pending):
        raise ValueError(f"落位结果项数 {len(place_result)} != 待落位数 {len(pending)}")
    allowed = _board_names(boards_txt)
    if not allowed:
        raise ValueError("模板板块清单为空（boards_txt 解析失败）")
    mapping = {}
    for line in place_result:
        if "，" not in line:
            raise ValueError(f"落位结果格式不符（缺，分隔）: {line[:60]}")
        category, title = line.split("，", 1)
        category, title = category.strip(), title.strip()
        if category not in allowed:
            raise ValueError(f"落位板块 [{category}] 不在模板清单: {sorted(allowed)}")
        mapping[title] = category
    miss = [block.get("小标题", "") for block in pending
            if block.get("小标题", "").strip() not in mapping]
    if miss:
        raise ValueError(f"落位未覆盖块（{len(miss)}）: {miss[:5]}")
    applied = 0
    for block in all_blocks:
        title = block.get("小标题", "").strip()
        if title in mapping:
            block["板块"] = mapping[title]
            applied += 1
    if applied != len(pending):
        raise ValueError(f"落位应用数 {applied} != 待落位数 {len(pending)}")
    return all_blocks


def _validate_final(new_text, expected_blocks, ops, how):
    """覆盖前完整性校验：非空、frontmatter 可解析、正文有内容块、
    expected_blocks 全部落入（或由 merge 动作承载）。返回错误信息或 None。"""
    if not new_text or not new_text.strip():
        return f"{how}: new_text 为空"
    fm, body_str = split_frontmatter(new_text)
    if "type" not in fm:
        return f"{how}: frontmatter 缺失/无法解析"
    final_blocks = _parse_blocks(body_str)
    if not final_blocks:
        return f"{how}: 最终页正文无可解析内容块"
    final_titles = {block.get("小标题", "").strip() for block in final_blocks if block.get("小标题")}
    merged_titles = set()
    for op in ops:
        if op.get("action") == "merge":
            merged_titles.add(str(op.get("old_title", "")))
            merged_titles.add(str(op.get("new_title", "")))
    missing = []
    for block in expected_blocks or []:
        title = str(block.get("小标题", "")).strip()
        if not title:
            continue
        if title not in final_titles and title not in merged_titles:
            missing.append(title)
    if missing:
        return f"{how}: {len(missing)} 个块未落入最终页: {missing[:5]}"
    return None


def _finish(entry, new_text, class_id, registry, dry_run, ops, how, expected_blocks=None):
    """落盘/覆盖统一出口：先完整性校验（fail 则不覆盖），再备份、写盘、异常回滚。"""
    verr = _validate_final(new_text, expected_blocks, ops, how)
    if verr:
        return {"status": "fail", "entry": entry, "step": "validate",
                "how": how, "error": verr, "dry_run": dry_run}
    if dry_run:
        return {"status": "ok", "entry": entry, "dry_run": True,
                "final_class": class_id, "how": how, "page": new_text, "ops": ops}
    page = registry.get(entry)
    fpath = page["path"]
    backup = fpath.with_suffix(".bak")
    shutil.copy2(fpath, backup)
    try:
        fpath.write_text(new_text, encoding="utf-8")
        backup.unlink(missing_ok=True)  # .bak 仅为写盘瞬间的瞬态保险，写盘成功即删
        return {"status": "ok", "entry": entry, "path": str(fpath),
                "final_class": class_id, "how": how, "ops": ops}
    except Exception as exc:
        if backup.exists():
            shutil.copy2(backup, fpath)
        return {"status": "fail", "entry": entry, "step": "write", "error": str(exc),
                "rolled_back": True}


def migrate_entry(entry, new_blocks, new_class_id, source_doc, registry,
                  dry_run, binary_caller, placement_caller, merge_caller, threshold=0.60):
    """迁移分支主流程：① binary 判最终分类 →
    分支1（乙=旧页分类）：placement 落位到旧页板块 + 增量写旧页；
    分支2（甲=新分类）：临时页 5 步（新块落位 → 旧块落位 → 增量 → 校验覆盖）。"""
    page = registry.get(entry)
    if not page:
        return {"status": "missing", "entry": entry, "message": "旧页不存在"}
    old_class_id = registry.old_type(entry) or 0
    old_blocks = page["blocks"]
    old_text = page["path"].read_text(encoding="utf-8")

    bin_res, bin_err = binary_caller(entry, old_blocks, new_blocks,
                                     class_desc(new_class_id), class_desc(old_class_id))
    if bin_err:
        return {"status": "fail", "entry": entry, "step": "binary", "error": bin_err}
    final_choice = bin_res["分类序号"]
    final_class = new_class_id if final_choice == "甲" else old_class_id

    if final_choice == "乙":
        boards = template_boards(old_class_id, ("基本信息", "影响"))
        existing = [block for block in old_blocks if block["板块"] not in ("基本信息", "影响")]
        pending = [block for block in new_blocks if block["板块"] not in ("基本信息", "影响")]
        if pending:
            place_res, place_err = placement_caller(entry, boards, existing, pending)
            if place_err:
                return {"status": "fail", "entry": entry, "step": "placement(b1)", "error": place_err}
            try:
                new_blocks = _apply_placement(new_blocks, pending, place_res, boards)
            except ValueError as exc:
                return {"status": "fail", "entry": entry, "step": "placement(b1)",
                        "error": f"落位校验失败: {exc}"}
        new_text, ops = incremental(old_text, new_blocks,
                                     merge_fn=lambda ob, nb: merge_caller(ob, nb),
                                     threshold=threshold, new_source=source_doc)
        new_text = apply_wikify(new_text, entry, source_doc, registry)
        return _finish(entry, new_text, old_class_id, registry, dry_run, ops,
                       "b1-增量写旧页", expected_blocks=new_blocks)

    tmp_record = {"entry": entry, "class_id": final_class, "blocks": new_blocks,
                  "source_doc": source_doc, "form": "multi"}
    tmp_page = build_page(tmp_record)
    fm, body = split_frontmatter(tmp_page)
    # b2 换模板会新建 frontmatter：先把旧页的全部来源并入，避免 A→B
    # 的分类迁移覆盖掉 A；随后 incremental 仍幂等合并本次 source_doc。
    # parse_frontmatter 已解析真实 YAML，避免 split_frontmatter 的 --- 包裹细节干扰。
    old_meta, _ = parse_frontmatter(old_text)
    new_fm_raw = fm.removeprefix("---\n").removesuffix("\n---\n")
    old_sources = old_meta.get("sources") or []
    if isinstance(old_sources, str):
        old_sources = [old_sources]
    for old_source in old_sources:
        source_name = str(old_source).strip()
        if source_name.startswith("[[") and source_name.endswith("]]" ):
            source_name = source_name[2:-2].strip()
        new_fm_raw = _merge_sources(new_fm_raw, source_name)
    fm = f"---\n{new_fm_raw}\n---\n"
    tmp_filled = fill_blocks(body, new_blocks)
    boards = template_boards(final_class, ("基本信息", "影响"))
    existing = [block for block in new_blocks if block["板块"] not in ("基本信息", "影响")]
    old_pending = [block for block in old_blocks if block["板块"] not in ("基本信息", "影响")]
    old_placed = []
    if old_pending:
        place_res, place_err = placement_caller(entry, boards, existing, old_pending)
        if place_err:
            return {"status": "fail", "entry": entry, "step": "placement(b2)", "error": place_err}
        try:
            old_placed = _apply_placement(old_blocks, old_pending, place_res, boards)
        except ValueError as exc:
            return {"status": "fail", "entry": entry, "step": "placement(b2)",
                    "error": f"落位校验失败: {exc}"}
    # fm 已是完整的 --- 包裹 frontmatter，不能再二次包裹。
    tmp_text = fm + f"# {entry}\n\n" + tmp_filled
    merged_text, ops2 = incremental(tmp_text, old_placed,
                                    merge_fn=lambda ob, nb: merge_caller(ob, nb),
                                    threshold=threshold, new_source=source_doc)
    merged_text = apply_wikify(merged_text, entry, source_doc, registry)
    return _finish(entry, merged_text, final_class, registry, dry_run, ops2,
                   "b2-临时页覆盖", expected_blocks=new_blocks + old_placed)


# ---------- 三分支引擎 ----------

def run_record(record, registry, dry_run, binary_caller, placement_caller, merge_caller,
               threshold=0.60):
    """处理单个 record：查重 → 创建 / 增量 / 迁移分支，并就地记录变更与错误日志。"""
    entry = record["entry"]
    registry.scan()  # 刷新快照（create_page 落盘后旧快照会过期）
    if not registry.exists(entry):
        res = create_page(record, registry, dry_run)
        if not dry_run:
            if res.get("status") == "ok":
                emit_operation("create", entry, res.get("class_id", record["class_id"]),
                               len(Path(res["path"]).read_text(encoding="utf-8")))
            elif res.get("status") == "fail":
                emit_error("E06", "S5写入", entry, res.get("error", ""), BASE)
        return res

    old_type = registry.old_type(entry)
    page = registry.get(entry)
    old_text = page["path"].read_text(encoding="utf-8")
    if old_type == record["class_id"]:
        new_text, ops = incremental(old_text, record["blocks"],
                                    merge_fn=lambda ob, nb: merge_caller(ob, nb),
                                    threshold=threshold,
                                    new_source=record.get("source_doc", ""))
        new_text = apply_wikify(new_text, entry, record.get("source_doc", ""), registry)
        if dry_run:
            return {"status": "ok", "entry": entry, "branch": "incremental",
                    "dry_run": True, "page": new_text, "ops": ops}
        backup = page["path"].with_suffix(".bak")
        shutil.copy2(page["path"], backup)
        try:
            page["path"].write_text(new_text, encoding="utf-8")
        except Exception as exc:
            if backup.exists():
                shutil.copy2(backup, page["path"])
            res = {"status": "fail", "entry": entry, "branch": "incremental",
                   "step": "write", "error": str(exc), "rolled_back": True}
            emit_error("E06", "S5写入", entry, str(exc), BASE)
            return res
        backup.unlink(missing_ok=True)
        emit_operation("update", entry, record["class_id"], len(new_text))
        return {"status": "ok", "entry": entry, "branch": "incremental", "ops": ops}

    res = migrate_entry(entry, record["blocks"], record["class_id"],
                        record.get("source_doc", ""), registry, dry_run,
                        binary_caller, placement_caller, merge_caller, threshold)
    if not dry_run:
        if res.get("status") == "ok":
            current = registry.scan().get(entry)
            emit_operation("update", entry, record["class_id"],
                           len(current["path"].read_text(encoding="utf-8")))
            emit_change("页面分类变更", entry, f"分类迁移至 {record['class_id']}")
        elif res.get("status") == "fail":
            step, err = res.get("step", ""), res.get("error", "")
            if step in ("validate",) or ("placement" in step and "落位校验失败" in err):
                emit_error("E07", "S5写入", entry, err, BASE)
            elif step == "write":
                emit_error("E06", "S5写入", entry, err, BASE)
            elif "LLM 调用异常" not in err and "解析" not in err:
                emit_error("E06", "S5写入", entry, err or "迁移失败", BASE)
    return res


def create_page(record, registry, dry_run=False):
    """创建分支：查重②（条目 vs 源文档同名）+ 建页 + 填块 + 落盘。

    条目页文件名与 raw/ 源文档同名时加（wiki）后缀避让（物理名变、逻辑名 title 不变）；
    加（wiki）后仍与源文档同名（异常数据）→ E09 报错，指向源文档侧人工裁决。
    对照集 = raw/ 物理源文档名 ∪ index.md 条目页名 ∪ sources_index.md 历史源文档名
    （后两者即 s0_unique.load_existing，与 S0 同一语义；覆盖历史残留名——
    物理已删但索引仍在的名字，防止条目页与历史登记名撞）。
    """
    entry = record["entry"]
    if registry.exists(entry):
        return {"status": "exists", "entry": entry,
                "message": "条目已存在，走增量/迁移分支，不创建"}
    page = build_page(record)
    fm, body = split_frontmatter(page)
    filled = fill_blocks(body, record["blocks"])
    page_final = fm + f"# {entry}\n\n" + filled
    page_final = apply_wikify(page_final, entry, record.get("source_doc", ""), registry)
    if dry_run:
        return {"status": "ok", "entry": entry, "dry_run": True, "page": page_final,
                "class_id": record["class_id"], "blocks": len(record["blocks"])}
    entities = registry.entities_dir
    entities.mkdir(parents=True, exist_ok=True)
    # 查重②：条目页文件名 vs 源文档文件名（rename 配置驱动：后缀避让 + 撞车策略）
    rename = config(BASE).get("rename", {})
    suffix = rename.get("wikipedia_suffix", "（wiki）")
    collision = rename.get("collision_action", "error")
    from s0_unique import load_existing  # noqa: E402
    source_files = {Path(doc).name for doc in docs(BASE)} | load_existing(BASE)
    fname = entry_filename(entry)
    if fname in source_files:
        fname = entry_filename(f"{entry}{suffix}")
    if fname in source_files:
        if collision != "error":
            print(f"[S5] rename.collision_action={collision} 非 error，按冲突拒绝处理")
        emit_error("E09", "S5写入", {"type": "条目", "entry": entry},
                   f"条目名与源文档同名且加{suffix}避让后仍冲突（{fname}），指向源文档侧裁决", BASE)
        return {"status": "fail", "entry": entry, "step": "name-collision",
                "class_id": record["class_id"], "blocks": len(record["blocks"]),
                "error": f"条目名与源文档同名且{suffix}避让后仍冲突，需人工裁决（指向源文档侧）"}
    fpath = entities / fname
    try:
        fpath.write_text(page_final, encoding="utf-8")
    except Exception as exc:
        if fpath.exists():
            try:
                fpath.unlink()  # 异常残留会造成下次查重误判"已存在"
            except Exception:
                pass
        return {"status": "fail", "entry": entry, "step": "write",
                "class_id": record["class_id"], "blocks": len(record["blocks"]),
                "error": f"创建写盘失败: {exc}", "cleaned": True}
    return {"status": "ok", "entry": entry, "path": str(fpath),
            "class_id": record["class_id"], "blocks": len(record["blocks"])}


# ---------- 块向量收尾 ----------

def block_id(entry, board, title):
    raw = f"{entry}|{board}|{title}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class VectorStore:
    """块级向量存储（vault/.vectors.json）：内容变化 → 重建；相同 → 复用；孤儿 → 清理。"""

    def __init__(self, vault_root):
        self.vault_root = Path(vault_root).resolve()
        self.path = self.vault_root / ".vectors.json"
        self.data = {}
        self.load()

    def load(self):
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                self.data = {}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")

    def upsert_block(self, entry, block, embed_fn):
        bid = block_id(entry, block.get("板块", ""), block.get("小标题", ""))
        payload = f"{block.get('小标题', '')}\n{block.get('正文', '')}"
        digest = text_hash(payload)
        old = self.data.get(bid)
        if old and old.get("hash") == digest:
            return {"id": bid, "action": "reuse", "reason": "内容未变"}
        vector = embed_fn(payload)
        self.data[bid] = {"hash": digest, "embedding": vector,
                          "entry": entry, "title": block.get("小标题", ""),
                          "board": block.get("板块", ""),
                          "updated": time.strftime("%Y-%m-%dT%H:%M:%S")}
        return {"id": bid, "action": "rebuild", "reason": "内容变化或新增", "dim": len(vector)}

    def sweep(self, entry, keep_ids):
        removed = []
        for bid in list(self.data.keys()):
            if self.data[bid].get("entry") == entry and bid not in keep_ids:
                del self.data[bid]
                removed.append(bid)
        return removed


def make_embedder():
    """embed_fn(text) → list[float]；服务参数全部来自资产 config.yaml embedding 段。"""
    import requests
    cfg = config(BASE).get("embedding", {})
    if not cfg:
        raise KeyError("config.yaml 缺 embedding 段")
    url = f"{cfg['base_url'].rstrip('/')}/embeddings"
    headers = {"Authorization": f"Bearer {cfg.get('api_key', '')}", "Content-Type": "application/json"}
    proxies = {"http": None, "https": None} if cfg.get("no_proxy") else None
    retries = int(cfg.get("max_retries", 3))
    backoff_base = float(cfg.get("retry_backoff_base", 2))
    backoff_max = float(cfg.get("retry_backoff_max", 30))

    def embed_fn(text):
        kwargs = {"headers": headers,
                  "json": {"model": cfg["name"], "input": text, "dimensions": cfg["dimensions"]},
                  "timeout": cfg.get("timeout", 120)}
        if proxies is not None:
            kwargs["proxies"] = proxies
        last_error = None
        for attempt in range(retries + 1):
            try:
                response = requests.post(url, **kwargs)
                response.raise_for_status()
                return response.json()["data"][0]["embedding"]
            except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
                last_error = exc
                if attempt == retries:
                    raise RuntimeError(f"embedding 失败，已重试 {retries} 次: {exc}") from exc
                time.sleep(min((2 ** attempt) * backoff_base, backoff_max))
        raise RuntimeError(f"embedding 失败: {last_error}")

    return embed_fn


def vector_finish(result, record, registry, store, embed):
    """页面成功落盘后从最终页读回块做向量收尾：
    复用（内容未变）/ 重建（内容变）/ sweep（页面不再有）。失败仅记录，不影响页面结果。"""
    page = registry.scan().get(record["entry"])
    if not page:
        return result
    keep_ids = []
    try:
        for block in page["blocks"]:
            res = store.upsert_block(record["entry"], block, embed)
            if res["id"]:
                keep_ids.append(res["id"])
        removed = store.sweep(record["entry"], keep_ids)
        if removed:
            result["vector_swept"] = len(removed)
        store.save()
    except Exception as exc:
        emit_error("E08", "S5向量", {"type": "内容块", "entry": record["entry"],
                                     "block": "批量向量收尾"}, str(exc), BASE)
        result["vector_error"] = str(exc)
    return result


# ---------- 批次处理 ----------

def load_records(input_path):
    """从 S4 产物文件（record 或 record 数组）或目录（每文件一条 record）读取。"""
    path = Path(input_path).expanduser().resolve()
    if path.is_dir():
        records = []
        for file in sorted(path.glob("*.json")):
            data = json.loads(file.read_text(encoding="utf-8"))
            records.extend(data if isinstance(data, list) else [data])
        return records
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else [data]


def process_batch(records, registry, dry_run, binary_caller, placement_caller,
                  merge_caller, embed, threshold=0.60):
    """逐条处理：空块跳过（E04）、三分支写入、向量收尾。返回 (results, alerts, aborted)。"""
    results, alerts, aborted = [], [], None
    store = None if dry_run else VectorStore(BASE)
    for item in records:
        entry = str(item.get("entry") or "").strip()
        if not entry:
            continue
        raw_blocks = item.get("blocks")
        if raw_blocks is None and "output" in item:
            raw_blocks = item["output"]
        blocks, note = parse_s4a_blocks(raw_blocks if raw_blocks is not None else [])
        if not blocks:
            detail = f"条目无有效内容块（{note or '空产物'}），不建页/不写入"
            alerts.append((time.strftime("%Y-%m-%d %H:%M:%S"), entry, "空块", detail))
            emit_error("E04", "S5写入", entry, detail, BASE)
            results.append({"entry": entry, "status": "skip-empty", "note": note})
            continue
        record = make_record(entry, item.get("class_id", 11), blocks,
                             item.get("source_doc", ""), item.get("form", "multi"), note)
        try:
            result = run_record(record, registry, dry_run,
                                binary_caller, placement_caller, merge_caller, threshold)
        except BatchAbort as exc:
            aborted = exc
            break
        if result.get("status") in ("fail", "exists") and result.get("error"):
            alerts.append((time.strftime("%Y-%m-%d %H:%M:%S"), entry,
                           result["status"], str(result.get("error", result.get("message", "")))))
        if not dry_run and result.get("status") == "ok":
            result = vector_finish(result, record, registry, store, embed)
        results.append(result)
    if aborted:
        emit_error("E02", f"S5写入（{aborted.stage}）", {"type": "批次", "entry": "批次中止"},
                   aborted.reason, BASE)
        alerts.append((time.strftime("%Y-%m-%d %H:%M:%S"), "批次", "abort", aborted.reason))
    else:
        # 源文档收尾（2026-10-23）：全源条目定稿后写 raw related + 全库双链重写。
        # 仅非中止批次执行：中止=条目集未定，related 会不完整。幂等。
        for source_doc in sorted({str(item.get("source_doc", "")).strip()
                                  for item in records if item.get("source_doc")}):
            if not source_doc:
                continue
            fin = finalize_source_doc(source_doc, registry, dry_run)
            if fin["raw"] == "missing":
                alerts.append((time.strftime("%Y-%m-%d %H:%M:%S"), source_doc, "related",
                               "raw 源文档未找到（basename 匹配失败），related 未写"))
        rewrite_entity_wikilinks(registry, dry_run)
    return results, alerts, aborted


def main():
    parser = argparse.ArgumentParser(description="S5 页面写入（创建/增量/迁移 + 向量收尾）")
    parser.add_argument("--input", required=True, help="S4 产物 JSON 文件（record 或数组）或目录")
    parser.add_argument("--asset", default=".", help="资产根目录")
    parser.add_argument("--batch", default="", help="批次标签（默认取 LLMWIKI_BATCH 或生成）")
    parser.add_argument("--dry-run", action="store_true", help="不写盘、不生成向量")
    parser.add_argument("--out", default="", help="写入结果 JSON 文件；省略则写到标准输出")
    args = parser.parse_args()

    asset = Path(args.asset).expanduser().resolve()
    tmp_root = Path(os.environ.get("LLMWIKI_TMP_ROOT") or (asset / ".tmp"))
    batch = args.batch or os.environ.get("LLMWIKI_BATCH") or f"S5-{time.strftime('%Y%m%d-%H%M%S')}"
    set_batch(tmp_root, batch)

    threshold = float(config(asset).get("s5", {}).get("merge_overlap_threshold", 0.60))

    records = load_records(args.input)
    registry = Registry(asset).scan()

    def binary(entry, old_blocks, new_blocks, desc_a, desc_b):
        return call_binary(entry, old_blocks, new_blocks, desc_a, desc_b)

    def placement(entry, boards, existing, pending):
        return call_placement(entry, boards, existing, pending)

    def merge(old_block, new_block):
        return call_merge(old_block, new_block)

    embed = None if args.dry_run else make_embedder()
    results, alerts, aborted = process_batch(
        records, registry, args.dry_run, binary, placement, merge, embed, threshold)

    failures = [result for result in results if result.get("status") == "fail"]
    output = json.dumps(results, ensure_ascii=False, indent=2)
    if args.out:
        destination = Path(args.out).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(output, encoding="utf-8")
        print(destination)
    else:
        print(output)

    run_dir = tmp_root / "flow_s5" / batch
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps({
        "batch": batch, "input": str(Path(args.input).expanduser().resolve()),
        "start": time.strftime("%Y-%m-%d %H:%M:%S"), "dry_run": args.dry_run,
        "n_records": len(results), "failures": len(failures),
        "aborted": aborted.reason if aborted else None,
        "COMPLETE": (not failures) and aborted is None,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    if alerts:
        (run_dir / "alerts.md").write_text(
            "# 告警记录\n\n" + "\n".join(f"- {at} {entry} | {kind} | {detail}"
                                        for at, entry, kind, detail in alerts) + "\n",
            encoding="utf-8")
    # 批次 summary.json：S6 日志写入器（状态/导入简要）的数据源
    summary_dir = tmp_root / "log" / batch
    summary_dir.mkdir(parents=True, exist_ok=True)
    (summary_dir / "summary.json").write_text(json.dumps({
        "batch": batch, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "import_type": "手动导入",
        "ok_count": sum(1 for result in results if result.get("status") == "ok"),
        "fail_count": sum(1 for result in results if result.get("status") in ("fail", "skip-empty"))
        + (1 if aborted else 0),
        "imported_documents": sorted({str(item.get("source_doc", "")).strip()
                                      for item in records if item.get("source_doc")}),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[S5 output] {run_dir}")


if __name__ == "__main__":
    main()
