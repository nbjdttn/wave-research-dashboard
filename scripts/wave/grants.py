"""Builds data/grants.json — a short, selected list of funding opportunities.

Pipeline
  1. collect   UKRI Funding Finder (open + upcoming, and the closed archive for calls that repeat),
               EU Funding & Tenders portal, and the watch-list of recurring funder schemes.
  2. screen    a keyword pre-screen, then (with a Claude key) a batch triage of what is left.
  3. read      fetch the full call text of the survivors.
  4. analyse   Claude judges topic fit, career-stage fit and eligibility, and writes the deadline,
               the checklist of what to submit, the effort estimate and whether the call repeats.
  5. select    only calls that pass BOTH the topic and the career-stage test are published.

Results are cached by content hash, so a daily run only pays for calls that are new or changed.
Without a Claude key the cached analyses are kept and new calls are listed as "awaiting review".
"""
from __future__ import annotations

import datetime as dt
import os
import re
import statistics
from collections import defaultdict

from . import funders as F
from .claude import PROMPT_VERSION, Budget, Claude, system_prompt
from .util import (CACHE, CONFIG, DATA, SourceError, log, now_iso, parse_date, read_json, sha, squash,
                   today, write_json)

# The pipeline's memory, split so that the large, slow-changing parts are not rewritten every day.
CACHE_FILES = {
    "grants.json": ("triage", "analysis", "first_seen", "last_seen", "baseline", "money"),   # decisions
    "grants_listings.json": ("ukri_live", "ukri_archive", "eu_live"),         # what the funders list
    "grants_texts.json": ("detail", "scheme_pages"),                          # call texts already read
}


def load_cache() -> dict:
    cache: dict = {}
    for name in CACHE_FILES:
        cache.update(read_json(CACHE / name, {}) or {})
    for k in ("triage", "analysis", "detail", "first_seen", "last_seen", "scheme_pages", "money"):
        cache.setdefault(k, {})
    for k in ("ukri_live", "ukri_archive", "eu_live"):
        cache.setdefault(k, [])
    cache.setdefault("baseline", today().isoformat())
    return cache


def save_cache(cache: dict) -> None:
    for name, keys in CACHE_FILES.items():
        write_json(CACHE / name, {k: cache[k] for k in keys if k in cache}, compact=True)


def days_since(stamp: str | None) -> int:
    d = parse_date(stamp)
    return (today() - d).days if d else 9999


GOOD_TOPIC = {"core", "strong", "open_call"}
GOOD_STAGE = {"ideal", "suitable", "stretch", "not_applicable"}
REPEATING = {"annual", "twice_yearly", "quarterly", "irregular"}


# ── screening ────────────────────────────────────────────────────────────────
OTHER_DISCIPLINES = {"MRC", "AHRC", "ESRC", "BBSRC"}     # councils outside the researcher's field


def _compile(weights: dict[str, float]) -> list[tuple[re.Pattern, float]]:
    return [(re.compile(r"\b" + re.escape(k.lower())), float(w)) for k, w in weights.items()]


def keyword_score(item: dict, pos: list, neg: list) -> float:
    """Rough relevance from the configured keywords. Used to rank, and as the only screen when no
    Claude key is configured."""
    own = f"{item['title']} {item.get('summary') or ''} {(item.get('description') or '')[:1800]} {item.get('call_title') or ''}".lower()
    text = f"{item['title'].lower()} {own}"
    return round(sum(w for rx, w in pos if rx.search(text)) + sum(w for rx, w in neg if rx.search(own)), 2)


def out_of_scope(item: dict) -> bool:
    """Cheap exclusions that need no judgement: other disciplines' councils and invite-only calls."""
    codes = set(F.funder_codes(item.get("funders") or []))
    if codes and codes <= OTHER_DISCIPLINES:
        return True
    return bool(re.search(r"invite[- ]only|invited (stage|application)|\binvitation only", item["title"], re.I))


def family(title: str) -> str:
    return next(F.iter_title_family(title))


def round_history(item: dict, archive: list[dict]) -> list[dict]:
    """Earlier rounds of the same scheme found in the UKRI archive (same normalised title)."""
    fam = family(item["title"])
    if len(fam) < 12:
        return []
    rounds = [a for a in archive if a["id"] != item["id"] and family(a["title"]) == fam and a.get("closes")]
    rounds.sort(key=lambda a: a["closes"], reverse=True)
    return [{"title": a["title"], "opens": (a.get("opens") or "")[:10] or None, "closes": a["closes"][:10],
             "url": a["url"]} for a in rounds[:5]]


