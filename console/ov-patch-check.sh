#!/usr/bin/env bash
# OV commit 上下文撑爆修复 · 启动自检（v3）
#
# 用途：检测当前生效的代码是否包含本修复的关键哨兵，防止 `uv tool upgrade`
#       静默覆盖 OV site-packages 补丁、或 console 代码回退后"补丁静默失效"。
# 用法：bash ov-patch-check.sh [--strict]
#       --strict：缺失任一哨兵时 exit 1（供启动脚本拒启）；默认仅告警 exit 0。
#
# 判定依据（与修复实现一一对应）：
#   A. OV extraction_batch.py 含 DEFAULT_EXTRACTION_BATCH_TOKEN_LIMIT（默认 60000 提取批上限）
#   B. OV resolve_extraction_batch_limits 对空 policy 返回默认上限（不再无限制单批全量）
#   C. console ov-import.js 不再引用 totalInputTokenBudget（单一预算口径，删除双语义）
#   D. console _splitBatches 预算兜底为 60000（pendingTokenBudget 别名）
#   E. console 归档断言：archiveCount === batchSize（live 实测锚定）
set -u
OV_PKG="${OV_SITE_PACKAGES:-${HOME:-~}/.local/share/uv/tools/openviking/lib/python3.12/site-packages/openviking}"
CONSOLE_JS="${CONSOLE_OV_IMPORT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ov-import.js}"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

fail=0
warn() { echo "[ov-patch-check] 告警: $1"; }
err()  { echo "[ov-patch-check] 缺失: $1"; fail=1; }

EB="$OV_PKG/session/extraction_batch.py"
if [ ! -f "$EB" ]; then
  err "OV extraction_batch.py 不存在（$EB）——请检查 OV_SITE_PACKAGES"
elif grep -q "DEFAULT_EXTRACTION_BATCH_TOKEN_LIMIT" "$EB"; then
  echo "[ov-patch-check] OK  A 提取批默认上限补丁在（DEFAULT_EXTRACTION_BATCH_TOKEN_LIMIT）"
else
  err "A 提取批默认上限补丁缺失——uv tool upgrade 可能已覆盖，需重新应用 patch-ov-extraction-batch-v3.diff"
fi

if grep -q "never silently allow an unbounded one-batch prompt" "$EB" 2>/dev/null; then
  echo "[ov-patch-check] OK  B resolve 空 policy → 默认上限（不再单批全量）"
else
  err "B resolve_extraction_batch_limits 空 policy 兜底缺失"
fi

if [ ! -f "$CONSOLE_JS" ]; then
  err "console ov-import.js 不存在（$CONSOLE_JS）"
else
  if grep -q "this\.config\.totalInputTokenBudget\|totalInputTokenBudget || 180000" "$CONSOLE_JS"; then
    err "C console 仍引用 totalInputTokenBudget（双预算口径未删干净）"
  else
    echo "[ov-patch-check] OK  C console 已删除 totalInputTokenBudget（单一预算）"
  fi
  if grep -q "pendingTokenBudget || 60000" "$CONSOLE_JS"; then
    echo "[ov-patch-check] OK  D _splitBatches 预算兜底 60000"
  else
    err "D _splitBatches 预算兜底非 60000"
  fi
  if grep -q "archiveCount === batchSize\|keepRecent = liveCount - batchSize\|messages.length - batchSize" "$CONSOLE_JS"; then
    echo "[ov-patch-check] OK  E 归档=本批 语义在（live 实测锚定）"
  else
    err "E 归档=本批 语义缺失"
  fi
fi

echo "[ov-patch-check] 结果: $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
[ $fail -eq 0 ] || { [ $STRICT -eq 1 ] && exit 1 || echo "[ov-patch-check] 非 strict 模式：仅告警（建议尽快恢复补丁）"; }
exit 0
