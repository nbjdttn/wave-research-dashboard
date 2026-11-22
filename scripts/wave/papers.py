"""Builds data/papers.json — recent papers similar to the researcher's own work.

Candidates come from Semantic Scholar's recommendation engine (seeded with the researcher's own
papers), arXiv, Crossref and — when an allowance is available — OpenAlex. Papers that cite the
researcher are collected too. Everything is scored against the profile with the TF-IDF model
written by the profile step, so the ranking is explainable: each paper carries the phrases that
matched and the researcher's own paper it is closest to.
"""
from __future__ import annotations

import datetime as dt
import os
import re

from . import scholarly as S
from .profile import author_key
from .text import Tfidf, cosine, phrase_hits
from .util import (CACHE, DATA, SourceError, log, norm_title, now_iso, read_json, sha, squash,
                   title_similarity, today, write_json)

JUNK_TITLE = re.compile(r"^(editorial|erratum|corrigendum|correction|retraction|index|preface|book review|contents)\b", re.I)


def _key(p: dict) -> str:
    return p.get("doi") or (f"arxiv:{p['arxiv']}" if p.get("arxiv") else f"t:{sha(norm_title(p['title']), n=14)}")


def _valid(p: dict) -> bool:
    t = p.get("title") or ""
    return len(t) >= 25 and len(t.split()) >= 4 and not JUNK_TITLE.search(t)


def _collect(cfg: dict, profile: dict, status: dict) -> dict[str, dict]:
    pc = cfg["papers"]
    since = today() - dt.timedelta(days=int(pc["window_days"]))
    pool: dict[str, dict] = {}

    def add(items: list[dict], source: str) -> int:
        n = 0
        for p in items:
            if not _valid(p):
                continue
            k = _key(p)
            cur = pool.get(k)
            if cur is None:
                # the same paper often arrives once with a DOI and once as a preprint: match on title too
                tk = norm_title(p["title"])
                cur = next((q for q in pool.values() if q["_tk"] == tk), None)
            if cur is None:
                p = dict(p)
                p["_tk"] = norm_title(p["title"])
                p["sources"] = [source]
                pool[k] = p
                cur = p
                n += 1
            else:
                if source not in cur["sources"]:
                    cur["sources"].append(source)
                for f in ("abstract", "doi", "arxiv", "oa_url", "venue", "date", "url"):
                    if not cur.get(f) and p.get(f):
                        cur[f] = p[f]
            if "_rec" in p and "_rec" not in cur:
                cur["_rec"] = p["_rec"]
        return n

    def attempt(name: str, fn) -> None:
        try:
            n = fn()
            status[name] = {"ok": True, "added": n, "checked": now_iso()}
            log(f"  {name}: +{n}")
        except SourceError as exc:
            status[name] = {"ok": False, "note": str(exc)[:160], "checked": now_iso()}
            log(f"  {name}: unavailable ({exc})")

    pubs = [p for p in profile["publications"] if p.get("doi") and p["type"] in ("journal", "conference")]
    seeds = {p["doi"] for p in sorted(pubs, key=lambda p: -p["citations"])[:14]}
    seeds |= {p["doi"] for p in sorted(pubs, key=lambda p: (-(p["year"] or 0), -p["citations"]))[:14]}

    def recommendations() -> int:
        recs = S.s2_recommendations(sorted(seeds), limit=300)
        for i, p in enumerate(recs):  # the service returns them best first: keep that signal
            p["_rec"] = 1.0 - i / max(1, len(recs))
        return add(recs, "Semantic Scholar")
    attempt("semantic_scholar", recommendations)

    def arxiv() -> int:
        cats = " OR ".join(f"cat:{c}" for c in pc["arxiv_categories"])
        n = 0
        for q in pc["queries"]:
            words = " AND ".join(f"all:{w}" for w in re.findall(r"[A-Za-z][A-Za-z-]+", q))
            n += add(S.arxiv_search(f"({words}) AND ({cats})", max_results=25), "arXiv")
        return n
    attempt("arxiv", arxiv)

    def crossref() -> int:
        n = 0
        for q in pc["queries"]:
            n += add(S.crossref_search(q, rows=20, filters=f"from-pub-date:{since.isoformat()},type:journal-article"), "Crossref")
        return n
    attempt("crossref", crossref)

    def openalex() -> int:
        key = os.environ.get("OPENALEX_API_KEY") or None
        n = 0
        for q in pc["queries"][:8]:
            n += add(S.openalex_search(key, search=q, filter=f"from_publication_date:{since.isoformat()},type:article|preprint",
                                       sort="relevance_score:desc"), "OpenAlex")
        return n
    attempt("openalex", openalex)

    # Who cited the researcher recently — read from the lists the citations step keeps up to date.
    cite_cache = read_json(CACHE / "citations.json", {}) or {}

    def citing() -> int:
        n = 0
        for p in pubs:
            for c in (cite_cache.get(p["doi"]) or {}).get("papers", []):
                d = c.get("date")
                if not d or d < since.isoformat() or not c.get("title"):
                    continue
                paper = {"s2_id": c.get("s2"), "doi": c.get("doi"), "arxiv": c.get("arxiv"), "title": c["title"],
                         "authors": [a["n"] for a in c.get("authors", [])], "venue": c.get("venue"), "year": c.get("year"),
                         "date": d, "abstract": c.get("abstract"), "oa_url": c.get("oa_url"), "url": c.get("url")}
                if not _valid(paper):
                    continue
                n += add([paper], "Semantic Scholar")
                tk = norm_title(paper["title"])
                hit = next((q for q in pool.values() if q["_tk"] == tk), None)
                if hit is not None:
                    hit.setdefault("cites", [])
                    if p["id"] not in hit["cites"]:
                        hit["cites"].append(p["id"])
        return n
    attempt("citing", citing)
    return pool


