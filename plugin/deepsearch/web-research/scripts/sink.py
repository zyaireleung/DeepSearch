"""Crawler Result .tmp 落盘。

布局：`<workspace>/Crawler Result/.tmp/<YYMM>/<日>/<HHMM><检索ID>/{meta.md,result.md,raw/}`。

渲染即占位替换（纯标准库）：模板 `<...>` 占位换成值，重复行表格用
`<!--row:start-->...<!--row:end-->` 行标记循环展开。类别不匹配的节整节删除。
"""
import os
import re
import secrets
import shutil
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(os.path.dirname(HERE))  # web-research/scripts -> plugin root
TPL_DIR = os.path.join(PLUGIN_ROOT, "templates", "crawler")

ROW_START = "<!--row:%s:start-->"
ROW_END = "<!--row:%s:end-->"

SOCIAL_FIELDS = ["title", "likes", "comments", "collects", "shares", "publish_time", "url"]
SOCIAL_SRC_FIELDS = ["user_nickname", "user_id", "works_count", "fans_count", "homepage", "note"]
GENERAL_FIELDS = ["page_title", "points", "url"]
GENERAL_SRC_FIELDS = ["url", "publish_time", "author", "site"]


def _workspace():
    return os.environ.get("DEEPSEARCH_CRAWL_WORKSPACE") or os.getcwd()


def _template_path(name):
    return os.path.join(TPL_DIR, name)


def new_retrieval_id():
    return "r" + time.strftime("%y%m%d%H%M") + secrets.token_hex(2)


def tmp_rel(rid):
    """检索ID → .tmp 相对路径（供调用方在抓取前就建好 raw 目录）。"""
    now = time.localtime()
    return os.path.join("Crawler Result", ".tmp",
                        time.strftime("%y%m", now), time.strftime("%d", now),
                        time.strftime("%H%M", now) + rid)


def allocate(rid=None):
    """预分配一个 crawl 落盘目录，返回 {rid, rel, save_root}。save_root 即 MediaCrawler
    --save_data_path 的目标：抓取直接写进 raw/，工作区外零落盘。"""
    rid = rid or new_retrieval_id()
    rel = tmp_rel(rid)
    save_root = os.path.join(_workspace(), rel, "raw")
    os.makedirs(save_root, exist_ok=True)
    return {"rid": rid, "rel": rel, "save_root": save_root}


def _na(v):
    """缺失值纪律：None→null；空串/缺键→N/A；其余原值。"""
    if v is None:
        return "null"
    if isinstance(v, str) and v.strip() == "":
        return "N/A"
    return str(v)


def _fill(tpl_text, mapping):
    out = tpl_text
    for k, v in mapping.items():
        out = out.replace("<%s>" % k, _na(v))
    return out


def _render_rows(tpl_text, rows, row_fields, name):
    """把 <!--row:<name>:start-->...<!--row:<name>:end--> 段按 rows 循环展开；无行则整段清空。"""
    start = ROW_START % name
    end = ROW_END % name
    i = tpl_text.find(start)
    j = tpl_text.find(end)
    if i < 0 or j < 0:
        return tpl_text
    block = tpl_text[i + len(start):j]
    rendered = "".join(_fill(block, {f: r.get(f) for f in row_fields}) for r in rows) if rows else ""
    return tpl_text[:i] + rendered + tpl_text[j + len(end):]


def _strip_sections(tpl_text, header_substr):
    """删掉所有标题含 header_substr 的整节（该 ## 标题到下一个 ## 或 EOF）。"""
    lines = tpl_text.split("\n")
    out = []
    skip = False
    for ln in lines:
        if ln.startswith("## "):
            skip = header_substr in ln
        if not skip:
            out.append(ln)
    return "\n".join(out)


def _render_meta(meta):
    return _fill(open(_template_path("tmp-meta.md"), encoding="utf-8").read(), meta)


