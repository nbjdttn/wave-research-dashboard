// "Profile" — the researcher's own record: headline numbers, where citations come from,
// and the full publication list. Short labels and figures; no paragraphs.
import { esc, safeUrl, icon, num, initials, $, copyText, fmtDate, brief } from './util.js';
import { columns, stacked, dataTable, sparkline } from './charts.js';
import { citationTrend, scholarAge } from './cards.js';

const state = { tab: 'overview', q: '', type: 'all', theme: 'all', sort: 'year', tables: {} };
const TYPE_LABEL = { journal: 'Journal', conference: 'Conference', preprint: 'Preprint', thesis: 'Thesis', other: 'Other' };
const SERIES = [
  { key: 'journal', label: 'Journal', color: 'var(--series-1)' },
  { key: 'conference', label: 'Conference', color: 'var(--series-2)' },
  { key: 'preprint', label: 'Preprint', color: 'var(--series-3)' },
  { key: 'other', label: 'Other', color: 'var(--series-4)' },
];
// who is citing: fixed colour per group, in this order
const KINDS = [
  { key: 'independent', label: 'Independent', color: 'var(--series-1)' },
  { key: 'collaborator', label: 'Co-authors', color: 'var(--series-2)' },
  { key: 'self', label: 'Your own', color: 'var(--series-3)' },
];
const LINKS = [['scholar', 'Scholar'], ['orcid', 'ORCID'], ['university', 'Manchester'], ['website', 'Website'], ['github', 'GitHub'], ['linkedin', 'LinkedIn']];
let regionNames;
const country = (code) => {
  try { regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(code) || code; } catch { return code; }
};

export function renderProfile(root, D, ctx, sub) {
  const P = D.profile;
  if (!P) { root.innerHTML = '<div class="empty"><h3>Profile data is not available yet</h3></div>'; return; }
  if (['overview', 'citations', 'publications'].includes(sub)) state.tab = sub;
  const r = P.researcher, m = P.metrics, C = D.citations;

  const head = () => `
    <div class="profile-head">
      ${r.avatar ? `<img class="avatar" src="${esc(r.avatar)}" alt="" width="76" height="76">` : `<div class="avatar initials" aria-hidden="true">${esc(initials(r.short_name || r.name))}</div>`}
      <div><h1 class="profile-name">${esc(r.name)}</h1>
        <p class="profile-role">${esc(r.title)}<br>${esc(r.institution)}</p></div>
    </div>
    <div class="toolbar" style="position:static;padding-bottom:0">
      <div class="seg" role="tablist" aria-label="Profile sections">
        <button role="tab" type="button" data-tab="overview" aria-selected="${state.tab === 'overview'}">Overview</button>
        <button role="tab" type="button" data-tab="citations" aria-selected="${state.tab === 'citations'}">Citations</button>
        <button role="tab" type="button" data-tab="publications" aria-selected="${state.tab === 'publications'}">Papers <span class="n">${m.outputs}</span></button>
      </div>
    </div>`;

  const draw = () => {
    root.innerHTML = head() + (state.tab === 'overview' ? overviewHTML(P) : state.tab === 'citations' ? citationsHTML(P, C) : publicationsHTML(P));
    if (state.tab === 'overview') mountOverview(root, P);
    if (state.tab === 'citations' && C) mountCitations(root, C);
  };

  root.onclick = (e) => {
    const t = e.target.closest('[data-tab],[data-set],[data-table],[data-cite],[data-bib],[data-clear]');
    if (!t) return;
    if (t.dataset.tab) state.tab = t.dataset.tab;
    else if (t.dataset.set) state[t.dataset.set] = t.dataset.val;
    else if (t.dataset.table) state.tables[t.dataset.table] = !state.tables[t.dataset.table];
    else if (t.dataset.cite) { copyText(reference(P.publications.find((p) => p.id === t.dataset.cite)), 'Reference copied'); return; }
    else if (t.dataset.bib) { copyText(bibtex(P.publications.find((p) => p.id === t.dataset.bib)), 'BibTeX copied'); return; }
    else if ('clear' in t.dataset) state.q = '';
    draw();
  };
  root.oninput = (e) => {
    if (e.target.name !== 'pq') return;
    state.q = e.target.value;
    clearTimeout(root._t);
    root._t = setTimeout(() => { draw(); const i = $('input[name=pq]', root); if (i) { i.focus(); i.setSelectionRange(state.q.length, state.q.length); } }, 200);
  };
  root.onsubmit = (e) => e.preventDefault();
  ctx.redraw = draw;
  draw();
}

