/**
 * 健康红绿黄（⑦，方案 § 9.5 / § 11.5 修订 5）
 *
 * mem0/ov_context：只 ok（绿）| unavailable（红）
 * ov_session：     ok（绿，已同步）| unsynced（红，不可同步）
 * wiki：           ok（绿，全部同步）| partial（黄，n/m）| down（红，全体不可同步）
 * stale 语义：wiki 全体 down 时仍可搜上次完整成功版本，但顶层红灯 + page/results 标 stale:true + lastSuccessfulSyncAt。
 *
 * health_snapshot 行式（db.js schema）：source_id 每源一行，state/detail/ok_count/total_count/last_ok_ms/observed_at。
 */
export function wikiHealth(assets) {
  const total = assets.length;
  if (total === 0) return { state: "down", note: "no_assets", synced: 0, total };
  const synced = assets.filter((a) => a.synced).length;
  if (synced === total) return { state: "ok", note: "all_synced", synced, total };
  if (synced === 0) return { state: "down", note: "all_unsynced", synced, total };
  return { state: "partial", note: `partial(${synced}/${total})`, synced, total };
}

export function binaryHealth(ok) {
  return ok ? { state: "ok", note: "ok" } : { state: "unavailable", note: "unavailable" };
}

function upsertSource(db, sourceId, { state, note, okCount, totalCount }) {
  const lastOk = state === "ok" ? Date.now() : db.prepare("SELECT last_ok_ms FROM health_snapshot WHERE source_id=? AND state IN ('ok','partial') ORDER BY observed_at DESC LIMIT 1").get(sourceId)?.last_ok_ms || null;
  db.prepare("INSERT OR REPLACE INTO health_snapshot (source_id, state, detail_code, detail, ok_count, total_count, last_ok_ms, observed_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(sourceId, state, note || null, note || null, okCount ?? null, totalCount ?? null, lastOk, Date.now());
  return lastOk;
}

/** 组装 health_snapshot（每源一行）+ stale 判定；返回 {sources, stale, lastSuccessfulSyncAt} */
export function snapshotHealth(db, { mem0, ovContext, ovSession, wiki }) {
  const m = binaryHealth(mem0);
  const oc = binaryHealth(ovContext);
  const os = ovSession ? { state: ovSession.synced ? "ok" : "unsynced", note: ovSession.synced ? "ok" : "unsynced", synced: ovSession.synced } : binaryHealth(false);
  const w = wikiHealth(wiki || []);
  upsertSource(db, "mem0", { state: m.state, note: m.note });
  upsertSource(db, "ov_context", { state: oc.state, note: oc.note });
  upsertSource(db, "ov_session", { state: os.state, note: os.note, okCount: os.synced ? 1 : 0 });
  const wikiLastOk = upsertSource(db, "wiki", { state: w.state, note: w.note, okCount: w.synced, totalCount: w.total });
  return {
    mem0: m.state,
    ovContext: oc.state,
    ovSession: os.state,
    wiki: w,
    stale: w.state === "down",
    lastSuccessfulSyncAt: w.state === "down" ? wikiLastOk : Date.now(),
  };
}

/** stale 标注（§ 11.5）：wiki down → page/results 标 stale:true + lastSuccessfulSyncAt */
export function applyStale(page, health) {
  if (!health || health.stale !== true) return page;
  return { ...page, stale: true, lastSuccessfulSyncAt: health.lastSuccessfulSyncAt || null };
}
