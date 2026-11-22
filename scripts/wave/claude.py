"""Claude-powered steps of the funding pipeline.

Runs only inside the scheduled GitHub Action (or locally) and only when the ANTHROPIC_API_KEY
environment variable is set — the key is never shipped to the web page.

Three jobs, all returning schema-validated JSON:
  * triage()   – one cheap batch call: which newly listed calls deserve a closer look?
  * analyse()  – one call per opportunity: topic fit, career-stage fit, eligibility, deadline,
                 what must be submitted, how much effort it is, and whether the call repeats.
  * research() – for a funder page the script could not read itself: Claude looks it up with the
                 web search / web fetch tools and returns notes that analyse() then structures.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from .util import log, squash, today

try:  # the site still builds without the SDK or a key; funding entries are then left un-analysed
    import anthropic
except ImportError:  # pragma: no cover
    anthropic = None  # type: ignore[assignment]

PROMPT_VERSION = "2026-11-c"   # bump to force every opportunity to be re-analysed

# Approximate list prices in USD per million tokens (input, output) — used only for the run log.
PRICES = {"claude-opus-5-5": (4, 20), "claude-sonnet-5-5": (2, 10), "claude-haiku-5-5": (0.1, 0.5),
          "claude-fable-5-2": (8, 40), "claude-opus-5": (5, 25), "claude-sonnet-5": (2, 10)}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


# "Not stated" is an empty string (or 0 for a month), never null. A nullable field is a union type,
# and the API allows at most 16 of those per schema and compiles them slowly; this schema has none.
# _tidy() turns the blanks back into None, so the cache and the page still see null.
STR = {"type": "string"}
NSTR = {"type": "string"}     # may be "" = not stated
NINT = {"type": "integer"}    # may be 0 = not known
BLANKABLE = {                 # object → its fields that may be blank
    None: ("concerns",),
    "round": ("opens", "closes", "closes_time", "stage", "notes"),
    "award_summary": ("amount", "duration"),
    "effort": ("start_by",),
    "recurrence": ("typical_open_month", "typical_close_month", "next_expected_open", "next_expected_close", "evidence"),
}
DATE = r"\d{4}-\d{2}(-\d{2})?$"
DATE_FIELDS = {"opens": DATE, "closes": DATE, "start_by": DATE, "next_expected_open": DATE, "next_expected_close": DATE,
               "closes_time": r"\d{1,2}:\d{2}$"}
THEMES = ["ocean", "offshore-energy", "coastal", "fluids", "climate-environment", "digital-twin",
          "ai-for-science", "infrastructure", "international", "industry", "any-discipline"]

ANALYSIS_SCHEMA = _obj({
    "summary": STR,
    "topic_fit": _obj({
        "verdict": {"type": "string", "enum": ["core", "strong", "partial", "open_call", "off_topic"]},
        "notes": STR,
    }),
    "career_stage": _obj({
        "verdict": {"type": "string", "enum": ["ideal", "suitable", "stretch", "too_early", "too_senior", "not_applicable"]},
        "notes": STR,
    }),
    "eligibility": _obj({
        "verdict": {"type": "string", "enum": ["eligible", "likely", "check", "not_eligible"]},
        "notes": STR,
    }),
    "fit_score": {"type": "integer"},
    "fit_label": {"type": "string", "enum": ["excellent", "strong", "possible", "weak"]},
    "why_fit": STR,
    "concerns": NSTR,
    "recommend": {"type": "boolean"},
    "recommend_reason": STR,
    "focus": {"type": "string", "enum": ["domain", "domain_ai", "ai_only", "open"]},
    "themes": {"type": "array", "items": {"type": "string", "enum": THEMES}},
    "opportunity_type": {"type": "string", "enum": [
        "project_grant", "fellowship", "network", "travel_exchange", "prize", "innovation", "hosting",
        "compute_equipment", "other"]},
    "role": {"type": "string", "enum": ["lead", "co_lead", "partner", "host", "any"]},
    "round": _obj({
        "status": {"type": "string", "enum": ["open", "upcoming", "rolling", "closed", "unknown"]},
        "opens": NSTR, "closes": NSTR, "closes_time": NSTR, "stage": NSTR,
        "other_dates": {"type": "array", "items": _obj({"label": STR, "date": STR})},
        "notes": NSTR,
    }),
    "award_summary": _obj({"amount": NSTR, "duration": NSTR}),
    "requirements": {"type": "array", "items": _obj({"item": STR, "detail": NSTR})},
    "effort": _obj({
        "level": {"type": "string", "enum": ["light", "moderate", "heavy", "major"]},
        "prep_time": STR, "person_days": STR,
        "drivers": {"type": "array", "items": STR},
        "start_by": NSTR,
    }),
    "recurrence": _obj({
        "cadence": {"type": "string", "enum": ["annual", "twice_yearly", "quarterly", "rolling", "irregular", "one_off", "unknown"]},
        "typical_open_month": NINT, "typical_close_month": NINT,
        "next_expected_open": NSTR, "next_expected_close": NSTR,
        "is_estimate": {"type": "boolean"},
        "evidence": NSTR,
    }),
    "next_steps": {"type": "array", "items": STR},
})

RELEVANCE = re.compile(r"\brelevan|\byour?\b", re.I)      # a bullet about the reader, not the paper: dropped

BULLETS_SCHEMA = _obj({
    "papers": {"type": "array", "items": _obj({
        "id": STR,
        "bullets": {"type": "array", "items": STR},
    })},
})

TRIAGE_SCHEMA = _obj({
    "decisions": {"type": "array", "items": _obj({
        "id": STR,
        "keep": {"type": "boolean"},
        "reason": STR,
    })},
})


def system_prompt(cfg: dict) -> str:
    r, c, i = cfg["researcher"], cfg["career"], cfg["interests"]
    phd = c.get("phd_award_year") or 0
    phd_line = (f"PhD awarded {phd} ({today().year - phd} years ago)." if phd else
                f"{c.get('phd_note') or 'PhD award date is not recorded'}. Where a scheme has a 'years since PhD' "
                "rule that this uncertainty could decide, say exactly what date to verify and set eligibility to "
                "\"check\"; where the rule is clearly met or clearly missed either way, say so.")
    bullets = lambda xs: "\n".join(f"- {x}" for x in xs)  # noqa: E731
    return f"""You are a research-funding adviser working for one academic. You read funding calls and decide, \
