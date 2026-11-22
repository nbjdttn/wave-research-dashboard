// Wave Research — bootstrap, routing and the settings sheet.
import { $, $$, esc, icon, store, shelf, toast, ago, daysTo, fmtDate, safeUrl, num, shellHeight } from './util.js';
import { clearCharts } from './charts.js';
import { paperIndex, isLive } from './cards.js';
import { renderToday } from './view-today.js';
import { renderPapers } from './view-papers.js';
import { renderFunding } from './view-funding.js';
import { renderProfile } from './view-profile.js';

const VIEWS = { today: renderToday, papers: renderPapers, funding: renderFunding, profile: renderProfile };
const TITLES = { today: 'Today', papers: 'Papers', funding: 'Funding', profile: 'Profile' };
const D = { profile: null, papers: null, grants: null, citations: null, briefing: null };
const view = $('#view');
const scroller = $('#scroller');                       // the only thing that scrolls (see index.html)
let leave = [];
let currentTab = null;
let similarityPromise = null;
let installEvent = null;

const ctx = {
  papers: shelf('saved.papers'),
  grants: shelf('saved.grants'),
  onLeave: (fn) => { if (typeof fn === 'function') leave.push(fn); },
  similarity: () => (similarityPromise ||= fetch('data/similarity.json').then((r) => { if (!r.ok) throw new Error('similarity model missing'); return r.json(); })),
  redraw: null,
  updatedLine: '',
};

