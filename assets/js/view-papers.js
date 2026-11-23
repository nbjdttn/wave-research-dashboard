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
  if (sub === 'citing' || sub === 'saved' || sub === 'new' || sub === 'archived') state.tab = sub;
  const feed = D.papers?.papers || [];
  const own = Object.fromEntries((D.profile?.publications || []).map((p) => [p.id, p]));
  const ownTitle = (id) => own[id]?.title;

  const draw = () => {
    const away = ctx.away.papers;                               // archived by the reader: off every list but its own
    const here = feed.filter((p) => !away.has(p.id));
    const savedHere = ctx.papers.all().filter((p) => !away.has(p.id));
    const gone = [...new Map([...feed, ...ctx.papers.all()].filter((p) => away.has(p.id)).map((p) => [p.id, p])).values()];
    if (state.tab === 'archived' && !gone.length) state.tab = 'new';
    const mine = state.tab === 'saved' || state.tab === 'archived';   // lists the reader made: no date or topic filters
    const base = state.tab === 'citing' ? here.filter((p) => p.cites?.length)
      : state.tab === 'saved' ? savedHere
        : state.tab === 'archived' ? gone
          : here.filter((p) => !p.cites?.length);
    const q = state.q.trim().toLowerCase();
    let list = base.filter((p) => {
      if (!mine) {
        const d = daysTo(p.news_date);
        if (state.range && d != null && d < -state.range) return false;
        if (state.focus === 'domain' && p.focus !== 'domain') return false;
        if (state.focus === 'ai' && p.focus !== 'domain_ai') return false;
      }
      if (q && !`${p.title} ${(p.authors || []).join(' ')} ${p.venue || ''} ${(p.matched || []).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const counts = {
      new: here.filter((p) => !p.cites?.length).length,
      citing: here.filter((p) => p.cites?.length).length,
      saved: savedHere.length,
      archived: gone.length,
    };
    const byDate = state.sort === 'date' && !mine;
    list = [...list].sort((a, b) => (byDate ? (b.news_date || '').localeCompare(a.news_date || '') || b.score - a.score : b.score - a.score));

    let body = '';
    if (state.live) {
      body = liveHTML(state.live, ctx, ownTitle);
    } else if (!list.length) {
      body = `<div class="empty"><h3>${state.tab === 'saved' ? 'Your reading list is empty' : 'Nothing matches'}</h3>
        <p>${state.tab === 'saved' ? 'Swipe a paper right, or tap its bookmark, to save it.' : 'Widen the filters.'}</p></div>`;
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
      body = `${state.tab === 'archived' ? '<p class="small muted" style="margin-top:14px">Put away on this device. Swipe right or tap the arrow to bring one back.</p>' : ''}
        <div class="stories" style="margin-top:${state.tab === 'archived' ? 12 : 18}px">${list.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, away: state.tab === 'archived' })).join('')}</div>`;
    }

    const chip = (key, value, label) => `<button class="chip" type="button" data-set="${key}" data-val="${value}" aria-pressed="${String(state[key]) === String(value)}">${label}</button>`;
    root.innerHTML = `
      <h1 class="page-title">Papers</h1>
      <p class="page-sub">New work close to yours · last ${num(D.papers?.window_days || 120)} days</p>
      <div class="toolbar">
        <div class="seg${counts.archived ? ' four' : ''}" role="tablist" aria-label="Paper lists">
          <button role="tab" type="button" data-tab="new" aria-selected="${state.tab === 'new'}">New <span class="n">${counts.new}</span></button>
          <button role="tab" type="button" data-tab="citing" aria-selected="${state.tab === 'citing'}">Citing you <span class="n">${counts.citing}</span></button>
          <button role="tab" type="button" data-tab="saved" aria-selected="${state.tab === 'saved'}">Reading list <span class="n">${counts.saved}</span></button>
          ${counts.archived ? `<button role="tab" type="button" data-tab="archived" aria-selected="${state.tab === 'archived'}" aria-label="Archived" title="Archived">${icon('archive', 'sm')}<span class="n">${counts.archived}</span></button>` : ''}
        </div>
        <form class="search" id="paper-search" role="search">
          ${icon('search')}
          <input type="search" name="q" value="${esc(state.q)}" placeholder="Filter, or search all journals" aria-label="Filter the feed or search the wider literature" autocomplete="off" enterkeyhint="search">
          ${state.q || state.live ? `<button type="button" data-clear aria-label="Clear search">${icon('x', 'sm')}</button>` : ''}
        </form>
        ${!mine && !state.live ? `<div class="chips" role="group" aria-label="Filters">
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
  if (live.error) return `<div class="notice warn" style="margin-top:18px">${icon('alert', 'sm')}<span><b>Search failed.</b> ${esc(live.error)}</span></div>`;
  const results = live.results.filter((p) => !ctx.away.papers.has(p.id));
  if (!results.length) return `<div class="empty"><h3>No results for “${esc(live.query)}”</h3><p>Try different words.</p></div>`;
  return `<h2 class="day-head">All journals · “${esc(live.query)}”<span class="n">${results.length}</span></h2>
    <div class="stories">${results.map((p) => storyHTML(p, { saved: ctx.papers.has(p.id), ownTitle, showNew: false })).join('')}</div>
    <p class="scan">Crossref · last two years · ranked against your papers</p>`;
}
