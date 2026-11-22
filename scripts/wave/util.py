"""Shared helpers: HTTP with polite retries, JSON I/O, text normalisation, dates."""
from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import tomllib
import unicodedata
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
CACHE = DATA / "cache"
CONFIG = ROOT / "config"

# A deliberately generic client name: no personal or project details leave the machine in headers.
API_UA = "research-dashboard/1.0 (static site builder)"
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)


class SourceError(RuntimeError):
    """A data source could not be read. Callers keep their previous snapshot."""


def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


# ── config ───────────────────────────────────────────────────────────────────
def load_config() -> dict:
    with open(CONFIG / "researcher.toml", "rb") as fh:
        cfg = tomllib.load(fh)
    model = os.environ.get("CLAUDE_MODEL", "").strip()
    if model:
        cfg.setdefault("claude", {})["model"] = model
    return cfg


# ── JSON ─────────────────────────────────────────────────────────────────────
def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj: Any, compact: bool = False) -> None:
    """Write deterministically so unchanged data produces no git diff."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=False)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text + "\n", encoding="utf-8")
    tmp.replace(path)


# ── HTTP ─────────────────────────────────────────────────────────────────────
_session: requests.Session | None = None
_last_hit: dict[str, float] = {}


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({"User-Agent": API_UA, "Accept-Language": "en-GB,en;q=0.9"})
    return _session


def fetch(
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    method: str = "GET",
    data: Any = None,
    json_body: Any = None,
    files: Any = None,
    timeout: float = 40,
    retries: int = 3,
    min_interval: float = 0.0,
    ok_statuses: tuple[int, ...] = (200,),
    browser: bool = False,
) -> requests.Response:
    """GET/POST with exponential backoff. `min_interval` throttles per host (seconds)."""
    host = re.sub(r"^https?://([^/]+).*$", r"\1", url)
    hdrs = dict(headers or {})
    if browser:
        hdrs.setdefault("User-Agent", BROWSER_UA)
    last: Exception | None = None
    for attempt in range(retries + 1):
        wait = min_interval - (time.monotonic() - _last_hit.get(host, 0.0))
        if wait > 0:
            time.sleep(wait)
        try:
            resp = session().request(
                method, url, params=params, headers=hdrs, data=data, json=json_body,
                files=files, timeout=timeout, allow_redirects=True,
            )
            _last_hit[host] = time.monotonic()
            if resp.status_code in ok_statuses:
                return resp
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                retry_after = resp.headers.get("retry-after", "")
                delay = float(retry_after) if retry_after.isdigit() else 2.0 * (2 ** attempt)
                if delay > 45:  # a long ban (e.g. a spent daily budget): give up, do not stall the run
                    raise SourceError(f"{host}: HTTP {resp.status_code}, retry-after {retry_after}s")
                time.sleep(delay)
                continue
            raise SourceError(f"{host}: HTTP {resp.status_code} for {url[:120]}")
        except requests.RequestException as exc:  # network trouble: back off and retry
            _last_hit[host] = time.monotonic()
            last = exc
            if attempt < retries:
                time.sleep(1.5 * (2 ** attempt))
                continue
            raise SourceError(f"{host}: {type(exc).__name__}: {exc}") from exc
    raise SourceError(f"{host}: gave up ({last})")


# ── text ─────────────────────────────────────────────────────────────────────
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def strip_tags(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    return _WS.sub(" ", html.unescape(_TAG.sub(" ", s))).strip()


def squash(s: str | None) -> str:
    return _WS.sub(" ", s or "").strip()


def norm_title(s: str | None) -> str:
    """Lower-case, accent-free, punctuation-free key for matching titles across sources."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("non-linear", "nonlinear").replace("non linear", "nonlinear")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return _WS.sub(" ", s).strip()


def title_similarity(a: str, b: str) -> float:
    """Token Jaccard on normalised titles, with a prefix bonus for truncated strings."""
    na, nb = norm_title(a), norm_title(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    short, long_ = (na, nb) if len(na) <= len(nb) else (nb, na)
    if len(short) >= 30 and long_.startswith(short):
        return 0.97
    ta, tb = set(na.split()), set(nb.split())
    return len(ta & tb) / max(1, len(ta | tb))


def sha(*parts: Any, n: int = 16) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p if isinstance(p, str) else json.dumps(p, sort_keys=True, ensure_ascii=False)).encode())
        h.update(b"\x1f")
    return h.hexdigest()[:n]


def slugify(s: str, n: int = 60) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", norm_title(s))).strip("-")[:n]


# ── dates ────────────────────────────────────────────────────────────────────
def today() -> dt.date:
    """UTC date; override with WAVE_TODAY=YYYY-MM-DD for reproducible test runs."""
    forced = os.environ.get("WAVE_TODAY")
    if forced:
        return dt.date.fromisoformat(forced)
    return dt.datetime.now(dt.timezone.utc).date()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(s: str | None) -> dt.date | None:
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return dt.date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.match(r"(\d{4})-(\d{2})$", s)
    if m:
        try:
            return dt.date(int(m[1]), int(m[2]), 1)
        except ValueError:
            return None
    return None


def days_until(s: str | None) -> int | None:
    d = parse_date(s)
    return (d - today()).days if d else None
