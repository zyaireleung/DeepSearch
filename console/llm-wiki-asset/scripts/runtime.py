"""LLM WiKi 运行时基础设施：配置读取、LLM 调用、批次诊断。

这是七个正式阶段共用的产品运行模块，不提供独立命令行入口。
"""
import json
import os
import re
import time
from pathlib import Path

import requests
import yaml

ASSET = Path(__file__).resolve().parent.parent
_CACHE = {}
_BATCH_DIR = None
_CONSECUTIVE_FAILURES = {}


class BatchAbort(Exception):
    """服务故障已确认（连续失败达阈值且联通探测失败），批次应中止。"""

    def __init__(self, stage, reason):
        super().__init__(f"[BatchAbort] {stage}: {reason}")
        self.stage = stage
        self.reason = reason


def config(asset=None):
    root = Path(asset).resolve() if asset else ASSET
    path = root / "config.yaml"
    if path not in _CACHE:
        _CACHE[path] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return _CACHE[path]


def stage_model(stage, asset=None):
    data = config(asset)
    stage_config = data.get("stages", {}).get(stage)
    if not stage_config:
        raise KeyError(f"config.yaml stages 缺少 {stage}")
    template = data.get("model_templates", {}).get(stage_config.get("model"))
    if not template:
        raise KeyError(f"config.yaml model_templates 缺少 {stage_config.get('model')}")
    return dict(template)


def stage_option(stage, name, default=None, asset=None):
    return config(asset).get("stages", {}).get(stage, {}).get(name, default)


def defaults(asset=None):
    return config(asset).get("defaults", {})


def docs(asset=None):
    """扫描资产 raw/ 递归列出源文档相对路径（排除隐藏文件），按路径排序。

    文档清单由资产目录自身承载：raw/ 里有什么，本资产就解析什么，
    不在任何配置文件中维护第二份清单。
    """
    root = Path(asset).resolve() if asset else ASSET
    raw = root / "raw"
    if not raw.exists():
        return []
    return sorted(str(path.relative_to(raw)) for path in raw.rglob("*")
                  if path.is_file() and not path.name.startswith("."))


def resolve_docs(asset=None, requested=()):
    """把 CLI 文档选择解析为 raw/ 相对路径列表；空选择 = 全部文档。

    每项可按 raw/ 相对路径精确匹配，或按文件名唯一匹配。
    找不到 / 不唯一 → 抛 ValueError（调用方转报错，不静默）。
    """
    available = docs(asset)
    if not requested:
        return available
    resolved = []
    for name in requested:
        if name in available:
            resolved.append(name)
            continue
        matches = [path for path in available if Path(path).name == name]
        if len(matches) == 1:
            resolved.append(matches[0])
        elif len(matches) > 1:
            raise ValueError(f"文件名 {name} 在 raw/ 下不唯一（{len(matches)} 个）：{matches}")
        else:
            raise ValueError(f"raw/ 下没有文档 {name}；可用：{available[:8]}")
    return resolved


def doc_key(doc):
    """raw/ 相对路径 → 平铺产物文件名标识（/ 换为 ~），供各阶段中间产物命名。"""
    return str(doc).replace("/", "~")


def parse_frontmatter(text):
    """解析条目页 frontmatter（--- 包裹的 YAML 头），返回 dict + 正文。

    tags/sources 统一为列表：空值行初始化空列表，": 值"行与"  - 项"行都追加。
    """
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        return {}, text
    frontmatter, current = {}, None
    for line in match.group(1).splitlines():
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("  - ") and current in {"tags", "sources"}:
            frontmatter.setdefault(current, []).append(line[4:].strip().strip('"\''))
        elif ":" in line:
            key, value = line.split(":", 1)
            current = key.strip()
            value = value.strip().strip('"\'')
            if current in {"tags", "sources"}:
                frontmatter.setdefault(current, [])
                if value:
                    frontmatter[current].append(value)
            else:
                frontmatter[current] = value
    return frontmatter, text[match.end():]


