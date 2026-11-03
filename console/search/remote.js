/**
 * 远端检索（④：OV 1933 find + mem0 search，mem0 端口由 search-api mem0Cfg.baseUrl 决定：6610 新库/8915 旧 TDAI）
 * OV find：POST {ovBaseUrl}/api/v1/search/find，body {query,target_uri,limit,score_threshold}，header X-API-Key。
 * mem0：POST {mem0Url}/search，body {query,limit} → {ok:true,results} | {source}（503 激活中）| {error}（500）。
 */

async function postJson(url, body, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
}

/** OV 1933 find（修订 6：唯一 OV 通道；search 解析为 find） */
export async function ovFind(ovBaseUrl, apiKey, { query, targetUri, limit = 20, scoreThreshold = 0, timeoutMs = 8000 } = {}) {
  const { status, json } = await postJson(
    `${ovBaseUrl}/api/v1/search/find`,
    { query, target_uri: targetUri || undefined, limit, score_threshold: scoreThreshold },
    { "X-API-Key": apiKey },
    timeoutMs,
  );
  if (status !== 200 || !json) return { ok: false, status, error: json?.detail || `HTTP ${status}` };
  const mem = json.result?.memories || json.memories || [];
  return {
    ok: true,
    status,
    results: mem.map((m) => ({
      uri: m.uri,
      level: m.level,
      contextType: m.context_type,
      score: m.score,
      abstract: m.abstract || "",
      tags: m.tags || [],
    })),
  };
}

/** mem0 8915 search（POST /search {query,limit} → {ok,results}） */
export async function mem0Search(mem0Url, { query, limit = 20, timeoutMs = 4000 } = {}) {
  const { status, json } = await postJson(`${mem0Url}/search`, { query, limit }, {}, timeoutMs);
  if (status === 503 && json?.source) return { ok: false, status, source: json.source, results: [] }; // 激活中
  if (!json?.ok) return { ok: false, status, error: json?.error || `HTTP ${status}`, results: [] };
  // mem0 返回 {ok, items:[{content,score}]}；兼容 results/items 两形态（V6 修复）
  const results = (json.results || json.items || []).map((r) => ({
    id: r.id,
    score: typeof r.score === "number" ? r.score : Number(r.score ?? 0),
    text: r.text || r.content || r.memory || "",
  }));
  return { ok: true, status, results };
}