// ── shared pieces ────────────────────────────────────────────────────────────
function chartCard(id, title, sub, extra = '') {
  return `<section class="card chart-card" aria-label="${esc(title)}">
    <div class="chart-head"><div><h3>${esc(title)}</h3><p>${sub}</p></div>
      <button class="act" type="button" data-table="${id}" aria-pressed="${!!state.tables[id]}" aria-label="Show ${esc(title)} as a ${state.tables[id] ? 'chart' : 'table'}">${icon(state.tables[id] ? 'chart' : 'table', 'sm')}</button></div>
    ${extra}<div class="chart" id="chart-${id}"></div></section>`;
}
const legend = (series) => `<div class="legend" style="margin-bottom:10px">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;

/** Ranked horizontal bars, one hue: name, figure, bar. */
function ranked(title, sub, rows, unit = '') {
  const max = Math.max(1, ...rows.map((x) => x.count));
  return `<section class="card chart-card" aria-label="${esc(title)}">
    <div class="chart-head"><div><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div></div>
    <div class="rows">${rows.map((x) => `<div class="rowbar"><span class="name">${esc(x.name)}</span>
      <span class="fig">${num(x.count)}${x.extra ? ` <span>· ${esc(x.extra)}</span>` : unit ? ` <span>${esc(unit)}</span>` : ''}</span>
      <span class="bar" style="width:${(x.count / max) * 100}%"></span></div>`).join('')}</div></section>`;
}

// ── overview ─────────────────────────────────────────────────────────────────
function overviewHTML(P) {
  const r = P.researcher, m = P.metrics;
  const year = Number(String(m.as_of || '').slice(0, 4)) || new Date().getFullYear();
  const age = scholarAge(P);
  const oa = m.openalex || {};
  const top = [...P.publications].sort((a, b) => b.citations - a.citations).slice(0, 5);
  return `
    <p class="profile-bio">${esc(r.tagline || '')}</p>
    <div class="links">${LINKS.filter(([k]) => r.links?.[k]).map(([k, label]) => `<a class="btn sm" href="${safeUrl(r.links[k])}" target="_blank" rel="noopener me">${esc(label)} ${icon('ext', 'xs')}</a>`).join('')}</div>

    <section class="section" aria-label="Headline numbers">
      <div class="kpis">
        <div class="card kpi"><div class="kpi-label">Citations</div><div class="kpi-value">${num(m.citations)}</div>
          <div class="kpi-delta">${citationTrend(P)}</div>${sparkline(P.citations_by_year.map((c) => c.count))}</div>
        <div class="card kpi"><div class="kpi-label">h-index</div><div class="kpi-value">${num(m.h_index)}</div>
          <div class="kpi-delta">${m.m_index} per active year</div></div>
        <div class="card kpi"><div class="kpi-label">i10-index</div><div class="kpi-value">${num(m.i10_index)}</div>
          <div class="kpi-delta">papers with 10+ citations</div></div>
        <div class="card kpi"><div class="kpi-label">Outputs</div><div class="kpi-value">${num(m.outputs)}</div>
          <div class="kpi-delta">${num(m.journal_articles)} journal · ${num(m.conference_papers)} conference</div></div>
      </div>
      <p class="scan"><span><b>Google Scholar</b>, read ${fmtDate(m.as_of, { year: true })}${age > 10 ? ` — ${age} days ago; Scholar blocks the daily refresh` : ''}</span>
        ${oa.cited_by_count != null ? `<span><b>OpenAlex</b>, daily: ${num(oa.cited_by_count)} citations · h ${num(oa.h_index)}</span>` : ''}</p>
    </section>

    <div class="cols half section">
      ${chartCard('cites', 'Citations per year', `Scholar · ${year} to ${age > 10 ? fmtDate(m.as_of) : 'date'}`)}
      ${chartCard('outputs', 'Outputs per year', 'By type', legend(SERIES))}
    </div>

    <div class="cols half section">
      ${ranked('Research themes', 'Outputs per theme (can overlap)', P.themes.slice().sort((a, b) => b.count - a.count).map((t) => ({ name: t.label, count: t.count, extra: `${num(t.citations)} cites` })))}
      ${ranked('Journals', 'Articles per journal', P.venues.slice(0, 8).map((v) => ({ name: v.name, count: v.count, extra: `${num(v.citations)} cites` })))}
    </div>

    <section class="section" aria-labelledby="h-top">
      <div class="section-head"><h2 class="eyebrow" id="h-top">Most cited</h2><button class="more" type="button" data-tab="publications">All ${icon('arrow', 'xs')}</button></div>
      <div class="pubs">${top.map((p) => pubHTML(p, false)).join('')}</div>
    </section>

    <section class="section" aria-labelledby="h-co">
      <div class="section-head"><h2 class="eyebrow" id="h-co">Collaborators<span class="count">${num(m.coauthors)}</span></h2></div>
      <div class="people">${P.coauthors.slice(0, 12).map((c) => `<div class="person"><span class="ini" aria-hidden="true">${esc(initials(c.name))}</span>
        <div><b>${esc(c.name)}</b><span>${c.count} joint</span></div></div>`).join('')}</div>
      <p class="scan"><span>First author <b>${num(m.first_author)}</b></span><span>Senior author <b>${num(m.senior_author)}</b></span>
        <span>Uses ML <b>${Math.round(m.ml_share * 100)}%</b></span>${P.countries?.length ? `<span>Co-author countries <b>${P.countries.length}</b></span>` : ''}</p>
    </section>`;
}

function mountOverview(root, P) {
  const year = Number(String(P.metrics.as_of || '').slice(0, 4)) || new Date().getFullYear();
  const cites = P.citations_by_year.map((c) => ({ label: String(c.year), value: c.count, partial: c.year === year }));
  const el1 = $('#chart-cites', root);
  if (state.tables.cites) el1.innerHTML = dataTable([{ key: 'label', label: 'Year' }, { key: 'value', label: 'Citations' }], cites);
  else columns(el1, { data: cites, unit: 'citations', partialNote: 'year to date' });

  const outs = P.publications_by_year.map((y) => ({ label: String(y.year), values: { journal: y.journal, conference: y.conference, preprint: y.preprint, other: (y.other || 0) + (y.thesis || 0) } }));
  const el2 = $('#chart-outputs', root);
  if (state.tables.outputs) {
    el2.innerHTML = dataTable([{ key: 'label', label: 'Year' }, ...SERIES.map((s) => ({ key: s.key, label: s.label }))], outs.map((o) => ({ label: o.label, ...o.values })));
  } else stacked(el2, { data: outs, series: SERIES, unit: 'outputs' });
}

// ── citations: who cites the work, and from where ────────────────────────────
function citationsHTML(P, C) {
  if (!C) return '<div class="empty"><h3>Citation analysis is not built yet</h3><p>It appears after the next update.</p></div>';
  const t = C.totals;
  const pct = (n) => `${Math.round((n / Math.max(1, t.citing_papers)) * 100)}%`;
  const trending = C.papers.filter((p) => p.recent > 0).slice(0, 6);
  return `
    <section class="section" style="margin-top:16px" aria-label="Citation numbers">
      <div class="kpis">
        <div class="card kpi"><div class="kpi-label">Citing papers</div><div class="kpi-value">${num(t.citing_papers)}</div>
          <div class="kpi-delta">${num(t.links)} citations traced</div></div>
        <div class="card kpi"><div class="kpi-label">Independent</div><div class="kpi-value">${pct(t.independent)}</div>
          <div class="kpi-delta">no shared authors</div></div>
        <div class="card kpi"><div class="kpi-label">Last 12 months</div><div class="kpi-value">${num(t.last_12_months)}</div>
          <div class="kpi-delta">new citing papers</div></div>
        <div class="card kpi"><div class="kpi-label">Countries</div><div class="kpi-value">${num(t.countries)}</div>
          <div class="kpi-delta">${num(t.institutions)} institutions</div></div>
      </div>
    </section>

    <div class="cols half section">
      <section class="card chart-card" aria-label="Who is citing">
        <div class="chart-head"><div><h3>Who is citing</h3><p>Share of citing papers</p></div></div>
        <div class="segbar" role="img" aria-label="${KINDS.map((k) => `${k.label} ${pct(t[k.key])}`).join(', ')}" style="height:10px">
          ${KINDS.filter((k) => t[k.key]).map((k) => `<span style="flex:${t[k.key]};background:${k.color};padding:0;border-radius:5px"></span>`).join('')}</div>
        <div class="rows" style="margin-top:14px;gap:9px">${KINDS.map((k) => `<div class="rowbar"><span class="name"><i style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${k.color};margin-right:8px"></i>${esc(k.label)}</span>
          <span class="fig">${num(t[k.key])} <span>· ${pct(t[k.key])}</span></span></div>`).join('')}</div>
      </section>
      ${chartCard('citing', 'Citing papers per year', 'By who is citing', legend(KINDS))}
    </div>

    <div class="cols half section">
      ${ranked('Journals citing you', 'Citing papers per journal', C.venues.slice(0, 8))}
      ${ranked('Countries', 'Citing papers with an author there', C.countries.slice(0, 8).map((x) => ({ name: country(x.code), count: x.count })))}
    </div>

    <div class="cols half section">
      ${ranked('Institutions', '', C.institutions.slice(0, 8))}
      ${trending.length ? ranked('Cited most this year', 'Your papers · last 12 months', trending.map((p) => ({ name: p.title, count: p.recent, extra: `${num(p.scholar)} in all` }))) : ''}
    </div>

    <section class="section" aria-labelledby="h-who">
      <div class="section-head"><h2 class="eyebrow" id="h-who">Researchers citing you most</h2></div>
      <div class="people">${C.authors.slice(0, 12).map((a) => `<div class="person"><span class="ini" aria-hidden="true">${esc(initials(a.name))}</span>
        <div><b>${esc(a.name)}</b><span>${a.count} papers${a.collaborator ? ' · co-author' : ''}</span></div></div>`).join('')}</div>
    </section>

    ${C.latest?.length ? `<section class="section" aria-labelledby="h-latest">
      <div class="section-head"><h2 class="eyebrow" id="h-latest">Latest citations</h2><a class="more" href="#papers/citing">All ${icon('arrow', 'xs')}</a></div>
      <div class="card pad">${C.latest.slice(0, 5).map((l) => `<a class="rowlink" href="${safeUrl(l.url)}" target="_blank" rel="noopener">
        <h3>${esc(l.title)}</h3><div class="right"><b>${fmtDate(l.date)}</b></div>
        <div class="meta">${l.venue ? `<span class="tag accent">${esc(l.venue)}</span>` : ''}${l.cites?.[0] ? `<span>cites ${esc(l.cites[0].slice(0, 46))}${l.cites[0].length > 46 ? '…' : ''}</span>` : ''}</div></a>`).join('')}</div>
    </section>` : ''}

    <p class="scan"><span>Traced by <b>Semantic Scholar</b>: ${num(t.links)} of Scholar’s ${num(t.scholar_citations)} citations</span><span>Places from <b>OpenAlex</b></span></p>`;
}

function mountCitations(root, C) {
  const el = $('#chart-citing', root);
  if (!el) return;
  const rows = C.by_year.map((y) => ({ label: String(y.year), values: { independent: y.independent, collaborator: y.collaborator, self: y.self } }));
  if (state.tables.citing) el.innerHTML = dataTable([{ key: 'label', label: 'Year' }, ...KINDS.map((k) => ({ key: k.key, label: k.label }))], rows.map((o) => ({ label: o.label, ...o.values })));
  else stacked(el, { data: rows, series: KINDS, unit: 'citing papers' });
}

// ── publications ─────────────────────────────────────────────────────────────
function authorsHTML(p) {
  const list = p.authors || [];
  const me = p.me_index;
  const fmt = (name, i) => (i === me ? `<b>${esc(name)}</b>` : esc(name));
  if (list.length <= 4) return list.map(fmt).join(', ') + (p.authors_truncated ? ', …' : '');
  const out = list.slice(0, 2).map(fmt);
  if (me != null && me >= 2) out.push(fmt(list[me], me));
  return `${out.join(', ')} <span class="muted">+${list.length - out.length}</span>`;
}

function pubHTML(p, withActions = true) {
  const link = p.url || p.scholar_url;
  return `<article class="pub">
    <h3>${link ? `<a href="${safeUrl(link)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</h3>
    <div class="cite-n"${p.citations_source === 'openalex' ? ' title="Not on your Scholar list yet — count from OpenAlex"' : ''}><b>${num(p.citations)}</b><span>cites</span></div>
    <p class="byline">${authorsHTML(p)}</p>
    <p class="where">${p.venue ? `<i>${esc(p.venue)}</i>` : ''}<span>${p.year || ''}</span>
      ${p.type !== 'journal' ? `<span class="tag">${esc(TYPE_LABEL[p.type] || p.type)}</span>` : ''}${p.oa_url ? '<span class="tag accent">Open</span>' : ''}${p.origin === 'orcid' ? '<span class="tag new">New</span>' : ''}</p>
    ${withActions ? `${p.abstract ? `<p class="abstract" data-toggle="abstract" hidden>${esc(p.abstract)}</p>` : ''}
    <div class="pub-actions">
      ${p.abstract ? '<button class="act" type="button" data-abs aria-expanded="false">Abstract</button>' : ''}
      ${p.oa_url ? `<a class="act" href="${safeUrl(p.oa_url)}" target="_blank" rel="noopener">${icon('pdf', 'sm')}Read</a>` : ''}
      <button class="act" type="button" data-cite="${esc(p.id)}">${icon('copy', 'sm')}Cite</button>
      <button class="act" type="button" data-bib="${esc(p.id)}">BibTeX</button>
    </div>` : ''}
  </article>`;
}