strictly and honestly, whether each one is worth this person's time. They have asked for a short list: only \
opportunities that fit BOTH their research topic AND their career stage. A call that fails either test must not be \
recommended, however prestigious. When in doubt, leave it out — a missed marginal call costs little, a cluttered list \
makes the tool useless.

# The researcher
{r['name']} — {r['title']}, {r['department']}, {r['institution']} ({r['location']}).
Career stage: {c['stage']} (appointed {c['appointed_year']}). {c['phd']}. {phd_line}
Previous roles: {'; '.join(c.get('previous_roles', []))}.
Currently holds: {'; '.join(c.get('current_awards', [])) or 'no major awards recorded'}.
Group: {c.get('group', '')}
Recognition: {'; '.join(c.get('recognition', []))}.

Research: {squash(i['summary'])}

What they want funding for right now:
{bullets(c.get('priorities', []))}

What they do NOT want to see:
{bullets(c.get('not_wanted', []))}

# How to judge
topic_fit — judged on the science only:
- "core": the call is squarely about ocean waves (including spectral wave modelling and forecasting, and nonlinear \
wave-wave interactions), wave-structure interaction, offshore/marine renewable energy, coastal or ocean \
hydrodynamics, air-sea interaction, extreme events in fluids, or scientific machine learning applied to such problems.
- "strong": a neighbouring area where their expertise is clearly wanted (fluid mechanics, digital twins of physical \
systems, ocean/climate/environmental prediction, energy infrastructure, AI for science and engineering). NERC's \
remit counts here — physical oceanography, marine and coastal processes, environmental prediction — whenever the \
science involves waves, ocean or coastal modelling, air-sea interaction or forecasting.
- "open_call": the scheme is open to any topic in their discipline (responsive-mode grants, personal fellowships, \
discipline-wide prizes) so they could propose their own research.
- "partial": only a small part of the call touches their work.
- "off_topic": anything else — including calls purely about core AI/ML research with no physical-science application.

