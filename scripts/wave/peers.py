"""Peer comparison — the researcher's citation growth against people at a similar career stage,
in the same field, at leading universities, with every curve counted from the PhD year.

Everything comes from single-record OpenAlex look-ups, which are free and need no key:

  1. candidates  authors of the papers that cite the researcher or appear in the similar-papers feed
  2. look-up     each candidate seen at a leading university → citations and papers per year, topics
  3. select      same field (topic overlap) and a PhD within a few years of the researcher's
  4. PhD year    from the config, else the ORCID education record, else first paper + N years (marked ~)

Records are cached and re-read weekly, so an ordinary day makes only a handful of requests.
"""
from __future__ import annotations

import datetime as dt
import math
import os
import re
import statistics
from collections import Counter

from . import scholarly as S
from .citations import _full_key
from .util import CACHE, DATA, SourceError, fetch, log, norm_title, now_iso, read_json, today, write_json

CALLS_PER_RUN = 900     # OpenAlex look-ups in one run; anything left over waits for the next day
REFRESH_DAYS = 7        # a kept author's record is re-read this often
RECHECK_DAYS = 120      # a rejected candidate is looked at again this often
ORCID_DAYS = 180
PHD = re.compile(r"ph\.?\s?d|d\.?\s?phil|doctor|博士|eng\.?\s?d", re.I)


def _inst_key(name: str | None) -> str:
    n = re.sub(r"[^\w&]+", " ", (name or "").lower()).strip()
    return n[4:] if n.startswith("the ") else n


def _age(stamp: str | None) -> int:
    try:
        return (today() - dt.date.fromisoformat((stamp or "")[:10])).days
    except ValueError:
        return 10_000


def _key() -> str | None:
    return os.environ.get("OPENALEX_API_KEY") or None


def work_authors(doi: str) -> list:
    """[[author id, name, first institution], …] for one paper (free look-up)."""
    r = fetch(f"{S.OPENALEX}/works/doi:{doi}", params={"select": "id,authorships"}, headers=S._oa_headers(_key()),
              min_interval=0.11, retries=1, ok_statuses=(200, 404))
    if r.status_code == 404:
        return []
    out = []
    for a in (r.json().get("authorships") or [])[:12]:
        au = a.get("author") or {}
        if au.get("id"):
            insts = [i.get("display_name") for i in a.get("institutions") or [] if i.get("display_name")]
            out.append([au["id"].rsplit("/", 1)[-1], au.get("display_name") or "", insts[:2]])
    return out


def author_record(aid: str) -> dict | None:
    r = fetch(f"{S.OPENALEX}/authors/{aid}", headers=S._oa_headers(_key()), min_interval=0.11, retries=1,
              ok_statuses=(200, 404))
    if r.status_code == 404:
        return None
    a = r.json()
    return {
        "name": a.get("display_name") or "",
        "orcid": (a.get("orcid") or "").rsplit("/", 1)[-1] or None,
        "works": a.get("works_count") or 0,
        "cites": a.get("cited_by_count") or 0,
        "h": (a.get("summary_stats") or {}).get("h_index") or 0,
        "cby": sorted([c["year"], c.get("works_count") or 0, c.get("cited_by_count") or 0] for c in a.get("counts_by_year") or []),
        "aff": [[x["institution"].get("display_name"), min(x.get("years") or [0]), max(x.get("years") or [0])]
                for x in a.get("affiliations") or [] if x.get("institution")][:8],
        "last": [[i.get("display_name"), i.get("country_code")] for i in a.get("last_known_institutions") or []][:2],
        "topics": {t["id"].rsplit("/", 1)[-1]: t.get("count") or 0 for t in (a.get("topics") or [])[:12]},
        "topic_names": [t.get("display_name") for t in (a.get("topics") or [])[:3]],
    }


def first_year(rec: dict) -> int | None:
    """First year of real activity. A lone early paper followed by a long gap is usually a
    mis-attributed record, so it is skipped."""
    years = sorted({y for y, works, _ in rec["cby"] if works} | {lo for _, lo, _ in rec["aff"] if lo})
    while len(years) > 1 and years[1] - years[0] > 4:
        years.pop(0)
    return years[0] if years else None


def orcid_phd(orcid: str) -> int | None:
    """Year the doctorate ended, when the person lists it publicly on ORCID."""
    best = None
    for section in ("educations", "qualifications"):
        r = fetch(f"https://pub.orcid.org/v3.0/{orcid}/{section}", headers={"Accept": "application/json"},
                  retries=1, min_interval=0.3, ok_statuses=(200, 404))
        if r.status_code != 200:
            continue
        for group in r.json().get("affiliation-group", []):
            for s in group.get("summaries", []):
                e = s.get("education-summary") or s.get("qualification-summary") or {}
                end = ((e.get("end-date") or {}).get("year") or {}).get("value")
                if end and PHD.search(e.get("role-title") or ""):
                    best = max(best or 0, int(end))
    return best