function publicationsHTML(P) {
  const q = state.q.trim().toLowerCase();
  const types = ['journal', 'conference', 'preprint', 'other'];
  const count = (t) => P.publications.filter((p) => (t === 'other' ? ['other', 'thesis'].includes(p.type) : p.type === t)).length;
  let list = P.publications.filter((p) => {
    if (state.type !== 'all' && !(state.type === 'other' ? ['other', 'thesis'].includes(p.type) : p.type === state.type)) return false;
    if (state.theme !== 'all' && !p.themes.includes(state.theme)) return false;
    if (q && !`${p.title} ${(p.authors || []).join(' ')} ${p.venue || ''} ${p.year}`.toLowerCase().includes(q)) return false;
    return true;
  });
  list = [...list].sort((a, b) => (state.sort === 'cites' ? b.citations - a.citations || (b.year || 0) - (a.year || 0) : (b.year || 0) - (a.year || 0) || b.citations - a.citations));
  const chip = (key, value, label) => `<button class="chip" type="button" data-set="${key}" data-val="${value}" aria-pressed="${state[key] === value}">${label}</button>`;
  let body = '';
  if (!list.length) body = '<div class="empty"><h3>No match</h3></div>';
  else if (state.sort === 'year') {
    const years = [...new Set(list.map((p) => p.year))];
    body = years.map((y) => { const part = list.filter((p) => p.year === y); return `<h2 class="year-head">${y || 'Undated'}<span>${part.length}</span></h2><div class="pubs">${part.map((p) => pubHTML(p)).join('')}</div>`; }).join('');
  } else body = `<div class="pubs" style="margin-top:8px">${list.map((p) => pubHTML(p)).join('')}</div>`;

  return `<div class="toolbar">
      <form class="search" role="search">${icon('search')}
        <input type="search" name="pq" value="${esc(state.q)}" placeholder="Title, author, journal, year" aria-label="Search publications" autocomplete="off">
        ${state.q ? `<button type="button" data-clear aria-label="Clear search">${icon('x', 'sm')}</button>` : ''}</form>
      <div class="chips" role="group" aria-label="Filters">
        ${chip('type', 'all', `All <span class="n">${P.publications.length}</span>`)}${types.map((t) => chip('type', t, `${TYPE_LABEL[t]} <span class="n">${count(t)}</span>`)).join('')}
        <span style="flex:none;width:1px;background:var(--line-2);margin:6px 2px"></span>
        ${chip('sort', 'year', 'Newest')}${chip('sort', 'cites', 'Most cited')}
      </div>
      <div class="chips" role="group" aria-label="Themes">
        ${chip('theme', 'all', 'All themes')}${P.themes.map((t) => chip('theme', t.id, esc(t.label))).join('')}
      </div>
    </div>
    <p class="small muted" style="margin-top:12px">${list.length} of ${P.publications.length} · ${num(list.reduce((a, p) => a + p.citations, 0))} citations</p>
    ${body}`;
}

