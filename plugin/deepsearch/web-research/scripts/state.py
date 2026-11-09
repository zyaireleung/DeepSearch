"""Run state: atomic JSON persistence (C3)."""
import json
import os
import tempfile
from datetime import datetime, timezone

DEFAULT_BUDGET = {"max_rounds": 4, "max_gateway_calls": 12, "max_minutes": 15}


def new_run(run_id, question, budget=None):
    return {
        "run_id": run_id,
        "config_version": None,
        "original_question": question,
        "claims": [],
        "evidence": [],
        "decisions": [],
        "round": 0,
        "budget": budget or dict(DEFAULT_BUDGET),
        "gateway_calls": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "planning",
    }


def save(path, state):
    path = str(path)
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)  # atomic replace
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def load(path):
    with open(str(path)) as f:
        return json.load(f)


def advance_round(state):
    state["round"] += 1
    return state