def summarise(cfg: dict, papers: list[dict]) -> dict:
    """Bullet-point summaries for the feed. Kept between runs; Claude is asked only about papers that
    have none yet (newest first, a bounded number per run). Without an API key the cache is still used."""
    from .claude import Claude          # imported here so the step also runs without the SDK

    cache = read_json(CACHE / "paper_bullets.json", {}) or {}
    limit = int(cfg.get("papers", {}).get("bullets_per_run", 48))
    todo = sorted((p for p in papers if p["id"] not in cache and len(p.get("abstract") or "") > 200),
                  key=lambda x: x["news_date"], reverse=True)
    ai = {"calls": 0, "estimated_cost_usd": 0.0, "added": 0}
    client = Claude(cfg)
    if client.available and todo:
        got = client.bullets(todo[:limit])
        for pid, points in got.items():
            cache[pid] = {"at": today().isoformat(), "b": points}
        ai = {"calls": client.calls, "estimated_cost_usd": client.cost_estimate(), "added": len(got)}
        log(f"  bullets: {len(got)} papers summarised in {client.calls} Claude calls (≈${client.cost_estimate()})"
            + (f"; {client.errors[0]}" if client.errors else ""))
    live = {p["id"] for p in papers}
    for pid in [k for k, v in cache.items() if k not in live and (today() - dt.date.fromisoformat(v["at"])).days > 200]:
        del cache[pid]
    write_json(CACHE / "paper_bullets.json", cache, compact=True)
    for paper in papers:
        paper["bullets"] = (cache.get(paper["id"]) or {}).get("b") or None
    ai["with_bullets"] = sum(1 for x in papers if x["bullets"])
    return ai


