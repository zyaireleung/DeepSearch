"""MediaCrawler 直调封装：绕过 gateway，单发抓取。返回新产 jsonl 的解析记录。

落盘约束：MediaCrawler 经 --save_data_path 直接写进调用方给定的工作区内目录
（Crawler Result/.tmp/<检索ID>/raw/<platform>/jsonl/），绝不在 ~/MediaCrawler/data
留任何数据。每条 crawl 一个独立 raw 目录，故无需 size 快照 diff，直接读全量 jsonl。
"""
import glob
import json
import os
import subprocess

MC_ROOT = os.environ.get("MEDIACRAWLER_ROOT", os.path.expanduser("~/MediaCrawler"))
MC_PY = os.path.join(MC_ROOT, ".venv", "bin", "python")
MC_MAIN = os.path.join(MC_ROOT, "main.py")

PLATFORMS = {"xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"}
TYPES = {"search", "detail", "creator"}
# CLI 平台名 → 内部落盘目录名（已核 mc-search.sh：ks→kuaishou；其余同名）
DATA_DIR_ALIAS = {"ks": "kuaishou"}
# 目录全名 → CLI 别名（Console /crawl-catalog 用全名 ID；工具同时接受两套，归一化到 CLI）
FULL_NAME_ALIAS = {
    "douyin": "dy", "bilibili": "bili", "weibo": "wb", "kuaishou": "ks",
}


def normalize_platform(platform):
    """接受目录全名（douyin/bilibili/weibo/kuaishou）与 CLI 别名（dy/bili/wb/ks），归一化到 CLI 名。"""
    return FULL_NAME_ALIAS.get(platform, platform)


def save_root_dir(save_root, platform):
    """MediaCrawler 在 --save_data_path 下按 <platform>/jsonl 落盘（ks→kuaishou）。"""
    p = normalize_platform(platform)
    return os.path.join(save_root, DATA_DIR_ALIAS.get(p, p), "jsonl")


def build_mc_args(platform, type, creator_id=None, specified_id=None, keywords=None):
    platform = normalize_platform(platform)
    if platform not in PLATFORMS:
        raise ValueError("bad platform: %s" % platform)
    if type not in TYPES:
        raise ValueError("bad type: %s" % type)
    args = ["--platform", platform, "--lt", "cookie", "--type", type]
    if type == "search":
        if not keywords:
            raise ValueError("search needs keywords")
        args += ["--keywords", keywords]
    elif type == "detail":
        if not specified_id:
            raise ValueError("detail needs specified_id")
        args += ["--specified_id", specified_id]
    elif type == "creator":
        if not creator_id:
            raise ValueError("creator needs creator_id")
        args += ["--creator_id", creator_id]
    return args


def read_all_lines(files):
    """读全部 jsonl 行（目录为本次 crawl 独享，无历史行需排除）。"""
    recs = []
    for f in files:
        try:
            with open(f, "rb") as fh:
                for raw in fh:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line:
                        try:
                            recs.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
        except OSError:
            continue
    return recs


def run_crawl(platform, type, save_root, creator_id=None, specified_id=None, keywords=None, timeout=600):
    """save_root=工作区内目录（如 Crawler Result/.tmp/<rid>/raw），MediaCrawler 直接写这里。"""
    args = build_mc_args(platform, type, creator_id, specified_id, keywords)
    out_dir = save_root_dir(save_root, platform)
    os.makedirs(out_dir, exist_ok=True)  # ks/bili 源码不自动建，显式建
    args += ["--save_data_path", save_root]
    env = {**os.environ, "no_proxy": "localhost,127.0.0.1",
           "http_proxy": "", "https_proxy": ""}
    try:
        proc = subprocess.run([MC_PY, MC_MAIN] + args, cwd=MC_ROOT, env=env,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "crawl timeout after %ss" % timeout}
    except FileNotFoundError as e:
        return {"ok": False, "error": "MediaCrawler python not found: %s" % e}
    if proc.returncode != 0:
        return {"ok": False, "error": ((proc.stderr or "") + (proc.stdout or ""))[-2000:]}
    new = sorted(glob.glob(os.path.join(out_dir, "*.jsonl")))
    recs = read_all_lines(new)
    return {"ok": True, "platform": platform, "type": type, "output_dir": out_dir,
            "save_root": save_root, "new_files": new, "raw_records": recs,
            "count": len(recs)}