def estimate_next(item: dict, history: list[dict]) -> dict | None:
    """Rule-of-thumb forecast of the next round from past closing dates (used as evidence for the
    model, and on its own when no Claude key is configured)."""
    closes = sorted({h["closes"] for h in history} | ({item["closes"][:10]} if item.get("closes") else set()))
    dates = [parse_date(c) for c in closes if parse_date(c)]
    if len(dates) < 2:
        return None
    gaps = [(b - a).days for a, b in zip(dates, dates[1:]) if (b - a).days > 45]
    if not gaps:
        return None
    gap = statistics.median(gaps)
    cadence = "annual" if 300 <= gap <= 430 else "twice_yearly" if 140 <= gap < 300 else "quarterly" if gap < 140 else "irregular"
    step = dt.timedelta(days=round(gap))
    nxt = dates[-1] + step
    while nxt < today():
        nxt += step
    opens = parse_date(item.get("opens"))
    lead = (dates[-1] - opens).days if opens and parse_date(item.get("closes")) and dates[-1] >= opens else 60
    nxt_open = nxt - dt.timedelta(days=max(14, min(lead, 200)))
    return {"cadence": cadence, "typical_open_month": nxt_open.month, "typical_close_month": nxt.month,
            "next_expected_open": nxt_open.strftime("%Y-%m"), "next_expected_close": nxt.strftime("%Y-%m"),
            "is_estimate": True,
            "evidence": f"{len(dates)} rounds in the UKRI archive closed on " + ", ".join(d.isoformat() for d in dates[-4:])}


def build_pool(live: list[dict], eu_items: list[dict], archive_list: list[dict], gc: dict) -> dict[str, dict]:
    """Everything worth a look: live UKRI calls in scope, EU topics still ahead, and the latest
    round of each past UKRI scheme (so repeating calls can be prepared for)."""
    pos, neg = _compile(gc.get("keywords", {})), _compile(gc.get("negative", {}))
    pool: dict[str, dict] = {}
    for it in live:
        it["_kw"] = keyword_score(it, pos, neg)
        if not out_of_scope(it):
            pool[it["id"]] = it
    for it in eu_items:
        it["_kw"] = keyword_score(it, pos, neg)
        pool[it["id"]] = it
    live_families = {family(i["title"]) for i in live}
    latest: dict[str, dict] = {}
    for a in archive_list:
        fam = family(a["title"])
        if fam in live_families or len(fam) < 12 or not a.get("closes") or out_of_scope(a):
            continue
        if fam not in latest or a["closes"] > latest[fam]["closes"]:
            latest[fam] = a
    for a in latest.values():
        pool[a["id"]] = {**a, "status": "closed", "_kw": keyword_score(a, pos, neg)}
    for it in pool.values():
        it["_th"] = sha(it["title"], it.get("summary") or (it.get("description") or "")[:400], it["status"])
    return pool


def shortlist_from(pool: dict[str, dict], triage: dict, gc: dict) -> list[dict]:
    floor = float(gc.get("prefilter_min", 1.6))

    def kept(it: dict) -> bool:
        t = triage.get(it["id"])
        if t and t.get("hash") == it["_th"]:
            return bool(t["keep"])
        # no decision yet (no Claude key): only the clearest keyword matches, and never closed calls
        return it["status"] != "closed" and it["_kw"] >= floor + (1.6 if it["source"] == "eu" else 0.6)

    rank = {"open": 0, "upcoming": 0, "closed": 1}
    chosen = sorted((i for i in pool.values() if kept(i)), key=lambda i: (rank.get(i["status"], 1), -i["_kw"]))
    return chosen[: int(gc.get("max_candidates", 70))]


def prepare(it: dict, archive_list: list[dict], cache: dict, fetch_detail: bool = True) -> dict:
    """Assemble exactly what the model is shown for one call (facts, round history, call text)."""
    tday = today().isoformat()
    history = round_history(it, archive_list) if it["source"] == "ukri" else []
    forecast = estimate_next(it, history) if it["source"] == "ukri" else None
    if it["source"] == "eu":
        body = F.eu_text(it)
        body_hash = it.get("_body_hash") or sha(body)
    else:
        det = cache["detail"].get(it["id"])
        stale = not det or (today() - (parse_date(det.get("at")) or today())).days >= (3 if it["status"] != "closed" else 400)
        if stale and fetch_detail:
            try:
                got = F.ukri_detail(it["url"])
                det = {"hash": got["hash"], "at": tday, "text": got["text"], "updated": got["updated"]}
                cache["detail"][it["id"]] = det
            except SourceError as exc:
                log("  detail:", it["id"], exc)
        body = (det or {}).get("text") or it.get("summary") or ""
        body_hash = (det or {}).get("hash") or sha(it.get("summary"))
    facts, hist = facts_text(it, history, forecast)
    return {"facts": facts, "hist": hist, "body": body, "body_hash": body_hash, "history": history, "forecast": forecast}


def scheme_facts(sc: dict) -> str:
    return (f"Title: {sc['title']}\nFunder: {sc['funder']}\nScheme page: {sc['url']}\n"
            "Listing status: unknown — work out from the page text whether a round is open, upcoming, "
            "rolling or closed, and its dates."
            + (f"\nNote: {sc['note']}" if sc.get("note") else ""))