career_stage — judged on who the scheme is really for:
- "ideal": designed for early-career / new academics building independence.
- "suitable": open to them and realistic for an early-career principal investigator.
- "stretch": possible, but they would be an unusually junior (or senior) applicant, or would have to lead something \
very large. Say what would make it credible.
- "too_early": aimed at established professors, large centres or programme-scale consortia they could not credibly lead yet.
- "too_senior": aimed at people more junior than them (doctoral or postdoctoral awards they cannot hold themselves).
- "not_applicable": they would act only as host, mentor or partner. Use role "host" or "partner" in that case.

eligibility — apply the call's own rules to them (UK university, permanent academic post). Use "not_eligible" when a \
rule clearly excludes them (wrong country, wrong sector, invite-only, a scheme they already hold and cannot hold twice).

recommend — true only if topic_fit is core/strong/open_call AND career_stage is ideal/suitable (or stretch with a \
convincing reason, or not_applicable for a hosting/partner role they explicitly want) AND eligibility is not \
"not_eligible" AND the opportunity is real value for the effort. Purely AI/ML calls are never recommended.

fit_score (0-100) summarises all of the above: 85+ excellent, 70-84 strong, 45-69 possible, below 45 weak. \
fit_label must match the score band.

focus: "domain" (physical science/engineering call), "domain_ai" (AI applied to science/engineering), \
"ai_only" (pure AI/ML/computing call), "open" (any discipline / bottom-up).

# Deadline, requirements and effort — the part they care about most
- round: the current or next round. Use the listing facts given to you as the authority for status and dates; add the \
stage (outline, expression of interest, full application...) and any other key dates you find (intent to submit, \
webinar, interviews, panel, latest start date). Dates are ISO "YYYY-MM-DD"; closes_time is 24-hour UK time "HH:MM". \
Use an empty string "" for anything not stated (and 0 for an unknown month). Never invent a date.
- requirements: the concrete checklist of what they must prepare or supply, in the order they would tackle it — \
each proposal section with its word or page limit, CV / track-record format, costings, letters of support, partner \
commitments, head-of-department or institutional statements, internal selection steps, registration on a submission \
system. 4-10 items, each a short noun phrase with the specific limit in `detail`. Take them from the text; if the \
call text does not list them, give the standard components for that scheme and write "typical — confirm in the \
guidance" in `detail`.
- effort.level: "light" = a few days (short form, no partners, no full costing); "moderate" = 1-3 weeks of part-time \
work; "heavy" = 1-2 months (full case for support, costings, letters); "major" = 3 months or more (consortium \
building, multi-stage, interview). prep_time is a phrase of at most six words such as "3-4 weeks part-time"; person_days a bare \
range such as "10-15". drivers: 2-4 short phrases naming what makes it that much work. start_by: the latest sensible date \
to begin, counted back from the deadline using your prep_time (ISO date), or "" when there is no deadline.
- recurrence: does this call repeat? Use the round history supplied, round numbers in the title, and statements in \
the text. cadence "one_off" for a single strategic call; "rolling" for always-open schemes. If the current round is \
closed or not yet announced and the call repeats, estimate next_expected_open / next_expected_close as "YYYY-MM" \
from past rounds and set is_estimate true, citing the evidence. If the next round is officially announced, give the \
announced months and set is_estimate false.
- next_steps: 2-3 concrete actions, most important first.

