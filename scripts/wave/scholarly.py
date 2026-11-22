"""Readers for the open scholarly sources: Google Scholar profile page, ORCID, Crossref,
OpenAlex, Semantic Scholar and arXiv. Each raises SourceError when the source is unavailable so
the caller can fall back to what it already has."""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from typing import Any

from .util import SourceError, fetch, squash, strip_tags

# ── Google Scholar ───────────────────────────────────────────────────────────
# Only the public profile page is read, once per run. robots.txt allows /citations?user= and
# disallows paging (cstart), so we take the 100 most recent items in one request and never page.
SCHOLAR_URL = "https://scholar.google.com/citations"


def _clean(fragment: str) -> str:
    return squash(html.unescape(re.sub(r"<[^>]+>", " ", fragment)))


def scholar_profile(user_id: str) -> dict:
    resp = fetch(
        SCHOLAR_URL,
        params={"user": user_id, "hl": "en", "pagesize": "100", "sortby": "pubdate"},
        browser=True, retries=1, timeout=40,
    )
    page = resp.text
    if "gsc_prf_in" not in page or "gsc_rsb_std" not in page:
        raise SourceError("scholar: profile page not returned (sign-in wall or bot check)")

    name = _clean(re.search(r'<div id="gsc_prf_in"[^>]*>(.*?)</div>', page, re.S).group(1))
    lines = [_clean(x) for x in re.findall(r'<div class="gsc_prf_il"[^>]*>(.*?)</div>', page, re.S)]
    interests = [_clean(x) for x in re.findall(r'<a[^>]*class="gsc_prf_inta[^"]*"[^>]*>(.*?)</a>', page, re.S)]
    stats = [int(x) for x in re.findall(r'<td class="gsc_rsb_std">(\d+)</td>', page)]
    if len(stats) < 6:
        raise SourceError("scholar: citation table missing")
    since = re.search(r"Since (\d{4})", page)

    years = [int(_clean(x)) for x in re.findall(r'<span class="gsc_g_t"[^>]*>(.*?)</span>', page, re.S)]
    per_year = {y: 0 for y in years}
    for z, count in re.findall(
        r'<a [^>]*class="gsc_g_a"[^>]*style="[^"]*z-index:(\d+)[^"]*"[^>]*>\s*<span class="gsc_g_al">(\d+)</span>',
        page,
    ):
        idx = len(years) - int(z)  # bars are stacked right-to-left by z-index
        if 0 <= idx < len(years):
            per_year[years[idx]] = int(count)

    pubs = []
    for row in re.findall(r'<tr class="gsc_a_tr">(.*?)</tr>', page, re.S):
        t = re.search(r'<a href="([^"]+)"[^>]*class="gsc_a_at"[^>]*>(.*?)</a>', row, re.S)
        if not t:
            continue
        gray = re.findall(r'<div class="gs_gray">(.*?)</div>', row, re.S)
        cited = re.search(r'<a href="([^"]*)"[^>]*class="gsc_a_ac[^"]*"[^>]*>(.*?)</a>', row, re.S)
        year = re.search(r'class="gsc_a_h gsc_a_hc gs_ibl"[^>]*>(.*?)</span>', row, re.S)
        cite_id = re.search(r"citation_for_view=([\w:-]+)", html.unescape(t.group(1)))
        cites_txt = _clean(cited.group(2)) if cited else ""
        year_txt = _clean(year.group(1)) if year else ""
        pubs.append({
            "title": _clean(t.group(2)),
            "authors_short": _clean(gray[0]) if gray else "",
            "venue_raw": _clean(gray[1]) if len(gray) > 1 else "",
            "citations": int(cites_txt) if cites_txt.isdigit() else 0,
            "year": int(year_txt) if year_txt.isdigit() else None,
            "scholar_id": cite_id.group(1) if cite_id else None,
            "cited_by_url": html.unescape(cited.group(1)) if cited and cited.group(1) else None,
        })
    if not pubs:
        raise SourceError("scholar: no publications parsed")

    coauthors = [_clean(x) for x in re.findall(r'<a tabindex="-1" href="/citations\?user=[^"]+"[^>]*>(.*?)</a>', page, re.S)]
    homepage = re.search(r'<a href="([^"]+)" rel="nofollow" class="gsc_prf_ila">Homepage', page)
    has_photo = "view_op=view_photo" in page or "medium_photo" in page
    more = re.search(r'<button[^>]*id="gsc_bpf_more"[^>]*>', page)
    return {
        "name": name,
        "affiliation": lines[0] if lines else "",
        "interests": interests or ([x for x in re.split(r"\s{2,}", lines[2])] if len(lines) > 2 else []),
        "citations": stats[0], "citations_recent": stats[1],
        "h_index": stats[2], "h_index_recent": stats[3],
        "i10_index": stats[4], "i10_index_recent": stats[5],
        "recent_since": int(since.group(1)) if since else None,
        "citations_by_year": [{"year": y, "count": per_year[y]} for y in years],
        "publications": pubs,
        "coauthors": coauthors,
        "homepage": html.unescape(homepage.group(1)) if homepage else None,
        "photo_url": (
            f"https://scholar.googleusercontent.com/citations?view_op=medium_photo&user={user_id}"
            if has_photo else None
        ),
        "truncated": bool(more and "disabled" not in more.group(0)),
    }


