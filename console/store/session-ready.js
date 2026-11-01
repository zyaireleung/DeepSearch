/**
 * V4 会话就绪判定（OV 0.5.2 目录存储）：读 <sessionsRoot>/<sessionId>/.meta.json。
 * 就绪 = commit_count > 0（或 last_commit_at 非空，或 history 下 archive_* 内有 .done）。
 * 未就绪（未 commit / 无 .meta.json）→ session_not_ready。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = () =>
  path.join(process.env.HOME || "", ".openviking", "data", "viking", "default", "user", "default", "sessions");

export function makeSessionReady(sessionsRoot) {
  const root = sessionsRoot || DEFAULT_ROOT();
  return async (sessionId) => {
    if (!sessionId) return true; // 无会话过滤 → 不判定
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, sessionId, ".meta.json"), "utf8"));
      if ((meta.commit_count ?? 0) > 0) return true;
      if ((meta.last_commit_at ?? "") !== "") return true;
      const histDir = path.join(root, sessionId, "history");
      if (fs.existsSync(histDir)) {
        for (const a of fs.readdirSync(histDir)) {
          if (fs.existsSync(path.join(histDir, a, ".done"))) return true;
        }
      }
      return false;
    } catch {
      return false; // 无 .meta.json / 解析失败 → 未就绪
    }
  };
}
