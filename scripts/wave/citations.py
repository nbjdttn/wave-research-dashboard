"""Builds data/citations.json — where the researcher's citations come from.

For every publication with a DOI, Semantic Scholar lists the papers that cite it. Each citing
paper is then looked up once in OpenAlex (a free single-record call) for its authors' institutions
and countries. From that we work out:

  * who cites the work — journals, authors, institutions, countries
  * how independent the citations are — the researcher's own papers, co-authors' papers, everyone else
  * how the citing papers are spread over the years
  * which of the researcher's papers are being cited right now

Counts here come from Semantic Scholar, so they run a little below Google Scholar's totals.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter, defaultdict

from . import scholarly as S
from .profile import author_key, tidy_venue
from .util import (CACHE, DATA, SourceError, log, norm_title, now_iso, read_json, squash, title_similarity,
                   today, write_json)

FIELDS = "isInfluential,intents,title,year,venue,publicationDate,externalIds,authors,abstract,openAccessPdf,url"


def _full_key(name: str) -> str | None:
    """'Thomas A. A. Adcock' → 'thomas adcock'; 'Hao-Yu Ding' → 'haoyu ding'.
    None when the given name is only initials (too ambiguous to match on its own)."""
    parts = [p for p in re.split(r"[\s.]+", norm_title(name)) if p]
    if len(parts) < 2:
        return None
    given = [p for p in parts[:-1] if len(p) > 1]
    return f"{''.join(given)} {parts[-1]}" if given else None


def _compact(row: dict, keep_abstract_after: str) -> dict | None:
    p = row.get("citingPaper") or {}
    if not p.get("title"):
        return None
    ext = p.get("externalIds") or {}
    date = p.get("publicationDate") or (f"{p['year']}-01-01" if p.get("year") else None)
    authors = [{"n": a.get("name"), "i": a.get("authorId")} for a in (p.get("authors") or [])[:15] if a.get("name")]
    rec = {
        "s2": p.get("paperId"), "doi": (ext.get("DOI") or "").lower() or None, "arxiv": ext.get("ArXiv"),
        "title": squash(p["title"]), "year": p.get("year"), "date": date,
        "venue": squash(p.get("venue")) or None, "authors": authors, "n_authors": len(p.get("authors") or []),
        "influential": bool(row.get("isInfluential")), "intents": row.get("intents") or [],
        "url": p.get("url"), "oa_url": ((p.get("openAccessPdf") or {}) or {}).get("url") or None,
    }
    if date and date >= keep_abstract_after and p.get("abstract"):
        rec["abstract"] = squash(p["abstract"])[:1400]      # only the feed of recent citers shows abstracts
    return rec


def refresh_citers(pubs: list[dict], cache: dict, window_days: int) -> dict:
    """Update the per-paper lists of citing papers (each list is re-read at most every three days)."""
    recent = (today() - dt.timedelta(days=window_days)).isoformat()
    stats = {"fetched": 0, "failed": 0}
    order = sorted(pubs, key=lambda p: (cache.get(p["doi"], {}).get("at", ""), -p["citations"]))
    for p in order:
        entry = cache.get(p["doi"])
        age = (today() - dt.date.fromisoformat(entry["at"])).days if entry and entry.get("v") == 2 else 99
        if age < 3 or stats["failed"] >= 3:           # after three refusals, stop asking this run
            continue
        try:
            resp = S.fetch(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{p['doi']}/citations",
                           params={"fields": FIELDS, "limit": 1000}, headers=S.s2_headers(), retries=3,
                           min_interval=1.2, ok_statuses=(200, 404), timeout=60)
            rows = resp.json().get("data", []) if resp.status_code == 200 else []
            cache[p["doi"]] = {"v": 2, "at": today().isoformat(),
                               "papers": [c for c in (_compact(r, recent) for r in rows) if c]}
            stats["fetched"] += 1
            stats["failed"] = 0
        except SourceError:
            stats["failed"] += 1
    return stats


def enrich(citers: dict[str, dict], oa_cache: dict, limit: int = 900) -> int:
    """Institutions and countries of each citing paper, from OpenAlex (looked up once, then kept)."""
    done = 0
    misses = 0
    for c in citers.values():
        doi = c.get("doi")
        if not doi or doi in oa_cache or done >= limit or misses >= 5:
            continue
        try:
            w = S.openalex_work(f"doi:{doi}")
            oa_cache[doi] = {"c": w.get("countries") or [], "i": (w.get("institutions") or [])[:8],
                             "v": w.get("venue"), "t": w.get("type")} if w else {}
            done += 1
            misses = 0
        except SourceError:
            misses += 1
    return done


def run(cfg: dict) -> dict:
    profile = read_json(DATA / "profile.json")
    if not profile:
        raise SourceError("citations: run the profile step first")
    prev = read_json(DATA / "citations.json", {}) or {}
    r = cfg["researcher"]
    pubs = [p for p in profile["publications"] if p.get("doi")]
    cache = read_json(CACHE / "citations.json", {}) or {}
    cache = {k: v for k, v in cache.items() if v.get("v") == 2}          # older layout kept recent citers only
    stats = refresh_citers(pubs, cache, int(cfg["papers"]["window_days"]))
    write_json(CACHE / "citations.json", cache, compact=True)
    covered = [p for p in pubs if p["doi"] in cache]
    log(f"  citing lists: {stats['fetched']} refreshed, {len(covered)} of {len(pubs)} papers covered")
    if not covered:
        if prev:
            log("  no citing lists available — keeping the previous analysis")
            return prev
        raise SourceError("citations: Semantic Scholar returned nothing and there is no earlier analysis")

    # one record per citing paper, remembering which of the researcher's papers it cites
    own_dois = {p["doi"] for p in profile["publications"] if p.get("doi")}
    own_titles = [p["title"] for p in profile["publications"]]
    own_tk = {norm_title(t) for t in own_titles}
    citers: dict[str, dict] = {}
    for p in covered:
        for c in cache[p["doi"]]["papers"]:
            key = c.get("s2") or c.get("doi") or norm_title(c["title"])
            rec = citers.setdefault(key, {**c, "cites": [], "influential": False})
            rec["cites"].append(p["id"])
            rec["influential"] = rec["influential"] or c.get("influential", False)

    oa_cache = read_json(CACHE / "citers_openalex.json", {}) or {}
    looked = enrich(citers, oa_cache)
    write_json(CACHE / "citers_openalex.json", oa_cache, compact=True)
    if looked:
        log(f"  OpenAlex: {looked} citing papers looked up for institutions and countries")

    me_keys = {k for k in (_full_key(r["name"].replace("(", " ").replace(")", " ")), _full_key(f"Tianning {r['family_name']}"),
                           _full_key(f"{r['short_name']}")) if k}
    collab = {}
    close = set()                 # initial-only names are matched only against regular co-authors
    for c in profile.get("coauthors", []):
        k = _full_key(c["name"])
        if k:
            collab[k] = c["name"]
        if c["count"] >= 3:
            close.add(author_key(c["name"]))

    def is_collaborator(name: str) -> bool:
        fk = _full_key(name)
        return fk in collab if fk else author_key(name) in close

    def kind(c: dict) -> str:
        if (c.get("doi") and c["doi"] in own_dois) or norm_title(c["title"]) in own_tk:
            return "self"
        keys = {_full_key(a["n"]) for a in c["authors"]}
        if keys & me_keys or any(title_similarity(c["title"], t) >= 0.92 for t in own_titles):
            return "self"
        return "collaborator" if any(is_collaborator(a["n"]) for a in c["authors"]) else "independent"

    this_year = today().year
    year_ago = (today() - dt.timedelta(days=365)).isoformat()
    kinds = Counter()
    by_year: dict[int, Counter] = defaultdict(Counter)
    by_month: Counter = Counter()
    this_month = today().isoformat()[:7]
    venues, countries, institutions = Counter(), Counter(), Counter()
    authors: dict[str, dict] = {}
    intents = Counter()
    located = 0
    for c in citers.values():
        c["kind"] = kind(c)
        kinds[c["kind"]] += 1
        if c.get("year"):
            by_year[min(int(c["year"]), this_year)][c["kind"]] += 1      # in-press papers count in the current year
        if len(c.get("date") or "") >= 7:
            by_month[min(c["date"][:7], this_month)] += 1
        oa = oa_cache.get(c.get("doi") or "") or {}
        venue = tidy_venue(c.get("venue") or oa.get("v"))[0]
        if venue and c["kind"] != "self":
            venues[venue] += 1
        if oa.get("c"):
            located += 1
        if c["kind"] != "self":
            for cc in set(oa.get("c") or []):
                countries[cc] += 1
            for inst in set(oa.get("i") or []):
                institutions[inst] += 1
            for a in c["authors"]:
                key = a.get("i") or _full_key(a["n"]) or a["n"]
                fk = _full_key(a["n"])
                if fk in me_keys:
                    continue
                e = authors.setdefault(key, {"names": Counter(), "count": 0, "collaborator": False})
                e["names"][a["n"]] += 1
                e["count"] += 1
                e["collaborator"] = e["collaborator"] or is_collaborator(a["n"])
        for i in c.get("intents") or []:
            intents[i] += 1

    per_paper = []
    by_id = {p["id"]: p for p in profile["publications"]}
    for p in covered:
        lst = cache[p["doi"]]["papers"]
        if not lst and not p["citations"]:
            continue
        per_paper.append({
            "id": p["id"], "title": p["title"], "year": p["year"], "venue": p.get("venue"),
            "scholar": p["citations"], "found": len(lst),
            "recent": sum(1 for c in lst if (c.get("date") or "") >= year_ago),
            "influential": sum(1 for c in lst if c.get("influential")),
        })
    per_paper.sort(key=lambda x: (-x["recent"], -x["found"]))

    latest = sorted((c for c in citers.values() if c["kind"] != "self" and c.get("date")),
                    key=lambda c: c["date"], reverse=True)[:8]
    top_authors = sorted(authors.values(), key=lambda e: (-e["count"], e["names"].most_common(1)[0][0]))[:14]
    total = sum(kinds.values())
    years = sorted(by_year)
    result = {
        "generated_at": now_iso(),
        "source": "Semantic Scholar (citing papers) and OpenAlex (institutions, countries)",
        "totals": {
            "citing_papers": total,
            "links": sum(len(c["cites"]) for c in citers.values()),
            "self": kinds["self"], "collaborator": kinds["collaborator"], "independent": kinds["independent"],
            "influential": sum(1 for c in citers.values() if c["influential"]),
            "last_12_months": sum(1 for c in citers.values() if (c.get("date") or "") >= year_ago and c["kind"] != "self"),
            "countries": len(countries), "institutions": len(institutions), "venues": len(venues),
            "located": located, "papers_covered": len(covered), "papers_with_doi": len(pubs),
            "scholar_citations": (profile.get("metrics") or {}).get("citations"),
        },
        # citing papers per month for the last six years, oldest first (a heat-map on the page)
        "by_month": [{"month": f"{y}-{m:02d}", "count": by_month.get(f"{y}-{m:02d}", 0)}
                     for y in range(this_year - 5, this_year + 1) for m in range(1, 13) if f"{y}-{m:02d}" <= this_month],
        "by_year": [{"year": y, "self": by_year[y]["self"], "collaborator": by_year[y]["collaborator"],
                     "independent": by_year[y]["independent"]}
                    for y in range(max(years[0], this_year - 9), this_year + 1)] if years else [],
        "venues": [{"name": v, "count": n} for v, n in venues.most_common(10)],
        "countries": [{"code": c, "count": n} for c, n in countries.most_common(12)],
        "institutions": [{"name": i, "count": n} for i, n in institutions.most_common(10)],
        "authors": [{"name": e["names"].most_common(1)[0][0], "count": e["count"], "collaborator": e["collaborator"]}
                    for e in top_authors],
        "intents": [{"intent": k, "count": v} for k, v in intents.most_common()],
        "papers": per_paper[:40],
        "latest": [{"title": c["title"], "venue": tidy_venue(c.get("venue"))[0], "date": c["date"],
                    "url": (f"https://doi.org/{c['doi']}" if c.get("doi") else c.get("url")),
                    "kind": c["kind"], "authors": [a["n"] for a in c["authors"][:3]], "n_authors": c["n_authors"],
                    "cites": [by_id[i]["title"] for i in c["cites"][:2] if i in by_id]} for c in latest],
    }
    write_json(DATA / "citations.json", result)
    t = result["totals"]
    log(f"citations.json: {t['citing_papers']} citing papers · {t['independent']} independent · "
        f"{t['collaborator']} from co-authors · {t['self']} self · {t['countries']} countries")
    return result