def run(cfg: dict) -> dict:
    profile = read_json(DATA / "profile.json")
    sim = read_json(DATA / "similarity.json")
    if not profile or not sim:
        raise SourceError("papers: run the profile step first")
    pc = cfg["papers"]
    prev = read_json(DATA / "papers.json", {}) or {}
    first_seen = {p["id"]: p.get("first_seen") for p in prev.get("papers", [])}
    status: dict = {}
    pool = _collect(cfg, profile, status)
    if not pool and prev.get("papers"):
        log("no candidates fetched — keeping the previous feed")
        prev["sources"] = status
        write_json(DATA / "papers.json", prev)
        return prev

    r = cfg["researcher"]
    me = author_key(f"{r['given_initial']} {r['family_name']}")
    own_titles = [p["title"] for p in profile["publications"]]
    own_dois = {p["doi"] for p in profile["publications"] if p.get("doi")}
    own_tk = {norm_title(t) for t in own_titles}
    collab = {author_key(c["name"]): c["name"] for c in profile["coauthors"][:40] if c["count"] >= 2}
    by_id = {p["id"]: p for p in profile["publications"]}
    tfidf = Tfidf.from_idf(sim["idf"])
    vectors = sim["vectors"]
    core, methods, avoid = sim["core"], sim["methods"], sim.get("avoid", {})
    watch = sim.get("watch", {})                 # topics the researcher is moving into
    venues = [v.lower() for v in sim.get("venues", [])]
    since = (today() - dt.timedelta(days=int(pc["window_days"]))).isoformat()

    out = []
    for p in pool.values():
        if p.get("doi") in own_dois or p["_tk"] in own_tk:
            continue
        if any(title_similarity(p["title"], t) >= 0.9 for t in own_titles):
            continue
        keys = [author_key(a) for a in p.get("authors") or []]
        if me in keys and len(keys) <= 40:
            continue  # the researcher's own new paper, not yet on Scholar
        date = p.get("date") or (f"{p['year']}-01-01" if p.get("year") else None)
        if not date or date < since or date > (today() + dt.timedelta(days=200)).isoformat():
            continue
        text = f"{p['title']}. {p['title']}. {p.get('abstract') or ''}"
        vec = tfidf.vector(text, top=60)
        sims = sorted(((cosine(vec, v["v"]), v["id"]) for v in vectors), reverse=True)
        best, best_id = sims[0] if sims else (0.0, None)
        top3 = sum(c for c, _ in sims[:3]) / max(1, len(sims[:3]))
        closeness = min(1.0, (0.55 * best + 0.45 * top3) / 0.34)   # near several of your papers, not just one
        core_score, core_hits = phrase_hits(text, core)
        meth_score, meth_hits = phrase_hits(text, methods)
        avoid_score, _ = phrase_hits(text, avoid)
        domain = min(1.0, core_score / 6.0)
        method = min(1.0, meth_score / 4.0)
        venue_l = (p.get("venue") or "").lower()
        good_venue = any(v in venue_l for v in venues) if venue_l else False
        coauthor = next((collab[k] for k in keys if k in collab), None)
        score = 0.46 * closeness + (0.24 * domain + 0.08 * method if core_score >= 1.0 else 0.03 * method)
        score += 0.20 * p["_rec"] + 0.04 if "_rec" in p else 0.0
        score += 0.05 if good_venue else 0.0
        score += 0.05 if coauthor else 0.0
        score += 0.08 if p.get("cites") else 0.0
        watch_score, watch_hits = phrase_hits(text, watch)
        score += min(0.22, 0.11 * watch_score)    # kept even when not yet close to past papers
        score -= min(0.40, 0.13 * avoid_score)
        score = max(0.0, min(1.0, score))
        if score < float(pc["min_score"]) and not p.get("cites"):
            continue
        focus = ("domain_ai" if core_score >= 1.0 and method > 0 else "domain" if core_score >= 1.0
                 else "ai_only" if method > 0 else "adjacent")
        authors = p.get("authors") or []
        pid = sha(_key(p), n=12)
        near = by_id.get(best_id) if best >= 0.12 else None
        out.append({
            "id": pid,
            "title": p["title"],
            "authors": authors[:8], "author_count": len(authors),
            "venue": p.get("venue"), "date": date[:10], "year": int(date[:4]),
            "abstract": (squash(p.get("abstract"))[:1400] or None),
            "url": (f"https://doi.org/{p['doi']}" if p.get("doi") else p.get("url")),
            "pdf_url": p.get("oa_url"),
            "doi": p.get("doi"), "arxiv": p.get("arxiv"),
            "sources": p["sources"],
            "score": round(score * 100),
            "similar_to": ({"id": near["id"], "title": near["title"], "year": near["year"]} if near else None),
            "matched": list(dict.fromkeys(watch_hits + core_hits + meth_hits))[:6],
            "focus": focus,
            "cites": p.get("cites") or [],
            "coauthor": coauthor,
            "first_seen": first_seen.get(pid) or today().isoformat(),
        })
        # The date a reader would call this "news": the publication day (first of the month when a
        # journal only gives a month), or the day we first spotted it if the issue date is still in
        # the future (in press).
        item = out[-1]
        pub = date[:10] if len(date) >= 10 else f"{date[:7]}-01"
        item["in_press"] = pub > today().isoformat()
        item["news_date"] = item["first_seen"] if item["in_press"] else pub

    out.sort(key=lambda p: (-p["score"], p["date"]), reverse=False)
    citing = [p for p in out if p["cites"]]
    feed = [p for p in out if not p["cites"] and p["focus"] != "adjacent"][: int(pc["max_items"])]
    keep = sorted(feed + citing[:80], key=lambda p: -p["score"])
    new_cut = (today() - dt.timedelta(days=int(pc.get("new_days", 10)))).isoformat()
    for p in keep:
        p["is_new"] = p["news_date"] >= new_cut
    ai = summarise(cfg, keep)
    result = {
        "generated_at": now_iso(),
        "ai": ai,
        "window_days": int(pc["window_days"]),
        "new_days": int(pc.get("new_days", 10)),
        "sources": status,
        "counts": {"candidates": len(pool), "kept": len(keep), "citing": len([p for p in keep if p["cites"]]),
                   "new": len([p for p in keep if p["is_new"]])},
        "papers": keep,
    }
    write_json(DATA / "papers.json", result)
    log(f"papers.json: {len(keep)} kept of {len(pool)} candidates ({result['counts']['citing']} cite the researcher)")
    return result
