// Wave Research — bootstrap, routing and the settings sheet.
import { $, $$, esc, icon, store, shelf, toast, ago, daysTo, fmtDate, safeUrl, num } from './util.js';
import { clearCharts } from './charts.js';
import { paperIndex, isLive } from './cards.js';
import { renderToday } from './view-today.js';
import { renderPapers } from './view-papers.js';
import { renderFunding } from './view-funding.js';
import { renderProfile } from './view-profile.js';

const VIEWS = { today: renderToday, papers: renderPapers, funding: renderFunding, profile: renderProfile };
const TITLES = { today: 'Today', papers: 'Papers', funding: 'Funding', profile: 'Profile' };
const D = { profile: null, papers: null, grants: null };
const view = $('#view');
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

async function load(name) {
  const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
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
  if (tab !== currentTab) window.scrollTo(0, 0);
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
  const ab = e.target.closest('[data-toggle="abstract"]');
  if (ab) ab.classList.toggle('open');
});

// ── top bar ──────────────────────────────────────────────────────────────────
const topbar = $('#topbar');
const onScroll = () => topbar.classList.toggle('is-stuck', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });

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
  ctx.updatedLine = `This edition was built ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Papers: Semantic Scholar, arXiv, Crossref. Funding: UKRI, EU Funding & Tenders and funder schemes, reviewed by Claude.`;
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
    const note = s.ok ? (s.count != null ? `${num(s.count)} items` : s.added != null ? `${num(s.added)} found` : s.note || 'ok') : 'not available on the last run';
    const when = s.ok ? ago(s.checked) : (s.last_success ? `last read ${ago(s.last_success)}` : ago(s.checked));
    return `<div class="src${s.ok ? '' : ' bad'}"><b style="font-weight:500">${esc(label)}</b><span>${esc(note)}<br>${esc(when)}</span></div>`;
  }).join('');
}

function openSettings() {
  const theme = store.raw('theme') || 'auto';
  const ai = D.grants?.ai || {};
  const repo = repoUrl();
  const seg = (v, label) => `<button type="button" role="tab" data-theme-set="${v}" aria-selected="${theme === v}">${label}</button>`;
  $('#sheet-body').innerHTML = `
    <h3>Appearance</h3>
    <div class="seg" role="tablist" aria-label="Theme">${seg('auto', 'Automatic')}${seg('light', 'Light')}${seg('dark', 'Dark')}</div>

    <h3>Daily update</h3>
    <p>A scheduled job rebuilds this edition every morning. ${D.grants?.generated_at ? `Last run: <b>${esc(ago(D.grants.generated_at))}</b>.` : ''}</p>
    ${repo ? `<p style="margin-top:10px"><a class="btn sm" href="${safeUrl(repo + '/actions/workflows/update.yml')}" target="_blank" rel="noopener">Run an update now ${icon('ext', 'xs')}</a></p>` : ''}

    <h3>Claude review of funding calls</h3>
    ${ai.key_present
      ? `<p>On, using <b>${esc(ai.model || 'Claude')}</b>. ${ai.last_ai_run ? `Last review ${esc(ago(ai.last_ai_run))}; ` : ''}${num(ai.total_calls || 0)} calls so far, about $${Number(ai.total_cost_usd || 0).toFixed(2)} in total.</p>`
      : `<p>The current list was reviewed when the site was built. To have new calls reviewed automatically each day, add your Anthropic API key as a repository secret named <b>ANTHROPIC_API_KEY</b>${repo ? ` (<a href="${safeUrl(repo + '/settings/secrets/actions')}" target="_blank" rel="noopener" style="text-decoration:underline">repository → Settings → Secrets → Actions</a>)` : ''}. The key stays in GitHub; it is never part of this page.</p>`}
    ${ai.errors?.length ? `<div class="notice warn" style="margin-top:10px">${icon('alert', 'sm')}<span>${esc(ai.errors[0])}</span></div>` : ''}

    <h3>Sources — your record</h3>
    <div class="srcs">${sourceRows(D.profile?.sources, { scholar: 'Google Scholar', orcid: 'ORCID', crossref: 'Crossref', openalex: 'OpenAlex' })}</div>
    <h3>Sources — papers</h3>
    <div class="srcs">${sourceRows(D.papers?.sources, { semantic_scholar: 'Semantic Scholar recommendations', arxiv: 'arXiv', crossref: 'Crossref', openalex: 'OpenAlex', citing: 'Papers citing you' })}</div>
    <h3>Sources — funding</h3>
    <div class="srcs">${sourceRows(D.grants?.sources, { ukri: 'UKRI Funding Finder', ukri_archive: 'UKRI past calls', eu: 'EU Funding & Tenders', schemes: 'Funder schemes watch-list' })}</div>

    <h3>On your phone</h3>
    <p id="install-slot">${installEvent ? '<button class="btn sm primary" type="button" id="install-btn">Install the app</button>'
      : 'Add this page to your home screen to open it like an app: in Safari tap <b>Share → Add to Home Screen</b>; in Chrome tap <b>⋮ → Add to Home screen</b>.'}</p>
    <p class="small muted" style="margin-top:14px">Your reading list, shortlist and ticked checklist items are kept on this device only.</p>`;
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
  const t = e.target.closest('[data-theme-set]');
  if (t) {
    const v = t.dataset.themeSet;
    if (v === 'auto') { document.documentElement.removeAttribute('data-theme'); try { localStorage.removeItem('wave.theme'); } catch { /* ignore */ } }
    else { document.documentElement.setAttribute('data-theme', v); store.raw('theme', v); }
    $$('[data-theme-set]', sheet).forEach((b) => b.setAttribute('aria-selected', String(b === t)));
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
async function start() {
  const [profile, papers, grants] = await Promise.allSettled([load('profile'), load('papers'), load('grants')]);
  D.profile = profile.status === 'fulfilled' ? profile.value : null;
  D.papers = papers.status === 'fulfilled' ? papers.value : null;
  D.grants = grants.status === 'fulfilled' ? grants.value : null;
  if (!D.profile && !D.papers && !D.grants) {
    view.innerHTML = `<div class="empty"><h3>No data yet</h3><p>The data files have not been built. Run the “Update data” workflow, or <code>python scripts/update.py</code> locally.</p></div>`;
    return;
  }
  freshness();
  tabBadges();
  window.addEventListener('hashchange', route);
  route();
  onScroll();
}
start();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
