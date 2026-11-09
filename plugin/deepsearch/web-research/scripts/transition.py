"""State machine: transitions, priority claim selection, breakers (audit gap1)."""
from datetime import datetime, timezone

_PHASES = ("planning", "searching", "reflecting", "completed")
_PRIORITY = {"high": 0, "medium": 1, "low": 2}


def advance(state, phase):
    if phase not in _PHASES:
        raise ValueError("bad phase: %s" % phase)
    state["status"] = phase
    if phase == "searching":
        state["round"] += 1
    if phase == "completed":
        state.setdefault("stop_reason", state.get("stop_reason"))
    return state


def top_pending(state):
    pending = [c for c in state.get("claims", []) if c.get("status") == "pending"]
    if not pending:
        return None
    # audit fix: respect depends_on -- skip claims whose deps aren't supported
    by_id = {c["id"]: c.get("status") for c in state.get("claims", [])}
    ready = [c for c in pending
             if all(by_id.get(d) == "supported" for d in c.get("depends_on", []))]
    pool = ready if ready else []
    if not pool:
        return None
    return min(pool, key=lambda c: _PRIORITY.get(c.get("priority", "low"), 2))


def apply_decisions(state, decisions, new_claims=None):
    by_id = {c["id"]: c for c in state.get("claims", [])}
    for d in decisions:
        c = by_id.get(d.get("claim_id"))
        if c is not None:
            c["status"] = d.get("verdict")
    for nc in (new_claims or []):
        nc.setdefault("status", "pending")
        if nc.get("id") not in by_id:
            state["claims"].append(nc)
            by_id[nc["id"]] = nc
    state.setdefault("decisions", []).append({
        "round": state.get("round", 0), "decisions": decisions})
    return state


def _minutes_elapsed(state):
    started = state.get("started_at")
    if not started:
        return 0.0
    try:
        t = datetime.fromisoformat(started)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - t).total_seconds() / 60.0
    except (ValueError, TypeError):
        return 0.0


def should_stop(state):
    b = state.get("budget", {})
    if state.get("round", 0) >= b.get("max_rounds", 4):
        return True, "max_rounds"
    if state.get("gateway_calls", 0) >= b.get("max_gateway_calls", 12):
        return True, "max_gateway_calls"
    if _minutes_elapsed(state) >= b.get("max_minutes", 15):  # audit fix
        return True, "max_minutes"
    if state.get("no_progress_rounds", 0) >= 2:
        return True, "no_progress"
    if not top_pending(state):
        return True, "no_pending"
    return False, None


def render_report(state):
    lines = ["# 研究报告: " + str(state.get("original_question", "")), ""]
    lines.append("config_version: " + str(state.get("config_version")))
    lines.append("rounds: " + str(state.get("round", 0)))
    lines.append("")
    lines.append("## Claims")
    for c in state.get("claims", []):
        lines.append("- [%s] %s: %s" % (c.get("status", "?"), c.get("id", ""),
                                        c.get("question", "")))
    lines.append("")
    lines.append("## 证据")
    for e in state.get("evidence", []):
        lines.append("- %s (claims: %s)" % (e.get("url", ""), ",".join(e.get("claims", []))))
    return "\n".join(lines)
