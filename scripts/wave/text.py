"""Small, dependency-free text similarity: tokeniser, phrase matcher and TF-IDF.

The same tokeniser is re-implemented in assets/js/similarity.js so the web page can rank live
search results against the profile exactly the way the pipeline does. Keep the two in step.
"""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter

STOP = set("""
a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had
has have having he her here hers him his how i if in into is it its itself just me more most my no
nor not now of off on once only or other our out over own same she should so some such than that
the their them then there these they this those through to too under until up very was we were
what when where which while who whom why will with would you your
study studies paper article work works result results show shows shown present presents presented
propose proposes proposed approach approaches method methods using use used based new novel also
however thus therefore within without between among via towards toward can may might well one two
three first second both due given obtain obtained obtains find finds found provide provides
provided investigate investigates investigated investigation analysis analyse analyze analysed
analyzed demonstrate demonstrates demonstrated consider considered considers different various
several many much high low large small good better best important significant significantly
respectively particular particularly compared comparison case cases effect effects et al fig figure
table abstract introduction conclusion conclusions
""".split())

_TOKEN = re.compile(r"[a-z0-9]+")


def normalise(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = t.replace("non-linear", "nonlinear").replace("non linear", "nonlinear")
    return re.sub(r"[‐‑‒–—−-]", " ", t)


def stem(tok: str) -> str:
    """Very light plural stripping; enough to merge wave/waves, load/loads, statistics/statistic."""
    if len(tok) > 4 and tok.endswith("ies"):
        return tok[:-3] + "y"
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith(("ss", "us", "is")):
        return tok[:-1]
    return tok


def tokens(text: str) -> list[str]:
    return [stem(t) for t in _TOKEN.findall(normalise(text))]


def terms(text: str) -> list[str]:
    """Unigrams (no stop-words, no bare numbers) plus bigrams of neighbouring content words."""
    toks = tokens(text)
    keep = [t for t in toks if t not in STOP and len(t) > 1 and not t.isdigit()]
    out = list(keep)
    prev = None
    for t in toks:
        ok = t not in STOP and len(t) > 1 and not t.isdigit()
        if ok and prev:
            out.append(f"{prev} {t}")
        prev = t if ok else None
    return out


def phrase_hits(text: str, weights: dict[str, float]) -> tuple[float, list[str]]:
    """Sum of weights of the phrases present in `text` (matched on stemmed tokens)."""
    hay = " " + " ".join(tokens(text)) + " "
    score, hits = 0.0, []
    for phrase, w in weights.items():
        needle = " " + " ".join(tokens(phrase)) + " "
        if needle.strip() and needle in hay:
            score += w
            hits.append(phrase)
    return score, hits


class Tfidf:
    def __init__(self, docs: list[str], max_vocab: int = 4000):
        self.n = max(1, len(docs))
        df: Counter[str] = Counter()
        for d in docs:
            df.update(set(terms(d)))
        common = [t for t, c in df.most_common() if c >= 2 or " " not in t][:max_vocab]
        self.idf = {t: math.log((1 + self.n) / (1 + df[t])) + 1.0 for t in common}

    @classmethod
    def from_idf(cls, idf: dict[str, float]) -> "Tfidf":
        obj = cls.__new__(cls)
        obj.n, obj.idf = 0, dict(idf)
        return obj

    def vector(self, text: str, top: int = 60) -> dict[str, float]:
        tf = Counter(t for t in terms(text) if t in self.idf)
        if not tf:
            return {}
        vec = {t: (1 + math.log(c)) * self.idf[t] for t, c in tf.items()}
        if len(vec) > top:
            vec = dict(sorted(vec.items(), key=lambda kv: -kv[1])[:top])
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        return {t: round(v / norm, 4) for t, v in vec.items()}


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(t, 0.0) for t, v in a.items())
