// "Papers" — the newsstand: new work close to yours, papers citing you, your reading list,
// and a live search of the wider literature ranked against your profile.
import { esc, icon, daysTo, num, $, toast } from './util.js';
import { storyHTML } from './cards.js';
import { makeScorer } from './similarity.js';

const state = { tab: 'new', range: 30, focus: 'all', sort: 'date', q: '', live: null, busy: false };

const GROUPS = [
  [0, 'Today'], [-7, 'This week'], [-30, 'This month'], [-9999, 'Earlier'],
];

export function renderPapers(root, D, ctx, sub) {
  if (sub === 'citing' || sub === 'saved' || sub === 'new') state.tab = sub;
  const feed = D.papers?.papers || [];
  const own = Object.fromEntries((D.profile?.publications || []).map((p) => [p.id, p]));
  const ownTitle = (id) => own[id]?.title;

  const draw = () => {
    const base = state.tab === 'citing' ? feed.filter((p) => p.cites?.length)
      : state.tab === 'saved' ? ctx.papers.all()
        : feed.filter((p) => !p.cites?.length);
    const q = state.q.trim().toLowerCase();
    let list = base.filter((p) => {
      if (state.tab !== 'saved') {
        const d = daysTo(p.news_date);
        if (state.range && d != null && d < -state.range) return false;
        if (state.focus === 'domain' && p.focus !== 'domain') return false;
        if (state.focus === 'ai' && p.focus !== 'domain_ai') return false;
      }
      if (q && !`${p.title} ${(p.authors || []).join(' ')} ${p.venue || ''} ${(p.matched || []).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const counts = {
      new: feed.filter((p) => !p.cites?.length).length,
      citing: feed.filter((p) => p.cites?.length).length,
      saved: ctx.papers.size,
    };
    const byDate = state.sort === 'date' && state.tab !== 'saved';
    list = [...list].sort((a, b) => (byDate ? (b.news_date || '').localeCompare(a.news_date || '') || b.score - a.score : b.score - a.score));

    let body = '';
    if (state.live) {
      body = liveHTML(state.live, ctx, ownTitle);
    } else if (!list.length) {
      body = `<div class="empty"><h3>${state.tab === 'saved' ? 'Your reading list is empty' : 'Nothing matches'}</h3>
        <p>${state.tab === 'saved' ? 'Tap the bookmark on any paper to keep it here.' : 'Try a longer time range or clear the filters.'}</p></div>`;
    } else if (byDate) {
      let rest = list;
      for (const [floor, label] of GROUPS) {
        const part = rest.filter((p) => (daysTo(p.news_date) ?? -99999) >= floor);
        rest = rest.filter((p) => !part.includes(p));
        if (part.length) {
          part.sort((a, b) => b.score - a.score);
          body += `<h2 class="day-head">${label}<span class="n">${part.length}</span></h2><div class="stories">${part.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, showNew: false })).join('')}</div>`;
        }
      }
    } else {
      body = `<div class="stories" style="margin-top:18px">${list.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle })).join('')}</div>`;
    }

    const chip = (key, value, label) => `<button class="chip" type="button" data-set="${key}" data-val="${value}" aria-pressed="${String(state[key]) === String(value)}">${label}</button>`;
    root.innerHTML = `
      <h1 class="page-title">Papers</h1>
      <p class="page-sub">A daily feed of new work close to your own — not a literature review. Everything here appeared in the last ${num(D.papers?.window_days || 120)} days.</p>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="Paper lists">
          <button role="tab" type="button" data-tab="new" aria-selected="${state.tab === 'new'}">New <span class="n">${counts.new}</span></button>
          <button role="tab" type="button" data-tab="citing" aria-selected="${state.tab === 'citing'}">Citing you <span class="n">${counts.citing}</span></button>
          <button role="tab" type="button" data-tab="saved" aria-selected="${state.tab === 'saved'}">Reading list <span class="n">${counts.saved}</span></button>
        </div>
        <form class="search" id="paper-search" role="search">
          ${icon('search')}
          <input type="search" name="q" value="${esc(state.q)}" placeholder="Filter the feed or search all journals" aria-label="Filter the feed or search the wider literature" autocomplete="off" enterkeyhint="search">
          ${state.q || state.live ? `<button type="button" data-clear aria-label="Clear search">${icon('x', 'sm')}</button>` : ''}
        </form>
        ${state.tab !== 'saved' && !state.live ? `<div class="chips" role="group" aria-label="Filters">
          ${chip('range', 7, 'This week')}${chip('range', 30, 'This month')}${chip('range', 0, 'All')}
          <span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>
          ${chip('focus', 'all', 'All topics')}${chip('focus', 'domain', 'Waves &amp; fluids')}${chip('focus', 'ai', 'ML × physics')}
          <span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>
          ${chip('sort', 'date', 'Newest')}${chip('sort', 'match', 'Best match')}
        </div>` : ''}
      </div>
      <div id="paper-list">${body}</div>
      ${!state.live && q ? `<div style="margin-top:20px"><button class="btn block" type="button" data-live>${icon('search', 'sm')}Search all journals for “${esc(state.q)}”</button></div>` : ''}`;
  };

  async function liveSearch() {
    const query = state.q.trim();
    if (query.length < 3 || state.busy) return;
    state.busy = true;
    state.live = { query, loading: true };
    draw();
    try {
      const model = await ctx.similarity();
      const scorer = makeScorer(model);
      const since = new Date().getFullYear() - 2;
      const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=40&filter=from-pub-date:${since}-01-01&select=DOI,title,author,issued,published,container-title,abstract,type`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Crossref answered ${res.status}`);
      const items = (await res.json()).message?.items || [];
      const ownDois = new Set((D.profile?.publications || []).map((p) => p.doi).filter(Boolean));
      const results = items.filter((it) => it.title?.[0] && !ownDois.has((it.DOI || '').toLowerCase())).map((it) => {
        const parts = (it.published || it.issued)?.['date-parts']?.[0] || [];
        const date = parts.length ? [parts[0], String(parts[1] || 1).padStart(2, '0'), String(parts[2] || 1).padStart(2, '0')].join('-') : null;
        const authors = (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
        const paper = {
          id: `cr-${it.DOI}`, title: strip(it.title[0]), authors: authors.slice(0, 8), author_count: authors.length,
          venue: strip(it['container-title']?.[0] || ''), date, news_date: date, year: parts[0],
          abstract: strip(it.abstract || '').replace(/^abstract\s*/i, '') || null,
          url: `https://doi.org/${it.DOI}`, doi: it.DOI, cites: [], sources: ['Crossref'],
        };
        const s = scorer(paper);
        const near = s.nearId ? own[s.nearId] : null;
        return { ...paper, score: s.score, matched: s.matched, focus: s.focus, similar_to: near ? { id: near.id, title: near.title, year: near.year } : null };
      }).sort((a, b) => b.score - a.score);
      state.live = { query, results };
    } catch (err) {
      state.live = { query, error: String(err.message || err) };
    }
    state.busy = false;
    draw();
  }

  root.onclick = (e) => {
    const t = e.target.closest('[data-tab],[data-set],[data-clear],[data-live]');
    if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.live = null; }
    else if (t.dataset.set) { state[t.dataset.set] = /^\d+$/.test(t.dataset.val) ? +t.dataset.val : t.dataset.val; }
    else if ('clear' in t.dataset) { state.q = ''; state.live = null; }
    else if ('live' in t.dataset) { liveSearch(); return; }
    draw();
  };
  root.oninput = (e) => {
    if (e.target.name !== 'q') return;
    state.q = e.target.value;
    if (state.live) return;
    clearTimeout(root._t);
    root._t = setTimeout(() => { draw(); const i = $('input[name=q]', root); if (i) { i.focus(); i.setSelectionRange(state.q.length, state.q.length); } }, 220);
  };
  root.onsubmit = (e) => {
    if (e.target.id !== 'paper-search') return;
    e.preventDefault();
    if (state.q.trim().length < 3) { toast('Type at least three letters to search'); return; }
    liveSearch();
  };
  ctx.redraw = draw;
  draw();
}

const strip = (s) => { const d = document.createElement('div'); d.innerHTML = String(s || '').replace(/<[^>]+>/g, ' '); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };

function liveHTML(live, ctx, ownTitle) {
  if (live.loading) return `<div class="boot"><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></div>`;
  if (live.error) return `<div class="notice warn" style="margin-top:18px">${icon('alert', 'sm')}<span><b>The search did not go through.</b> ${esc(live.error)}. Check your connection and try again.</span></div>`;
  if (!live.results.length) return `<div class="empty"><h3>No results for “${esc(live.query)}”</h3><p>Try different words.</p></div>`;
  return `<h2 class="day-head">All journals · “${esc(live.query)}”<span class="n">${live.results.length}, ranked by closeness to your work</span></h2>
    <div class="stories">${live.results.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, showNew: false })).join('')}</div>
    <p class="scan">Results from Crossref (last two years), scored in your browser against your own papers.</p>`;
}
