"""Builds data/profile.json — the researcher's publication record and metrics.

Google Scholar is the master list and the source of the headline numbers (it is the record the
researcher curates). ORCID supplies DOIs and work types, Crossref and OpenAlex supply full author
lists, abstracts and open-access links. Every source is optional: if one is unreachable the
previous snapshot's values are kept and the failure is recorded in `sources`.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

from . import scholarly as S
from .text import Tfidf, phrase_hits
from .util import (CACHE, DATA, ROOT, SourceError, log, norm_title, now_iso, read_json, sha,
                   squash, title_similarity, today, write_json)

# ── themes ───────────────────────────────────────────────────────────────────
THEMES = [
    ("rogue", "Rogue waves & wave statistics",
     r"rogue|freak|extreme wave|extreme water wave|kurtosis|wave statistic|space.time|large waves|largest wave|"
     r"wave group|focus|spectral tail|spectral cutoff|average shape|averaged shape|probability|depth transition|"
     r"random wave"),
    ("wsi", "Wave–structure interaction",
     r"cylinder|monopile|\bpiles?\b|wave load|wave force|waveforce|wave loading|wave impact|turbine foundation|"
     r"secondary load cycle|\bfnv\b|scattering|ocean infrastructure|nonlinear load|nonlinear forces"),
    ("physics", "Nonlinear wave physics & breaking",
     r"breaking|bound wave|bound component|superharmonic|harmonic|four.wave|mnls|envelope|solitary|soliton|"
     r"wind wave|wind impact|wind forcing|unsteady wind|phase manipulation|phase decomposition|nonlinear changes|"
     r"water wave equation|nonlinearity|non-linearity|data assimilation|phase-resolved"),
    ("spectral", "Spectral wave modelling",
     r"spectral wave|wave spectr|wave model|wavewatch|\bswan\b|four.wave|quadruplet|wave.wave interaction|"
     r"nonlinear (wave )?interaction|energy transfer|kinetic equation|hasselmann|wave action|source term|"
     r"phase.averaged|wave turbulence|directional spectr|hindcast|wave forecast|whitecap|wind.wave growth"),
    ("tides", "Tides, sea level & coastal",
     r"\btid(e|es|al)\b|rtide|swot|seiche|sea surface|sea level|coastal flood|estuar|pentland|response method|"
     r"response framework|response.based"),
    ("energy", "Marine renewable energy",
     r"wave energy|oscillating water column|tidal energy|offshore wind|renewable|wind turbine|marine energy|"
     r"floating solar"),
    ("ml", "Scientific machine learning",
     r"machine learning|neural|deeponet|gaussian process|data.driven|data informed|physics.informed|\bpinn|"
     r"symbolic|discover|generative|learning|support vector|reduced order|surrogate|bayesian|\bml\b|"
     r"transformer|hybrid model|sequential sampling"),
]
THEME_LABELS = {k: lab for k, lab, _ in THEMES}

# ── venues ───────────────────────────────────────────────────────────────────
VENUE_ALIASES = [
    (r"conference on (offshore mechanics and arctic engineering|ocean ?, ?offshore (and|&) arctic)|"
     r"^volume \d+[a-z]?\b.*ocean engineering|^asme \d{4}",
     "OMAE — Ocean, Offshore & Arctic Engineering Conference"),
    (r"egu general assembly|^egu ?\d\d|european geosciences union|egusphere", "EGU General Assembly"),
    (r"agu fall meeting", "AGU Fall Meeting"),
    (r"water waves and floating bodies|iwwwfb", "Int. Workshop on Water Waves & Floating Bodies"),
    (r"european wave and tidal energy", "European Wave & Tidal Energy Conference"),
    (r"primare", "PRIMaRE Conference on Marine Renewable Energy"),
    (r"^arxiv", "arXiv"),
    (r"ess open archive", "ESS Open Archive"),
    (r"ssrn", "SSRN"),
    (r"proceedings of the royal society a", "Proceedings of the Royal Society A"),
    (r"journal of geophysical research.{0,3}machine learning", "JGR: Machine Learning and Computation"),
    (r"journal of geophysical research.{0,3}oceans", "JGR: Oceans"),
    (r"scientia sinica", "Scientia Sinica Physica, Mechanica & Astronomica"),
    (r"european journal of mechanics.{0,4}b", "European Journal of Mechanics B/Fluids"),
    (r"ijcai", "IJCAI Workshop"),
    (r"^physical review fluids", "Physical Review Fluids"),
    (r"^nature communications", "Nature Communications"),
    (r"international journal of offshore and polar engineering", "Int. Journal of Offshore and Polar Engineering"),
]
CONFERENCE_RE = re.compile(
    r"conference|workshop|proceedings of the european wave|symposium|egu general|^egu ?\d|agu fall|"
    r"european geosciences union|meeting abstracts|congress|omae|primare|ijcai", re.I)
PREPRINT_RE = re.compile(r"arxiv|ess open archive|ssrn|preprint|egusphere", re.I)
OTHER_RE = re.compile(
    r"data set|dataset|supporting information|^earth \d|school of engineering|^centre national|"
    r"^university of (?!oxford)", re.I)
SMALL_WORDS = {"of", "and", "the", "in", "on", "for", "to", "a", "an", "at", "by"}


def tidy_venue(raw: str | None) -> tuple[str | None, str | None]:
    """'Journal of Fluid Mechanics 1021, A24 , 2025' → ('Journal of Fluid Mechanics', '1021, A24')."""
    raw = squash(raw)
    if not raw:
        return None, None
    s = re.sub(r"\s*,?\s*(19|20)\d\d\s*$", "", raw).strip(" ,…")
    for pat, canon in VENUE_ALIASES:
        if re.search(pat, s.lower()):
            m = re.search(r"\s(\d+\s*(?:\(\d+[^)]*\))?\s*,\s*[\w-]+)\s*$", s)
            return canon, (m.group(1).strip() if m and "arxiv" not in s.lower() else None)
    name, detail = s, None
    m = re.match(r"^(.*?[A-Za-z)])[\s,]+(\d[\d\s(),.–:A-Za-z-]*)$", s)
    if m and not re.search(r"\d{2}(st|nd|rd|th)\b", m.group(1)) and len(m.group(1)) > 3:
        name, detail = m.group(1).strip(" ,…"), m.group(2).strip(" ,…") or None
    key = name.lower()
    for pat, canon in VENUE_ALIASES:
        if re.search(pat, key):
            return canon, detail
    if name.islower() or name.isupper() or re.search(r"\b[a-z]{4,}\b", name):
        name = " ".join(w if (w.lower() in SMALL_WORDS and i) or w.isupper() else w[:1].upper() + w[1:]
                        for i, w in enumerate(name.split()))
    return name, detail


def classify(pub: dict) -> str:
    raw = squash(pub.get("venue_raw"))
    venue = pub.get("venue") or ""
    orcid_type = (pub.get("orcid_type") or "").lower()
    if re.match(r"supporting information", pub["title"], re.I) or OTHER_RE.search(raw):
        return "other"
    if CONFERENCE_RE.search(raw) or CONFERENCE_RE.search(venue):
        return "conference"
    if PREPRINT_RE.search(raw):
        return "preprint"
    if re.search(r"university of oxford", raw, re.I) or orcid_type == "dissertation-thesis":
        return "thesis"
    if not raw:  # nothing on Scholar: trust ORCID's type if there is one
        if orcid_type == "journal-article":
            return "journal"
        if orcid_type == "preprint" or PREPRINT_RE.search(venue):
            return "preprint"
        return "other"
    return "journal"


# ── authors ──────────────────────────────────────────────────────────────────
def author_key(name: str) -> str:
    """'Thomas A. A. Adcock', 'TAA Adcock', 'Adcock, T' → 'adcock_t'."""
    name = squash(name.replace(".", " "))
    if "," in name:
        fam, _, giv = name.partition(",")
        name = f"{giv.strip()} {fam.strip()}"
    parts = name.split()
    if not parts:
        return ""
    if len(parts) >= 2 and parts[0].isupper() and len(parts[0]) > 1 and re.search(r"[a-z][A-Z]", parts[1]):
        parts = parts[1:] + parts[:1]  # 'TANG TianNing' → family name first
    fam = norm_title(parts[-1])
    first = norm_title(parts[0])[:1] if len(parts) > 1 else ""
    return f"{fam}_{first}"


def split_short_authors(s: str) -> tuple[list[str], bool]:
    names = [squash(x) for x in s.split(",") if squash(x)]
    truncated = any(n in ("...", "…") for n in names)
    return [n for n in names if n not in ("...", "…")], truncated


def is_full_name(n: str) -> bool:
    first = n.replace(".", " ").split()[0] if n.split() else ""
    return len(first) > 1 and not first.isupper()


# ── enrichment caches ────────────────────────────────────────────────────────
def _enrich(doi: str, cr_cache: dict, oa_cache: dict) -> tuple[dict, dict]:
    stamp = today().isoformat()
    if doi not in cr_cache:
        try:
            cr_cache[doi] = {**S.crossref_work(doi), "_at": stamp}
        except SourceError as exc:
            log("  crossref", doi, exc)
    oa = oa_cache.get(doi)
    stale = not oa or (today() - _d(oa.get("_at"))).days > 30
    if stale:
        try:
            oa_cache[doi] = {**S.openalex_work(f"doi:{doi}"), "_at": stamp}
        except SourceError as exc:
            log("  openalex", doi, exc)
    return cr_cache.get(doi) or {}, oa_cache.get(doi) or {}


def _d(s):
    import datetime as dt
    try:
        return dt.date.fromisoformat(s)
    except (TypeError, ValueError):
        return dt.date(2000, 1, 1)


# ── main ─────────────────────────────────────────────────────────────────────
SNAPSHOT_KEYS = ("citations", "citations_recent", "h_index", "h_index_recent", "i10_index", "i10_index_recent", "recent_since")


def build(cfg: dict) -> dict:
    r = cfg["researcher"]
    prev = read_json(DATA / "profile.json", {}) or {}
    sources: dict[str, dict] = dict(prev.get("sources") or {})
    stamp, tday = now_iso(), today().isoformat()

    def mark(name: str, ok: bool, note: str = "") -> None:
        entry = dict(sources.get(name) or {})
        entry.update({"ok": ok, "checked": stamp, "note": note})
        if ok:
            entry["last_success"] = stamp
        sources[name] = entry

    # 1 ─ Google Scholar: the list the researcher curates, and the figures academics quote.
    #     Scholar turns away requests from data-centre addresses (GitHub's runners get HTTP 403),
    #     so a successful read is treated as a dated snapshot and kept until the next one.
    scholar = None
    try:
        scholar = S.scholar_profile(r["scholar_id"])
        mark("scholar", True, f"{len(scholar['publications'])} items")
        log(f"scholar: {len(scholar['publications'])} items, {scholar['citations']} citations")
    except SourceError as exc:
        mark("scholar", False, str(exc))
        log("scholar unavailable:", exc)

    # 2 ─ ORCID: DOIs, work types — and new papers on the days Scholar cannot be read.
    orcid_works: list[dict] = []
    try:
        orcid_works = S.orcid_works(r["orcid"])
        mark("orcid", True, f"{len(orcid_works)} works")
        log(f"orcid: {len(orcid_works)} works")
    except SourceError as exc:
        mark("orcid", False, str(exc))
        log("orcid unavailable:", exc)

    if scholar is None and not prev.get("publications"):
        raise SourceError("no Scholar data and no previous snapshot — cannot build the profile")

    cr_cache = read_json(CACHE / "crossref.json", {}) or {}
    oa_cache = read_json(CACHE / "openalex.json", {}) or {}
    doi_cache = read_json(CACHE / "title_doi.json", {}) or {}
    orcid_by_title: dict[str, list[dict]] = defaultdict(list)
    for w in orcid_works:
        if w.get("title"):
            orcid_by_title[norm_title(w["title"])].append(w)
    me = author_key(f"{r['given_initial']} {r['family_name']}")

    def pick_orcid(row: dict) -> dict | None:
        """Choose the ORCID record that is the same *version* as the Scholar row."""
        cands = orcid_by_title.get(norm_title(row["title"]))
        if not cands:
            best = max(orcid_works, key=lambda w: title_similarity(w["title"], row["title"]), default=None)
            cands = [best] if best and title_similarity(best["title"], row["title"]) >= 0.9 else []
        if not cands:
            return None
        wants_preprint = bool(PREPRINT_RE.search(row["venue_raw"] or "")) or bool(
            re.search(r"^egu ?\d|egu general|european geosciences", row["venue_raw"] or "", re.I))

        def rank(w: dict) -> tuple:
            is_pre = (w.get("type") == "preprint")
            same_venue = title_similarity(w.get("journal") or "", tidy_venue(row["venue_raw"])[0] or "") >= 0.6
            return (same_venue, is_pre == wants_preprint, bool(w.get("doi")))
        return max(cands, key=rank)

    def make_pub(row: dict, ow: dict | None, origin: str) -> dict:
        """One publication record from a Scholar row (or an ORCID work shaped like one)."""
        key = norm_title(row["title"])
        doi = ow.get("doi") if ow else None
        # No DOI from ORCID: ask Crossref once, remember the answer (including "none").
        if not doi and row.get("venue_raw") and not OTHER_RE.search(row["venue_raw"]):
            if key in doi_cache:
                doi = doi_cache[key] or None
            else:
                try:
                    hits = S.crossref_search(row["title"], rows=3)
                    hit = next((h for h in hits if title_similarity(h["title"], row["title"]) >= 0.92
                                and h.get("type") in ("journal-article", "proceedings-article", "posted-content", "book-chapter")
                                and any(author_key(a) == me for a in h["authors"])), None)
                    doi_cache[key] = hit["doi"] if hit else ""
                    doi = doi_cache[key] or None
                except SourceError as exc:
                    log("  crossref search failed:", exc)

        cr, oa = _enrich(doi, cr_cache, oa_cache) if doi else ({}, {})
        short, truncated = split_short_authors(row.get("authors_short") or "")
        full = oa.get("authors") or cr.get("authors") or []
        authors = full if len(full) >= len(short) and full else short
        venue_src = cr.get("venue") or (ow or {}).get("journal") or oa.get("venue")
        venue, detail = tidy_venue(row.get("venue_raw"))
        v2 = tidy_venue(venue_src)[0] if venue_src else None
        if v2 and (not venue or title_similarity(venue, v2) >= 0.6):
            venue = v2
        keys = [author_key(a) for a in authors]
        pos = keys.index(me) if me in keys else None
        role = None
        if pos is not None:
            role = "first" if pos == 0 else ("last" if pos == len(keys) - 1 and not (truncated and authors is short) else "middle")
        on_scholar = origin == "scholar"
        pub = {
            "id": row.get("scholar_id") or sha(key, n=12),
            "title": row["title"],
            "authors": authors,
            "authors_truncated": bool(truncated and authors is short),
            "me_index": pos,
            "role": role,
            "year": row.get("year") or (ow or {}).get("year") or cr.get("year"),
            "date": cr.get("date") or oa.get("date"),
            "venue": venue,
            "venue_detail": detail,
            "venue_raw": row.get("venue_raw"),
            "orcid_type": (ow or {}).get("type"),
            # Scholar's count where Scholar lists the paper; OpenAlex's for papers it has not shown us yet
            "citations": row["citations"] if on_scholar else int(oa.get("citations") or 0),
            "citations_source": "scholar" if on_scholar else "openalex",
            "origin": origin,
            "doi": doi,
            "url": f"https://doi.org/{doi}" if doi else None,
            "scholar_url": (f"https://scholar.google.com/citations?view_op=view_citation&hl=en&user={r['scholar_id']}"
                            f"&citation_for_view={row['scholar_id']}") if row.get("scholar_id") else None,
            "oa_url": oa.get("oa_url") if oa.get("is_oa") else None,
            "abstract": cr.get("abstract") or oa.get("abstract"),
            "institutions": oa.get("institutions") or [],
            "countries": oa.get("countries") or [],
        }
        pub["type"] = classify(pub)
        blob = f"{pub['title']} {pub.get('abstract') or ''}".lower()
        title_l = pub["title"].lower()
        pub["themes"] = [k for k, _, pat in THEMES if re.search(pat, title_l)] or \
                        [k for k, _, pat in THEMES if re.search(pat, blob)][:2]
        pub.pop("venue_raw", None)
        pub.pop("orcid_type", None)
        return pub

    # 3 ─ the publication list
    if scholar is not None:
        snapshot = {**{k: scholar[k] for k in SNAPSHOT_KEYS}, "citations_by_year": scholar["citations_by_year"],
                    "as_of": tday, "interests": scholar.get("interests") or [], "coauthors": scholar.get("coauthors") or []}
        pubs = [make_pub(row, pick_orcid(row), "scholar") for row in scholar["publications"]]
        # Collapse exact duplicate listings (same title and year), keeping the richer record.
        merged: dict[tuple, dict] = {}
        for p in pubs:
            k = (norm_title(p["title"]), p["year"], p["type"] if p["type"] == "preprint" else "x")
            if k in merged:
                keep = merged[k]
                if (p["citations"], bool(p["doi"])) > (keep["citations"], bool(keep["doi"])):
                    p["duplicates"] = keep.get("duplicates", 1) + 1
                    merged[k] = p
                else:
                    keep["duplicates"] = keep.get("duplicates", 1) + 1
            else:
                merged[k] = p
        pubs = list(merged.values())
    else:
        pm = prev.get("metrics") or {}
        snapshot = prev.get("scholar_snapshot") or {
            **{k: pm.get(k) for k in SNAPSHOT_KEYS}, "citations_by_year": prev.get("citations_by_year") or [],
            "as_of": pm.get("as_of"), "interests": (prev.get("researcher") or {}).get("interests") or [], "coauthors": []}
        pubs = [dict(p) for p in prev["publications"]]
        log(f"keeping the Scholar snapshot of {snapshot.get('as_of')} ({len(pubs)} outputs)")
        for p in pubs:                      # open-access status and OpenAlex counts still move
            if p.get("doi"):
                _, oa = _enrich(p["doi"], cr_cache, oa_cache)
                if oa.get("is_oa") and not p.get("oa_url"):
                    p["oa_url"] = oa.get("oa_url")
                if p.get("citations_source") == "openalex":
                    p["citations"] = int(oa.get("citations") or p.get("citations") or 0)

    # Recent work ORCID knows about and the list does not (a new paper Scholar has not shown us yet).
    known_dois = {p["doi"] for p in pubs if p.get("doi")}
    known_titles = [p["title"] for p in pubs]
    added = 0
    for w in orcid_works:
        if not w.get("title") or (w.get("year") or 0) < today().year - 1:
            continue
        if w.get("type") not in ("journal-article", "conference-paper", "book-chapter"):
            continue
        if (w.get("doi") and w["doi"] in known_dois) or any(title_similarity(w["title"], t) >= 0.85 for t in known_titles):
            continue
        p = make_pub({"title": w["title"], "authors_short": "", "venue_raw": w.get("journal") or "",
                      "citations": 0, "year": w.get("year"), "scholar_id": None}, w, "orcid")
        if p["authors"] and p["me_index"] is None:
            continue                         # ORCID lists it, but the author list does not include them
        pubs.append(p)
        known_titles.append(p["title"])
        known_dois.add(p.get("doi"))
        added += 1
    if added:
        log(f"  {added} recent output(s) added from ORCID")
    pubs.sort(key=lambda p: (-(p["year"] or 0), -(p["citations"] or 0), p["title"]))

    write_json(CACHE / "crossref.json", cr_cache, compact=True)
    write_json(CACHE / "openalex.json", oa_cache, compact=True)
    write_json(CACHE / "title_doi.json", doi_cache)

    # ── aggregates ───────────────────────────────────────────────────────────
    this_year = today().year
    by_year: dict[int, Counter] = defaultdict(Counter)
    for p in pubs:
        if p["year"]:
            by_year[p["year"]][p["type"]] += 1
    years = sorted(by_year)
    pubs_by_year = [{"year": y, **{t: by_year[y].get(t, 0) for t in ("journal", "conference", "preprint", "thesis", "other")}}
                    for y in range(years[0], max(years[-1], this_year) + 1)] if years else []

    for p in pubs:                                # recomputed every run, so a new theme reaches older records too
        title_l = p["title"].lower()
        p["themes"] = [k for k, _, pat in THEMES if re.search(pat, title_l)] or \
                      [k for k, _, pat in THEMES if re.search(pat, f"{title_l} {(p.get('abstract') or '').lower()}")][:2]
    themes = []
    for k, label, _ in THEMES:
        sel = [p for p in pubs if k in p["themes"]]
        if sel:
            themes.append({"id": k, "label": label, "count": len(sel),
                           "citations": sum(p["citations"] for p in sel),
                           "journal": sum(1 for p in sel if p["type"] == "journal")})

    co: dict[str, dict] = {}
    scholar_names = {author_key(n): n for n in snapshot.get("coauthors") or []}
    for p in pubs:
        for a in p["authors"]:
            k = author_key(a)
            if not k or k == me:
                continue
            e = co.setdefault(k, {"names": Counter(), "count": 0, "first": 9999, "last": 0, "citations": 0})
            e["names"][a] += 1
            e["count"] += 1
            e["citations"] += p["citations"]
            if p["year"]:
                e["first"], e["last"] = min(e["first"], p["year"]), max(e["last"], p["year"])
    coauthors = []
    for k, e in co.items():
        full = [n for n in e["names"] if is_full_name(n)]
        name = scholar_names.get(k) or (max(full, key=lambda n: (e["names"][n], len(n))) if full else max(e["names"], key=e["names"].get))
        coauthors.append({"name": name, "count": e["count"], "citations": e["citations"],
                          "first_year": e["first"] if e["first"] < 9999 else None, "last_year": e["last"] or None})
    coauthors.sort(key=lambda c: (-c["count"], -c["citations"], c["name"]))

    venues = Counter(p["venue"] for p in pubs if p["venue"] and p["type"] == "journal")
    venue_cites: Counter = Counter()
    for p in pubs:
        if p["venue"] and p["type"] == "journal":
            venue_cites[p["venue"]] += p["citations"]
    countries = Counter(c for p in pubs for c in p["countries"])
    institutions = Counter(i for p in pubs for i in p["institutions"])

    cby = snapshot.get("citations_by_year") or []
    cite_now = next((c["count"] for c in cby if c["year"] == this_year), 0)
    cite_prev = next((c["count"] for c in cby if c["year"] == this_year - 1), 0)
    first_year = min((p["year"] for p in pubs if p["year"]), default=this_year)
    metrics = {
        **{k: snapshot.get(k) for k in SNAPSHOT_KEYS},
        "outputs": len(pubs), "journal_articles": sum(1 for p in pubs if p["type"] == "journal"),
        "conference_papers": sum(1 for p in pubs if p["type"] == "conference"),
        "preprints": sum(1 for p in pubs if p["type"] == "preprint"),
        "citations_this_year": cite_now, "citations_last_year": cite_prev,
        "first_year": first_year, "active_years": this_year - first_year + 1,
        "m_index": round((snapshot.get("h_index") or 0) / max(1, this_year - first_year + 1), 2),
        "citations_per_output": round((snapshot.get("citations") or 0) / max(1, len(pubs)), 1),
        "first_author": sum(1 for p in pubs if p["role"] == "first"),
        "senior_author": sum(1 for p in pubs if p["role"] == "last"),
        "coauthors": len(coauthors),
        "ml_share": round(sum(1 for p in pubs if "ml" in p["themes"]) / max(1, len(pubs)), 2),
        "open_access": sum(1 for p in pubs if p.get("oa_url")),
        "with_doi": sum(1 for p in pubs if p.get("doi")),
        "source": "Google Scholar", "as_of": snapshot.get("as_of"),
        "scholar_live": scholar is not None,
    }

    # OpenAlex: read every day (free single-record look-up), so there is always a figure that moves.
    oa_live = (prev.get("metrics") or {}).get("openalex") or {}
    try:
        got = S.openalex_author(r["openalex_id"])
        oa_live = {k: got.get(k) for k in ("works_count", "cited_by_count", "h_index", "i10_index")}
        oa_live["by_year"] = sorted(({"year": c["year"], "count": c.get("cited_by_count", 0)} for c in got.get("counts_by_year") or []),
                                    key=lambda c: c["year"])
        oa_live["as_of"] = tday
        mark("openalex", True)
    except SourceError as exc:
        mark("openalex", False, str(exc))
    metrics["openalex"] = oa_live
    mark("crossref", True, f"{len(cr_cache)} records cached")

    # Daily history → "+N citations in the last month". Scholar's figure only changes on days it
    # could be read; OpenAlex's is recorded every day.
    history = [h for h in (prev.get("history") or []) if h.get("date") != tday]
    history.append({"date": tday, "citations": metrics["citations"], "h_index": metrics["h_index"],
                    "i10_index": metrics["i10_index"], "outputs": metrics["outputs"],
                    "scholar": scholar is not None,
                    "oa_citations": oa_live.get("cited_by_count"), "oa_h_index": oa_live.get("h_index")})
    history = sorted(history, key=lambda h: h["date"])[-800:]

    # Profile photo (the researcher's own public Scholar picture), refreshed weekly.
    avatar = ROOT / "assets" / "img" / "avatar.jpg"
    try:
        if scholar is not None and scholar.get("photo_url") and (not avatar.exists() or today().weekday() == 0):
            avatar.write_bytes(S.scholar_photo(r["scholar_id"]))
    except SourceError as exc:
        log("photo:", exc)

    # Similarity model shipped to the page: IDF table + one vector per paper.
    docs = [f"{p['title']}. {p['title']}. {p.get('abstract') or ''}" for p in pubs]
    core, methods = cfg["interests"]["core"], cfg["interests"]["methods"]
    tfidf = Tfidf(docs + [cfg["interests"]["summary"]], max_vocab=3000)
    vectors = []
    for p, d in zip(pubs, docs):
        if p["type"] in ("journal", "conference", "preprint", "thesis"):
            vectors.append({"id": p["id"], "v": tfidf.vector(d, top=40)})
    similarity = {"idf": {t: round(v, 3) for t, v in tfidf.idf.items()}, "vectors": vectors,
                  "core": core, "methods": methods, "avoid": cfg["interests"].get("avoid", {}),
                  "watch": cfg["interests"].get("watch", {}),
                  "venues": sorted({v for v in (p["venue"] for p in pubs if p["type"] == "journal") if v}
                                   | set(cfg["papers"].get("preferred_venues", [])))}

    researcher = {k: r[k] for k in ("name", "short_name", "title", "department", "institution", "location", "tagline")}
    researcher.update({
        "bio": squash(r.get("bio")), "links": r.get("links", {}), "orcid": r["orcid"],
        "interests": snapshot.get("interests") or [], "avatar": "assets/img/avatar.jpg" if avatar.exists() else None,
        "career": {k: cfg["career"][k] for k in ("stage", "appointed_year", "current_awards", "recognition") if k in cfg["career"]},
    })
    return {
        "generated_at": stamp, "checked_at": stamp,
        "researcher": researcher, "metrics": metrics, "scholar_snapshot": snapshot,
        "citations_by_year": cby, "publications_by_year": pubs_by_year,
        "themes": themes, "theme_labels": THEME_LABELS,
        "coauthors": coauthors[:60],
        "venues": [{"name": v, "count": c, "citations": venue_cites[v]} for v, c in venues.most_common(14)],
        "countries": [{"code": c, "count": n} for c, n in countries.most_common(20)],
        "institutions": [{"name": i, "count": n} for i, n in institutions.most_common(20)],
        "publications": pubs, "history": history, "sources": sources, "similarity": similarity,
    }


def run(cfg: dict) -> dict:
    profile = build(cfg)
    sim = profile.pop("similarity", None)
    write_json(DATA / "profile.json", profile)
    if sim:
        write_json(DATA / "similarity.json", sim, compact=True)
    m = profile["metrics"]
    log(f"profile.json: {m['outputs']} outputs · {m['citations']} citations · h={m['h_index']} "
        f"(Scholar as of {m['as_of']}; OpenAlex {(m.get('openalex') or {}).get('cited_by_count')} citations)")
    return profile
