"""Funding alerts through GitHub's own notifications.

One standing issue in the repository ("Funding alerts") receives a short comment when something needs
the researcher's attention: a strongly fitting call that has just appeared, or a selected call whose
deadline has come within a fortnight. GitHub then notifies whoever watches the repository — by email
and, with the GitHub app, on the phone. Each item is announced once.

Runs only inside the scheduled Action (it needs GITHUB_TOKEN and GITHUB_REPOSITORY); anywhere else it
does nothing.
"""
from __future__ import annotations

import os

from .util import CACHE, DATA, SourceError, fetch, log, parse_date, read_json, today, write_json

TITLE = "Funding alerts"
API = "https://api.github.com"
EFFORT = {"light": "light", "moderate": "moderate", "heavy": "heavy", "major": "major"}


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


def due(cfg: dict, grants: dict, sent: dict) -> list[tuple[str, str]]:
    """(key, markdown line) for everything that should be announced now."""
    g = cfg.get("grants", {})
    min_fit, days_ahead = int(g.get("alert_min_fit", 75)), int(g.get("alert_days_before", 14))
    out = []
    for o in grants.get("opportunities", []):
        a = o["analysis"]
        closes = parse_date(o.get("closes"))
        left = (closes - today()).days if closes else None
        effort = f"{EFFORT.get(a['effort']['level'], a['effort']['level'])} effort ({a['effort']['prep_time']})"
        when = f"closes {closes.strftime('%-d %b %Y')}" if closes else (o.get("closes_note") or "no fixed deadline")
        line = f"**{o['title']}** — {o['funder']}; {when}; {effort}; fit {a['fit_score']}/100.\n{a['summary']}"
        if o.get("is_new") and a["fit_score"] >= min_fit and f"new:{o['id']}" not in sent:
            out.append((f"new:{o['id']}", f"🆕 New and a strong fit\n{line}", o))
        elif o["bucket"] == "deadline" and left is not None and 0 <= left <= days_ahead and f"due:{o['id']}:{o['closes'][:10]}" not in sent:
            out.append((f"due:{o['id']}:{o['closes'][:10]}", f"⏳ {left} day{'s' if left != 1 else ''} left\n{line}", o))
    return out


def run(cfg: dict) -> dict:
    token, repo = os.environ.get("GITHUB_TOKEN", "").strip(), os.environ.get("GITHUB_REPOSITORY", "").strip()
    state = read_json(CACHE / "alerts.json", {}) or {}
    sent = state.setdefault("sent", {})
    grants = read_json(DATA / "grants.json", {}) or {}
    if not cfg.get("grants", {}).get("alerts", True):
        log("  alerts: switched off in the config")
        return state
    items = due(cfg, grants, sent)
    if not (token and repo):
        log(f"  alerts: not running inside GitHub Actions — {len(items)} item(s) would be announced")
        return state
    if not items:
        log("  alerts: nothing new to announce")
        return state
    owner, name = repo.split("/", 1)
    site = f"https://{owner.lower()}.github.io/{name}/"
    try:
        issue = state.get("issue")
        if not issue:
            found = fetch(f"{API}/repos/{repo}/issues", params={"state": "open", "per_page": 50}, headers=_headers(token)).json()
            issue = next((i["number"] for i in found if i.get("title") == TITLE and "pull_request" not in i), None)
        if not issue:
            made = fetch(f"{API}/repos/{repo}/issues", method="POST", headers=_headers(token), ok_statuses=(201,), json_body={
                "title": TITLE,
                "body": "Short notes from the daily update when a funding call needs attention: a strong new call, or a "
                        f"deadline within a fortnight. Subscribe to this issue to be told.\n\nDashboard: {site}"})
            issue = made.json()["number"]
        state["issue"] = issue
        done = 0
        for key, text, o in items[:6]:                     # never a flood
            body = f"{text}\n\n[Open in the dashboard]({site}#funding/{o['id']}) · [the call]({o['url']})"
            fetch(f"{API}/repos/{repo}/issues/{issue}/comments", method="POST", headers=_headers(token), ok_statuses=(201,),
                  json_body={"body": body})
            sent[key] = today().isoformat()
            done += 1
        for key, _, _ in items[6:]:                         # the rest are noted as seen, not announced late
            sent[key] = today().isoformat()
        log(f"  alerts: {done} announced on issue #{issue}")
    except (SourceError, KeyError, ValueError) as exc:
        log(f"  alerts: could not post ({exc}) — will try again on the next run")
    cutoff = today().toordinal() - 400
    state["sent"] = {k: v for k, v in sent.items() if (parse_date(v) or today()).toordinal() > cutoff}
    write_json(CACHE / "alerts.json", state)
    return state
