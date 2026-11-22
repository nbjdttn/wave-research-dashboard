// Scores any paper against the researcher's profile, in the browser.
// This mirrors scripts/wave/text.py and the scoring in scripts/wave/papers.py — keep them in step.

const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being
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
table abstract introduction conclusion conclusions`.split(/\s+/));

const normalise = (text) => (text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/non-linear|non linear/g, 'nonlinear').replace(/[‐‑‒–—−-]/g, ' ');

function stem(tok) {
  if (tok.length > 4 && tok.endsWith('ies')) return tok.slice(0, -3) + 'y';
  if (tok.length > 3 && tok.endsWith('s') && !/(ss|us|is)$/.test(tok)) return tok.slice(0, -1);
  return tok;
}
export const tokens = (text) => (normalise(text).match(/[a-z0-9]+/g) || []).map(stem);

function terms(text) {
  const toks = tokens(text);
  const ok = (t) => !STOP.has(t) && t.length > 1 && !/^\d+$/.test(t);
  const out = toks.filter(ok);
  let prev = null;
  for (const t of toks) {
    const good = ok(t);
    if (good && prev) out.push(`${prev} ${t}`);
    prev = good ? t : null;
  }
  return out;
}

function phraseHits(text, weights) {
  const hay = ` ${tokens(text).join(' ')} `;
  let score = 0;
  const hits = [];
  for (const [phrase, w] of Object.entries(weights || {})) {
    const needle = ` ${tokens(phrase).join(' ')} `;
    if (needle.trim() && hay.includes(needle)) { score += w; hits.push(phrase); }
  }
  return [score, hits];
}

function vector(text, idf, top = 60) {
  const tf = new Map();
  for (const t of terms(text)) if (idf[t] != null) tf.set(t, (tf.get(t) || 0) + 1);
  let entries = [...tf].map(([t, c]) => [t, (1 + Math.log(c)) * idf[t]]);
  if (entries.length > top) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, top);
  const norm = Math.sqrt(entries.reduce((a, [, v]) => a + v * v, 0)) || 1;
  return new Map(entries.map(([t, v]) => [t, v / norm]));
}

/** Build a scorer from data/similarity.json. */
export function makeScorer(model) {
  const venues = (model.venues || []).map((v) => v.toLowerCase());
  return (paper) => {
    const text = `${paper.title}. ${paper.title}. ${paper.abstract || ''}`;
    const vec = vector(text, model.idf);
    const sims = model.vectors.map((v) => {
      let dot = 0;
      for (const [t, w] of vec) if (v.v[t]) dot += w * v.v[t];
      return [dot, v.id];
    }).sort((a, b) => b[0] - a[0]);
    const [best, bestId] = sims[0] || [0, null];
    const top3 = sims.slice(0, 3).reduce((a, [c]) => a + c, 0) / Math.max(1, Math.min(3, sims.length));
    const closeness = Math.min(1, (0.55 * best + 0.45 * top3) / 0.34);
    const [core, coreHits] = phraseHits(text, model.core);
    const [meth, methHits] = phraseHits(text, model.methods);
    const [avoid] = phraseHits(text, model.avoid);
    const domain = Math.min(1, core / 6), method = Math.min(1, meth / 4);
    const venue = (paper.venue || '').toLowerCase();
    let score = 0.46 * closeness + (core >= 1 ? 0.24 * domain + 0.08 * method : 0.03 * method);
    if (venue && venues.some((v) => venue.includes(v))) score += 0.05;
    score -= Math.min(0.4, 0.13 * avoid);
    // live results have no recommender signal, so stretch the scale to match the feed's
    score = Math.max(0, Math.min(1, score / 0.83));
    return {
      score: Math.round(score * 100),
      nearId: best >= 0.12 ? bestId : null,
      matched: [...coreHits, ...methHits].slice(0, 6),
      focus: core >= 1 && method > 0 ? 'domain_ai' : core >= 1 ? 'domain' : method > 0 ? 'ai_only' : 'adjacent',
    };
  };
}