async function load(name, fresh = false) {
  // `fresh` (pull to refresh) also gets past the ten-minute cache of the web host
  const res = await fetch(`data/${name}.json${fresh ? `?t=${Date.now()}` : ''}`, { cache: fresh ? 'no-store' : 'no-cache' });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

function route() {
  const [tabRaw, sub] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  const tab = VIEWS[tabRaw] ? tabRaw : 'today';
  leave.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  leave = [];
  clearCharts();
  ctx.redraw = null;
  view.onclick = view.oninput = view.onsubmit = view.onchange = null;
  $$('[data-tab]', document.querySelector('.tabbar')).forEach((a) => a.classList.toggle('is-active', a.dataset.tab === tab));
  $$('[data-tab]', document.querySelector('.topnav')).forEach((a) => { a.classList.toggle('is-active', a.dataset.tab === tab); a.toggleAttribute('aria-current', a.dataset.tab === tab); });
  document.title = tab === 'today' ? 'Wave Research' : `${TITLES[tab]} · Wave Research`;
  try {
    VIEWS[tab](view, D, ctx, sub);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><h3>This screen could not be drawn</h3><p>${esc(err.message)}</p></div>`;
  }
  if (tab !== currentTab) scroller.scrollTo(0, 0);
  currentTab = tab;
}

// ── actions shared by every screen ───────────────────────────────────────────
document.addEventListener('click', (e) => {
  const sp = e.target.closest('[data-save-paper]');
  if (sp) {
    const p = paperIndex.get(sp.dataset.savePaper) || ctx.papers.all().find((x) => x.id === sp.dataset.savePaper);
    if (!p) return;
    const on = ctx.papers.toggle(p);
    $$(`[data-save-paper="${CSS.escape(p.id)}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
    toast(on ? 'Saved to your reading list' : 'Removed from your reading list');
    const n = $('.seg [data-tab="saved"] .n', view);
    if (n && currentTab === 'papers') n.textContent = ctx.papers.size;
    return;
  }
  const so = e.target.closest('[data-save-opp]');
  if (so) {
    const o = (D.grants?.opportunities || []).find((x) => x.id === so.dataset.saveOpp);
    if (!o) return;
    const on = ctx.grants.toggle({ id: o.id, title: o.title });
    so.setAttribute('aria-pressed', String(on));
    toast(on ? 'Added to your shortlist' : 'Removed from your shortlist');
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {                                             // swap a shortened line for the full text
    const rest = more.nextElementSibling, lede = more.previousElementSibling;
    if (rest) rest.hidden = false;
    if (lede?.classList.contains('lede')) lede.hidden = true;
    more.hidden = true;
    return;
  }
  const absBtn = e.target.closest('[data-abs]');
  if (absBtn) {
    const para = absBtn.closest('article')?.querySelector('.abstract');
    if (para) {
      para.hidden = !para.hidden;
      para.classList.toggle('open', !para.hidden);
      absBtn.setAttribute('aria-expanded', String(!para.hidden));
    }
    return;
  }
  const ab = e.target.closest('[data-toggle="abstract"]');
  if (ab) ab.classList.toggle('open');
});

// ── top bar ──────────────────────────────────────────────────────────────────
// ── getting back to the top: a button after a long scroll, or tap the current tab ──
const toTop = $('#to-top');
const onScroll = () => { toTop.hidden = scroller.scrollTop < 1400; };
scroller.addEventListener('scroll', onScroll, { passive: true });
toTop.addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]');
  if (a && a.classList.contains('is-active') && location.hash === a.getAttribute('href')) {
    e.preventDefault();
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

function freshness() {
  const stamps = [D.profile?.generated_at, D.papers?.generated_at, D.grants?.generated_at].filter(Boolean).sort();
  const el = $('#fresh');
  if (!stamps.length) { el.hidden = true; return; }
  const latest = stamps.at(-1);
  const hours = (Date.now() - new Date(latest).getTime()) / 36e5;
  el.textContent = `Updated ${ago(latest)}`;
  el.classList.toggle('is-stale', hours > 40);
  el.hidden = false;
  const d = new Date(latest);
  ctx.updatedLine = `Built ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function tabBadges() {
  const urgent = (D.grants?.opportunities || []).filter((o) => o.bucket === 'deadline' && isLive(o) && daysTo(o.closes) <= 14).length;
  const tab = $('.tabbar [data-tab="funding"]');
  tab.querySelector('.dot')?.remove();
  if (urgent) tab.insertAdjacentHTML('beforeend', `<span class="dot" aria-label="${urgent} deadlines within two weeks">${urgent}</span>`);
}

// ── settings sheet ───────────────────────────────────────────────────────────
const sheet = $('#sheet'), backdrop = $('#sheet-backdrop');
let lastFocus = null;

function repoUrl() {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : null;
}

function sourceRows(group, labels) {
  return Object.entries(labels).map(([key, label]) => {
    const s = group?.[key];
    if (!s) return '';
    const when = s.ok ? ago(s.checked) : (s.last_success ? `blocked · last read ${ago(s.last_success)}` : 'not available');
    return `<div class="src${s.ok ? '' : ' bad'}"><b style="font-weight:500">${esc(label)}</b><span>${esc(when)}</span></div>`;
  }).join('');
}

/** A small preview of one palette: page, card, wave line, text and accent. */
function swatch(key, pal, mode, on) {
  const t = pal[mode];
  return `<button class="swatch" type="button" role="radio" aria-checked="${on}" data-palette-set="${esc(key)}">
    <svg viewBox="0 0 96 60" aria-hidden="true">
      <rect width="96" height="60" fill="${esc(t.bg)}"/>
      <rect x="7" y="7" width="82" height="34" rx="8" fill="${esc(t.surface)}" stroke="${esc(t.line)}" stroke-width="1"/>
      <path d="M7 27c8 0 9-3 13-3s5 8 9 8 5-16 10-16 5 12 9 12 5-4 9-4 6 3 10 3 8-1 22-1" fill="none" stroke="${esc(t.accent)}" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="8" y="47" width="30" height="5" rx="2.5" fill="${esc(t.ink)}"/><rect x="42" y="48" width="16" height="3" rx="1.5" fill="${esc(t.ink3)}"/>
      <circle cx="83" cy="50" r="5" fill="${esc(t.accent)}"/>
    </svg><span class="swatch-name">${esc(pal.name)}</span></button>`;
}

function openSettings() {
  const theme = store.raw('theme') || 'auto';
  const ai = D.grants?.ai || {};
  const repo = repoUrl();
  const WP = window.WavePalettes;
  const seg = (v, label) => `<button type="button" role="tab" data-theme-set="${v}" aria-selected="${theme === v}">${label}</button>`;
  $('#sheet-body').innerHTML = `
    ${WP ? `<h3>Palette</h3>
    <div class="palettes" role="radiogroup" aria-label="Colour palette">${Object.entries(WP.all).map(([k, pal]) => swatch(k, pal, WP.mode(), WP.current() === k)).join('')}</div>` : ''}

    <h3>Light or dark</h3>
    <div class="seg" role="tablist" aria-label="Theme">${seg('auto', 'Auto')}${seg('light', 'Light')}${seg('dark', 'Dark')}</div>

    <h3>Daily update</h3>
    <p>${D.grants?.generated_at ? `Last run <b>${esc(ago(D.grants.generated_at))}</b> · ` : ''}every morning, 05:17 UTC</p>
    ${repo ? `<p style="margin-top:10px"><a class="btn sm" href="${safeUrl(repo + '/actions/workflows/update.yml')}" target="_blank" rel="noopener">Run now ${icon('ext', 'xs')}</a></p>` : ''}

    <h3>Claude funding review</h3>
    ${ai.key_present
      ? `<p><b>On</b> · ${esc(ai.model || 'Claude')} · ${num(ai.total_calls || 0)} calls · $${Number(ai.total_cost_usd || 0).toFixed(2)} so far</p>`
      : `<p><b>Waiting for your key.</b> Add the repository secret <b>ANTHROPIC_API_KEY</b>${repo ? ` <a href="${safeUrl(repo + '/settings/secrets/actions')}" target="_blank" rel="noopener" style="text-decoration:underline">here</a>` : ''}.</p>`}
    ${ai.errors?.length ? `<div class="notice warn" style="margin-top:10px">${icon('alert', 'sm')}<span>${esc(ai.errors[0])}</span></div>` : ''}

    <h3>Sources</h3>
    <div class="srcs">${sourceRows(D.profile?.sources, { scholar: 'Google Scholar', orcid: 'ORCID', crossref: 'Crossref', openalex: 'OpenAlex' })}
      ${sourceRows(D.papers?.sources, { semantic_scholar: 'Semantic Scholar', arxiv: 'arXiv', citing: 'Papers citing you' })}
      ${sourceRows(D.grants?.sources, { ukri: 'UKRI Funding Finder', eu: 'EU Funding & Tenders', schemes: 'Funder schemes' })}</div>

    <h3>On your phone</h3>
    <p id="install-slot">${installEvent ? '<button class="btn sm primary" type="button" id="install-btn">Install the app</button>'
      : 'Safari: <b>Share → Add to Home Screen</b>. Chrome: <b>⋮ → Add to Home screen</b>.'}</p>
    <p class="small muted" style="margin-top:12px">Saved items and ticks stay on this device.</p>`;
  lastFocus = document.activeElement;
  backdrop.hidden = false;
  sheet.hidden = false;
  $('#close-sheet').focus();
}
function closeSettings() {
  sheet.hidden = true;
  backdrop.hidden = true;
  lastFocus?.focus?.();
}
$('#open-settings').addEventListener('click', openSettings);
$('#close-sheet').addEventListener('click', closeSettings);
backdrop.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSettings(); });
sheet.addEventListener('click', async (e) => {
  const pal = e.target.closest('[data-palette-set]');
  if (pal && window.WavePalettes) {
    window.WavePalettes.choose(pal.dataset.paletteSet);
    $$('[data-palette-set]', sheet).forEach((b) => b.setAttribute('aria-checked', String(b === pal)));
    return;
  }
  const t = e.target.closest('[data-theme-set]');
  if (t) {
    const v = t.dataset.themeSet;
    if (v === 'auto') { document.documentElement.removeAttribute('data-theme'); store.raw('theme', 'auto'); }
    else { document.documentElement.setAttribute('data-theme', v); store.raw('theme', v); }
    window.WavePalettes?.apply();                         // each palette has its own light and dark set
    openSettings();                                       // redraw the swatches for the new mode
    return;
  }
  if (e.target.closest('#install-btn') && installEvent) {
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    closeSettings();
  }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

// ── start ────────────────────────────────────────────────────────────────────
async function loadAll(fresh = false) {
  const names = Object.keys(D);
  const got = await Promise.allSettled(names.map((n) => load(n, fresh)));
  got.forEach((r, i) => { if (r.status === 'fulfilled') D[names[i]] = r.value; });
}

async function start() {
  await loadAll();
  if (!D.profile && !D.papers && !D.grants) {
    view.innerHTML = `<div class="empty"><h3>No data yet</h3><p>Run the “Update data” workflow.</p></div>`;
    return;
  }
  freshness();
  tabBadges();
  window.addEventListener('hashchange', route);
  route();
  onScroll();
}
start();

// ── the shell is exactly as tall as the visible screen ───────────────────────
// A page opened from the home screen can report a viewport taller than the screen, which pushes
// anything anchored to its bottom out of sight. The shell's height is therefore measured, and never
// allowed to exceed the screen itself.
let insetProbe = null;
function fitShell() {
  if (!insetProbe) {                                     // reads env(safe-area-inset-top): the strip under the status bar
    insetProbe = document.createElement('div');
    insetProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:0;padding-top:env(safe-area-inset-top,0px)';
    document.body.appendChild(insetProbe);
  }
  const h = shellHeight({
    inner: window.innerHeight, visual: window.visualViewport?.height, screenW: window.screen?.width, screenH: window.screen?.height,
    portrait: window.innerWidth <= window.innerHeight, top: parseFloat(getComputedStyle(insetProbe).paddingTop) || 0,
    standalone: window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches,
  });
  if (h > 100) document.documentElement.style.setProperty('--app-h', `${h}px`);
}
fitShell();
['resize', 'orientationchange', 'pageshow'].forEach((ev) => window.addEventListener(ev, fitShell));
window.visualViewport?.addEventListener('resize', fitShell);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fitShell(); });
[250, 1000, 2500].forEach((ms) => setTimeout(fitShell, ms));       // phones settle their bars after launch

// ── no accidental zoom ───────────────────────────────────────────────────────
// CSS touch-action switches off double-tap and pinch zoom; this covers Safari versions that ignore it.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ── pull down to refresh ─────────────────────────────────────────────────────
const ptr = $('#ptr');
const PULL_AT = 72;
let pull = null, refreshing = false;

async function refresh() {
  const stamp = () => [D.profile, D.papers, D.grants].map((x) => x?.generated_at).join();
  const before = stamp();
  let newVersion = false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      reg.addEventListener('updatefound', () => { newVersion = true; }, { once: true });
      await reg.update().catch(() => {});
    }
  } catch { /* no service worker: data only */ }
  await loadAll(true);
  loadedAt = Date.now();
  freshness();
  tabBadges();
  route();
  if (newVersion) { toast('New version — reloading'); setTimeout(() => location.reload(), 900); return; }
  toast(!navigator.onLine ? 'Offline — showing the saved edition' : stamp() === before ? `Up to date · ${ctx.updatedLine.replace('Built', 'built')}` : 'Updated');
}

// Coming back to the app after a while: fetch the latest edition quietly if you are at the top.
let loadedAt = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || refreshing || Date.now() - loadedAt < 2 * 36e5 || scroller.scrollTop > 40 || !sheet.hidden) return;
  loadedAt = Date.now();
  await loadAll(true);
  freshness();
  tabBadges();
  route();
});

scroller.addEventListener('touchstart', (e) => {
  const ok = !refreshing && sheet.hidden && scroller.scrollTop <= 2 && e.touches.length === 1
    && !e.target.closest('.chart') && e.target !== document.activeElement;
  pull = ok ? { x: e.touches[0].clientX, y: e.touches[0].clientY, d: 0, on: false } : null;
}, { passive: true });
scroller.addEventListener('touchmove', (e) => {
  if (!pull) return;
  const dx = e.touches[0].clientX - pull.x, dy = e.touches[0].clientY - pull.y;
  if (!pull.on) {
    if (dy < -6 || Math.abs(dx) > 14 || scroller.scrollTop > 2) { pull = null; return; }   // scrolling or swiping instead
    if (dy < 10) return;
    pull.on = true;
  }
  pull.d = Math.max(0, Math.min(120, dy * 0.5));
  ptr.classList.remove('settle');
  ptr.style.opacity = String(Math.min(1, pull.d / 36));
  ptr.style.transform = `translateY(${pull.d - 52}px)`;
  ptr.firstElementChild.style.transform = `rotate(${Math.round(pull.d * 3.2)}deg)`;
}, { passive: true });
const endPull = async () => {
  if (!pull) return;
  const go = pull.on && pull.d >= PULL_AT;
  pull = null;
  ptr.classList.add('settle');
  ptr.firstElementChild.style.transform = '';
  if (!go) { ptr.style.opacity = '0'; ptr.style.transform = ''; return; }
  refreshing = true;
  ptr.classList.add('busy');
  ptr.style.opacity = '1';
  ptr.style.transform = 'translateY(16px)';
  try { await refresh(); } finally {
    ptr.classList.remove('busy');
    ptr.style.opacity = '0';
    ptr.style.transform = '';
    refreshing = false;
  }
};
scroller.addEventListener('touchend', endPull);
scroller.addEventListener('touchcancel', endPull);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