def similarity(mine: dict, theirs: dict) -> float:
    dot = sum(mine.get(k, 0) * v for k, v in theirs.items())
    na, nb = math.sqrt(sum(v * v for v in mine.values())), math.sqrt(sum(v * v for v in theirs.values()))
    return dot / (na * nb) if na and nb else 0.0


def series(rec: dict, start: int, end: int) -> list[dict]:
    by = {y: (w, c) for y, w, c in rec["cby"]}
    return [{"year": y, "cites": by.get(y, (0, 0))[1], "works": by.get(y, (0, 0))[0]} for y in range(start, end + 1)]


def run(cfg: dict) -> dict:
    pc = cfg.get("peers", {})
    r, career = cfg["researcher"], cfg["career"]
    prev = read_json(DATA / "peers.json", {}) or {}
    if not pc.get("enabled", True):
        log("  peers: switched off in the config")
        return prev
    my_id, my_phd = r.get("openalex_id"), int(career.get("phd_award_year") or 0)
    if not (my_id and my_phd):
        raise SourceError("peers: needs researcher.openalex_id and career.phd_award_year in the config")
    this_year = today().year
    window, lag = int(pc.get("stage_window_years", 3)), int(pc.get("phd_lag_years", 3))
    min_sim, max_peers = float(pc.get("min_similarity", 0.3)), int(pc.get("max_peers", 12))
    leading = {_inst_key(n) for n in pc.get("institutions", [])}
    include = {str(x).rsplit("/", 1)[-1] for x in pc.get("include", [])}
    exclude = {str(x).strip().lower() for x in pc.get("exclude", [])}
    fixed = {str(k).strip().lower(): int(v) for k, v in (pc.get("phd_years") or {}).items()}

    cache = read_json(CACHE / "peers.json", {}) or {}
    if cache.get("v") != 1:
        cache = {"v": 1, "seen": {}, "pool": {}, "authors": {}, "orcid": {}}
    sig = f"{min_sim}|{window}|{lag}|{pc.get('min_works', 5)}"
    if cache.get("sig") != sig:                  # the selection rules changed: judge rejected candidates afresh
        cache["authors"] = {k: v for k, v in cache["authors"].items() if not v.get("skip")}
        cache["sig"] = sig
    seen, pool, authors, orcids = cache["seen"], cache["pool"], cache["authors"], cache["orcid"]
    budget = CALLS_PER_RUN

    # 1 ── candidates: who writes the papers around this researcher's work
    dois: dict[str, str] = {}
    for entry in (read_json(CACHE / "citations.json", {}) or {}).values():
        for p in entry.get("papers", []):
            if p.get("doi"):
                dois[p["doi"].lower()] = "citing"
    for p in (read_json(DATA / "papers.json", {}) or {}).get("papers", []):
        if p.get("doi"):
            dois.setdefault(p["doi"].lower(), "similar")
    misses = looked = 0
    for doi in dois:
        if doi in seen or budget <= 0 or misses >= 6:
            continue
        try:
            for aid, name, insts in work_authors(doi):
                e = pool.setdefault(aid, {"n": name, "i": [], "w": 0})
                e["w"] += 1
                for i in insts:
                    if i not in e["i"] and len(e["i"]) < 4:
                        e["i"].append(i)
            seen[doi] = 1
            looked += 1
            budget -= 1
            misses = 0
        except SourceError:
            misses += 1
    log(f"  candidates: {len(pool)} authors from {len(seen)} papers ({looked} papers read this run)")

    # 2 ── look up the ones seen at a leading university (plus anyone named in the config)
    wanted = [aid for aid, e in pool.items() if any(_inst_key(i) in leading for i in e["i"])]
    wanted = sorted(set(wanted) | include, key=lambda a: -pool.get(a, {}).get("w", 99))
    misses = fetched = 0
    for aid in [my_id] + wanted:
        have = authors.get(aid)
        stale = (not have or _age(have.get("at")) >= (RECHECK_DAYS if have.get("skip") else REFRESH_DAYS)
                 or (aid == my_id and _age(have.get("at")) >= 1))
        if not stale or budget <= 0 or misses >= 6:
            continue
        try:
            rec = author_record(aid)
            authors[aid] = {"at": today().isoformat(), **(rec or {"skip": "gone"})}
            fetched += 1
            budget -= 1
            misses = 0
        except SourceError:
            misses += 1
    me = authors.get(my_id)
    if not me or me.get("skip"):
        write_json(CACHE / "peers.json", cache, compact=True)
        if prev:
            log("  peers: the researcher's own OpenAlex record is unavailable — keeping the previous comparison")
            return prev
        raise SourceError("peers: OpenAlex did not return the researcher's own record")

    # 3 ── same field, similar stage
    coauthors = {k for k in (_full_key(c["name"]) for c in (read_json(DATA / "profile.json", {}) or {}).get("coauthors", [])) if k}
    my_first = first_year(me) or my_phd - lag

    def phd_of(aid: str, rec: dict) -> tuple[int | None, str]:
        for k in (aid.lower(), rec["name"].strip().lower()):
            if k in fixed:
                return fixed[k], "config"
        o = orcids.get(rec.get("orcid") or "")
        if o and o.get("phd"):
            return int(o["phd"]), "orcid"
        fy = first_year(rec)
        return (fy + lag if fy else None), "estimate"

    def rejected(aid: str, rec: dict) -> str | None:
        if aid in include:
            return None
        if rec["works"] < int(pc.get("min_works", 5)):
            return "few papers"
        fy = first_year(rec)
        if not fy or fy < my_first - (window + 5) or rec["works"] > 200:
            return "senior"
        if similarity(me["topics"], rec["topics"]) < min_sim:
            return "other field"
        return None

    shortlist = []
    for aid in wanted:
        rec = authors.get(aid)
        if not rec or rec.get("skip") or aid == my_id:
            continue
        why = rejected(aid, rec)
        if why:                                  # keep a stub so the record is not fetched again for months
            authors[aid] = {"at": rec["at"], "skip": why, "name": rec["name"]}
            continue
        shortlist.append(aid)
    shortlist.sort(key=lambda a: -similarity(me["topics"], authors[a]["topics"]))

    # 4 ── PhD years: ORCID where the person lists it (best-placed candidates only)
    asked = 0
    for aid in shortlist[:max_peers * 4]:
        oid = authors[aid].get("orcid")
        if not oid or (oid in orcids and _age(orcids[oid].get("at")) < ORCID_DAYS) or asked >= 60:
            continue
        try:
            orcids[oid] = {"at": today().isoformat(), "phd": orcid_phd(oid)}
            asked += 1
        except SourceError:
            break

    main, near, far = [], [], 0
    for aid in shortlist:
        rec = authors[aid]
        if aid.lower() in exclude or rec["name"].strip().lower() in exclude:
            continue
        phd, source = phd_of(aid, rec)
        gap = abs(phd - my_phd) if phd is not None else 99
        if gap > window + 2 and aid not in include:
            far += 1
            continue
        now_at = next((n for n, _ in rec["last"] if _inst_key(n) in leading), None)
        recent = next((n for n, _, hi in rec["aff"] if _inst_key(n) in leading and hi >= this_year - 2), None)
        if not (now_at or recent or aid in include):
            continue
        inst = now_at or recent or (rec["last"][0][0] if rec["last"] else None)
        country = next((c for n, c in rec["last"] if n == inst), rec["last"][0][1] if rec["last"] else None)
        fy = first_year(rec) or phd - lag
        entry = {
            "id": aid, "name": rec["name"], "institution": inst, "country": country,
            "phd_year": phd, "phd_source": source, "first_year": fy,
            "similarity": round(similarity(me["topics"], rec["topics"]), 2),
            "coauthor": (_full_key(rec["name"]) or "") in coauthors,
            "citations": rec["cites"], "works": rec["works"], "h_index": rec["h"],
            "by_year": series(rec, min(fy, phd - 3), this_year),
            "url": f"https://openalex.org/{aid}",
        }
        (main if gap <= window or aid in include else near).append(entry)
    eligible = len(main)
    peers = main[:max_peers]
    # the bench: further candidates the reader can swipe into the comparison on the page
    bench = [{**e, "near_stage": e in near} for e in (main[max_peers:] + near)][:int(pc.get("max_bench", 24))]
    if not pc.get("show_names", True):           # the data file is public: leave the names out of it altogether
        for n, e in enumerate(peers + bench):
            e.update({"name": f"Peer {n + 1}", "id": f"peer-{n + 1}", "url": None, "coauthor": False})
    write_json(CACHE / "peers.json", cache, compact=True)

    # headline: where the researcher stands at the same number of years after the PhD
    age = this_year - my_phd
    mine = series(me, min(my_first, my_phd - 3), this_year)

    def total_at(rows: list[dict], year: int) -> int:
        return sum(x["cites"] for x in rows if x["year"] <= year)

    reached = [total_at(p["by_year"], p["phd_year"] + age) for p in peers if p["phd_year"] + age <= this_year]
    you_now = total_at(mine, this_year)
    out = {
        "generated_at": now_iso(),
        "source": "OpenAlex",
        "you": {"id": my_id, "name": r["short_name"], "phd_year": my_phd, "first_year": my_first,
                "citations": me["cites"], "works": me["works"], "h_index": me["h"], "by_year": mine},
        "cohort": {"stage_window": [my_phd - window, my_phd + window], "candidates": len(pool), "looked_up": len(wanted),
                   "eligible": eligible, "shown": len(peers), "bench": len(bench), "institutions": len(leading),
                   "estimated_phd": sum(1 for p in peers if p["phd_source"] == "estimate")},
        "summary": {"age": age, "you": you_now, "reached": len(reached),
                    "median": round(statistics.median(reached)) if reached else None,
                    "rank": 1 + sum(1 for v in reached if v > you_now) if reached else None},
        "show_names": bool(pc.get("show_names", True)),
        "peers": peers,
        "bench": bench,
    }
    write_json(DATA / "peers.json", out)
    log(f"peers.json: {len(peers)} peers shown of {eligible} eligible · {fetched} author records read · "
        f"{asked} ORCID look-ups · {far} outside the career-stage window")
    return out
