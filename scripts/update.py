#!/usr/bin/env python3
"""Refresh the dashboard's data files.

    python scripts/update.py              # everything
    python scripts/update.py profile      # publication record and metrics
    python scripts/update.py citations    # who cites the work, and from where
    python scripts/update.py papers       # similar-papers feed
    python scripts/update.py grants       # funding opportunities
    python scripts/update.py alerts       # (inside GitHub Actions) announce funding that needs attention

Each step is independent and fault tolerant: if a source is down the previous data is kept.
The Claude API is used only by the `grants` step and only when ANTHROPIC_API_KEY is set.
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wave.util import DATA, load_config, log, read_json  # noqa: E402

STEPS = ("profile", "citations", "papers", "grants", "alerts")


def summary(failed: list[str]) -> None:
    """A short report for the GitHub Actions run page (and the log)."""
    import os
    prof, papers, grants, cites = (read_json(DATA / f"{n}.json", {}) or {} for n in ("profile", "papers", "grants", "citations"))
    ct = cites.get("totals", {})
    m, pc, gc, ai = prof.get("metrics", {}), papers.get("counts", {}), grants.get("counts", {}), grants.get("ai", {})
    lines = [
        "## Wave Research — data refresh",
        f"- **Profile:** {m.get('outputs', '?')} outputs · {m.get('citations', '?')} citations · h-index {m.get('h_index', '?')}",
        f"- **Citations:** {ct.get('citing_papers', '?')} citing papers analysed · {ct.get('independent', '?')} independent · "
        f"{ct.get('countries', '?')} countries",
        f"- **Papers:** {pc.get('kept', '?')} in the feed ({pc.get('new', '?')} new, {pc.get('citing', '?')} citing you)",
        f"- **Funding:** {gc.get('selected', '?')} selected · {gc.get('filtered', '?')} read and left out · "
        f"{gc.get('awaiting_review', 0)} awaiting review",
        f"- **Claude:** {ai.get('calls_this_run', 0)} calls this run (≈ ${ai.get('estimated_cost_usd', 0)}) with "
        f"`{ai.get('model', 'n/a')}`" if ai.get("key_present") else
        "- **Claude:** no API key configured — add the `ANTHROPIC_API_KEY` repository secret to review new calls automatically",
    ]
    for group, src in (("profile", prof.get("sources", {})), ("papers", papers.get("sources", {})), ("funding", grants.get("sources", {}))):
        down = [k for k, v in src.items() if isinstance(v, dict) and v.get("ok") is False]
        if down:
            lines.append(f"- ⚠️ {group}: unavailable this run — {', '.join(down)} (previous data kept)")
    for e in ai.get("errors") or []:
        lines.append(f"- ⚠️ {e}")
    if failed:
        lines.append(f"- ❌ steps that failed: {', '.join(failed)}")
    text = "\n".join(lines)
    log("\n" + text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


def main(argv: list[str]) -> int:
    wanted = [a for a in argv if a in STEPS] or list(STEPS)
    cfg = load_config()
    failed = []
    for step in wanted:
        log(f"\n━━ {step} ━━")
        try:
            module = __import__(f"wave.{step}", fromlist=["run"])
            module.run(cfg)
        except Exception as exc:  # one failing step must not stop the others
            failed.append(step)
            log(f"!! {step} failed: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    if failed:
        log(f"\nFinished with problems in: {', '.join(failed)} (previous data kept for those).")
    summary(failed)
    # Exit 0 unless everything failed, so a flaky source never blocks publishing fresh data.
    return 1 if len(failed) == len(wanted) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