# ── facts given to the model ─────────────────────────────────────────────────
def facts_text(item: dict, history: list[dict], forecast: dict | None) -> tuple[str, str]:
    money = "; ".join(f"{k.replace('_', ' ')}: {item[k]}" for k in ("total_fund", "award_range", "max_award", "min_award") if item.get(k))
    lines = [
        f"Title: {item['title']}",
        f"Funder: {', '.join(item.get('funders') or [item.get('funder') or ''])}"
        + (f" (co-funders: {', '.join(item['co_funders'])})" if item.get("co_funders") else ""),
        f"Source listing: {item['source'].upper()} | URL: {item['url']}",
        f"Listing status: {item['status']}",
        f"Published: {item.get('published') or 'n/a'} | Opens: {item.get('opens') or 'n/a'} | "
        f"Closes: {item.get('closes') or item.get('closes_note') or 'n/a'}",
    ]
    if money:
        lines.append(f"Funding: {money}")
    if item.get("summary"):
        lines.append(f"Listing summary: {item['summary'][:700]}")
    hist = ""
    if history:
        hist = "\n".join(f"- {h['title']}: opened {h['opens'] or 'n/a'}, closed {h['closes']}" for h in history)
        if forecast:
            hist += (f"\nSimple projection from these dates: {forecast['cadence']}, next round closing around "
                     f"{forecast['next_expected_close']} (opening around {forecast['next_expected_open']}).")
    return "\n".join(lines), hist


# ── money and odds ───────────────────────────────────────────────────────────
_AMOUNT = re.compile(r"([£€$])\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b|m\b|million|billion|bn\b)?", re.I)
_TO_GBP = {"£": 1.0, "€": 0.85, "$": 0.8}


def _amounts(text: str) -> list[tuple[str, float]]:
    """Every sum of money in a text, as (currency sign, value)."""
    found = []
    for sign, digits, unit in _AMOUNT.findall(text or ""):
        value = float(digits.replace(",", ""))
        unit = (unit or "").lower()
        value *= 1e3 if unit == "k" else 1e6 if unit in ("m", "million") else 1e9 if unit in ("bn", "billion") else 1
        found.append((sign, value))
    return found


def compact(sign: str, value: float) -> str:
    """£950,000 → £950k; €1,500,000 → €1.5m."""
    if value >= 1e6:
        return f"{sign}{value / 1e6:.2f}".rstrip("0").rstrip(".") + "m"
    if value >= 1e3:
        return f"{sign}{value / 1e3:.1f}".rstrip("0").rstrip(".") + "k"
    return f"{sign}{value:,.0f}"


def money_text(o: dict) -> str:
    """What is known about the money of one call, as the money job is shown it."""
    award = o.get("award") or {}
    parts = [f"{k.replace('_', ' ')}: {v}" for k, v in award.items() if v]
    amount = (o["analysis"].get("award_summary") or {}).get("amount")
    duration = (o["analysis"].get("award_summary") or {}).get("duration")
    if amount:
        parts.append(f"award: {amount}")
    if duration:
        parts.append(f"duration: {duration}")
    return "; ".join(parts) or "nothing stated"


def money_rule(o: dict) -> dict:
    """A plain reading of the figures, used when Claude is not available."""
    award = o.get("award") or {}
    amount = (o["analysis"].get("award_summary") or {}).get("amount") or ""
    for field, label in (("award_range", "per award"), ("max_award", "max per award")):
        got = _amounts(award.get(field) or "")
        if got:
            sign, top = got[-1]
            head = "–".join(compact(s, v) for s, v in got[:2]) if field == "award_range" and len(got) > 1 else compact(sign, top)
            return {"headline": head, "label": label, "max_gbp": round(top * _TO_GBP[sign])}
    if re.search(r"\bno (upper )?limit\b", amount, re.I):
        return {"headline": "No limit", "label": "", "max_gbp": 0}
    if re.search(r"compute|GPU|core hours", amount, re.I) and re.search(r"no funding|only", amount, re.I):
        return {"headline": "Compute time", "label": "no money", "max_gbp": 0}
    got = _amounts(amount)
    if got:
        m = re.search(r"up to\s*([£€$])", amount, re.I)
        sign, value = (got[0] if not m else next(((s, v) for s, v in got if s == m.group(1)), got[0]))
        return {"headline": compact(sign, value), "label": "", "max_gbp": round(value * _TO_GBP[sign])}
    return {"headline": "", "label": "", "max_gbp": 0}


def add_money(selected: list[dict], cache: dict, claude: Claude) -> None:
    """Give every call a short money figure. Claude writes it once per call (cached while the figures
    are unchanged); without Claude, a plain reading of the figures stands in and is not kept."""
    store = cache.setdefault("money", {})
    keys = {o["id"]: sha(o["title"], money_text(o)) for o in selected}
    need = [o for o in selected if (store.get(o["id"]) or {}).get("hash") != keys[o["id"]]]
    if need and claude.available and claude.remaining > 0:
        try:
            got = claude.money([{"id": o["id"], "title": o["title"], "funder": o["funder"], "money": money_text(o)} for o in need])
        except Budget:
            got = {}
        for o in need:
            if o["id"] in got:
                store[o["id"]] = {"hash": keys[o["id"]], **got[o["id"]], "by": claude.model, "at": today().isoformat()}
    for o in selected:
        hit = store.get(o["id"])
        m = {k: hit[k] for k in ("headline", "label", "max_gbp")} if hit and hit.get("hash") == keys[o["id"]] else money_rule(o)
        pot = _amounts((o.get("award") or {}).get("total_fund") or "")
        if pot:
            m["pot"] = compact(*pot[0])
        o["money"] = m


