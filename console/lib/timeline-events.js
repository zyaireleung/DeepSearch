// lib/timeline-events.js
// 事件时间线：四类事件（log/import/wiki/model）的追加 + 读取 + 去重合并分页纯函数。
// ponytail: 单 jsonl 追加 + 读时排序切页，2000 条上限。量级上来再换 SQLite（见 Global Constraints）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX = 2000;
const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 50;

function sha(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

function appendLine(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    // ponytail: 热路径只 append，不每条 trim（trim 全量读文件、最坏回写 = O(n)/条）。
    // 裁剪交给 bootstrapLogs 收尾 + readEvents 读时截断。
  } catch {}
}

function sortKeyOf(x) { return x.ts || x.sortKey || ''; }

/** 物理裁剪：按时间键（ts/sortKey）倒序保留最新 max 条，不按文件写入顺序（r4 修正）。
 *  旧日志 bootstrap 追加在文件尾部，按写入顺序 slice(-max) 会保留旧日志、淘汰更新的结构化事件。 */
function trim(file, max = MAX) {
  try {
    const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (recs.length <= max) return;
    recs.sort((a, b) => sortKeyOf(b).localeCompare(sortKeyOf(a)));
    fs.writeFileSync(file, recs.slice(0, max).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch {}
}

/** 追加一条结构化事件。缺省补 id/ts。 */
export function appendEvent(file, evt) {
  const rec = {
    id: evt.id || `${evt.type}:${sha(`${evt.subtype}|${evt.title}|${JSON.stringify(evt.fields || {})}|${evt.ts || Date.now()}`)}`,
    ts: evt.ts || new Date().toISOString(),
    type: evt.type, subtype: evt.subtype || '', title: evt.title || '', fields: evt.fields || {},
  };
  appendLine(file, rec);
  return rec;
}

/** 追加一条运行日志事件。id 由内容稳定生成，防重启/重复 bootstrap 重复。 */
export function appendLog(file, line, { todayIso } = {}) {
  const { time, kind, text } = line;
  const id = 'log:' + sha(`${time}|${kind}|${text}`);
  // r4: 日期取 todayIso 的 ISO 段，不经过 new Date() 的本地时区折返（UTC 机器不会差一天）。
  const day = (todayIso || new Date().toISOString()).slice(0, 10);
  const ts = `${day}T${time}`;
  const rec = { id, ts, type: 'log', subtype: kind, title: text, fields: {} };
  appendLine(file, rec);
  return rec;
}

/** 旧日志（只有 HH:MM:SS，无日期）进 jsonl：ts=null、sortKey 合成垫底，绝不伪造今天。 */
export function bootstrapLogs(file, legacyLines, { nowIso } = {}) {
  const existing = new Set(readEvents(file).map((x) => x.id));
  const out = [];
  for (const line of legacyLines || []) {
    const m = /^\[(\d{2}:\d{2}:\d{2})\] \[(\w+)\] (.*)$/.exec(line);
    if (!m) continue;
    const [, time, kind, text] = m;
    const id = 'log:' + sha(`${time}|${kind}|${text}`);
    if (existing.has(id)) continue;            // 今天已由 appendLog 写过，跳过
    out.push({ id, ts: null, sortKey: `1970-01-01T${time}Z`, type: 'log', subtype: kind, title: text, fields: {} });
  }
  for (const rec of out) appendLine(file, rec);
  trim(file);                                   // r3: 收尾裁剪一次，不在 append 热路径反复全量读写
  return out;
}

/** 读时按 max 截断（倒序取最新 max 条）。裁剪只在 bootstrap 收尾物理裁一次，读时软截断。 */
export function readEvents(file, max = MAX) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => sortKeyOf(b).localeCompare(sortKeyOf(a)))
      .slice(0, max);
  } catch { return []; }
}

/** 归一化内存 recentLogs 为时间线条目（供与 jsonl 去重合并）。
 *  已带 id 的条目视为已归一化，原样透传（保留其 ts/sortKey/type/subtype/title/fields）；
 *  原始 {time,kind,text} 才按内容重算 id 与垫底 sortKey。两种入参都兼容。 */
function memLogItems(recentLogs) {
  return (recentLogs || []).map((l) => {
    if (l && l.id) return l;
    return {
      id: 'log:' + sha(`${l.time}|${l.kind}|${l.text}`),
      ts: l.ts || null, sortKey: l.ts || `1970-01-01T${l.time}Z`,
      type: 'log', subtype: l.kind || 'info', title: l.text || '', fields: {},
    };
  });
}

/** 混合去重 + 倒序 + 切页。分页模式以 jsonl 为准，内存 log 只补 jsonl 缺失的。 */
export function mergePage({ events = [], recentLogs = [], page = 1, size = PAGE_SIZE_DEFAULT }) {
  const byId = new Map();
  for (const e of events) byId.set(e.id, e);                       // jsonl 优先
  for (const m of memLogItems(recentLogs)) if (!byId.has(m.id)) byId.set(m.id, m);
  const all = [...byId.values()].sort((a, b) => sortKeyOf(b).localeCompare(sortKeyOf(a)));
  const total = all.length;
  size = Math.max(1, Math.min(PAGE_SIZE_MAX, size | 0 || PAGE_SIZE_DEFAULT));
  page = Math.max(1, page | 0 || 1);
  const start = (page - 1) * size;
  return { total, page, size, logs: all.slice(start, start + size) };
}

/** 预设 diff：增 / 删 / 字段改。 */
export function diffPresets(oldList = [], newList = []) {
  const out = [];
  const prev = new Map(oldList.map((p) => [p.name, p]));
  const nextNames = new Set(newList.map((p) => p.name));
  for (const o of oldList) if (!nextNames.has(o.name)) out.push({ name: o.name, removed: true });
  for (const n of newList) {
    const o = prev.get(n.name);
    if (!o) { out.push({ name: n.name, added: true }); continue; }
    const changes = {};
    for (const k of ['baseUrl', 'model', 'temperature', 'timeout', 'dimensions', 'maxTokens']) {
      if (o[k] !== undefined && n[k] !== undefined && String(o[k]) !== String(n[k])) changes[k] = [o[k], n[k]];
    }
    if (Object.keys(changes).length) out.push({ name: n.name, changes });
  }
  return out;
}

/** 解析 ?page&size；无参 = 旧形状。 */
export function normalizePageQuery(searchParams) {
  const sp = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
  const hasP = sp.has('page'), hasS = sp.has('size');
  if (!hasP && !hasS) return { paged: false, page: 1, size: PAGE_SIZE_DEFAULT };
  const rawPage = parseInt(sp.get('page'), 10);
  const rawSize = parseInt(sp.get('size'), 10);
  return {
    paged: true,
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    size: Number.isFinite(rawSize) && rawSize > 0 ? Math.min(PAGE_SIZE_MAX, rawSize) : PAGE_SIZE_DEFAULT,
  };
}
