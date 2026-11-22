// Shared helpers: escaping, dates, icons, local storage, tooltip and toast.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML. Every value that comes from a data file goes through this. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** Only http(s) links are ever rendered. */
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? esc(u) : '#');

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── dates ────────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
/** 'YYYY-MM-DD…' or 'YYYY-MM' → local Date at midnight (month-only → the 1st). */
export function parseDay(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
}
export const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Whole days from today to the given date (negative = past). */
export function daysTo(s) {
  const d = parseDay(s);
  return d ? Math.round((d - today()) / 864e5) : null;
}
export function fmtDate(s, { year = 'auto', long = false } = {}) {
  if (!s) return '';
  const d = parseDay(s);
  if (!d) return esc(s);
  const names = long ? MONTHS_LONG : MONTHS;
  const monthOnly = /^\d{4}-\d{2}$/.test(s);
  const showYear = year === true || monthOnly || (year === 'auto' && d.getFullYear() !== today().getFullYear());
  return `${monthOnly ? '' : d.getDate() + ' '}${names[d.getMonth()]}${showYear ? ' ' + d.getFullYear() : ''}`;
}
export const fmtMonth = (s) => { const d = parseDay(s); return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; };
export const fmtTime = (s) => { const m = /T(\d{2}):(\d{2})/.exec(s || ''); return m ? `${m[1]}:${m[2]}` : ''; };
export function longToday() {
  const d = today();
  return `${DAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
export function rel(days) {
  if (days == null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const a = Math.abs(days);
  const unit = a < 14 ? `${a} days` : a < 70 ? `${Math.round(a / 7)} weeks` : `${Math.round(a / 30.4)} months`;
  return days > 0 ? `in ${unit}` : `${unit} ago`;
}
export function left(days) {
  if (days == null) return '';
  if (days < 0) return 'closed';
  if (days === 0) return 'closes today';
  if (days === 1) return '1 day left';
  return days < 100 ? `${days} days left` : `${Math.round(days / 30.4)} months left`;
}
export function ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 6e4);
  if (!Number.isFinite(mins)) return '';
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 36) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/** Split off the first sentence. Abbreviations, initials and decimals do not end a sentence. */
const ABBR = /(?:\b(?:e\.g|i\.e|etc|vs|approx|no|st|dr|prof|fig|al|inc|ltd|jr|sr)\.|\b[A-Z]\.)$/i;
export function splitSentence(text) {
  const t = String(text ?? '').trim();
  const re = /[.!?](?=\s+["“'(£€]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(t))) {
    const head = t.slice(0, m.index + 1);
    if (head.length < 25 || ABBR.test(head)) continue;
    return [head, t.slice(m.index + 1).trim()];
  }
  return [t, ''];
}
/**
 * Keep it short: show the first sentence, cut at a clause if that is still long;
 * the full text is one tap away. Always returns a single element.
 */
export function brief(text, limit = 150) {
  const full = String(text ?? '').trim();
  let [shown] = splitSentence(full);
  if (shown.length > limit) {
    const head = shown.slice(0, limit);
    const clause = Math.max(...[', ', '; ', ' — ', ' – ', ': '].map((m) => head.lastIndexOf(m)));
    const cut = clause > limit * 0.55 ? clause : head.lastIndexOf(' ');
    shown = `${head.slice(0, cut > 0 ? cut : limit)
      .replace(/(?:[\s,;:–—-]+(?:a|an|the|of|to|and|or|with|for|in|on|at|by|that|which|from|as))+$/i, '')   // do not end on a small word
      .replace(/[\s,;:–—-]+$/, '')}…`;
  }
  if (shown === full) return `<span class="brief">${esc(full)}</span>`;
  return `<span class="brief"><span class="lede">${esc(shown)}</span> <button class="more-btn" type="button" data-more aria-expanded="false">more</button><span class="rest" hidden>${esc(full)}</span></span>`;
}

export const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));
export const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;

/** 'A. Smith, B. Jones and 4 others' */
export function people(list, total, max = 3) {
  const n = total ?? list.length;
  if (!list?.length) return '';
  const shown = list.slice(0, n > max ? max : n).map(esc);
  if (n > max) return `${shown.join(', ')} <span class="muted">+${n - max}</span>`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
}
export const initials = (name) => name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]).filter((c, i, a) => i === 0 || i === a.length - 1).join('').toUpperCase();

// ── icons ────────────────────────────────────────────────────────────────────
const PATHS = {
  ext: '<path d="M14 5h5v5M19 5l-8 8M11 6H6.500A1.500 1.500 0 0 0 5 7.500v10A1.500 1.500 0 0 0 6.500 19h10a1.500 1.500 0 0 0 1.500-1.500V13"/>',
  save: '<path d="M7 4.500h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.500a1 1 0 0 1 1-1z"/>',
  cal: '<rect x="4" y="5.500" width="16" height="14.500" rx="2.500"/><path d="M4 10h16M8.500 3.500v4M15.500 3.500v4"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.500M12 17.300v.2"/>',
  info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500M12 7.700v.2"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M16 16l4 4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  quote: '<path d="M9.500 7C6.500 8 5 10.300 5 13.500V17h5v-5H7.500c0-1.800.8-3 2.500-3.600zM18.500 7c-3 1-4.500 3.300-4.500 6.500V17h5v-5h-2.500c0-1.800.8-3 2.500-3.600z"/>',
  spark: '<path d="M12 3.500l1.800 5.200 5.200 1.800-5.200 1.800L12 17.500l-1.800-5.200L5 10.500l5.200-1.800zM18.500 15.500l.8 2.200 2.200.8-2.200.8-.8 2.200-.8-2.200-2.200-.8 2.200-.8z"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M4 14.500h16M10 5v14"/>',
  chart: '<path d="M5 19V9M10 19V5M15 19v-7M20 19v-4"/>',
  pdf: '<path d="M7 3.500h7l4.500 4.500v12.500H7z"/><path d="M14 3.500V8h4.500"/>',
  copy: '<rect x="8" y="8" width="11.500" height="11.500" rx="2"/><path d="M5 15.500V6a1.500 1.500 0 0 1 1.500-1.500H15"/>',
  wave: '<path d="M3 13c2.200 0 2.500-4 4.500-4s2.300 7 4.500 7 2.200-10 4.500-10 2.200 7 4.500 7"/>',
  host: '<circle cx="9" cy="9" r="3.200"/><path d="M3.500 19c.5-3 2.700-4.800 5.500-4.800s5 1.800 5.500 4.800M16 6.500a2.800 2.800 0 0 1 0 5.400M17.500 14.600c1.700.6 2.700 2.100 3 4.400"/>',
  repeat: '<path d="M17 4l3 3-3 3M20 7H8a4 4 0 0 0-4 4v1M7 20l-3-3 3-3M4 17h12a4 4 0 0 0 4-4v-1"/>',
};
export const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;

// ── local storage (per-device conveniences only; the page works without it) ──
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('wave.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('wave.' + key, JSON.stringify(value)); } catch { /* private mode: ignore */ }
  },
  raw(key, value) {
    try { if (value === undefined) return localStorage.getItem('wave.' + key); localStorage.setItem('wave.' + key, value); } catch { /* ignore */ }
    return null;
  },
};

/** A saved-items collection that keeps a snapshot, so a saved paper survives leaving the feed. */
export function shelf(key) {
  let items = store.get(key, {});
  return {
    has: (id) => Object.prototype.hasOwnProperty.call(items, id),
    all: () => Object.values(items),
    toggle(obj) {
      if (this.has(obj.id)) delete items[obj.id]; else items[obj.id] = { ...obj, saved_at: isoDay(today()) };
      store.set(key, items);
      return this.has(obj.id);
    },
    get size() { return Object.keys(items).length; },
  };
}

// ── tooltip & toast ──────────────────────────────────────────────────────────
const tip = () => document.getElementById('tooltip');
export function showTip(html, x, y) {
  const el = tip();
  el.innerHTML = html;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const left_ = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  el.style.left = `${left_}px`;
  el.style.top = `${top}px`;
}
export function hideTip() { const el = tip(); if (el) el.hidden = true; }
window.addEventListener('scroll', hideTip, { passive: true });

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

export async function copyText(text, done = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy not available in this browser'); }
}

/** Download a small text file (used for calendar entries and BibTeX). */
export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