def _render_result(category, data_social, data_general):
    tpl = open(_template_path("tmp-result.md"), encoding="utf-8").read()
    if category == "社媒类":
        tpl = _render_rows(tpl, data_social or [], SOCIAL_FIELDS, "social")
        tpl = _render_rows(tpl, data_social or [], SOCIAL_SRC_FIELDS, "social_src")
        tpl = _strip_sections(tpl, "其他")  # 删 Wigolo 两节
    else:
        tpl = _render_rows(tpl, data_general or [], GENERAL_FIELDS, "general")
        tpl = _render_rows(tpl, data_general or [], GENERAL_SRC_FIELDS, "general_src")
        tpl = _strip_sections(tpl, "社媒")  # 删 MediaCrawler 两节
    return tpl


def write_tmp(category, meta, data_social=None, data_general=None, raw_files=None,
              rid=None, raw_dir=None):
    """rid/raw_dir 传入时=已 allocate 的目录（raw/ 内文件由 MediaCrawler 直接写入，
    无需再拷贝）；缺省时=自建目录并从 raw_files 拷贝（web step 等外部文件场景）。

    raw_dir 模式下 tmp_dir 从 raw_dir 推导（raw_dir=<...>/<HHMM><rid>/raw），不用 tmp_rel(rid)
    重算时间——跨分钟时重算会得到不同的 <HHMM> 前缀，指向 allocate 没建的目录。"""
    if raw_dir:
        rid = rid or new_retrieval_id()
        tmp_dir = os.path.dirname(raw_dir)
        rel = os.path.relpath(tmp_dir, _workspace())
        raw = raw_dir
        os.makedirs(raw, exist_ok=True)  # crawl count=0 时 MediaCrawler 可能没建子目录，兜底建 raw/ 根
        n_raw = len(raw_files or [])
    else:
        rid = rid or new_retrieval_id()
        rel = tmp_rel(rid)
        tmp_dir = os.path.join(_workspace(), rel)
        raw = os.path.join(tmp_dir, "raw")
        os.makedirs(raw, exist_ok=True)
        for src in (raw_files or []):
            if os.path.isfile(src):
                shutil.copy(src, raw)
        n_raw = len([f for f in (raw_files or []) if os.path.isfile(f)])
    meta_full = {**meta, "检索ID": rid, "类别": category,
                 "检索时间": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                 "tmp_dir_rel": rel, "raw_count": n_raw}
    meta_path = os.path.join(tmp_dir, "meta.md")
    result_path = os.path.join(tmp_dir, "result.md")
    open(meta_path, "w", encoding="utf-8").write(_render_meta(meta_full))
    open(result_path, "w", encoding="utf-8").write(_render_result(category, data_social, data_general))
    return {"tmp_dir": tmp_dir, "meta_path": meta_path, "result_path": result_path,
            "retrieval_id": rid}


def map_media_record(rec):
    """MediaCrawler jsonl → result.md 行 dict。跨平台字段名兼容；字符串 "None"→None。"""
    def g(*keys):
        for k in keys:
            v = rec.get(k)
            if v not in (None, "", "None"):
                return v
        return None

    return {"title": g("title", "desc", "content"),
            "likes": g("voteup_count", "liked_count", "digg_count", "like_count"),
            "comments": g("comment_count", "comments_count"),
            "collects": g("collect_count", "collected_count"),
            "shares": g("share_count"),
            "publish_time": g("publish_time", "create_time", "time"),
            "url": g("content_url", "url", "video_url", "note_url")}


def _site_from_url(url):
    """从 URL 提取站点主机名（如 postgresql.org / news.ycombinator.com）。"""
    if not url:
        return None
    m = re.match(r"^https?://([^/]+)", str(url))
    return m.group(1) if m else None


def map_wigolo_record(rec):
    """Wigolo 结果 → result.md 行 dict（主表 + 来源表共用同一 url）。"""
    url = rec.get("url") or rec.get("link")
    return {"page_title": rec.get("title"),
            "points": rec.get("content") or rec.get("snippet"),
            "url": url,
            "publish_time": rec.get("published_date") or rec.get("date"),
            "author": rec.get("author") or rec.get("user"),
            "site": _site_from_url(url)}