# Brevity — this is read on a phone and the researcher has asked for no long paragraphs
Write plainly, in British English, addressing the researcher as "you". Every text field is ONE short sentence \
or phrase. No hedging, no restating the title, no second sentence.
- summary: at most 22 words — what is funded and for whom.
- every `notes` field, why_fit, concerns, recommend_reason: at most 20 words each.
- requirements: `item` at most 6 words; `detail` at most 14 words — the limit or specific only.
- effort.drivers: at most 6 words each. next_steps: at most 3, each at most 14 words, starting with a verb.
- round.notes and recurrence.evidence: at most 20 words, or "".
- concerns: "" when there is nothing worth flagging."""


class Budget(RuntimeError):
    """Raised when the per-run spending guard is reached."""


class Claude:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        cc = cfg.get("claude", {})
        self.model = cc.get("model", "claude-opus-5-5")
        self.effort = cc.get("effort", "medium")
        self.max_calls = int(cc.get("max_calls_per_run", 40))
        self.use_web = bool(cc.get("use_web_tools", True))
        self.calls = 0
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0, "web_searches": 0}
        self.errors: list[str] = []
        self.client = None
        if anthropic is not None and os.environ.get("ANTHROPIC_API_KEY", "").strip():
            self.client = anthropic.Anthropic(max_retries=2, timeout=600.0)
        self._system = [{"type": "text", "text": system_prompt(cfg), "cache_control": {"type": "ephemeral"}}]

    @property
    def available(self) -> bool:
        return self.client is not None

    @property
    def remaining(self) -> int:
        return max(0, self.max_calls - self.calls)

    def cost_estimate(self) -> float:
        pin, pout = PRICES.get(self.model, (4, 20))
        u = self.usage
        return round((u["input_tokens"] * pin + u["cache_creation_input_tokens"] * pin * 1.25
                      + u["cache_read_input_tokens"] * pin * 0.1 + u["output_tokens"] * pout) / 1e6
                     + u["web_searches"] * 0.01, 3)

    # ── low level ────────────────────────────────────────────────────────────
    def _request(self, *, user: str, schema: dict | None, tools: list | None = None,
                 max_tokens: int = 16000, effort: str | None = None) -> Any:
        """One Messages API call with refusal fallback; returns the final message (or None)."""
        if not self.available:
            return None
        if self.calls >= self.max_calls:
            raise Budget(f"reached max_calls_per_run={self.max_calls}")
        self.calls += 1
        output_config: dict = {"effort": effort or self.effort}
        if schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": schema}
        kwargs: dict = dict(model=self.model, max_tokens=max_tokens, system=self._system,
                            thinking={"type": "adaptive"}, output_config=output_config,
                            messages=[{"role": "user", "content": user}])
        if tools:
            kwargs["tools"] = tools
        # Server-side refusal fallback: if a safety classifier declines, the API retries on the
        # model Anthropic recommends. Not offered on Haiku, which simply returns the refusal.
        if "haiku" not in self.model:
            kwargs["betas"] = ["server-side-fallback-2026-07-01"]
            kwargs["fallbacks"] = "default"
        try:
            msg = self.client.beta.messages.create(**kwargs)
            for _ in range(4):  # a long web-tool turn can pause; re-send to let the server resume it
                if msg.stop_reason != "pause_turn":
                    break
                self._count(msg)
                kwargs["messages"] = [{"role": "user", "content": user}, {"role": "assistant", "content": msg.content}]
                msg = self.client.beta.messages.create(**kwargs)
        except anthropic.AuthenticationError as exc:
            self.errors.append("Claude API key was rejected (401) — check the ANTHROPIC_API_KEY secret.")
            self.client = None
            log("  claude: authentication failed:", exc.message)
            return None
        except anthropic.PermissionDeniedError as exc:
            self.errors.append(f"Claude API refused the request (403): {exc.message}")
            self.client = None
            return None
        except anthropic.NotFoundError as exc:
            self.errors.append(f"Model '{self.model}' was not found — check CLAUDE_MODEL / config.")
            self.client = None
            log("  claude:", exc.message)
            return None
        except anthropic.BadRequestError as exc:
            self.errors.append(f"Claude API rejected a request (400): {exc.message[:200]}")
            log("  claude: bad request:", exc.message)
            return None
        except anthropic.RateLimitError as exc:
            self.errors.append("Claude API rate limit reached — the rest will be analysed on the next run.")
            log("  claude: rate limited:", exc.message)
            raise Budget("rate limited") from exc
        except anthropic.APIStatusError as exc:
            self.errors.append(f"Claude API error {exc.status_code}")
            log("  claude: API error", exc.status_code, exc.message)
            return None
        except anthropic.APIConnectionError as exc:
            self.errors.append("Could not reach the Claude API.")
            log("  claude: connection error:", exc)
            return None
        self._count(msg)
        if msg.stop_reason == "refusal":
            log("  claude: request declined by a safety classifier — skipped")
            return None
        if msg.stop_reason == "max_tokens":
            log("  claude: response hit max_tokens — skipped")
            return None
        return msg

    def _count(self, msg: Any) -> None:
        u = getattr(msg, "usage", None)
        if not u:
            return
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            self.usage[k] += getattr(u, k, 0) or 0
        stu = getattr(u, "server_tool_use", None)
        if stu:
            self.usage["web_searches"] += getattr(stu, "web_search_requests", 0) or 0

    @staticmethod
    def _text(msg: Any) -> str:
        return "".join(b.text for b in msg.content if b.type == "text") if msg else ""

    def _json(self, msg: Any) -> dict | None:
        text = self._text(msg)
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            log("  claude: response was not valid JSON — skipped")
            return None

    # ── jobs ─────────────────────────────────────────────────────────────────
    def triage(self, items: list[dict]) -> dict[str, dict]:
        """Screen listing entries (title + one-paragraph summary). Returns {id: {keep, reason}}."""
        out: dict[str, dict] = {}
        for start in range(0, len(items), 60):
            chunk = items[start:start + 60]
            lines = []
            for it in chunk:
                when = (f"closes {it['closes'][:10]}" if it.get("closes") else (it.get("closes_note") or "no date"))
                lines.append(f"[{it['id']}] {it['title']} — {it.get('funder')}; {it['status']}, {when}"
                             f"{'; ' + it['summary'][:420] if it.get('summary') else ''}")
            user = (
                "Screening pass. Below are funding calls from a public listing (id in brackets). For each one decide "
                "whether it deserves a full read for this researcher. Keep it ONLY if, on the face of it, it could "
                "pass both tests — topic (core, strong or open to their discipline) and career stage — and they could "
                "plausibly apply, co-lead, partner or host. Closed calls are included so that recurring schemes can "
                "be prepared for in advance: keep a closed call only if it looks like a repeating scheme that would "
                "suit them next time. Drop medical, biological, social-science, arts, business-only, invite-only and "
                "purely AI/ML calls. Give a reason of at most 12 words. Return a decision for every id.\n\n"
                + "\n".join(lines))
            data = self._json(self._request(user=user, schema=TRIAGE_SCHEMA, effort="low", max_tokens=12000))
            for d in (data or {}).get("decisions", []):
                out[d["id"]] = {"keep": bool(d["keep"]), "reason": squash(d["reason"])[:140]}
        return out

    def bullets(self, papers: list[dict]) -> dict[str, list[str]]:
        """Two or three short bullet points per paper, from its abstract. Returns {id: [bullet, …]}."""
        out: dict[str, list[str]] = {}
        for start in range(0, len(papers), 12):
            chunk = papers[start:start + 12]
            blocks = "\n\n".join(f"[{p['id']}] {p['title']}\n{p['abstract']}" for p in chunk)
            user = (
                "Below are new papers (id in brackets, title, abstract) from the researcher's reading feed. For each, write "
                "the summary they would want on a phone: two bullet points, or three when there is a second real result, "
                "each at most 12 words, plain and specific. First: what was done. Then: what was found, with the number "
                "if the abstract gives one. Do NOT say why the paper is relevant or how it relates to the researcher — "
                "everything in the feed is relevant. No hedging, no 'this paper', no restating the title, nothing that "
                "is not in the abstract. Return every id.\n\n" + blocks)
            try:
                data = self._json(self._request(user=user, schema=BULLETS_SCHEMA, effort="low", max_tokens=6000))
            except Budget:
                break
            for row in (data or {}).get("papers", []):
                points = [squash(b).rstrip(".") for b in row.get("bullets") or [] if squash(b) and not RELEVANCE.search(b)][:3]
                if points:
                    out[row["id"]] = points
        return out

    def analyse(self, facts: str, body: str, history: str = "") -> dict | None:
        """Full assessment of one opportunity. `facts` = authoritative listing data."""
        user = (
            f"Today is {today().isoformat()}. Assess this funding opportunity for the researcher.\n\n"
            f"# Listing facts (authoritative for status and dates)\n{facts}\n\n"
            + (f"# Earlier rounds of what looks like the same scheme\n{history}\n\n" if history else "")
            + f"# Text of the call\n{body}")
        data = self._json(self._request(user=user, schema=ANALYSIS_SCHEMA))
        return _tidy(data) if data else None

    def research(self, title: str, funder: str, url: str) -> str | None:
        """Look a scheme up on the web when its page could not be fetched directly."""
        if not (self.available and self.use_web):
            return None
        new = "haiku" not in self.model  # newer tool versions need Opus/Sonnet/Fable
        host = url.split("/")[2] if "//" in url else None
        tools = [
            {"type": "web_fetch_20260209" if new else "web_fetch_20250910", "name": "web_fetch",
             "max_uses": 3, "max_content_tokens": 12000},
            {"type": "web_search_20260209" if new else "web_search_20250305", "name": "web_search", "max_uses": 2},
        ]
        user = (
            f"Today is {today().isoformat()}. Find the current state of this funding scheme from the funder's own "
            f"website: \"{title}\" ({funder}). Start with {url}"
            + (f" and stay on {host} where you can" if host else "") + ".\n\n"
            "Report, as plain notes with the page URL beside each fact: whether a round is open now and its opening "
            "and closing dates and times; dates of the previous round; when the next round is expected; who is "
            "eligible (career stage, years since PhD, institution, nationality); the award amount and duration; and "
            "exactly what an applicant must submit (sections, page or word limits, CV format, letters, statements, "
            "internal selection). Quote dates exactly as written. If you cannot confirm something, say so — do not guess.")
        msg = self._request(user=user, schema=None, tools=tools, max_tokens=8000)
        notes = self._text(msg)
        return notes if len(notes) > 200 else None


def fill_blanks(a: dict) -> dict:
    """The reverse of what _tidy() does to blanks: None → "" / 0, so stored answers fit the API schema again."""
    for owner, keys in BLANKABLE.items():
        obj = a if owner is None else a.get(owner)
        if isinstance(obj, dict):
            for k in keys:
                if obj.get(k) is None and k in obj:
                    obj[k] = 0 if k.startswith("typical_") else ""
    for r in a.get("requirements") or []:
        if isinstance(r, dict) and r.get("detail") is None:
            r["detail"] = ""
    return a


def _tidy(a: dict) -> dict:
    """Clamp and normalise a model answer so the page can rely on its shape."""
    for owner, keys in BLANKABLE.items():                 # blanks ("" / 0 / placeholders) become None
        obj = a if owner is None else a.get(owner)
        for k in keys if isinstance(obj, dict) else ():
            v = obj.get(k)
            if isinstance(v, str):
                v = squash(v)
                if k in DATE_FIELDS and not re.match(DATE_FIELDS[k], v):
                    v = ""                                # "not stated", "TBC" … are not dates
                elif v.lower() in ("null", "none", "n/a", "not stated", "unknown"):
                    v = ""
            if k.startswith("typical_") and not (isinstance(v, int) and 1 <= v <= 12):
                v = None
            obj[k] = v or None
    for r in a.get("requirements") or []:
        r["detail"] = squash(r.get("detail")) or None
    for owner, k in ((a.get("topic_fit"), "verdict"), (a.get("career_stage"), "verdict"), (a.get("eligibility"), "verdict"),
                     (a, "fit_label"), (a, "focus"), (a, "opportunity_type"), (a, "role"),
                     (a.get("round"), "status"), (a.get("effort"), "level"), (a.get("recurrence"), "cadence")):
        if isinstance(owner, dict) and isinstance(owner.get(k), str):
            owner[k] = owner[k].strip().lower()           # enum casing is not guaranteed by the API
    a["fit_score"] = max(0, min(100, int(a.get("fit_score") or 0)))
    s = a["fit_score"]
    a["fit_label"] = "excellent" if s >= 85 else "strong" if s >= 70 else "possible" if s >= 45 else "weak"
    for k in ("summary", "why_fit", "recommend_reason"):
        a[k] = squash(a.get(k))
    a["requirements"] = [r for r in a.get("requirements") or [] if squash(r.get("item"))][:12]
    a["next_steps"] = [squash(x) for x in a.get("next_steps") or [] if squash(x)][:5]
    a["effort"]["drivers"] = [squash(x) for x in a["effort"].get("drivers") or [] if squash(x)][:5]
    prep = squash(a["effort"].get("prep_time"))
    if len(prep) > 34:  # the card shows this in a narrow cell: keep the first clause, move the rest
        clauses = [c.strip(" ,.") for c in re.split(
            r"[;:(]|,\s|\s[—–-]\s|\s(?:including|incl\.|with|plus|mostly|mainly|depending|because|once|then)\s", prep)]
        clauses = [c for c in clauses if c]
        head = next((c for c in clauses if re.search(r"\d", c)), clauses[0] if clauses else prep)
        if len(head) > 34:
            head = head[:34].rsplit(" ", 1)[0]
        if len(head) >= 4:
            if prep not in a["effort"]["drivers"]:
                a["effort"]["drivers"] = ([prep] + a["effort"]["drivers"])[:5]
            prep = head
    a["effort"]["prep_time"] = prep
    return a