function reference(p) {
  if (!p) return '';
  const authors = (p.authors || []).join(', ') + (p.authors_truncated ? ', et al.' : '');
  return `${authors} (${p.year || 'n.d.'}). ${p.title}. ${[p.venue, p.venue_detail].filter(Boolean).join(', ')}.${p.doi ? ` https://doi.org/${p.doi}` : ''}`.replace(/\s+\./g, '.');
}

function bibtex(p) {
  if (!p) return '';
  const first = ((p.authors || ['anon'])[0].split(/\s+/).pop() || 'anon').toLowerCase().replace(/[^a-z]/g, '');
  const word = (p.title.split(/\s+/).find((w) => w.length > 3) || 'paper').toLowerCase().replace(/[^a-z]/g, '');
  const kind = p.type === 'journal' ? 'article' : p.type === 'conference' ? 'inproceedings' : p.type === 'thesis' ? 'phdthesis' : 'misc';
  const venueKey = kind === 'article' ? 'journal' : kind === 'inproceedings' ? 'booktitle' : kind === 'phdthesis' ? 'school' : 'howpublished';
  const rows = [['title', `{${p.title}}`], ['author', (p.authors || []).join(' and ')], [venueKey, p.venue], ['year', p.year], ['doi', p.doi]]
    .filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
  return `@${kind}{${first}${p.year || ''}${word},\n${rows}\n}`;
}
