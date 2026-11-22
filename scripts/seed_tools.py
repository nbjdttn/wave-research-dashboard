#!/usr/bin/env python3
"""Maintenance helpers for the funding cache — run the Claude steps *without* an API key.

The scheduled workflow does all of this automatically with the ANTHROPIC_API_KEY secret. These
commands exist so the same screening and analysis can be done by hand (for example in a Claude
chat or Claude Code session) and imported, which is how the site's first data set was produced.

    python scripts/seed_tools.py export-triage  FILE     # calls still needing a keep/drop decision
    python scripts/seed_tools.py import-triage  FILE     # [{"id":…, "keep":true, "reason":…}, …]
    python scripts/seed_tools.py export-analysis DIR     # one brief per shortlisted call
    python scripts/seed_tools.py validate-analysis DIR   # check DIR/<id>.json answers against the schema
    python scripts/seed_tools.py import-analysis DIR     # DIR/<id>.json answers → cache
    python scripts/seed_tools.py import-schemes FILE     # recurring-scheme catalogue → watch-list
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wave import funders as F  # noqa: E402
from wave import grants as G  # noqa: E402
from wave.claude import ANALYSIS_SCHEMA, PROMPT_VERSION, _tidy, fill_blanks, system_prompt  # noqa: E402
from wave.util import CACHE, CONFIG, load_config, log, read_json, sha, today, write_json  # noqa: E402

SEED_MODEL = "claude (build-time review)"


def validate(value, schema, path="$") -> list[str]:
    """Tiny JSON-schema checker for the subset used by ANALYSIS_SCHEMA."""
    if "anyOf" in schema:
        errs = [validate(value, s, path) for s in schema["anyOf"]]
        return [] if any(not e for e in errs) else [f"{path}: matches none of the allowed shapes"]
    t = schema.get("type")
    if t == "null":
        return [] if value is None else [f"{path}: expected null"]
    if t == "string":
        if not isinstance(value, str):
            return [f"{path}: expected string, got {type(value).__name__}"]
        if "enum" in schema and value not in schema["enum"]:
            return [f"{path}: '{value}' not in {schema['enum']}"]
        return []
    if t == "integer":
        return [] if isinstance(value, int) and not isinstance(value, bool) else [f"{path}: expected integer"]
    if t == "boolean":
        return [] if isinstance(value, bool) else [f"{path}: expected boolean"]
    if t == "array":
        if not isinstance(value, list):
            return [f"{path}: expected array"]
        return [e for i, v in enumerate(value) for e in validate(v, schema["items"], f"{path}[{i}]")]
    if t == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected object"]
        errs = [f"{path}: missing '{k}'" for k in schema.get("required", []) if k not in value]
        errs += [f"{path}: unexpected '{k}'" for k in value if k not in schema["properties"]]
        for k, sub in schema["properties"].items():
            if k in value:
                errs += validate(value[k], sub, f"{path}.{k}")
        return errs
    return []


def _state(cfg):
    cache = G.load_cache()
    live, eu, arch = cache.get("ukri_live", []), cache.get("eu_live", []), cache.get("ukri_archive", [])
    pool = G.build_pool(live, eu, arch, cfg["grants"])
    return cache, pool, arch


def export_triage(cfg, out: Path) -> None:
    cache, pool, _ = _state(cfg)
    need = [it for it in pool.values() if (cache["triage"].get(it["id"]) or {}).get("hash") != it["_th"]]
    rows = []
    for it in sorted(need, key=lambda i: (i["source"], i["status"], -i["_kw"])):
        when = f"closes {it['closes'][:10]}" if it.get("closes") else (it.get("closes_note") or "no date")
        text = it.get("summary") or (it.get("description") or "")
        rows.append({"id": it["id"], "title": it["title"], "funder": it.get("funder"), "status": it["status"],
                     "when": when, "summary": text[:420]})
    write_json(out, rows)
    log(f"{len(rows)} calls written to {out}")


def import_triage(cfg, src: Path) -> None:
    cache, pool, _ = _state(cfg)
    n = 0
    for d in read_json(src, []) or []:
        it = pool.get(d.get("id"))
        if it:
            cache["triage"][it["id"]] = {"hash": it["_th"], "keep": bool(d["keep"]),
                                         "reason": str(d.get("reason", ""))[:140], "by": SEED_MODEL}
            n += 1
    G.save_cache(cache)
    log(f"{n} triage decisions stored ({sum(1 for t in cache['triage'].values() if t['keep'])} kept in total)")


def export_analysis(cfg, outdir: Path) -> None:
    cache, pool, arch = _state(cfg)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "_system.md").write_text(system_prompt(cfg), encoding="utf-8")
    (outdir / "_schema.json").write_text(json.dumps(ANALYSIS_SCHEMA, indent=1), encoding="utf-8")
    index = []
    for it in G.shortlist_from(pool, cache["triage"], cfg["grants"]):
        prep = G.prepare(it, arch, cache)
        have = cache["analysis"].get(it["id"], {})
        if (have.get("content") or have.get("facts_hash")) == sha(prep["facts"], prep["body_hash"]):
            continue
        user = (f"Today is {today().isoformat()}. Assess this funding opportunity for the researcher.\n\n"
                f"# Listing facts (authoritative for status and dates)\n{prep['facts']}\n\n"
                + (f"# Earlier rounds of what looks like the same scheme\n{prep['hist']}\n\n" if prep["hist"] else "")
                + f"# Text of the call\n{prep['body']}")
        (outdir / f"{it['id']}.md").write_text(user, encoding="utf-8")
        index.append({"id": it["id"], "title": it["title"], "status": it["status"], "chars": len(user)})
    G.save_cache(cache)   # keeps the fetched call texts
    write_json(outdir / "_index.json", index)
    log(f"{len(index)} briefs written to {outdir}")


def import_analysis(cfg, src: Path) -> None:
    cache, pool, arch = _state(cfg)
    prompt_hash = sha(PROMPT_VERSION, system_prompt(cfg))
    ok = bad = 0
    for f in sorted(src.glob("*.json")):
        if f.name.startswith("_"):
            continue
        it = pool.get(f.stem)
        data = read_json(f)
        if not it or not isinstance(data, dict):
            log(f"  skip {f.name}: unknown id or unreadable")
            bad += 1
            continue
        errs = validate(fill_blanks(data), ANALYSIS_SCHEMA)
        if errs:
            log(f"  {f.name}: " + "; ".join(errs[:4]))
            bad += 1
            continue
        prep = G.prepare(it, arch, cache, fetch_detail=False)
        cache["analysis"][it["id"]] = {
            "content": sha(prep["facts"], prep["body_hash"]), "profile": prompt_hash,
            "at": today().isoformat(), "model": SEED_MODEL, "seeded": True, "data": _tidy(data)}
        ok += 1
    G.save_cache(cache)
    log(f"{ok} analyses imported, {bad} rejected")


def import_schemes(cfg, src: Path) -> None:
    """Catalogue of recurring schemes (researched by hand) → watch-list + first analyses."""
    cache, _, _ = _state(cfg)
    doc = read_json(src) or {}
    watch, ok, bad = [], 0, 0
    for s in doc.get("schemes", []):
        a = dict(s.get("analysis") or {})
        dl = a.pop("deadline", None) or {}
        focus = a.get("focus")
        score = int(a.get("fit_score") or 0)
        # the catalogue judged topic through `focus`; whether it is worth applying is `recommend`
        a.setdefault("topic_fit", {
            "verdict": ("off_topic" if focus == "ai_only" else "open_call" if focus == "open"
                        else "core" if score >= 85 else "strong"),
            "notes": a.get("why_fit") or ""})
        a["round"] = {
            "status": s.get("status") or "unknown", "opens": s.get("opens"), "closes": s.get("closes"),
            "closes_time": s.get("closes_time") or dl.get("time"), "stage": dl.get("stage"),
            "other_dates": [{"label": str(d.get("label")), "date": str(d.get("date"))} for d in dl.get("other_dates") or []],
            "notes": dl.get("notes")}
        rec = dict(s.get("recurrence") or {})
        a["recurrence"] = {k: rec.get(k) for k in ("cadence", "typical_open_month", "typical_close_month",
                                                    "next_expected_open", "next_expected_close", "is_estimate", "evidence")}
        a["recurrence"]["cadence"] = a["recurrence"]["cadence"] or "unknown"
        a["recurrence"]["is_estimate"] = bool(a["recurrence"]["is_estimate"])
        if a.get("role") not in ("lead", "co_lead", "partner", "host", "any"):
            a["role"] = "any"
        if a.get("focus") not in ("domain", "domain_ai", "ai_only", "open"):
            a["focus"] = "open"
        errs = validate(fill_blanks(a), ANALYSIS_SCHEMA)
        if errs:
            log(f"  {s.get('slug')}: " + "; ".join(errs[:5]))
            bad += 1
            continue
        sc = {"slug": s["slug"], "title": s["title"], "funder": s["funder"], "url": s["url"],
              "note": s.get("typical_cycle") or None}
        watch.append(sc)
        sid = f"scheme-{s['slug']}"
        cache["analysis"][sid] = {"hash": "seed", "at": doc.get("researched_on") or today().isoformat(),
                                  "model": SEED_MODEL, "seeded": True, "data": _tidy(a),
                                  "last_round": s.get("last_round"), "source_urls": s.get("source_urls") or [],
                                  "confidence": s.get("confidence")}
        ok += 1
    write_json(CONFIG / "schemes.json", {
        "_about": "Recurring funder schemes without a machine-readable feed. The daily job re-reads each page "
                  "and asks Claude to refresh the round dates. Add or remove entries freely.",
        "schemes": watch})
    G.save_cache(cache)
    log(f"{ok} schemes imported, {bad} rejected → config/schemes.json")


def validate_dir(cfg, src: Path) -> None:
    """Check hand-written answers against the schema before importing them."""
    bad = 0
    for f in sorted(src.glob("*.json")):
        if f.name.startswith("_"):
            continue
        data = read_json(f)
        errs = ["not valid JSON"] if not isinstance(data, dict) else validate(fill_blanks(data), ANALYSIS_SCHEMA)
        if errs:
            bad += 1
            print(f"{f.name}: " + "; ".join(errs[:6]))
    print(f"{len(list(src.glob('*.json')))} files checked, {bad} with problems")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    cmd, arg = sys.argv[1], Path(sys.argv[2])
    {"export-triage": export_triage, "import-triage": import_triage, "export-analysis": export_analysis,
     "import-analysis": import_analysis, "import-schemes": import_schemes,
     "validate-analysis": validate_dir}[cmd](load_config(), arg)