def scholar_photo(user_id: str) -> bytes:
    resp = fetch(
        "https://scholar.googleusercontent.com/citations",
        params={"view_op": "medium_photo", "user": user_id}, browser=True, retries=1,
    )
    if not resp.headers.get("content-type", "").startswith("image/"):
        raise SourceError("scholar: photo not an image")
    return resp.content


# ── ORCID ────────────────────────────────────────────────────────────────────
def orcid_works(orcid: str) -> list[dict]:
    resp = fetch(f"https://pub.orcid.org/v3.0/{orcid}/works", headers={"Accept": "application/json"})
    out = []
    for group in resp.json().get("group", []):
        summary = (group.get("work-summary") or [{}])[0]
        ids = {
            e.get("external-id-type"): e.get("external-id-value")
            for e in (group.get("external-ids") or {}).get("external-id", [])
        }
        date = summary.get("publication-date") or {}

        def part(key: str) -> str | None:
            return ((date.get(key) or {}) or {}).get("value")

        out.append({
            "title": squash(((summary.get("title") or {}).get("title") or {}).get("value")),
            "type": summary.get("type"),
            "journal": squash((summary.get("journal-title") or {}).get("value")) or None,
            "year": int(part("year")) if part("year") else None,
            "month": part("month"), "day": part("day"),
            "doi": (ids.get("doi") or "").lower() or None,
            "url": ((summary.get("url") or {}) or {}).get("value"),
        })
    return out


# ── Crossref ─────────────────────────────────────────────────────────────────
CROSSREF = "https://api.crossref.org/works"
_CR_SELECT = "DOI,title,author,issued,published,container-title,type,abstract,is-referenced-by-count,volume,issue,page,article-number,URL"


def _crossref_item(item: dict) -> dict:
    parts = ((item.get("published") or item.get("issued") or {}).get("date-parts") or [[None]])[0]
    authors = []
    for a in item.get("author", []) or []:
        nm = squash(f"{a.get('given', '')} {a.get('family', '')}") or squash(a.get("name"))
        if nm:
            authors.append(nm)
    abstract = strip_tags(item.get("abstract"))
    abstract = re.sub(r"^(abstract)\s*[:.]?\s*", "", abstract, flags=re.I)
    return {
        "doi": (item.get("DOI") or "").lower() or None,
        "title": strip_tags((item.get("title") or [""])[0]),
        "authors": authors,
        "venue": strip_tags((item.get("container-title") or [""])[0]) or None,
        "type": item.get("type"),
        "year": parts[0] if parts else None,
        "date": "-".join(f"{p:02d}" if i else f"{p:04d}" for i, p in enumerate(parts)) if parts and parts[0] else None,
        "abstract": abstract or None,
        "volume": item.get("volume"), "issue": item.get("issue"),
        "pages": item.get("page") or item.get("article-number"),
        "citations": item.get("is-referenced-by-count"),
    }


def crossref_work(doi: str) -> dict:
    resp = fetch(f"{CROSSREF}/{requests_quote(doi)}", min_interval=1.05, retries=2, ok_statuses=(200, 404))
    if resp.status_code == 404:
        return {}
    return _crossref_item(resp.json().get("message", {}))


