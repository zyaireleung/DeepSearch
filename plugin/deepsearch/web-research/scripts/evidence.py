"""Evidence dedupe: canonical URL OR content hash (audit B3)."""
import hashlib
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode


def _canonical(url):
    s = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(s.query) if not k.lower().startswith("utm_")]
    return urlunsplit((s.scheme, s.netloc, s.path.rstrip("/"), urlencode(q), ""))


def _content_hash(text):
    return hashlib.sha256((text or "").strip().encode()).hexdigest()


def dedupe(results):
    seen_url, seen_hash = set(), set()
    out = []
    for r in results:
        cu = _canonical(r["url"])
        ch = _content_hash(r.get("content", ""))
        if cu in seen_url or ch in seen_hash:
            continue
        seen_url.add(cu)
        seen_hash.add(ch)
        out.append(r)
    return out


def attach_claim(evidence, claim_id, urls):
    urls = set(urls)
    for e in evidence:
        e.setdefault("claims", [])
        if e["url"] in urls and claim_id not in e["claims"]:
            e["claims"].append(claim_id)
    return evidence
