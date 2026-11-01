/**
 * 同步串行队列（⑦，方案 L7 / § 9.5 / § 11.5）
 *
 * jobId 化：POST /sync → {jobId, state:"queued", dryRun, target}；真实同步/rebuild 进串行队列（sync_jobs），
 * 并发同步同一 target 只入队；进度查 GET /sync/:jobId。dryRun 默认 true（先量化后决策），真实写需显式 false。
 */
import { randomUUID } from "node:crypto";

export function enqueueSync(db, { target = "all", dryRun = true, rebuild = false } = {}) {
  const jobId = randomUUID().slice(0, 8);
  const ts = Date.now();
  db.prepare("INSERT INTO sync_jobs (job_id, target, dry_run, rebuild, state, created_at) VALUES (?,?,?,?,?,?)")
    .run(jobId, target, dryRun ? 1 : 0, rebuild ? 1 : 0, "queued", ts);
  return { jobId, state: "queued", dryRun, target };
}

/** 取任务（串行：只挡 running；queued 可逐个消费） */
export function claimNextSyncJob(db) {
  const running = db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE state='running'").get();
  if (running.n > 0) return null;
  const row = db.prepare("SELECT * FROM sync_jobs WHERE state='queued' ORDER BY created_at LIMIT 1").get();
  if (!row) return null;
  db.prepare("UPDATE sync_jobs SET state='running' WHERE job_id=?").run(row.job_id);
  return db.prepare("SELECT * FROM sync_jobs WHERE job_id=?").get(row.job_id);
}

export function getSyncJob(db, jobId) {
  return db.prepare("SELECT * FROM sync_jobs WHERE job_id=?").get(jobId) || null;
}

export function finishSyncJob(db, jobId, { ok, detail }) {
  db.prepare("UPDATE sync_jobs SET state=?, result_json=?, finished_at=? WHERE job_id=?").run(ok ? "done" : "failed", JSON.stringify(detail || {}), Date.now(), jobId);
}

/** 串行 worker：逐条 claim → run → finish；并发同一 target 由 claimNextSyncJob 的 running 门控保证 */
export async function runSyncQueue(db, { targets = {} } = {}) {
  let job;
  while ((job = claimNextSyncJob(db))) {
    const run = targets[job.target] || targets.all;
    try {
      const detail = run ? await run(db, job) : { note: "no-runner" };
      finishSyncJob(db, job.job_id, { ok: true, detail });
    } catch (e) {
      finishSyncJob(db, job.job_id, { ok: false, detail: { error: e.message } });
    }
  }
}