def class_names(asset=None):
    """分类模板 → 英文分类名映射：{序号: type}。"""
    root = Path(asset).resolve() if asset else ASSET
    names = {}
    templates = root / "schema" / "templates"
    if not templates.exists():
        return names
    for path in sorted(templates.glob("*.md")):
        if not path.stem.isdigit():
            continue
        match = re.search(r'^type:\s*"?([^"\n]+)"?', path.read_text(encoding="utf-8"), re.M)
        if match:
            names[path.stem] = match.group(1).strip()
    return names


def template_boards(class_id, exclude=(), asset=None):
    """模板板块清单：板块名 + 引导问句，返回 "- 名：问句" 文本。

    exclude 为排除的板块名（如 S5 落位排除头尾板块）；exclude 为空 = 全部板块。
    """
    root = Path(asset).resolve() if asset else ASSET
    path = root / "schema" / "templates" / f"{class_id:02d}.md"
    if not path.exists():
        return ""
    boards, current = [], None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            current = line[3:].strip()
            boards.append([current, []])
        elif current is not None and line.strip() and not line.strip().startswith("#####"):
            boards[-1][1].append(line.strip())
    out = []
    for name, questions in boards:
        if name in exclude:
            continue
        question = " ".join(questions)[:160]
        out.append(f"- {name}：{question}" if question else f"- {name}")
    return "\n".join(out)


def set_batch(tmp_root, batch):
    global _BATCH_DIR
    _BATCH_DIR = Path(tmp_root) / "log" / batch
    _BATCH_DIR.mkdir(parents=True, exist_ok=True)


def _append(filename, row):
    if _BATCH_DIR is None:
        return
    with (_BATCH_DIR / filename).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def error_codes(asset=None):
    root = Path(asset).resolve() if asset else ASSET
    result, in_skeleton = {}, False
    path = root / "schema" / "error-codes.md"
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        if "detail / impact 骨架" in line:
            in_skeleton = True
        if not line.startswith("|") or "E0" not in line:
            continue
        parts = [value.strip() for value in line.strip("|").split("|")]
        if not parts or not parts[0].startswith("E0"):
            continue
        entry = result.setdefault(parts[0], {})
        if in_skeleton and len(parts) >= 3:
            entry.update(detail=parts[1], impact=parts[2])
        elif len(parts) >= 5:
            entry["level"] = parts[4]
    return result


def emit_response(stage, doc, entry, raw, result, note=""):
    _append("llm_responses.jsonl", {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "stage": stage,
                                     "doc": doc, "entry": entry, "raw": raw,
                                     "parse_result": result, "parse_note": note})


def emit_error(code, stage, target, cause, asset=None):
    definitions = error_codes(asset)
    template = definitions.get(code, {})
    description = str(target.get("entry") if isinstance(target, dict) else target)
    extra = cause or "见 cause"

    def fill(text, name):
        return (text.replace("{源文档名}", name).replace("{条目名}", name)
                    .replace("{条目页名}", name).replace("{逻辑名}", name)
                    .replace("{文档}", name).replace("{条目页}", name)
                    .replace("{小标题}", "").replace("{校验项}", extra)
                    .replace("{target}", name))

    detail = fill(template.get("detail", "{target} 出错"), description)
    detail = detail.replace("{环节}", stage).replace("{原因}", extra)
    impact = fill(template.get("impact", "见 log"), description)
    _append("errors.jsonl", {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "code": code,
                               "level": template.get("level", "error"), "stage": stage, "target": target,
                               "anchor": detail, "cause": cause, "impact": impact})


def emit_operation(operation, entry, class_id, size):
    _append("operations.jsonl", {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "operation": operation,
                                  "entry": entry, "class_id": int(class_id), "page_size": int(size)})


def emit_change(category, desc, impact=""):
    _append("changes.jsonl", {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                              "category": category, "desc": desc, "impact": impact})


def extract_json(text):
    text = str(text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.S)
    if fenced:
        text = fenced.group(1)
    for opener, closer in (("[", "]"), ("{", "}")):
        start = text.find(opener)
        if start < 0:
            continue
        depth = 0
        for index in range(start, len(text)):
            if text[index] == opener:
                depth += 1
            elif text[index] == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:index + 1])
                    except json.JSONDecodeError:
                        break
    return None