def add_odds(selected: list[dict]) -> None:
    """A rough chance of success from config/success_rates.json (published figures only), or, for a call
    that states its pot and its largest award, how many awards that makes at most."""
    rates = (read_json(CONFIG / "success_rates.json", {}) or {}).get("rates", [])
    for o in selected:
        o.pop("odds", None)
        hit = None
        for r in rates:
            m = r.get("match") or {}
            if o["id"] in (m.get("ids") or []) or (m.get("id") and re.search(m["id"], o["id"])) or (
                    m.get("title") and re.search(m["title"], o["title"], re.I)
                    and re.search(m.get("funder") or ".", o["funder"], re.I)):
                hit = r
                break
        if hit:
            o["odds"] = {k: hit.get(k) for k in ("rate", "qualifier", "text", "period", "basis", "source") if hit.get(k) not in (None, "")}
            continue
        pot, top = _amounts((o.get("award") or {}).get("total_fund") or ""), _amounts((o.get("award") or {}).get("max_award") or "")
        if pot and top and top[0][1] and pot[0][1] / top[0][1] >= 2:
            o["odds"] = {"awards": int(pot[0][1] // top[0][1])}


def one_per_family(selected: list[dict]) -> list[dict]:
    """One card per call: when a funder lists the same scheme more than once (a general page and this
    round, or last round and this one), keep the most actionable — a deadline, then always open, then
    prepare ahead — and, among equals, the better fit."""
    rank = {"deadline": 0, "rolling": 1, "prepare": 2}
    best: dict[str, dict] = {}
    for o in selected:
        fam = family(re.sub(r"\([^)]*\)", " ", o["title"]))                # "(KTP)" and the like do not make a new scheme
        who = "UKRI" if o.get("source") == "ukri" else o["funder"]     # UKRI lists one scheme under several council names
        key = f"{who}|{fam}" if len(fam) >= 12 else o["id"]
        held = best.get(key)
        if held is None or (rank.get(o["bucket"], 3), -o["analysis"]["fit_score"]) < (rank.get(held["bucket"], 3), -held["analysis"]["fit_score"]):
            best[key] = o
    keep = {id(o) for o in best.values()}
    out, seen = [], set()
    for o in selected:
        if id(o) in keep and o["id"] not in seen:
            seen.add(o["id"])
            out.append(o)
    return out


def add_sector(selected: list[dict]) -> None:
    """Mark the calls whose money comes from industry, or that are run with industry, as the watch-list says."""
    watch = read_json(CONFIG / "schemes.json", {}) or {}
    by_id = {f"scheme-{sc['slug']}": sc.get("sector") for sc in watch.get("schemes", [])}
    rule = re.compile(watch["industry_match"], re.I) if watch.get("industry_match") else None
    for o in selected:
        if by_id.get(o["id"]):
            o["sector"] = by_id[o["id"]]
        elif rule and not o["id"].startswith("scheme-") and rule.search(f"{o['funder']} {o['title']}"):
            o["sector"] = "industry"
        else:
            o.pop("sector", None)


def refresh_published() -> None:
    """Apply the money figures and odds to data/grants.json as it stands, without fetching anything
    (used after editing config/success_rates.json or seeding money figures by hand)."""
    cache = load_cache()
    data = read_json(DATA / "grants.json", {}) or {}

    class _Off:                      # no Claude here: cached figures, else the plain reading
        available, remaining, model = False, 0, ""

    data["opportunities"] = one_per_family(data.get("opportunities", []))
    add_money(data.get("opportunities", []), cache, _Off())
    add_odds(data.get("opportunities", []))
    add_sector(data.get("opportunities", []))
    write_json(DATA / "grants.json", data)


# ── selection ────────────────────────────────────────────────────────────────
def verdict(a: dict, min_fit: int) -> tuple[bool, str]:
    """Apply the two tests the researcher asked for. Returns (selected, reason if not)."""
    if a["topic_fit"]["verdict"] not in GOOD_TOPIC or a["focus"] == "ai_only":
        return False, "Topic: " + a["topic_fit"]["notes"]
    if a["career_stage"]["verdict"] not in GOOD_STAGE:
        return False, "Career stage: " + a["career_stage"]["notes"]
    if a["eligibility"]["verdict"] == "not_eligible":
        return False, "Not eligible: " + a["eligibility"]["notes"]
    if not a["recommend"]:
        return False, a["recommend_reason"] or "Not recommended"
    if a["fit_score"] < min_fit:
        return False, f"Fit {a['fit_score']}/100 is below the threshold of {min_fit}"
    return True, ""


def bucket_for(status: str, closes: str | None, a: dict) -> str | None:
    rec = a.get("recurrence") or {}
    future = bool(closes and closes[:10] >= today().isoformat())
    if status in ("open", "upcoming") and future:
        return "deadline"
    if status == "rolling" or (status == "open" and not closes):
        return "rolling"
    if status == "upcoming":
        return "prepare"            # announced, dates still to be confirmed
    if rec.get("cadence") in REPEATING:
        return "prepare"            # closed for now, but it comes round again (date may be unknown)
    if rec.get("cadence") == "rolling":
        return "rolling"
    return None


def effort_start(a: dict, closes: str | None) -> None:
    """Make sure a deadline always comes with a 'start by' date."""
    eff = a["effort"]
    if eff.get("start_by") or not closes:
        return
    lead = {"light": 10, "moderate": 28, "heavy": 60, "major": 120}.get(eff.get("level"), 28)
    d = parse_date(closes)
    if d:
        eff["start_by"] = (d - dt.timedelta(days=lead)).isoformat()


# ── calendar feed ────────────────────────────────────────────────────────────
def _ics_escape(text: str) -> str:
    return (text or "").replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def _ics_fold(line: str) -> str:
    """RFC 5545: lines are at most 75 octets; continuation lines start with a space."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > 73:
            out.append(cur.decode("utf-8"))
            cur = b" " + b
        else:
            cur += b
    out.append(cur.decode("utf-8"))
    return "\r\n".join(out)


def write_calendar(selected: list[dict]) -> int:
    """data/deadlines.ics — subscribe to it once and every deadline (and its 'start by' date) stays
    in your phone's calendar, updated by the daily run."""
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wave Research//Funding deadlines//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "X-WR-CALNAME:Funding deadlines", "X-PUBLISHED-TTL:PT12H",
             "REFRESH-INTERVAL;VALUE=DURATION:PT12H"]
    count = 0

    def event(uid: str, day: dt.date, title: str, desc: str, url: str, alarm_days: int) -> None:
        nonlocal count
        count += 1
        nxt = day + dt.timedelta(days=1)
        lines.extend([
            "BEGIN:VEVENT", f"UID:{uid}@wave-research", f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{day:%Y%m%d}", f"DTEND;VALUE=DATE:{nxt:%Y%m%d}",
            f"SUMMARY:{_ics_escape(title)}", f"DESCRIPTION:{_ics_escape(desc)}", f"URL:{url}", "TRANSP:TRANSPARENT",
            "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_escape(title)}", f"TRIGGER:-P{alarm_days}D", "END:VALARM",
            "END:VEVENT"])

    for o in selected:
        a = o["analysis"]
        need = "\n".join(f"• {r['item']}" + (f" — {r['detail']}" if r.get("detail") else "") for r in a["requirements"])
        effort = f"Effort: {a['effort']['level']} ({a['effort']['prep_time']})."
        closes = parse_date(o.get("closes"))
        if o["bucket"] == "deadline" and closes and closes >= today():
            time = (o["closes"][11:16] + " UK ") if len(o["closes"]) > 11 else ""
            event(f"{o['id']}-deadline", closes, f"Deadline {time}— {o['title']} ({o.get('funder')})",
                  f"{a['summary']}\n\n{effort}\n\nWhat you need:\n{need}\n\n{o['url']}", o["url"], 7)
        start = parse_date(a["effort"].get("start_by"))
        if start and start >= today() and o["bucket"] in ("deadline", "prepare"):
            label = "Start preparing" if o["bucket"] == "deadline" else "Start preparing (round expected, dates not announced)"
            event(f"{o['id']}-start", start, f"{label} — {o['title']} ({o.get('funder')})",
                  f"{effort}\n\nWhat you need:\n{need}\n\n{o['url']}", o["url"], 1)
    lines.append("END:VCALENDAR")
    (DATA / "deadlines.ics").write_text("\r\n".join(_ics_fold(l) for l in lines) + "\r\n", encoding="utf-8", newline="")
    return count


# ── main ─────────────────────────────────────────────────────────────────────
def run(cfg: dict) -> dict:
    gc = cfg["grants"]
    cc = cfg.get("claude", {})
    cache = load_cache()
    prev = read_json(DATA / "grants.json", {}) or {}
    status: dict = dict(prev.get("sources") or {})
    claude = Claude(cfg)
    prompt_hash = sha(PROMPT_VERSION, system_prompt(cfg))
    stamp, tday = now_iso(), today().isoformat()

    def attempt(name: str, fn, default):
        try:
            value = fn()
            status[name] = {"ok": True, "count": len(value), "checked": stamp, "last_success": stamp}
            log(f"  {name}: {len(value)}")
            return value
        except SourceError as exc:
            status[name] = {**(status.get(name) or {}), "ok": False, "note": str(exc)[:160], "checked": stamp}
            log(f"  {name}: unavailable ({exc})")
            return default

    # 1 ─ collect ─────────────────────────────────────────────────────────────
    live = attempt("ukri", lambda: F.ukri_listing(["open", "upcoming"], max_pages=25), None)
    if live is None:  # keep working from what we knew yesterday
        live = [i for i in cache.get("ukri_live", [])]
    else:
        cache["ukri_live"] = live

    lookback = today() - dt.timedelta(days=int(gc.get("closed_lookback_days", 760)))
    archive = {a["id"]: a for a in cache["ukri_archive"]}

    def closed() -> list[dict]:
        fresh = F.ukri_listing(["closed"], max_pages=70 if not archive else 12, published_after=lookback,
                               stop_at_ids=set(archive) if archive else None)
        for it in fresh:
            archive[it["id"]] = {k: (v[:320] if k == "summary" and v else v) for k, v in it.items()}
        return fresh
    attempt("ukri_archive", closed, [])
    live_ids = {i["id"] for i in live}
    cache["ukri_archive"] = sorted(
        (a for a in archive.values()
         if a["id"] not in live_ids and (parse_date(a.get("published")) or today()) >= lookback),
        key=lambda a: a.get("published") or "", reverse=True)
    archive_list = cache["ukri_archive"]

    def eu() -> list[dict]:
        found: dict[str, dict] = {}
        for q in gc.get("eu_queries", []):
            for it in F.eu_search(q, page_size=40):
                found.setdefault(it["id"], it)
        for ident in gc.get("eu_always", []):
            for it in F.eu_search(f'"{ident}"', page_size=10):
                if it["identifier"].startswith(ident):
                    it["_always"] = True
                    found[it["id"]] = it
        # The portal's ranking shuffles between calls. A topic we have already decided to keep must
        # not vanish because it slipped off a results page, so those are fetched by identifier.
        wanted = [i for i in cache.get("eu_live", [])
                  if i["id"] not in found and (cache["triage"].get(i["id"]) or {}).get("keep")]
        for old in wanted[:25]:
            for it in F.eu_search(f'"{old["identifier"]}"', page_size=5):
                if it["identifier"] == old["identifier"]:
                    found[it["id"]] = it
        return list(found.values())
    eu_items = attempt("eu", eu, None)
    if eu_items is None:
        eu_items = cache.get("eu_live", [])
    else:
        for it in eu_items:
            it["_body_hash"] = sha(F.eu_text(it))
        cache["eu_live"] = [{**it, "description": (it.get("description") or "")[:600], "conditions": ""} for it in eu_items]

    schemes = (read_json(CONFIG / "schemes.json", {}) or {}).get("schemes", [])
    status["schemes"] = {"ok": True, "count": len(schemes), "checked": stamp}

    # 2 ─ screen ──────────────────────────────────────────────────────────────
    pool = build_pool(live, eu_items, archive_list, gc)
    # A call is screened once — and again if the research topics in the profile change, but then only
    # the ones that were turned away (a wider interest can only let more in).
    reassess = str(cfg.get("claude", {}).get("reassess_on_profile_change", "uncertain")).lower()
    topics = sha(cfg["interests"].get("summary", ""), sorted(cfg["interests"].get("watch", {})), cfg["career"].get("priorities", []))

    def unscreened(it: dict) -> bool:
        t = cache["triage"].get(it["id"]) or {}
        return t.get("hash") != it["_th"] or (not t.get("keep") and t.get("topics") != topics and reassess != "none")

    need = [it for it in pool.values() if unscreened(it)]
    log(f"  in scope: {len(pool)} calls ({len(need)} to screen)")
    if need and claude.available:
        try:
            decided = claude.triage(sorted(need, key=lambda i: -i["_kw"]))
            for it in need:
                d = decided.get(it["id"])
                if d:
                    cache["triage"][it["id"]] = {"hash": it["_th"], "keep": d["keep"], "reason": d["reason"], "by": claude.model,
                                                 "topics": topics}
            log(f"  triage: {sum(1 for d in decided.values() if d['keep'])} kept of {len(decided)} screened")
        except Budget as exc:
            log("  triage stopped:", exc)
    shortlist = shortlist_from(pool, cache["triage"], gc)
    log(f"  shortlist: {len(shortlist)} calls for full analysis")

    # 3 + 4 ─ read and analyse ────────────────────────────────────────────────
    out_items: list[dict] = []
    pending = 0
    refresh_days = int(cc.get("reanalyse_after_days", 30))
    reassess = str(cc.get("reassess_on_profile_change", "uncertain")).lower()

    def profile_stale(entry: dict | None) -> bool:
        """Has the researcher's own description changed since this review, in a way that matters?"""
        if not entry or entry.get("profile") == prompt_hash or reassess == "none":
            return False
        if reassess == "all":
            return True
        return entry["data"]["eligibility"]["verdict"] == "check"     # reviews that were waiting on a fact

    for it in shortlist:
        prep = prepare(it, archive_list, cache)
        content = sha(prep["facts"], prep["body_hash"])
        entry = cache["analysis"].get(it["id"])
        age = (today() - (parse_date((entry or {}).get("at")) or today())).days if entry else 0
        # A review stays valid while the call's own text is unchanged, for up to `reanalyse_after_days`
        # (closed calls never change), unless the researcher's profile has changed underneath it.
        fresh = (bool(entry) and (entry.get("content") or entry.get("facts_hash")) == content
                 and (age < refresh_days or it["status"] == "closed") and not profile_stale(entry))
        if not fresh and claude.available and claude.remaining > 0:
            try:
                data = claude.analyse(prep["facts"], prep["body"], prep["hist"])
            except Budget:
                data = None
            if data:
                entry = {"content": content, "profile": prompt_hash, "at": tday, "model": claude.model, "data": data}
                cache["analysis"][it["id"]] = entry
        if entry is None:
            pending += 1
        out_items.append({"item": it, "entry": entry, "history": prep["history"], "forecast": prep["forecast"]})

    # 5 ─ recurring scheme watch-list ─────────────────────────────────────────
    # Each scheme page is re-read every day (free). Claude is asked again only when the page has
    # changed and the last look is at least `scheme_check_days` old, or after `reanalyse_after_days`.
    check_days = int(cc.get("scheme_check_days", 7))

    listed = {i["url"].rstrip("/") for i in shortlist}
    for sc in schemes:
        if sc["url"].rstrip("/") in listed:
            continue                      # already covered, with firmer dates, by a funder listing above
        sid = f"scheme-{sc['slug']}"
        page = cache["scheme_pages"].get(sid) or {}
        text, text_hash = page.get("text"), page.get("hash")
        if days_since(page.get("at")) >= 1:
            try:
                got = F.page_text(sc["url"])
                text, text_hash = got["text"], got["hash"]
                cache["scheme_pages"][sid] = {"hash": text_hash, "at": tday, "text": text, "via": "direct"}
            except SourceError as exc:
                # Blocked or script-rendered page: let Claude look it up with its web tools, at most
                # once a fortnight per scheme (this is the one step that costs two calls).
                if claude.available and claude.remaining > 1 and days_since(page.get("looked_up")) >= check_days * 2:
                    try:
                        notes = claude.research(sc["title"], sc["funder"], sc["url"])
                    except Budget:
                        notes = None
                    if notes:
                        text, text_hash = notes, sha(notes)
                    cache["scheme_pages"][sid] = {"hash": text_hash, "at": tday, "text": text,
                                                  "via": "claude-web", "looked_up": tday}
                elif not text:
                    log(f"  scheme page not readable by script: {sc['slug']} ({str(exc)[:60]})")
        it = {"id": sid, "source": "scheme", "title": sc["title"], "funder": sc["funder"], "funders": [sc["funder"]],
              "url": sc["url"], "status": "unknown", "summary": sc.get("note") or "", "opens": None, "closes": None,
              "closes_note": None, "published": None, "sector": sc.get("sector")}
        entry = cache["analysis"].get(sid)
        if text:
            facts = scheme_facts(sc)
            if entry is not None and not entry.get("page_hash"):
                entry["page_hash"] = text_hash          # what the page looked like at the last review
            age_a = days_since((entry or {}).get("at"))
            changed = entry is not None and entry.get("page_hash") != text_hash
            stale = entry is None or age_a >= refresh_days or (changed and age_a >= check_days) or profile_stale(entry)
            if stale and claude.available and claude.remaining > 0:
                try:
                    data = claude.analyse(facts, text)
                except Budget:
                    data = None
                if data:
                    entry = {"page_hash": text_hash, "profile": prompt_hash, "at": tday, "model": claude.model, "data": data,
                             "last_round": (entry or {}).get("last_round")}
                    cache["analysis"][sid] = entry
        if entry is None:
            pending += 1
        out_items.append({"item": it, "entry": entry, "history": [], "forecast": None})

    # 6 ─ select and publish ──────────────────────────────────────────────────
    min_fit = int(gc.get("min_fit_score", 60))
    selected, filtered, unreviewed = [], [], []
    for row in out_items:
        it, entry = row["item"], row["entry"]
        cache["first_seen"].setdefault(it["id"], tday)
        base = {
            "id": it["id"], "source": it["source"], "title": it["title"], "funder": F.short_funder(it),
            "url": it["url"], "published": it.get("published"), "first_seen": cache["first_seen"][it["id"]],
        }
        if not entry:
            if it["source"] != "scheme" and it["status"] != "closed":
                unreviewed.append({**base, "status": it["status"], "opens": it.get("opens"), "closes": it.get("closes"),
                                   "closes_note": it.get("closes_note"), "summary": (it.get("summary") or "")[:300],
                                   "keyword_score": it.get("_kw")})
            continue
        a = dict(entry["data"])
        rnd = a.get("round") or {}
        if it["source"] == "scheme":
            st, opens, closes = rnd.get("status") or "unknown", rnd.get("opens"), rnd.get("closes")
            if closes and rnd.get("closes_time"):
                closes = f"{closes[:10]}T{rnd['closes_time']}:00"
        else:  # the listing is the authority for status and dates
            st, opens, closes = it["status"], it.get("opens"), it.get("closes")
            if st == "open" and not closes:
                st = "rolling" if re.search(r"no closing date", it.get("closes_note") or "", re.I) else "open"
        if closes and closes[:10] < tday and st in ("open", "upcoming"):
            st = "closed"
        if not a["recurrence"].get("next_expected_close") and row["forecast"] and st == "closed":
            a["recurrence"] = {**a["recurrence"], **row["forecast"]}
        ok, why = verdict(a, min_fit)
        bucket = bucket_for(st, closes, a) if ok else None
        if ok and bucket is None:
            ok, why = False, "Closed, and nothing indicates another round"
        if not ok:
            filtered.append({**base, "status": st, "reason": squash(why)[:220], "fit_score": a["fit_score"]})
            continue
        effort_start(a, closes if bucket == "deadline" else (
            f"{a['recurrence']['next_expected_close']}-01" if bucket == "prepare" and a["recurrence"].get("next_expected_close") else None))
        selected.append({
            **base, "status": st, "bucket": bucket, "opens": opens, "closes": closes,
            "closes_note": it.get("closes_note"),
            "award": {k: it.get(k) for k in ("total_fund", "award_range", "max_award", "min_award") if it.get(k)},
            "eu": ({"identifier": it.get("identifier"), "action_type": it.get("action_type"),
                    "deadline_model": it.get("deadline_model"), "all_deadlines": it.get("all_deadlines")}
                   if it["source"] == "eu" else None),
            "history": row["history"][:4],
            "last_round": entry.get("last_round") or None,
            "analysis": a,
            "analysed": {"model": entry.get("model"), "at": entry.get("at"), "seeded": bool(entry.get("seeded"))},
            # "New" means newly published, or newly found since the very first build — not
            # everything that happened to be on the list on day one.
            "is_new": bool(it.get("published") and (today() - (parse_date(it["published"]) or today())).days <= 10)
                      or (cache["first_seen"][it["id"]] > cache["baseline"]
                          and (today() - (parse_date(cache["first_seen"][it["id"]]) or today())).days <= 7),
        })

    selected = one_per_family(selected)
    add_money(selected, cache, claude)
    add_odds(selected)
    add_sector(selected)

    order = {"deadline": 0, "rolling": 1, "prepare": 2}
    selected.sort(key=lambda o: (
        order[o["bucket"]],
        o["closes"] or "" if o["bucket"] == "deadline" else
        (o["analysis"]["recurrence"].get("next_expected_close") or "9999") if o["bucket"] == "prepare" else "",
        -o["analysis"]["fit_score"]))
    filtered.sort(key=lambda f: -f["fit_score"])
    unreviewed.sort(key=lambda u: -(u.get("keyword_score") or 0))

    # Forget a call only after it has been gone for two months: a single day's absence (a listing
    # hiccup, a shuffled search page) must not throw away a decision that cost a Claude call.
    for cid in {r["item"]["id"] for r in out_items} | set(pool):
        cache["last_seen"][cid] = tday
    gone = {cid for cid, seen in cache["last_seen"].items() if days_since(seen) > 60}
    for part in ("detail", "analysis", "triage", "first_seen", "last_seen", "money"):
        cache[part] = {k: v for k, v in cache[part].items()
                       if k not in gone and (k in cache["last_seen"] or k.startswith("scheme-") or part == "last_seen")}
    save_cache(cache)

    ai_prev = prev.get("ai") or {}
    result = {
        "generated_at": stamp,
        "counts": {
            "scanned": {"ukri_open": len(live), "ukri_past": len(archive_list), "eu": len(eu_items), "schemes": len(schemes)},
            "screened": len(pool), "read": len(out_items), "selected": len(selected), "filtered": len(filtered),
            "awaiting_review": pending,
            "by_bucket": {b: sum(1 for o in selected if o["bucket"] == b) for b in order},
        },
        "opportunities": selected,
        "filtered": filtered[:60],
        "unreviewed": unreviewed[:12],
        "sources": status,
        "ai": {
            "enabled": claude.available,
            "key_present": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
            "model": claude.model,
            "calls_this_run": claude.calls,
            "estimated_cost_usd": claude.cost_estimate(),
            "usage": claude.usage,
            "errors": claude.errors[:5],
            "last_ai_run": stamp if claude.calls else ai_prev.get("last_ai_run"),
            "total_calls": int(ai_prev.get("total_calls") or 0) + claude.calls,
            "total_cost_usd": round(float(ai_prev.get("total_cost_usd") or 0) + claude.cost_estimate(), 2),
        },
    }
    write_json(DATA / "grants.json", result)
    log(f"deadlines.ics: {write_calendar(selected)} calendar entries")
    log(f"grants.json: {len(selected)} selected · {len(filtered)} filtered out · {pending} awaiting review"
        f" · Claude calls {claude.calls} (≈${claude.cost_estimate()})")
    return result