def crossref_search(query: str, *, rows: int = 5, filters: str | None = None, sort: str | None = None) -> list[dict]:
    params: dict[str, Any] = {"query.bibliographic": query, "rows": rows, "select": _CR_SELECT}
    if filters:
        params["filter"] = filters
    if sort:
        params["sort"], params["order"] = sort, "desc"
    resp = fetch(CROSSREF, params=params, min_interval=1.05, retries=2)
    return [_crossref_item(i) for i in resp.json().get("message", {}).get("items", [])]


def requests_quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="/")


# ── OpenAlex ─────────────────────────────────────────────────────────────────
# Look-ups of a single record by id/DOI are free and need no key. List/search calls are metered
# (a small free daily allowance per IP, or a free key via OPENALEX_API_KEY).
OPENALEX = "https://api.openalex.org"


def _abstract_from_index(inv: dict | None) -> str | None:
    if not inv:
        return None
    pos: list[tuple[int, str]] = [(i, w) for w, idxs in inv.items() for i in idxs]
    pos.sort()
    return squash(" ".join(w for _, w in pos)) or None


def openalex_work_brief(w: dict) -> dict:
    loc = w.get("primary_location") or {}
    src = loc.get("source") or {}
    oa = w.get("open_access") or {}
    best = w.get("best_oa_location") or {}
    authors, insts, countries = [], [], []
    for a in w.get("authorships", []) or []:
        nm = (a.get("author") or {}).get("display_name")
        if nm:
            authors.append(nm)
        for inst in a.get("institutions", []) or []:
            if inst.get("display_name"):
                insts.append(inst["display_name"])
            if inst.get("country_code"):
                countries.append(inst["country_code"])
    return {
        "openalex_id": (w.get("id") or "").rsplit("/", 1)[-1] or None,
        "doi": (w.get("doi") or "").replace("https://doi.org/", "").lower() or None,
        "title": squash(w.get("display_name") or w.get("title")),
        "authors": authors,
        "author_institutions": [
            {
                "name": (a.get("author") or {}).get("display_name"),
                "institutions": [i.get("display_name") for i in a.get("institutions", []) or [] if i.get("display_name")],
                "countries": [i.get("country_code") for i in a.get("institutions", []) or [] if i.get("country_code")],
            }
            for a in w.get("authorships", []) or []
        ],
        "institutions": sorted(set(insts)),
        "countries": sorted(set(countries)),
        "venue": src.get("display_name"),
        "year": w.get("publication_year"),
        "date": w.get("publication_date"),
        "type": w.get("type"),
        "abstract": _abstract_from_index(w.get("abstract_inverted_index")),
        "citations": w.get("cited_by_count"),
        "is_oa": bool(oa.get("is_oa")),
        "oa_url": oa.get("oa_url") or best.get("pdf_url") or best.get("landing_page_url"),
        "topics": [t.get("display_name") for t in (w.get("topics") or [])[:3] if t.get("display_name")],
        "related": [r.rsplit("/", 1)[-1] for r in (w.get("related_works") or [])[:10]],
        "url": loc.get("landing_page_url") or w.get("doi") or w.get("id"),
    }


def _oa_headers(key: str | None) -> dict:
    return {"Authorization": f"Bearer {key}"} if key else {}


def openalex_work(ident: str, key: str | None = None) -> dict:
    """ident: 'doi:10.x/y' or an OpenAlex work id like 'W123'. Free singleton look-up."""
    resp = fetch(f"{OPENALEX}/works/{ident}", headers=_oa_headers(key), min_interval=0.12,
                 retries=1, ok_statuses=(200, 404))
    if resp.status_code == 404:
        return {}
    return openalex_work_brief(resp.json())


def openalex_author(author_id: str, key: str | None = None) -> dict:
    resp = fetch(f"{OPENALEX}/authors/{author_id}", headers=_oa_headers(key), retries=1)
    a = resp.json()
    stats = a.get("summary_stats") or {}
    return {
        "works_count": a.get("works_count"),
        "cited_by_count": a.get("cited_by_count"),
        "h_index": stats.get("h_index"),
        "i10_index": stats.get("i10_index"),
        "topics": [t.get("display_name") for t in (a.get("topics") or [])[:8]],
        "counts_by_year": a.get("counts_by_year") or [],
    }


