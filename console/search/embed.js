/**
 * 8810 WeMM embedding（④，端点契约实测：POST {base_url}/embeddings）
 * payload {model,input,dimensions} → data[0].embedding float[dimensions]。
 */

/** 读取资产 config.yaml embedding 段（base_url/api_key/dimensions/name/timeout） */
export async function embedText(cfg, text) {
  const url = `${String(cfg.baseUrl || cfg.base_url).replace(/\/+$/, "")}/embeddings`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey || cfg.api_key || ""}`,
    },
    body: JSON.stringify({ model: cfg.model || cfg.name, input: text, dimensions: cfg.dimensions || 1024 }),
    signal: AbortSignal.timeout((cfg.timeout || 120) * 1000),
  });
  if (!r.ok) throw new Error(`[embed] HTTP ${r.status}`);
  const j = await r.json();
  const v = j?.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error("[embed] 响应缺 data[0].embedding");
  return v;
}

/** float 向量 → int8 量化（1024 字节；round(f*127)，clamp [-127,127]） */
export function quantizeInt8(vec) {
  const buf = Buffer.alloc(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let x = Math.round(Number(vec[i]) * 127);
    if (x > 127) x = 127;
    else if (x < -127) x = -127;
    buf[i] = x & 0xff;
  }
  return buf;
}

/** float32 LE BLOB（源 OV chunks.embedding 4096B=1024 浮点）→ int8 BLOB（1024B） */
export function float32ToInt8(buf) {
  const n = buf.length / 4;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, n);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let x = Math.round(Number(f32[i]) * 127);
    if (x > 127) x = 127;
    else if (x < -127) x = -127;
    out[i] = x & 0xff;
  }
  return out;
}

/** int8 BLOB → float 数组（b/127） */
export function dequantize(buf) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] > 127 ? buf[i] - 256 : buf[i]; // 补码
    out[i] = b / 127;
  }
  return out;
}

/** cosine(qFloat, vInt8Buf)：点积归一化（同 8810 空间，(cos+1)/2 由调用方换算） */
export function int8Cosine(qFloat, vBuf) {
  const n = vBuf.length;
  let dot = 0, qn = 0, vn = 0;
  for (let i = 0; i < n; i++) {
    const b = vBuf[i] > 127 ? vBuf[i] - 256 : vBuf[i];
    const v = b / 127;
    const q = qFloat[i];
    dot += q * v;
    qn += q * q;
    vn += v * v;
  }
  const denom = Math.sqrt(qn) * Math.sqrt(vn);
  return denom === 0 ? 0 : dot / denom;
}
