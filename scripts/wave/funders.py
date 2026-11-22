"""Readers for the funding sources that publish machine-readable listings:

* UKRI Funding Finder (all UK research councils + Innovate UK) — HTML listing with <time> stamps
* EU Funding & Tenders portal (Horizon Europe incl. ERC and MSCA) — public search API

plus a generic page-to-text reader used for funder scheme pages that have no feed.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import Iterator

from bs4 import BeautifulSoup

from .util import SourceError, fetch, log, parse_date, sha, squash, strip_tags, today

# ── UKRI ─────────────────────────────────────────────────────────────────────
UKRI_LIST = "https://www.ukri.org/opportunity/"
MONTHS = {m: i for i, m in enumerate(
    "january february march april may june july august september october november december".split(), 1)}


def _uk_date(text: str) -> str | None:
    m = re.search(r"(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", text or "")
    if not m or m.group(2).lower() not in MONTHS:
        return None
    return f"{int(m.group(3)):04d}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"


def _ukri_page(statuses: list[str], page: int) -> tuple[list[dict], int]:
    params = {f"filter_status[{i}]": s for i, s in enumerate(statuses)}
    params.update({"filter_order": "publication_date", "filter_submitted": "true"})
    url = UKRI_LIST if page == 1 else f"{UKRI_LIST}page/{page}/"
    resp = fetch(url, params=params, browser=True, min_interval=0.7, timeout=50, ok_statuses=(200, 404))
    if resp.status_code == 404:
        return [], 0
    soup = BeautifulSoup(resp.text, "html.parser")
    pages = [int(x) for x in re.findall(r"/opportunity/page/(\d+)/", resp.text)]
    items = []
    for card in soup.select("div.opportunity.type-opportunity"):
        link = card.select_one("a.ukri-funding-opp__link")
        if not link:
            continue
        rows: dict[str, tuple[str, str | None]] = {}
        for row in card.select("dl.opportunity__summary div.govuk-table__row"):
            dt_, dd = row.find("dt"), row.find("dd")
            if not dt_ or not dd:
                continue
            tm = dd.find("time")
            rows[squash(dt_.get_text(" ")).rstrip(":").strip().lower()] = (
                squash(dd.get_text(" ")), tm.get("datetime") if tm else None)
        summary = card.select_one(".entry-content")
        status = rows.get("opportunity status", ("", None))[0].lower()
        closes_txt, closes_iso = rows.get("closing date", ("", None))
        opens_txt, opens_iso = rows.get("opening date", ("", None))
        funders = [squash(x) for x in rows.get("funders", ("", None))[0].split(",") if squash(x)]
        co = [squash(x) for x in rows.get("co-funders", ("", None))[0].split(",") if squash(x)]
        post_id = (card.get("id") or "").replace("post-", "")
        items.append({
            "id": f"ukri-{post_id}",
            "source": "ukri",
            "title": squash(link.get_text(" ")),
            "url": link.get("href"),
            "summary": squash(summary.get_text(" ")) if summary else "",
            "status": "open" if status.startswith("open") else "upcoming" if status.startswith("upcoming") else "closed",
            "funders": funders, "co_funders": co,
            "funder": _short_funder(funders),
            "funding_type": rows.get("funding type", ("", None))[0] or None,
            "total_fund": rows.get("total fund", ("", None))[0] or None,
            "max_award": rows.get("maximum award", ("", None))[0] or None,
            "min_award": rows.get("minimum award", ("", None))[0] or None,
            "award_range": (rows.get("award range") or rows.get("award") or ("", None))[0] or None,
            "published": _uk_date(rows.get("publication date", ("", None))[0]),
            "opens": opens_iso or _uk_date(opens_txt),
            "closes": closes_iso or _uk_date(closes_txt),
            "closes_note": None if (closes_iso or _uk_date(closes_txt)) else (closes_txt or None),
        })
    return items, (max(pages) if pages else 1)


COUNCILS = {
    "engineering and physical sciences research council": "EPSRC",
    "natural environment research council": "NERC",
    "science and technology facilities council": "STFC",
    "medical research council": "MRC",
    "biotechnology and biological sciences research council": "BBSRC",
    "economic and social research council": "ESRC",
    "arts and humanities research council": "AHRC",
    "uk research and innovation": "UKRI",
    "innovate uk": "Innovate UK",
    "research england": "Research England",
}


def funder_codes(funders: list[str]) -> list[str]:
    names = []
    for f in funders:
        key = re.sub(r"\s*\(.*?\)\s*", "", f).strip().lower()
        names.append(COUNCILS.get(key, re.sub(r"\s*\(.*?\)\s*", "", f).strip()))
    return list(dict.fromkeys(names))


def _short_funder(funders: list[str]) -> str:
    names = funder_codes(funders)
    if len(names) > 1 and "UKRI" in names:
        names.remove("UKRI")
    if len(names) > 2:          # several councils behind one call: it is a cross-UKRI opportunity
        return "UKRI"
    return " · ".join(names) or "UKRI"


def short_funder(item: dict) -> str:
    return _short_funder(item.get("funders") or []) if item.get("source") == "ukri" else (item.get("funder") or "")


def ukri_listing(statuses: list[str], *, max_pages: int = 20, published_after: dt.date | None = None,
                 stop_at_ids: set[str] | None = None) -> list[dict]:
    """Walk the Funding Finder (newest first). Stops early at the look-back limit, or once a whole
    page consists of ids we have already stored (incremental refresh of the closed archive)."""
    out: list[dict] = []
    page, last = 1, 1
    while page <= min(last, max_pages):
        items, last = _ukri_page(statuses, page)
        if not items:
            break
        out.extend(items)
        if published_after and all((parse_date(i["published"]) or today()) < published_after for i in items):
            break
        if stop_at_ids is not None and all(i["id"] in stop_at_ids for i in items):
            break
        page += 1
    seen, unique = set(), []
    for i in out:
        if i["id"] not in seen:
            seen.add(i["id"])
            unique.append(i)
    return unique


# Sections of a UKRI opportunity page that are the same boilerplate on every call. They are left
# out of the text given to the model so the call-specific parts (scope, eligibility, what to
# submit, dates) fit comfortably; nothing call-specific is removed.
UKRI_BOILERPLATE = re.compile(
    r"equality, diversity|trusted research|personal data|generative artificial|use of hyperlinks|^references$|"
    r"animal involvement|genetically modified|human participation|human tissue|publication of outcomes|"
    r"responsible research|research and innovation impact|supporting skills and talent|bullying and harassment|"
    r"research disruption|sensitive information|our commitment|principles of assessment|^feedback$|"
    r"find out about|grant terms and conditions|research integrity|data management|ask about this|"
    r"get help with|webinar recording|accessibility", re.I)
LIMIT_SENTENCE = re.compile(r"[^.\n]*\b\d[\d,]*\s*(?:words?|pages?|characters?|minutes?)\b[^.\n]*\.?", re.I)


def ukri_detail(url: str, max_chars: int = 26000) -> dict:
    resp = fetch(url, browser=True, min_interval=0.7, timeout=50)
    soup = BeautifulSoup(resp.text, "html.parser")
    main = soup.find("main") or soup
    for junk in main.select("script, style, nav, form, .ukri-related-content, .govuk-breadcrumbs, #feedback, footer"):
        junk.decompose()
    updated = None
    m = re.search(r"Last updated:\s*(\d{1,2} [A-Za-z]+ \d{4})", main.get_text(" "))
    if m:
        updated = _uk_date(m.group(1))

    intro: list[str] = []
    sections: list[tuple[str, str, str]] = []  # (h2, h3, text)
    h2 = h3 = ""
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf
        text = squash(" ".join(buf))
        if text:
            if h2:
                sections.append((h2, h3, text))
            else:
                intro.append(text)
        buf = []

    for el in main.find_all(["h2", "h3", "p", "li", "dt", "dd", "th", "td"]):
        if el.name in ("h2", "h3"):
            flush()
            title = squash(el.get_text(" "))
            if el.name == "h2":
                h2, h3 = title, ""
            else:
                h3 = title
        else:
            if el.find(["p", "li"]):  # container cell; children are visited on their own
                continue
            t = squash(el.get_text(" "))
            if t:
                buf.append(("• " + t) if el.name == "li" else t)
    flush()

    parts = ["\n".join(intro)[:2500]]
    for sec_h2, sec_h3, text in sections:
        if UKRI_BOILERPLATE.search(sec_h3 or "") or UKRI_BOILERPLATE.search(sec_h2 or ""):
            continue
        if re.search(r"questions we will ask|application questions|sections of the application", sec_h2, re.I) \
                or re.search(r"^(vision|approach|applicant and team|resources and cost|project partners|core team|"
                             r"summary|facilities|ethics|your organisation|references)", sec_h3 or "", re.I):
            # An application section: keep its name, its stated limits and a short gist.
            limits = " ".join(dict.fromkeys(squash(x) for x in LIMIT_SENTENCE.findall(text)))[:400]
            text = f"{text[:260]}{' … ' + limits if limits and limits not in text[:260] else ''}"
        else:
            # the scope decides topic fit, so it gets the most room; other sections a fair share
            room = 5000 if re.search(r"scope|what we will fund", sec_h3 or "", re.I) else \
                3000 if re.search(r"eligib|funding available|who can apply|how to apply|deadline|assess", f"{sec_h2} {sec_h3}", re.I) else 2000
            text = text[:room] + (" […]" if len(text) > room else "")
        parts.append(f"\n## {sec_h2}" + (f" — {sec_h3}" if sec_h3 else "") + f"\n{text}")
    body = "\n".join(p for p in parts if p.strip())
    if len(body) > max_chars:
        body = body[:max_chars].rsplit("\n", 1)[0] + "\n[text shortened]"
    return {"text": body, "updated": updated, "hash": sha(body)}


# ── EU Funding & Tenders ─────────────────────────────────────────────────────
EU_API = "https://api.tech.ec.europa.eu/search-api/prod/rest/search"
EU_STATUS = {"31094501": "upcoming", "31094502": "open", "31094503": "closed"}
EU_PROGRAMMES = {"43108390": "Horizon Europe", "44181033": "Euratom", "43152860": "Digital Europe",
                 "43252405": "LIFE", "43251567": "Connecting Europe Facility", "43392145": "EMFAF"}


def _first(meta: dict, key: str) -> str | None:
    v = meta.get(key)
    return (v[0] if isinstance(v, list) and v else v) or None


def _eu_item(res: dict) -> dict | None:
    meta = res.get("metadata") or {}
    ident = _first(meta, "identifier")
    if not ident:
        return None
    deadlines = sorted(d[:10] for d in (meta.get("deadlineDate") or []) if d)
    upcoming = [d for d in deadlines if d >= today().isoformat()]
    budget = None
    try:
        overview = json.loads(_first(meta, "budgetOverview") or "{}")
        for actions in (overview.get("budgetTopicActionMap") or {}).values():
            for a in actions:
                if str(a.get("action", "")).startswith(ident):
                    lo, hi, n = a.get("minContribution"), a.get("maxContribution"), a.get("expectedGrants")
                    total = sum(v for v in (a.get("budgetYearMap") or {}).values() if isinstance(v, (int, float)))
                    budget = {"min": lo, "max": hi, "expected_grants": n, "topic_budget": total or None}
    except (ValueError, TypeError):
        pass
    programme = EU_PROGRAMMES.get(_first(meta, "frameworkProgramme") or "", "EU programme")
    prefix = "ERC" if ident.startswith("ERC-") else "MSCA" if "MSCA" in ident else programme
    return {
        "id": f"eu-{ident}",
        "source": "eu",
        "identifier": ident,
        "title": squash(_first(meta, "title") or res.get("title") or ident),
        "url": f"https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/{ident}",
        "summary": "",
        "description": strip_tags(_first(meta, "descriptionByte"))[:9000],
        "conditions": strip_tags(_first(meta, "topicConditions"))[:3500],
        "status": EU_STATUS.get(_first(meta, "status") or "", "unknown"),
        "funders": ["European Commission"], "co_funders": [],
        "funder": prefix,
        "programme": programme,
        "call_id": _first(meta, "callIdentifier"),
        "call_title": squash(_first(meta, "callTitle")),
        "action_type": "; ".join(meta.get("typesOfAction") or []) or None,
        "deadline_model": _first(meta, "deadlineModel"),
        "all_deadlines": deadlines,
        "priorities": meta.get("crossCuttingPriorities") or [],
        "budget": budget,
        "funding_type": "Grant",
        "published": None,
        "opens": (_first(meta, "startDate") or "")[:10] or None,
        "closes": (upcoming[0] if upcoming else (deadlines[-1] if deadlines else None)),
        "closes_note": None,
    }


def eu_search(text: str, *, statuses: tuple[str, ...] = ("31094501", "31094502"), page_size: int = 50,
              pages: int = 1) -> list[dict]:
    query = {"bool": {"must": [{"terms": {"type": ["1", "2", "8"]}}, {"terms": {"status": list(statuses)}}]}}
    out = []
    for page in range(1, pages + 1):
        resp = fetch(
            EU_API, method="POST",
            params={"apiKey": "SEDIA", "text": text, "pageSize": page_size, "pageNumber": page},
            files={
                "query": (None, json.dumps(query), "application/json"),
                "languages": (None, '["en"]', "application/json"),
                "sort": (None, '{"order":"DESC","field":"relevance"}', "application/json"),
            },
            min_interval=0.5, timeout=60, retries=2,
        )
        results = resp.json().get("results") or []
        for r in results:
            x = _eu_item(r)
            # the index leaves old topics flagged "open": keep only those with a deadline still ahead
            if x and (not x["all_deadlines"] or x["all_deadlines"][-1] >= today().isoformat()):
                out.append(x)
        if len(results) < page_size:
            break
    return out


def eu_text(item: dict) -> str:
    b = item.get("budget") or {}
    money = ""
    if b.get("max"):
        money = (f"EU contribution per grant: €{b['min']:,.0f}–€{b['max']:,.0f}" if b.get("min") and b["min"] != b["max"]
                 else f"EU contribution per grant: about €{b['max']:,.0f}")
        if b.get("expected_grants"):
            money += f"; expected number of grants: {b['expected_grants']}"
    lines = [
        f"Topic: {item['identifier']} — {item['title']}",
        f"Programme: {item['programme']} | Call: {item.get('call_id')} {item.get('call_title') or ''}",
        f"Type of action: {item.get('action_type')}",
        f"Submission model: {item.get('deadline_model')} | Opening: {item.get('opens')} | Deadline(s): {', '.join(item.get('all_deadlines') or []) or 'not stated'}",
        money,
        f"Cross-cutting priorities: {', '.join(item.get('priorities') or [])}",
        "", "## Topic description", item.get("description") or "(no description published yet)",
        "", "## Conditions and documents", item.get("conditions") or "(not published yet)",
    ]
    return "\n".join(x for x in lines if x is not None)


# ── generic funder page ──────────────────────────────────────────────────────
def page_text(url: str, max_chars: int = 16000) -> dict:
    """Readable text of a funder's scheme page (navigation, scripts and footers removed)."""
    resp = fetch(url, browser=True, min_interval=1.0, timeout=45, retries=1)
    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype and "text" not in ctype:
        raise SourceError(f"{url}: not an HTML page ({ctype})")
    soup = BeautifulSoup(resp.text, "html.parser")
    for junk in soup.select("script, style, noscript, nav, header, footer, form, aside, svg, iframe, "
                            "[role=navigation], .cookie, .cookies, .breadcrumb, .breadcrumbs, .menu, .nav"):
        junk.decompose()
    main = soup.find("main") or soup.find(attrs={"role": "main"}) or soup.find("article") or soup.body or soup
    chunks = []
    for el in main.find_all(["h1", "h2", "h3", "h4", "p", "li", "td", "th", "dt", "dd"]):
        if el.find(["p", "li", "table"]):
            continue
        t = squash(el.get_text(" "))
        if not t:
            continue
        if el.name in ("h1", "h2", "h3", "h4"):
            chunks.append(f"\n## {t}")
        else:
            chunks.append(("• " + t) if el.name == "li" else t)
    text = "\n".join(dict.fromkeys(chunks))  # drop exact repeats (menus rendered twice, etc.)
    if len(text) < 400:
        raise SourceError(f"{url}: page has too little readable text (likely script-rendered or blocked)")
    if len(text) > max_chars:
        text = text[:max_chars].rsplit("\n", 1)[0] + "\n[text shortened]"
    # the hash ignores digits-only noise such as visitor counters, but keeps dates
    return {"text": text, "hash": sha(re.sub(r"\s+", " ", text))}


def iter_title_family(title: str) -> Iterator[str]:
    """Normalised 'family' key of a call title: years, round numbers and stage labels removed, so
    that 'Knowledge Transfer Partnership: 2026 to 2027 round 4' and '…2025 to 2026 round 2' match."""
    t = title.lower()
    t = re.sub(r"\b(19|20)\d\d(\s*(to|-|–|/)\s*(19|20)?\d\d)?\b", " ", t)
    t = re.sub(r"\b(round|phase|call|cohort|wave|stage|batch)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b", " ", t)
    t = re.sub(r"\b(pre-announcement|outline|full|invited|invite only|expression of interest|eoi|spring|summer|autumn|winter)\b", " ", t)
    t = re.sub(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b", " ", t)
    t = re.sub(r"[^a-z]+", " ", t)
    yield squash(t)