def openalex_search(key: str | None = None, **params: Any) -> list[dict]:
    """Metered list call. Raises SourceError when the free allowance is spent."""
    params.setdefault("per-page", 50)
    resp = fetch(f"{OPENALEX}/works", params=params, headers=_oa_headers(key), retries=0)
    return [openalex_work_brief(w) for w in resp.json().get("results", [])]


# ── Semantic Scholar ─────────────────────────────────────────────────────────
S2_FIELDS = "title,year,venue,publicationDate,externalIds,citationCount,authors,abstract,openAccessPdf,url,publicationTypes"


def s2_headers() -> dict:
    """Semantic Scholar works without a key but shares one rate limit among all anonymous callers;
    a free key (environment variable S2_API_KEY) makes it dependable."""
    import os
    key = os.environ.get("S2_API_KEY", "").strip()
    return {"x-api-key": key} if key else {}


def _s2_paper(p: dict) -> dict:
    ext = p.get("externalIds") or {}
    return {
        "s2_id": p.get("paperId"),
        "doi": (ext.get("DOI") or "").lower() or None,
        "arxiv": ext.get("ArXiv"),
        "title": squash(p.get("title")),
        "authors": [a.get("name") for a in p.get("authors") or [] if a.get("name")],
        "venue": squash(p.get("venue")) or None,
        "year": p.get("year"),
        "date": p.get("publicationDate"),
        "abstract": squash(p.get("abstract")) or None,
        "citations": p.get("citationCount"),
        "oa_url": ((p.get("openAccessPdf") or {}) or {}).get("url") or None,
        "url": p.get("url"),
    }


def s2_recommendations(positive_dois: list[str], limit: int = 200) -> list[dict]:
    """Papers Semantic Scholar judges similar to the given seed papers (recent work only)."""
    resp = fetch(
        "https://api.semanticscholar.org/recommendations/v1/papers",
        params={"fields": S2_FIELDS, "limit": limit}, method="POST",
        json_body={"positivePaperIds": [f"DOI:{d}" for d in positive_dois]},
        headers=s2_headers(), retries=5, min_interval=1.2, timeout=60,
    )
    return [_s2_paper(p) for p in resp.json().get("recommendedPapers", [])]


def s2_search(query: str, *, year_from: int, limit: int = 30) -> list[dict]:
    resp = fetch(
        "https://api.semanticscholar.org/graph/v1/paper/search",
        params={"query": query, "fields": S2_FIELDS, "limit": limit, "year": f"{year_from}-"},
        headers=s2_headers(), retries=4, min_interval=1.2, timeout=60,
    )
    return [_s2_paper(p) for p in resp.json().get("data", []) or []]


# ── arXiv ────────────────────────────────────────────────────────────────────
_ATOM = {"a": "http://www.w3.org/2005/Atom", "x": "http://arxiv.org/schemas/atom"}


def arxiv_search(query: str, *, max_results: int = 40) -> list[dict]:
    resp = fetch(
        "https://export.arxiv.org/api/query",
        params={"search_query": query, "sortBy": "submittedDate", "sortOrder": "descending",
                "max_results": max_results},
        min_interval=3.1, retries=2, timeout=60,
    )
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError as exc:
        raise SourceError(f"arxiv: bad XML ({exc})") from exc
    out = []
    for e in root.findall("a:entry", _ATOM):
        ident = (e.findtext("a:id", "", _ATOM) or "").rsplit("/abs/", 1)[-1]
        ident = re.sub(r"v\d+$", "", ident)
        pdf = next((l.get("href") for l in e.findall("a:link", _ATOM) if l.get("title") == "pdf"), None)
        doi = e.findtext("x:doi", None, _ATOM)
        out.append({
            "arxiv": ident,
            "doi": doi.lower() if doi else None,
            "title": squash(e.findtext("a:title", "", _ATOM)),
            "authors": [squash(a.findtext("a:name", "", _ATOM)) for a in e.findall("a:author", _ATOM)],
            "venue": "arXiv",
            "date": (e.findtext("a:published", "", _ATOM) or "")[:10] or None,
            "year": int((e.findtext("a:published", "0000", _ATOM) or "0000")[:4]) or None,
            "abstract": squash(e.findtext("a:summary", "", _ATOM)) or None,
            "categories": [c.get("term") for c in e.findall("a:category", _ATOM)],
            "oa_url": pdf, "url": f"https://arxiv.org/abs/{ident}",
        })
    return out