def extract_list(text):
    value = extract_json(text)
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return next((item for item in value.values() if isinstance(item, list)), None)
    return None


def llm_policy(asset=None):
    data = config(asset).get("llm", {})
    return {
        "max_retries": data.get("max_retries", 3),
        "retry_backoff_base": data.get("retry_backoff_base", 2),
        "retry_backoff_max": data.get("retry_backoff_max", 30),
        "abort_on_consecutive_failures": data.get("abort_on_consecutive_failures", 3),
        "probe_timeout": data.get("probe_timeout", 10),
    }


def probe(asset=None, timeout=None):
    """最小请求探测 LLM 服务联通性：能回即视为服务正常。"""
    root = Path(asset).resolve() if asset else ASSET
    policy = llm_policy(root)
    first = next(iter(config(root).get("stages", {})), None)
    if not first:
        return False
    model = stage_model(first, root)
    kwargs = {"headers": {"Content-Type": "application/json",
                          "Authorization": f"Bearer {model.get('api_key', '')}"},
              "json": {"model": model["name"], "messages": [{"role": "user", "content": "ping"}],
                       "max_tokens": 1},
              "timeout": timeout if timeout is not None else policy["probe_timeout"]}
    if model.get("no_proxy"):
        kwargs["proxies"] = {"http": None, "https": None}
    try:
        return requests.post(f"{model['base_url'].rstrip('/')}/chat/completions", **kwargs).status_code < 500
    except requests.RequestException:
        return False


def guard_failure(stage, asset=None):
    """批次级故障守护：连续失败计数 + 阈值联通探测。

    未达阈值 → 返回 False（调用方继续逐条记录）；
    达阈值且探测成功 → 重置计数，返回 True（暂态问题，继续）；
    达阈值且探测失败 → 抛 BatchAbort（服务故障，中止批次）。
    """
    policy = llm_policy(asset)
    threshold = int(policy["abort_on_consecutive_failures"])
    _CONSECUTIVE_FAILURES[stage] = _CONSECUTIVE_FAILURES.get(stage, 0) + 1
    if _CONSECUTIVE_FAILURES[stage] < threshold:
        return False
    count = _CONSECUTIVE_FAILURES[stage]
    alive = probe(asset)
    _CONSECUTIVE_FAILURES[stage] = 0
    if not alive:
        raise BatchAbort(stage, f"连续失败 {count} 次且联通探测失败，判定服务故障")
    return True


def call_stage(stage, prompt, asset=None, context=None):
    root = Path(asset).resolve() if asset else ASSET
    model = stage_model(stage, root)
    policy = config(root).get("llm", {})
    retries = int(policy.get("max_retries", 3))
    last_error = None
    for attempt in range(retries + 1):
        try:
            kwargs = {"headers": {"Content-Type": "application/json", "Authorization": f"Bearer {model.get('api_key', '')}"},
                      "json": {"model": model["name"], "messages": [{"role": "user", "content": prompt}],
                               "temperature": model.get("temperature", 0.1), "max_tokens": model.get("max_tokens", 4096)},
                      "timeout": model.get("timeout", 120)}
            if model.get("enable_thinking") is not None:
                kwargs["json"]["enable_thinking"] = model["enable_thinking"]
            if model.get("no_proxy"):
                kwargs["proxies"] = {"http": None, "https": None}
            response = requests.post(f"{model['base_url'].rstrip('/')}/chat/completions", **kwargs)
            response.raise_for_status()
            _CONSECUTIVE_FAILURES[stage] = 0
            return response.json()["choices"][0]["message"]["content"]
        except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(min((2 ** attempt) * float(policy.get("retry_backoff_base", 2)), float(policy.get("retry_backoff_max", 30))))
    guard_failure(stage, root)  # 达阈值且探测失败 → 抛 BatchAbort
    emit_error("E05" if stage.startswith(("s4", "s5")) else "E02", f"S{stage[1:]}",
               {"type": "LLM调用", "stage": stage, **(context or {})}, f"LLM 调用失败: {last_error}", root)
    return None
